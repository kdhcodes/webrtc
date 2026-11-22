// Shared helpers for the library integration tests: two RTCPeerConnections
// over loopback through the public API, with the nonstandard sources
// pushing media on a real-time clock.
import type { TestContext } from 'node:test';
import {
  type MediaStreamTrack,
  nonstandard,
  type RTCConfiguration,
  RTCPeerConnection,
  type RTCPeerConnectionIceEvent,
} from '../../lib/index.ts';

/** A failure guard only; tests wait on events, never on time. */
export const WAIT_MS = 15_000;

/** Resolves with the first `type` event on `target` matching `pred`. */
export function next<E extends Event = Event>(
  target: EventTarget,
  type: string,
  pred: (event: E) => boolean = () => true,
): Promise<E> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, listener);
      reject(new Error(`timed out waiting for ${type}`));
    }, WAIT_MS);
    const listener = (event: Event) => {
      if (!pred(event as E)) return;
      clearTimeout(timer);
      target.removeEventListener(type, listener);
      resolve(event as E);
    };
    target.addEventListener(type, listener);
  });
}

/** Resolves once `pc.connectionState` is `state` (now or later). */
export function reaches(pc: RTCPeerConnection, state: RTCPeerConnection['connectionState']) {
  if (pc.connectionState === state) return Promise.resolve();
  return next(pc, 'connectionstatechange', () => pc.connectionState === state).then(() => {});
}

export interface Pair {
  a: RTCPeerConnection;
  b: RTCPeerConnection;
  /** Errors from forwarding trickled candidates; should stay empty. */
  iceErrors: unknown[];
}

/**
 * Two peer connections that trickle their candidates (including the
 * end-of-candidates ones) to each other. Closed after the test.
 */
export function pair(
  t: TestContext,
  config: { a?: RTCConfiguration; b?: RTCConfiguration } = {},
): Pair {
  const a = new RTCPeerConnection(config.a);
  const b = new RTCPeerConnection(config.b);
  t.after(() => {
    a.close();
    b.close();
  });
  const iceErrors: unknown[] = [];
  const forward = (to: RTCPeerConnection) => (e: Event) => {
    const { candidate } = e as RTCPeerConnectionIceEvent;
    if (candidate) to.addIceCandidate(candidate).catch((error) => iceErrors.push(error));
  };
  a.addEventListener('icecandidate', forward(b));
  b.addEventListener('icecandidate', forward(a));
  return { a, b, iceErrors };
}

/** One offer/answer round from `offerer` to `answerer`. */
export async function negotiate(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
): Promise<void> {
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription ?? fail('no local offer'));
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription ?? fail('no local answer'));
}

function fail(message: string): never {
  throw new Error(message);
}

/** Negotiates and waits until both sides are connected. */
export async function connect({ a, b }: Pair): Promise<void> {
  const connected = Promise.all([reaches(a, 'connected'), reaches(b, 'connected')]);
  await negotiate(a, b);
  await connected;
}

/** 10 ms of a 440 Hz tone at 48 kHz mono. */
export function tone(tick: number): Int16Array {
  const samples = new Int16Array(480);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (tick * 480 + i)) / 48_000));
  }
  return samples;
}

/** A mid-grey I420 frame. */
export function greyFrame(width: number, height: number): Uint8Array {
  const chroma = ((width + 1) >> 1) * ((height + 1) >> 1);
  return new Uint8Array(width * height + 2 * chroma).fill(128);
}

export interface Media {
  audio: MediaStreamTrack;
  video: MediaStreamTrack;
  /** Changes the size of the frames pushed from now on. */
  frameSize(width: number, height: number): void;
}

/**
 * A nonstandard audio and video source pushing a tone every 10 ms and a
 * grey frame every 30 ms, until the test ends.
 */
export function media(t: TestContext, width = 320, height = 240): Media {
  const audioSource = new nonstandard.RTCAudioSource();
  const videoSource = new nonstandard.RTCVideoSource();
  let frame = { width, height, data: greyFrame(width, height) };
  let tick = 0;
  const pump = setInterval(() => {
    audioSource.onData({ samples: tone(tick), sampleRate: 48_000 });
    if (tick % 3 === 0) videoSource.onFrame(frame);
    tick++;
  }, 10);
  t.after(() => clearInterval(pump));
  return {
    audio: audioSource.createTrack(),
    video: videoSource.createTrack(),
    frameSize: (w, h) => {
      frame = { width: w, height: h, data: greyFrame(w, h) };
    },
  };
}

/** Decoded tone, not silence. */
export const audible = (samples: Int16Array) => samples.some((s) => Math.abs(s) > 1000);
