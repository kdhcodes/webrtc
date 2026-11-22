import { native } from '../internal/native.ts';
import type { NativeVideoSink } from '../internal/native-types.ts';
import { registerInterface } from '../internal/webidl.ts';
import {
  type MediaStreamTrack,
  type MediaStreamTrackLike,
  whenEnded,
} from '../MediaStreamTrack.ts';
import { sinkTrack } from './convert.ts';
import { getEventHandler, setEventHandler } from './event-handler.ts';

/** A received frame: tightly packed I420 in a Uint8Array (wrtc parity). */
export interface RTCVideoSinkFrame {
  width: number;
  height: number;
  rotation: number;
  data: Uint8Array;
}

/** The `frame` event. */
export interface RTCVideoFrameEvent extends Event {
  readonly frame: RTCVideoSinkFrame;
}

// wrtc dispatches a plain `{type, frame}`; `frame` is an own enumerable
// property here too.
class VideoFrameEvent extends Event implements RTCVideoFrameEvent {
  readonly frame: RTCVideoSinkFrame;

  constructor(frame: RTCVideoSinkFrame) {
    super('frame');
    this.frame = frame;
  }
}

type FrameHandler = ((event: RTCVideoFrameEvent) => void) | null;

/**
 * Receives the frames of a local or remote video track. It keeps the process alive
 * until stop(), or until its track ends (the track's own stop(), its
 * transceiver stopping, or its connection closing), when it stops itself:
 * an ended track delivers nothing more, as in Chrome. wrtc keeps the sink,
 * and the process, alive until stop(), and keeps delivering a stopped local
 * track's media.
 *
 * `rotation` is the frame's rotation metadata, and the pixels arrive
 * unrotated. On a local track (an `RTCVideoSource`'s, or getUserMedia's)
 * the sink gets every frame as pushed: what the source does for its
 * senders (dropping frames for `maxFramerate`, scaling down for the
 * encoder's adaptation, rotating the pixels for a peer that didn't
 * negotiate the CVO header extension) doesn't reach it, as a local preview
 * isn't affected in Chrome. Before 2026-11-21 such a sender made the
 * source rotate the pixels for every sink.
 *
 * At most the 3 newest frames wait for the event loop: when it falls
 * behind (GC, CPU load, a slow listener), a new frame drops the oldest
 * waiting one, and `framesDropped` counts it. Frames that arrive do so in
 * order. On a local track that includes frames pushed in one task: push 5
 * in a row and the sink gets the last 3. wrtc queues every frame without
 * limit, in native memory. Audio sinks never drop.
 *
 * Accepted differences from wrtc, whose `frame` event is a plain object:
 * - The event is a real `Event` with `frame` as an own enumerable
 *   property, so destructuring and `Object.keys` match wrtc, but `type` is
 *   inherited rather than own: `{...e}`, `JSON.stringify(e)` and
 *   `structuredClone(e)` lose it. (An own property, unlike the standard
 *   events' prototype getters: this event isn't WebIDL, so wrtc's shape
 *   wins; SPEC-LAYER-PLAN.md, "Events".)
 * - `for…in` over the event also walks `Event.prototype` (`type`,
 *   `target`, `preventDefault`, ...).
 * - The event's `frame` field is typed `readonly` (it is still writable at
 *   runtime, as in wrtc).
 * - `onframe` is an event handler attribute: it starts as `null`, assigning
 *   a non-function clears it so it reads back `null`, and the handler runs
 *   in registration order among `addEventListener` listeners (HTML), where
 *   wrtc always runs it after them.
 */
export class RTCVideoSink extends EventTarget {
  #native: NativeVideoSink;
  #stopped = false;
  /**
   * The track, held until stop() like senders and streams hold theirs: a
   * getUserMedia track that's collected stops its generator.
   */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: held only to keep the track reachable
  #track: MediaStreamTrackLike | null;
  #cancelEnded = (): void => {};

  static {
    registerInterface('RTCVideoSink', (value) => #native in value);
  }

  constructor(track: MediaStreamTrackLike) {
    super();
    const handle = sinkTrack(track, 'video', 'RTCVideoSink');
    this.#track = track;
    this.#native = new native.VideoSink(handle, (frame) => {
      // Events queued before stop() are dropped.
      if (!this.#stopped) this.dispatchEvent(new VideoFrameEvent(frame));
    });
    // Its track ending means no more media: release the sink, and with it
    // the process (see the class comment).
    this.#cancelEnded = whenEnded(track as MediaStreamTrack, () => this.#stop());
  }

  get [Symbol.toStringTag](): string {
    return 'RTCVideoSink';
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /**
   * Nonstandard, not in wrtc: how many frames this sink dropped because the
   * event loop fell behind (see the class comment). Cheap to read (an
   * atomic in the native sink); it stops growing at stop().
   */
  get framesDropped(): number {
    return this.#native.framesDropped;
  }

  get onframe(): FrameHandler {
    return getEventHandler(this, 'frame') as FrameHandler;
  }

  set onframe(value: FrameHandler) {
    setEventHandler(this, 'frame', value);
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
