// Node side of the Chrome interop tests: our RTCPeerConnection in this
// process, talking peer to peer with Chromium's, driven through Playwright.
// Signaling is in-process (page.evaluate one way, page.exposeFunction the
// other), with trickle ICE both ways. test/interop/chrome-peer.js is the page
// side.
//
// Media is deterministic on both sides, so each side checks it receives what
// the other sent: a tone of a known frequency, and frames of a known size and
// grey level.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import {
  type MediaStreamTrack,
  nonstandard,
  type RTCIceCandidateInit,
  RTCPeerConnection,
  type RTCPeerConnectionIceEvent,
  type RTCSessionDescriptionInit,
  type RTCTrackEvent,
} from '../../lib/index.ts';
import { next, WAIT_MS } from '../integration/harness.ts';

export { next };

const PAGE_SCRIPT = fileURLToPath(new URL('./chrome-peer.js', import.meta.url));

/**
 * Launches Playwright's Chromium (headless). `INTEROP_CHANNEL=chrome` runs
 * the installed Google Chrome instead.
 */
export function launch(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    ...(process.env.INTEROP_CHANNEL ? { channel: process.env.INTEROP_CHANNEL } : {}),
    args: [
      // WebAudio runs (and remote audio plays out) without a user gesture.
      '--autoplay-policy=no-user-gesture-required',
      // Keep the page's media timers at full rate.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });
}

/** An event from the page, with its payload. */
export class PageEvent<T = unknown> extends Event {
  readonly detail: T;
  constructor(type: string, detail: T) {
    super(type);
    this.detail = detail;
  }
}

/**
 * Polls `probe` until `done` accepts its result, which it resolves with.
 * Used for browser stats, which have no event; the timeout is only a
 * failure guard, and its message includes the last result.
 */
export async function until<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The measurements of one inbound-rtp in the page (chrome-peer.js `inbound`). */
export interface Inbound {
  kind: 'audio' | 'video';
  mid: string;
  trackId: string;
  codec: string | null;
  packetsReceived: number;
  framesDecoded: number;
  frameWidth: number;
  frameHeight: number;
  framesPerSecond: number;
  totalAudioEnergy: number;
  audioLevel: number;
  /** WebAudio (audio) or canvas readback (video) of the remote track. */
  measured:
    | { rms: number; peakHz: number }
    | { width: number; height: number; luma: number | null }
    | null;
}

export interface ChromeTransceiver {
  mid: string | null;
  kind: string;
  direction: string;
  currentDirection: string | null;
  remoteTrack: { id: string; muted: boolean };
}

/** The page's peer connection. Events: icecandidate, connectionstatechange, track, removetrack. */
export class ChromePeer extends EventTarget {
  readonly page: Page;
  connectionState = 'new';

  constructor(page: Page) {
    super();
    this.page = page;
    this.addEventListener('connectionstatechange', (e) => {
      this.connectionState = (e as PageEvent<string>).detail;
    });
  }

  /** Calls `window.peer[method](...args)` in the page. */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.page.evaluate(
      ([m, a]) => {
        const peer = (
          globalThis as unknown as { peer: Record<string, (...x: unknown[]) => unknown> }
        ).peer;
        return peer[m as string]?.(...(a as unknown[])) as T;
      },
      [method, args] as const,
    );
  }

  inbound(): Promise<Inbound[]> {
    return this.call('inbound');
  }

  transceivers(): Promise<ChromeTransceiver[]> {
    return this.call('transceivers');
  }

  /** Resolves once `connectionState` satisfies `pred` (now or later). */
  reaches(pred: (state: string) => boolean, timeoutMs = WAIT_MS): Promise<string> {
    if (pred(this.connectionState)) return Promise.resolve(this.connectionState);
    return within(timeoutMs, this, 'connectionstatechange', (e) =>
      pred((e as PageEvent<string>).detail),
    ).then(() => this.connectionState);
  }
}

/**
 * How long to wait for a peer to notice the other side went away. ICE
 * consent freshness reports `disconnected` after about 5 s (`failed` after
 * 30 s), so this is well above WAIT_MS, to stay clear of a loaded machine.
 */
export const CONSENT_WAIT_MS = 45_000;

/** The connection states that mean the other side went away. */
export const ENDED = ['disconnected', 'failed', 'closed'];

/** Like `next`, with its own failure-guard timeout. */
function within(
  timeoutMs: number,
  target: EventTarget,
  type: string,
  pred: (event: Event) => boolean,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, listener);
      reject(new Error(`timed out after ${timeoutMs} ms waiting for ${type}`));
    }, timeoutMs);
    const listener = (event: Event) => {
      if (!pred(event)) return;
      clearTimeout(timer);
      target.removeEventListener(type, listener);
      resolve(event);
    };
    target.addEventListener(type, listener);
  });
}

/** Resolves once our `pc.connectionState` satisfies `pred` (now or later). */
export function nodeReaches(
  pc: RTCPeerConnection,
  pred: (state: RTCPeerConnection['connectionState']) => boolean,
  timeoutMs = WAIT_MS,
): Promise<string> {
  if (pred(pc.connectionState)) return Promise.resolve(pc.connectionState);
  return within(timeoutMs, pc, 'connectionstatechange', () => pred(pc.connectionState)).then(
    () => pc.connectionState,
  );
}

/** Rewrites one side's SDP before the other side applies it. */
export interface Munge {
  /** Our offer, before Chrome applies it. */
  offer?: (sdp: string) => string;
  /** Chrome's answer, before we apply it. */
  answer?: (sdp: string) => string;
}

export interface Call {
  /** Our peer connection. */
  pc: RTCPeerConnection;
  chrome: ChromePeer;
  /**
   * Maps a trickled candidate's sdpMid to the mid the other side knows
   * (identity by default; munged SDP can give the sides different mids).
   */
  mids: { toChrome: (mid: string) => string; toNode: (mid: string) => string };
  /** One offer/answer round, offered by our side. */
  nodeOffers(munge?: Munge): Promise<void>;
  /** One offer/answer round, offered by Chrome. */
  chromeOffers(): Promise<void>;
  /** Adds the candidates from Chrome that waited for our remote description. */
  flushCandidates(): Promise<void>;
  /**
   * Asserts that each side added every candidate the other trickled
   * (candidates reaching an already closed peer connection don't count).
   * Tests call it at the end of their body: an assertion in a t.after hook
   * would skip the test's later hooks (media pumps, sinks) and hang.
   */
  checkCandidates(): Promise<void>;
}

/**
 * Our peer connection and one in a fresh page of `browser`, trickling
 * candidates to each other. Both are closed after the test.
 */
export async function call(t: TestContext, browser: Browser): Promise<Call> {
  const context = await browser.newContext();
  const pc = new RTCPeerConnection();
  // Failures adding the other side's candidates: ours, and delivering them
  // to the page (the page records its own addIceCandidate failures).
  const iceErrors: string[] = [];
  let tearingDown = false;
  // Never throws, so the test's other t.after hooks always run.
  t.after(async () => {
    tearingDown = true;
    pc.close();
    // Closing a context of a browser that went away never settles.
    if (browser.isConnected()) await context.close().catch(() => {});
  });
  const page = await context.newPage();
  const chrome = new ChromePeer(page);
  await page.exposeFunction('__emit', (type: string, detail: unknown) => {
    chrome.dispatchEvent(new PageEvent(type, detail));
  });
  await page.addScriptTag({ path: PAGE_SCRIPT });
  await chrome.call('create');

  const mids: Call['mids'] = { toChrome: (mid) => mid, toNode: (mid) => mid };
  const withMid = (candidate: RTCIceCandidateInit, map: (mid: string) => string) =>
    candidate.sdpMid == null ? candidate : { ...candidate, sdpMid: map(candidate.sdpMid) };

  // Candidates that arrive before our remote description wait for it.
  let pending: RTCIceCandidateInit[] = [];
  const addCandidate = (candidate: RTCIceCandidateInit) =>
    pc.addIceCandidate(candidate).catch((error) => {
      if (pc.signalingState !== 'closed') iceErrors.push(`ours: ${error}`);
    });
  const flush = async () => {
    const queued = pending;
    pending = [];
    for (const candidate of queued) await addCandidate(candidate);
  };
  chrome.addEventListener('icecandidate', (e) => {
    const detail = (e as PageEvent<RTCIceCandidateInit | null>).detail;
    if (!detail) return;
    const candidate = withMid(detail, mids.toNode);
    if (pc.remoteDescription) addCandidate(candidate);
    else pending.push(candidate);
  });
  pc.addEventListener('icecandidate', (e) => {
    const { candidate } = e as RTCPeerConnectionIceEvent;
    if (!candidate || pc.signalingState === 'closed') return;
    chrome
      .call('addIceCandidate', withMid(candidate.toJSON(), mids.toChrome))
      .catch((error) => tearingDown || iceErrors.push(`delivery: ${error}`));
  });

  return {
    pc,
    chrome,
    mids,
    async nodeOffers(munge = {}) {
      await pc.setLocalDescription(await pc.createOffer());
      const offer = pc.localDescription?.sdp ?? '';
      const answer = await chrome.call<RTCSessionDescriptionInit>('acceptOffer', {
        type: 'offer',
        sdp: munge.offer ? munge.offer(offer) : offer,
      });
      const sdp = answer.sdp ?? '';
      await pc.setRemoteDescription({
        type: 'answer',
        sdp: munge.answer ? munge.answer(sdp) : sdp,
      });
      await flush();
    },
    async chromeOffers() {
      const offer = await chrome.call<RTCSessionDescriptionInit>('createOffer');
      await pc.setRemoteDescription(offer);
      await flush();
      await pc.setLocalDescription(await pc.createAnswer());
      await chrome.call('acceptAnswer', pc.localDescription?.toJSON());
    },
    flushCandidates: flush,
    async checkCandidates() {
      const pageErrors = await chrome.call<string[]>('iceErrors');
      assert.deepEqual([...iceErrors, ...pageErrors], [], 'every trickled candidate was added');
    },
  };
}

/** Negotiates with `round` and waits until both sides are connected. */
export async function connect(c: Call, round: () => Promise<void>): Promise<void> {
  const connected = Promise.all([
    nodeReaches(c.pc, (s) => s === 'connected'),
    c.chrome.reaches((s) => s === 'connected'),
  ]);
  connected.catch(() => {}); // Reported below, unless `round` fails first.
  await round();
  await connected;
}

/** A tightly packed I420 frame of one grey level. */
export function i420(width: number, height: number, luma: number): Uint8Array {
  const chroma = ((width + 1) >> 1) * ((height + 1) >> 1);
  const data = new Uint8Array(width * height + 2 * chroma).fill(128);
  data.fill(luma, 0, width * height);
  return data;
}

export interface NodeMedia {
  audio: MediaStreamTrack;
  video: MediaStreamTrack;
}

/**
 * Nonstandard sources pushing, every 10 ms, 10 ms of a `frequency` Hz tone
 * (amplitude 8000, 48 kHz mono), and every 30 ms a `width` x `height` frame
 * of grey `luma`, until the test ends.
 */
export function nodeMedia(
  t: TestContext,
  { frequency = 440, width = 320, height = 240, luma = 128 } = {},
): NodeMedia {
  const audioSource = new nonstandard.RTCAudioSource();
  const videoSource = new nonstandard.RTCVideoSource();
  const frame = { width, height, data: i420(width, height, luma) };
  let tick = 0;
  const pump = setInterval(() => {
    const samples = new Int16Array(480);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(
        8000 * Math.sin((2 * Math.PI * frequency * (tick * 480 + i)) / 48_000),
      );
    }
    audioSource.onData({ samples, sampleRate: 48_000 });
    if (tick % 3 === 0) videoSource.onFrame(frame);
    tick++;
  }, 10);
  t.after(() => clearInterval(pump));
  const audio = audioSource.createTrack();
  const video = videoSource.createTrack();
  t.after(() => {
    audio.stop();
    video.stop();
  });
  return { audio, video };
}

export interface Heard {
  sampleRate: number;
  channelCount: number;
  numberOfFrames: number;
  /** Peak absolute sample over the measured window. */
  peak: number;
  /** Estimated from zero crossings over the measured window. */
  frequency: number;
}

/**
 * Listens on a sink of `track` until 50 consecutive audible events (500 ms
 * at 10 ms each), and measures them.
 */
export async function hear(t: TestContext, track: MediaStreamTrack): Promise<Heard> {
  const sink = new nonstandard.RTCAudioSink(track);
  t.after(() => sink.stop());
  const window: nonstandard.RTCAudioDataEvent[] = [];
  await next<nonstandard.RTCAudioDataEvent>(sink, 'data', (e) => {
    if (e.samples.some((s) => Math.abs(s) > 1000)) window.push(e);
    else window.length = 0;
    return window.length >= 50;
  });
  sink.stop();
  const [first] = window as [nonstandard.RTCAudioDataEvent];
  const samples = window.flatMap((e) => {
    // First channel only.
    const mono: number[] = [];
    for (let i = 0; i < e.numberOfFrames; i++) mono.push(e.samples[i * e.channelCount] ?? 0);
    return mono;
  });
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] ?? 0) < 0 !== (samples[i] ?? 0) < 0) crossings++;
  }
  return {
    sampleRate: first.sampleRate,
    channelCount: first.channelCount,
    numberOfFrames: first.numberOfFrames,
    peak: samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0),
    frequency: Math.round((crossings / 2) * (first.sampleRate / samples.length)),
  };
}

export interface Seen {
  width: number;
  height: number;
  /** Mean of the Y plane of the last frame. */
  luma: number;
  /** Frames per second over the measured frames. */
  fps: number;
}

/** Waits on a sink of `track` for `count` frames of `width` x `height`, and measures them. */
export async function see(
  t: TestContext,
  track: MediaStreamTrack,
  width: number,
  height: number,
  count = 30,
): Promise<Seen> {
  const sink = new nonstandard.RTCVideoSink(track);
  t.after(() => sink.stop());
  const times: number[] = [];
  const sizes = new Map<string, number>();
  const { frame } = await next<nonstandard.RTCVideoFrameEvent>(sink, 'frame', (e) => {
    const size = `${e.frame.width}x${e.frame.height}`;
    sizes.set(size, (sizes.get(size) ?? 0) + 1);
    if (e.frame.width !== width || e.frame.height !== height) return false;
    times.push(performance.now());
    return times.length >= count;
  }).catch((error) => {
    const got = [...sizes].map(([size, n]) => `${n} of ${size}`).join(', ') || 'no frames';
    throw new Error(`expected ${count} frames of ${width}x${height}, got ${got}`, {
      cause: error,
    });
  });
  sink.stop();
  let sum = 0;
  for (let i = 0; i < width * height; i++) sum += frame.data[i] ?? 0;
  const seconds = ((times.at(-1) ?? 0) - (times[0] ?? 0)) / 1000;
  return {
    width,
    height,
    luma: Math.round(sum / (width * height)),
    fps: Math.round((count - 1) / seconds),
  };
}

/** Limited-range BT.601: the RGB grey a browser renders for luma `y`. */
export const rgbOf = (y: number) => Math.round((255 / 219) * (y - 16));
/**
 * Whether `luma` is what Chrome encodes a canvas of grey `level` to. The
 * headless shell keeps the value (full range: Y = L); full Chromium converts
 * to limited range (Y = 16 + 219/255 L, so 71 for 64).
 */
export const fromCanvas = (luma: number, level: number) =>
  near(luma, level, 5) || near(luma, Math.round(16 + (219 / 255) * level), 5);

/** Polls Chrome's inbound-rtp until one matches `pred`, and resolves with it. */
export async function untilInbound(
  chrome: ChromePeer,
  pred: (stats: Inbound) => boolean,
  what: string,
): Promise<Inbound> {
  const all = await until(
    () => chrome.inbound(),
    (stats) => stats.some(pred),
    `Chrome to receive ${what}`,
  );
  return all.find(pred) as Inbound;
}

export const near = (actual: number, expected: number, tolerance: number) =>
  Math.abs(actual - expected) <= tolerance;

/** Chrome plays out a tone of `frequency` Hz at the level our sources push (8000 of 32768). */
export function chromeHears(chrome: ChromePeer, frequency: number): Promise<Inbound> {
  return untilInbound(
    chrome,
    (s) => {
      const m = s.measured as { rms: number; peakHz: number } | null;
      // An FFT bin is 48000 / 8192 = 5.9 Hz wide.
      return s.kind === 'audio' && !!m && near(m.peakHz, frequency, 12) && near(m.rms, 0.173, 0.03);
    },
    `a ${frequency} Hz tone`,
  );
}

/**
 * Chrome decodes and renders `width` x `height` frames of the grey our
 * sources push as luma `luma`, having decoded at least 30 frames.
 */
export function chromeSees(
  chrome: ChromePeer,
  width: number,
  height: number,
  luma: number,
  pred: (stats: Inbound) => boolean = () => true,
): Promise<Inbound> {
  return untilInbound(
    chrome,
    (s) => {
      const m = s.measured as { width: number; height: number; luma: number | null } | null;
      return (
        s.kind === 'video' &&
        s.framesDecoded >= 30 &&
        s.frameWidth === width &&
        s.frameHeight === height &&
        m?.width === width &&
        m.height === height &&
        m.luma !== null &&
        near(m.luma, rgbOf(luma), 10) &&
        pred(s)
      );
    },
    `${width}x${height} frames of luma ${luma}`,
  );
}

/** A one-line summary of Chrome's reception, for test diagnostics. */
export function summary(s: Inbound): string {
  const m = s.measured as Record<string, number | null> | null;
  return s.kind === 'audio'
    ? `${s.codec}, ${s.packetsReceived} packets, WebAudio rms ${m?.rms?.toFixed(3)} peak ${m?.peakHz?.toFixed(0)} Hz`
    : `${s.codec} ${s.frameWidth}x${s.frameHeight} @ ${s.framesPerSecond} fps, ${s.framesDecoded} decoded, rendered grey ${m?.luma?.toFixed(0)}`;
}

/**
 * A call with media flowing both ways (each side's tone and frames reach
 * the other); resolves with our remote audio and video tracks.
 */
export async function liveCall(
  t: TestContext,
  browser: Browser,
): Promise<{ c: Call; remote: MediaStreamTrack[] }> {
  const c = await call(t, browser);
  const m = nodeMedia(t, { luma: 200 });
  c.pc.addTrack(m.audio);
  c.pc.addTrack(m.video);
  await c.chrome.call('addTone', 660);
  await c.chrome.call('addCanvas', 320, 240, 64);
  const remote: MediaStreamTrack[] = [];
  c.pc.addEventListener('track', (e) => remote.push((e as RTCTrackEvent).track));
  await connect(c, c.nodeOffers);
  const [audio, video] = remote as [MediaStreamTrack, MediaStreamTrack];
  await Promise.all([
    hear(t, audio),
    see(t, video, 320, 240, 5),
    chromeHears(c.chrome, 440),
    chromeSees(c.chrome, 320, 240, 200),
  ]);
  return { c, remote };
}
