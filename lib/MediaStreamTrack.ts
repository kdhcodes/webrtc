import type {
  MediaTrackCapabilities,
  MediaTrackConstraints,
  MediaTrackSettings,
} from './internal/generated/idl.ts';
import type { NativeTrack } from './internal/native-types.ts';
import { registerInterface } from './internal/webidl.ts';
import { getEventHandler, setEventHandler } from './nonstandard/event-handler.ts';

export type MediaStreamTrackState = 'live' | 'ended';

/**
 * Anything with a track's identity. Constructors that take a track (the
 * nonstandard sinks) are typed with this so code annotated with the DOM's
 * global MediaStreamTrack (wrtc's types re-export it) still compiles. At
 * runtime they require one of our MediaStreamTrack objects.
 */
export interface MediaStreamTrackLike {
  readonly id: string;
  readonly kind: string;
}

// No `this` type: our class has private fields, which makes it nominal, and
// the DOM's handler type would then not accept ours.
type Handler = ((ev: Event) => unknown) | null;

const constructToken = Symbol('MediaStreamTrack');
const contentHints = {
  audio: ['', 'speech', 'speech-recognition', 'music'],
  video: ['', 'motion', 'detail', 'text'],
} as const;

// One wrapper per native handle. The native registry already maps each
// libwebrtc track to one handle while the handle is reachable, and a wrapper
// holds its handle, so this gives `sender.track === receiver.track`-style
// identity for as long as JS holds the wrapper.
const wrappers = new WeakMap<NativeTrack, MediaStreamTrack>();

let nativeOf: (track: MediaStreamTrack) => NativeTrack;
let isTrack: (value: object) => value is MediaStreamTrack;
let endSource: (track: MediaStreamTrack) => void;
let makeDeviceTrack: (track: MediaStreamTrack, label: string, onAllEnded: () => void) => void;
let makeRemote: (track: MediaStreamTrack) => void;
let setMuted: (track: MediaStreamTrack, muted: boolean) => void;
let onEnd: (track: MediaStreamTrack, callback: () => void) => () => void;

/** The tracks on one getUserMedia source that haven't ended yet. */
interface DeviceLifetime {
  live: number;
  onAllEnded: () => void;
}

function releaseDeviceTrack(lifetime: DeviceLifetime): void {
  if (--lifetime.live === 0) lifetime.onAllEnded();
}

// A getUserMedia track that is collected without ever ending counts as
// ended: nothing can use it any more. Everything that consumes a track
// (senders, streams, sinks) holds this wrapper while it does, so a collected
// one is unused, and its generator must not run on forever.
const collectedDeviceTracks = new FinalizationRegistry<DeviceLifetime>(releaseDeviceTrack);

/**
 * A media track. Not constructible from JS; tracks come from the
 * nonstandard sources, getUserMedia and receivers.
 *
 * wrtc parity (SPEC-LAYER-PLAN.md, "wrtc compatibility spec"):
 * - `stop()` marks the track ended, without an event (as in the spec);
 *   media keeps flowing to senders. Its sinks stop, though (Chrome; wrtc
 *   keeps feeding them): see the sinks' class comments.
 * - `getSettings()` returns wrtc's fixed values.
 *
 * Not wrtc parity (the spec and Chrome; wrtc has neither):
 * - A receiver's track starts muted, unmutes when media arrives and mutes
 *   when negotiation stops it receiving. Local tracks are never muted.
 *   Muting doesn't touch media: sinks see whatever arrives either way.
 * - A receiver's track (and every clone of it) ends with an `ended` event
 *   when its transceiver stops or its peer connection closes, in a queued
 *   task, so `readyState` is still "live" until then.
 *
 * Declares the full Media Capture surface so instances are assignable to
 * the DOM's MediaStreamTrack type. `kind` is typed `string` for the same
 * reason; at runtime it is always "audio" or "video".
 */
export class MediaStreamTrack extends EventTarget {
  #native: NativeTrack;
  #id: string;
  #kind: 'audio' | 'video';
  #ended = false;
  /**
   * Every live track on this track's source that clone() made, including
   * this one (weakly, so clones can be collected). Ending the source ends
   * them all. Null until the first clone.
   */
  #family: Set<WeakRef<MediaStreamTrack>> | null = null;
  // wrtc parity: once stopped, `enabled` reads and writes a JS copy and no
  // longer reaches the native track.
  #endedEnabled = true;
  #contentHint = '';
  #label = '';
  /** getUserMedia tracks only: shared with every clone. */
  #lifetime: DeviceLifetime | null = null;
  #muted = false;
  /** A receiver's track, or a clone of one. */
  #remote = false;
  /** Its source's end is queued (see markTrackEnded). */
  #sourceEnding = false;
  /** Run once, when it ends (see whenEnded). */
  #onEnded: Set<() => void> | null = null;

  static {
    nativeOf = (track) => track.#native;
    isTrack = (value): value is MediaStreamTrack => #native in value;
    endSource = (track) => {
      if (track.#sourceEnding) return;
      track.#sourceEnding = true;
      // Media Capture and Streams: a track that ends for a reason other
      // than stop() ends in a queued task, which does nothing to a track
      // already ended (e.g. by stop()) and otherwise fires `ended`.
      setImmediate(() => {
        for (const ref of track.#family ?? [new WeakRef(track)]) {
          const member = ref.deref();
          if (member && !member.#ended) {
            member.#end();
            member.dispatchEvent(new Event('ended'));
            member.#runEnded();
          }
        }
      });
    };
    onEnd = (track, callback) => {
      if (track.#ended) {
        callback();
        return () => {};
      }
      track.#onEnded ??= new Set();
      track.#onEnded.add(callback);
      return () => track.#onEnded?.delete(callback);
    };
    makeDeviceTrack = (track, label, onAllEnded) => {
      track.#label = label;
      track.#lifetime = { live: 1, onAllEnded };
      collectedDeviceTracks.register(track, track.#lifetime, track);
    };
    makeRemote = (track) => {
      if (track.#remote) return;
      track.#remote = true;
      track.#muted = true;
      // The spec's and Chrome's label for a receiver's track.
      track.#label = `remote ${track.kind}`;
    };
    // The source's muted state: every live clone follows it (as in Chrome,
    // where it belongs to the source), each firing its own event.
    setMuted = (track, muted) => {
      // An unmute already queued when the transceiver stopped arrives
      // after its end is queued: the track ends muted, without one.
      if (!muted && track.#sourceEnding) return;
      for (const ref of track.#family ?? [new WeakRef(track)]) {
        const member = ref.deref();
        if (member) member.#setMuted(muted);
      }
    };
    registerInterface('MediaStreamTrack', (value) => #native in value);
  }

  /** @internal Use trackFromNative(). */
  constructor(...args: unknown[]) {
    super();
    if (args[0] !== constructToken) {
      throw new TypeError(
        "Failed to construct 'MediaStreamTrack': Illegal constructor. Tracks come from " +
          "getUserMedia(), a nonstandard RTCAudioSource or RTCVideoSource's createTrack(), " +
          "or a peer connection's track event.",
      );
    }
    const native = args[1] as NativeTrack;
    this.#native = native;
    this.#id = native.id;
    this.#kind = native.kind;
  }

  // Node's EventTarget would otherwise make this "[object EventTarget]".
  get [Symbol.toStringTag](): string {
    return 'MediaStreamTrack';
  }

  get id(): string {
    return this.#id;
  }

  get kind(): string {
    return this.#kind;
  }

  /**
   * The device's label for getUserMedia tracks, "remote audio" or "remote
   * video" for a receiver's (as in Chrome), otherwise "".
   */
  get label(): string {
    return this.#label;
  }

  get enabled(): boolean {
    return this.#ended ? this.#endedEnabled : this.#native.enabled;
  }

  set enabled(value: boolean) {
    if (this.#ended) {
      this.#endedEnabled = Boolean(value);
    } else {
      this.#native.enabled = Boolean(value);
    }
  }

  /**
   * True while a receiver's track gets no media (see the class comment).
   * Always false for local tracks.
   */
  get muted(): boolean {
    return this.#muted;
  }

  get readyState(): MediaStreamTrackState {
    return this.#ended ? 'ended' : 'live';
  }

  get contentHint(): string {
    return this.#contentHint;
  }

  set contentHint(value: string) {
    const hint = String(value);
    if ((contentHints[this.#kind] as readonly string[]).includes(hint)) {
      this.#contentHint = hint;
    }
  }

  get onended(): Handler {
    return getEventHandler(this, 'ended') as Handler;
  }

  set onended(value: Handler) {
    setEventHandler(this, 'ended', value);
  }

  get onmute(): Handler {
    return getEventHandler(this, 'mute') as Handler;
  }

  set onmute(value: Handler) {
    setEventHandler(this, 'mute', value);
  }

  get onunmute(): Handler {
    return getEventHandler(this, 'unmute') as Handler;
  }

  set onunmute(value: Handler) {
    setEventHandler(this, 'unmute', value);
  }

  /**
   * Marks the track ended, with no event. Its sinks stop (they'd get no
   * more media from an ended track, as in Chrome; wrtc kept delivering to
   * them). getUserMedia's generator stops once every track on its source
   * (clones included) has ended or been collected.
   */
  stop(): void {
    if (this.#ended) return;
    this.#end();
    this.#runEnded();
  }

  /**
   * A new track on the same source, with a new id, for local and received
   * tracks alike (a received track's clone gets the same remote media).
   * Copies `enabled`, `muted` and `readyState` (the spec; wrtc doesn't copy
   * `enabled`). Clones of a received track end with it when its source
   * ends (the remote side stops sending it, or the connection closes), as
   * in wrtc.
   */
  clone(): MediaStreamTrack {
    const clone = trackFromNative(this.#native.clone());
    clone.enabled = this.enabled;
    clone.#label = this.#label;
    clone.#remote = this.#remote;
    clone.#muted = this.#muted;
    if (this.#ended) {
      clone.#end();
      return clone;
    }
    if (this.#lifetime) {
      this.#lifetime.live++;
      clone.#lifetime = this.#lifetime;
      collectedDeviceTracks.register(clone, this.#lifetime, clone);
    }
    if (!this.#family) this.#family = new Set([new WeakRef<MediaStreamTrack>(this)]);
    for (const ref of this.#family) if (!ref.deref()) this.#family.delete(ref);
    this.#family.add(new WeakRef(clone));
    clone.#family = this.#family;
    return clone;
  }

  getCapabilities(): MediaTrackCapabilities {
    this.#native; // WebIDL's brand check: a foreign `this` throws a TypeError.
    return {};
  }

  getConstraints(): MediaTrackConstraints {
    this.#native; // WebIDL's brand check: a foreign `this` throws a TypeError.
    return {};
  }

  /** wrtc's fixed values; it has no real device to report on. */
  getSettings(): MediaTrackSettings {
    const settings =
      this.#kind === 'audio'
        ? {
            deviceId: 'FakeAudioDevice',
            groupId: 'FakeDeviceGroup',
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false,
            channelCount: 1,
            sampleRate: 48000,
            sampleSize: 16,
            latency: 0,
            volume: 0.25,
          }
        : {
            deviceId: 'FakeVideoDevice',
            groupId: 'FakeDeviceGroup',
            height: 480,
            width: 640,
            aspectRatio: 640 / 480,
            frameRate: 30,
            facingMode: 'user',
          };
    return settings as MediaTrackSettings;
  }

  /** There is nothing to constrain; resolves without changing anything. */
  applyConstraints(_constraints?: MediaTrackConstraints): Promise<void> {
    this.#native; // WebIDL's brand check: a foreign `this` throws a TypeError.
    return Promise.resolve();
  }

  /** The spec's "set the muted state" (Media Capture and Streams). */
  #setMuted(muted: boolean): void {
    // An ended track's source is gone: no more mute changes (WPT
    // RTCPeerConnection-remote-track-mute: none on a stopped transceiver's).
    if (this.#ended || this.#muted === muted) return;
    this.#muted = muted;
    this.dispatchEvent(new Event(muted ? 'mute' : 'unmute'));
  }

  /** Runs the whenEnded() callbacks once; one that throws doesn't skip the rest. */
  #runEnded(): void {
    const callbacks = this.#onEnded;
    this.#onEnded = null;
    for (const callback of callbacks ?? []) {
      try {
        callback();
      } catch (error) {
        // Reported like a listener's error.
        process.nextTick(() => {
          throw error;
        });
      }
    }
  }

  #end(): void {
    if (this.#ended) return;
    this.#endedEnabled = this.#native.enabled;
    this.#ended = true;
    if (this.#lifetime) {
      collectedDeviceTracks.unregister(this);
      releaseDeviceTrack(this.#lifetime);
    }
  }
}

/** Internal: the wrapper for a native track handle, created on first use. */
export function trackFromNative(native: NativeTrack): MediaStreamTrack {
  let track = wrappers.get(native);
  if (!track) {
    track = new MediaStreamTrack(constructToken, native);
    wrappers.set(native, track);
  }
  return track;
}

/** Internal: the native handle behind one of our tracks, or undefined. */
export function nativeTrackOf(value: unknown): NativeTrack | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  return isTrack(value) ? nativeOf(value) : undefined;
}

/**
 * Internal: marks a new, live track as getUserMedia's, with the device's
 * label. `onAllEnded` runs once, when this track and every clone of it have
 * ended or been collected.
 */
export function initDeviceTrack(
  track: MediaStreamTrack,
  label: string,
  onAllEnded: () => void,
): void {
  makeDeviceTrack(track, label, onAllEnded);
}

/**
 * Internal: marks a receiver's track as remote, which starts it muted. Only
 * the first call for a track has an effect.
 */
export function initRemoteTrack(track: MediaStreamTrack): void {
  makeRemote(track);
}

/**
 * Internal: sets the muted state of a receiver's track and its live clones,
 * firing `mute` or `unmute` on each one that changes. Ended tracks don't
 * change.
 */
export function setTrackMuted(track: MediaStreamTrack, muted: boolean): void {
  setMuted(track, muted);
}

/**
 * Internal: a receiver's source ended (its transceiver stopped, or its
 * peer connection closed). In a queued task, ends its track and every clone
 * of it that hasn't ended yet, each with an `ended` event (webrtc-pc "stop
 * sending and receiving"; Media Capture and Streams, "ended"). Once per
 * track; later calls do nothing.
 */
export function markTrackEnded(track: MediaStreamTrack): void {
  endSource(track);
}

/**
 * Internal: runs `callback` once this track ends, by stop() or because its
 * source ended (then after its `ended` event, in that task), or now if it
 * already has. Returns a function that cancels it.
 */
export function whenEnded(track: MediaStreamTrack, callback: () => void): () => void {
  return onEnd(track, callback);
}
