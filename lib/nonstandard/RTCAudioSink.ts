import { native } from '../internal/native.ts';
import type { NativeAudioData, NativeSink } from '../internal/native-types.ts';
import { registerInterface } from '../internal/webidl.ts';
import {
  type MediaStreamTrack,
  type MediaStreamTrackLike,
  whenEnded,
} from '../MediaStreamTrack.ts';
import { sinkTrack } from './convert.ts';
import { getEventHandler, setEventHandler } from './event-handler.ts';

/** The `data` event: RTCAudioData fields as own properties. */
export interface RTCAudioDataEvent extends Event {
  readonly samples: Int16Array;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  readonly channelCount: number;
  readonly numberOfFrames: number;
}

// wrtc dispatches a plain object with these own properties (in this order)
// plus `type`; ours is an Event whose payload fields are own and enumerable,
// so destructuring and spreading the payload behave the same.
class AudioDataEvent extends Event implements RTCAudioDataEvent {
  readonly samples: Int16Array;
  readonly bitsPerSample: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly numberOfFrames: number;

  constructor(data: NativeAudioData) {
    super('data');
    this.samples = data.samples;
    this.bitsPerSample = data.bitsPerSample;
    this.sampleRate = data.sampleRate;
    this.channelCount = data.channelCount;
    this.numberOfFrames = data.numberOfFrames;
  }
}

type DataHandler = ((event: RTCAudioDataEvent) => void) | null;

/**
 * Receives the audio of a local or remote audio track. A sink on a remote
 * track sees the mixer's format (48 kHz, 480 frames per event); one on a
 * local track sees exactly what was pushed. It keeps the process alive
 * until stop(), or until its track ends (the track's own stop(), its
 * transceiver stopping, or its connection closing), when it stops itself:
 * an ended track delivers nothing more, as in Chrome. wrtc keeps the sink,
 * and the process, alive until stop(), and keeps delivering a stopped local
 * track's media.
 *
 * Accepted differences from wrtc, whose `data` event is a plain object:
 * - The event is a real `Event` with the payload as own enumerable
 *   properties, so destructuring and `Object.keys` match wrtc, but `type`
 *   is inherited rather than own: `{...e}`, `JSON.stringify(e)` and
 *   `structuredClone(e)` lose it. (Own properties, unlike the standard
 *   events' prototype getters: this event isn't WebIDL, so wrtc's shape
 *   wins; SPEC-LAYER-PLAN.md, "Events".)
 * - `for…in` over the event also walks `Event.prototype` (`type`,
 *   `target`, `preventDefault`, ...).
 * - The payload fields are typed `readonly` (they are still writable at
 *   runtime, as in wrtc).
 * - `ondata` is an event handler attribute: it starts as `null`, assigning
 *   a non-function clears it so it reads back `null`, and the handler runs
 *   in registration order among `addEventListener` listeners (HTML), where
 *   wrtc always runs it after them.
 */
export class RTCAudioSink extends EventTarget {
  #native: NativeSink;
  #stopped = false;
  /**
   * The track, held until stop() like senders and streams hold theirs: a
   * getUserMedia track that's collected stops its generator.
   */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: held only to keep the track reachable
  #track: MediaStreamTrackLike | null;
  #cancelEnded = (): void => {};

  static {
    registerInterface('RTCAudioSink', (value) => #native in value);
  }

  constructor(track: MediaStreamTrackLike) {
    super();
    const handle = sinkTrack(track, 'audio', 'RTCAudioSink');
    this.#track = track;
    this.#native = new native.AudioSink(handle, (data) => {
      // Events queued before stop() are dropped.
      if (!this.#stopped) this.dispatchEvent(new AudioDataEvent(data));
    });
    // Its track ending means no more media: release the sink, and with it
    // the process (see the class comment).
    this.#cancelEnded = whenEnded(track as MediaStreamTrack, () => this.#stop());
  }

  get [Symbol.toStringTag](): string {
    return 'RTCAudioSink';
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get ondata(): DataHandler {
    return getEventHandler(this, 'data') as DataHandler;
  }

  set ondata(value: DataHandler) {
    setEventHandler(this, 'data', value);
  }

  stop(): void {
    this.#stop();
  }

  // Not the public stop(), which a subclass may override: the source-end
  // hook can run inside this constructor, before a subclass is set up.
  #stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#track = null;
    // The canceller references the track: drop it too, so a stopped sink
    // doesn't keep its track (and a getUserMedia generator) alive.
    this.#cancelEnded();
    this.#cancelEnded = () => {};
    this.#native.stop();
  }
}
