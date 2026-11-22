/**
 * The synthetic "devices" behind getUserMedia (lib/mediaDevices.ts): 48 kHz
 * mono silence in 10 ms chunks, and a still 640x480 colour-bar pattern at
 * 30 fps, pushed into native sources on one shared clock.
 *
 * wrtc's getUserMedia tracks carry no media at all; this is the documented
 * improvement (SPEC-LAYER-PLAN.md, "getUserMedia"). The formats match the
 * fixed values MediaStreamTrack.getSettings() reports.
 *
 * Lifetime:
 * - The clock is an unref'd interval, so it never keeps the process alive,
 *   and it runs only while at least one feed is running.
 * - Each feed runs until its stop(); getUserMedia stops it once every track
 *   on its source (clones included) has ended or been collected.
 */
import { native } from './native.ts';
import type { NativeAudioData, NativeTrack, NativeVideoFrame } from './native-types.ts';

export const AUDIO_SAMPLE_RATE = 48_000;
/** 10 ms, the only chunk size the native audio source takes. */
const AUDIO_FRAMES = AUDIO_SAMPLE_RATE / 100;
export const VIDEO_WIDTH = 640;
export const VIDEO_HEIGHT = 480;
export const VIDEO_FRAME_RATE = 30;
/** The clock's period. Each tick pushes whatever has fallen due since the last. */
const TICK_MS = 10;

/**
 * Calls `emit` `perSecond` times a second on average, measured from
 * `start`, however irregularly tick() is called. Timers fire late and
 * drift, so counting due emissions (rather than one per tick) keeps the
 * rate exact. After a stall (a blocked event loop) it emits at most
 * `maxBurst` at once and drops the rest: real-time media that arrives late
 * in a burst is worse than a gap.
 */
export class Pacer {
  #perSecond: number;
  #start: number;
  #maxBurst: number;
  #emit: () => void;
  #emitted = 0;

  constructor(perSecond: number, start: number, maxBurst: number, emit: () => void) {
    this.#perSecond = perSecond;
    this.#start = start;
    this.#maxBurst = maxBurst;
    this.#emit = emit;
  }

  /** Emits everything due by `now` (ms, same clock as `start`); the first at `start`. */
  tick(now: number): void {
    const due = Math.floor(((now - this.#start) * this.#perSecond) / 1000) + 1;
    if (due - this.#emitted > this.#maxBurst) this.#emitted = due - this.#maxBurst;
    while (this.#emitted < due) {
      this.#emitted++;
      this.#emit();
    }
  }
}

// --- the shared clock -------------------------------------------------------

const running = new Set<Pacer>();
let timer: ReturnType<typeof setInterval> | undefined;

let warned = false;

function tickAll(): void {
  const now = performance.now();
  for (const pacer of running) {
    // One failing feed must neither throw out of the timer (an uncaught
    // exception) nor starve the feeds after it. It keeps being retried.
    try {
      pacer.tick(now);
    } catch (error) {
      if (!warned) {
        warned = true;
        process.emitWarning(`getUserMedia's synthetic media failed to push: ${error}`);
      }
    }
  }
}

/** Internal (exported for tests): puts a pacer on the shared clock. */
export function startPacer(pacer: Pacer): void {
  running.add(pacer);
  if (timer === undefined) {
    timer = setInterval(tickAll, TICK_MS);
    // Synthetic media must not keep the process alive; whatever consumes it
    // (a peer connection, a sink) does that itself.
    timer.unref();
  }
}

/** Internal (exported for tests): takes a pacer off the shared clock. Idempotent. */
export function stopPacer(pacer: Pacer): void {
  running.delete(pacer);
  if (running.size === 0 && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

/** Internal, for tests: how many feeds are running, and whether the clock is. */
export function clockState(): { feeds: number; ticking: boolean } {
  return { feeds: running.size, ticking: timer !== undefined };
}

// --- content ----------------------------------------------------------------

/**
 * 75% colour bars (white, yellow, cyan, green, magenta, red, blue, black),
 * BT.601 limited range, as a tightly packed I420 frame. `width` must be a
 * multiple of 16 so every bar is a whole number of chroma columns.
 */
export function colourBars(width: number, height: number): Uint8Array {
  const bars: [number, number, number][] = [
    [180, 128, 128],
    [162, 44, 142],
    [131, 156, 44],
    [112, 72, 58],
    [84, 184, 198],
    [65, 100, 212],
    [35, 212, 114],
    [16, 128, 128],
  ];
  const chromaWidth = width / 2;
  const chromaHeight = Math.ceil(height / 2);
  const frame = new Uint8Array(width * height + 2 * chromaWidth * chromaHeight);
  const lumaRow = new Uint8Array(width);
  const uRow = new Uint8Array(chromaWidth);
  const vRow = new Uint8Array(chromaWidth);
  for (let x = 0; x < width; x++) {
    const [y, u, v] = bars[Math.floor((x * bars.length) / width)] as [number, number, number];
    lumaRow[x] = y;
    if (x % 2 === 0) {
      uRow[x / 2] = u;
      vRow[x / 2] = v;
    }
  }
  const uPlane = width * height;
  const vPlane = uPlane + chromaWidth * chromaHeight;
  for (let row = 0; row < height; row++) frame.set(lumaRow, row * width);
  for (let row = 0; row < chromaHeight; row++) {
    frame.set(uRow, uPlane + row * chromaWidth);
    frame.set(vRow, vPlane + row * chromaWidth);
  }
  return frame;
}

// Built on first use and shared by every feed: the native sources copy what
// they're given, and these never reach user code.
let silence: NativeAudioData | undefined;
let pattern: NativeVideoFrame | undefined;

// --- feeds ------------------------------------------------------------------

/** A native source being fed by the clock, and its first track. */
export interface Feed {
  readonly track: NativeTrack;
  /**
   * Stops the feed for good. Idempotent. It doesn't reference the track, so
   * holding it doesn't keep the track's wrapper alive.
   */
  readonly stop: () => void;
}

function feed(track: NativeTrack, pacer: Pacer): Feed {
  startPacer(pacer);
  return { track, stop: () => stopPacer(pacer) };
}

/** Starts feeding silence into a new native audio source. */
export function startAudioFeed(): Feed {
  const source = new native.AudioSource();
  silence ??= {
    samples: new Int16Array(AUDIO_FRAMES),
    sampleRate: AUDIO_SAMPLE_RATE,
    bitsPerSample: 16,
    channelCount: 1,
    numberOfFrames: AUDIO_FRAMES,
  };
  const data = silence;
  // Up to 50 ms of catch-up after a stall.
  return feed(
    source.createTrack(),
    new Pacer(100, performance.now(), 5, () => source.pushData(data)),
  );
}

/** Starts feeding the colour-bar pattern into a new native video source. */
export function startVideoFeed(): Feed {
  const source = new native.VideoSource({ isScreencast: false, needsDenoising: null });
  pattern ??= {
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    data: colourBars(VIDEO_WIDTH, VIDEO_HEIGHT),
    rotation: 0,
  };
  const frame = pattern;
  // A late frame is simply sent late; never two at once.
  return feed(
    source.createTrack(),
    new Pacer(VIDEO_FRAME_RATE, performance.now(), 1, () => source.pushFrame(frame)),
  );
}
