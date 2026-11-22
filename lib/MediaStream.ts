import {
  type AddListenerOptions,
  type AnyEventHandler,
  type AnyListener,
  type EventHandler,
  getEventHandler,
  type Listener,
  type RemoveListenerOptions,
  setEventHandler,
} from './internal/events.ts';
import { type EventInit, toMediaStreamTrackEventInit } from './internal/generated/idl.ts';
import {
  getIteratorMethod,
  interfaceType,
  isObject,
  registerInterface,
  sequence,
} from './internal/webidl.ts';
import type { MediaStreamTrack, MediaStreamTrackLike } from './MediaStreamTrack.ts';

// node:crypto took about 7 of the 42 ms this package took to import on
// Linux (bench/RESULTS.md), so it's loaded on first use instead. In most
// apps something else has loaded it by then.
let uuid: (() => string) | undefined;
function randomUUID(): string {
  uuid ??= process.getBuiltinModule('node:crypto').randomUUID;
  return uuid();
}

const toTrack = interfaceType('MediaStreamTrack') as (v: unknown, c: string) => MediaStreamTrack;
const toTracks = sequence(toTrack);

export interface MediaStreamTrackEventInit extends EventInit {
  track: MediaStreamTrackLike;
}

/**
 * `addtrack` / `removetrack` on a MediaStream. `track` is a WebIDL
 * attribute: a getter on the prototype, as in browsers (SPEC-LAYER-PLAN.md,
 * "Events").
 */
export class MediaStreamTrackEvent extends Event {
  readonly #track: MediaStreamTrack;

  static {
    registerInterface('MediaStreamTrackEvent', (value) => #track in value);
  }

  constructor(type: string, eventInitDict: MediaStreamTrackEventInit) {
    const init = toMediaStreamTrackEventInit(
      eventInitDict,
      "Failed to construct 'MediaStreamTrackEvent': eventInitDict",
    );
    super(String(type), init);
    this.#track = init.track as MediaStreamTrack;
  }

  get track(): MediaStreamTrack {
    return this.#track;
  }

  get [Symbol.toStringTag](): string {
    return 'MediaStreamTrackEvent';
  }
}

/**
 * The legacy `addstream` / `removestream` event on an RTCPeerConnection,
 * which Chrome still fires. `stream` is an enumerable getter on the
 * prototype, as Chrome's is. Not exported: wrtc has no such class, and
 * nothing constructs one.
 */
export class MediaStreamEvent extends Event {
  readonly #stream: MediaStream;

  static {
    // Not in the IDL table (the spec dropped the interface), so lib/index.ts
    // doesn't shape it: the attribute is made enumerable here.
    Object.defineProperty(MediaStreamEvent.prototype, 'stream', { enumerable: true });
  }

  /** @internal */
  constructor(type: 'addstream' | 'removestream', stream: MediaStream) {
    super(type);
    this.#stream = stream;
  }

  get stream(): MediaStream {
    return this.#stream;
  }

  get [Symbol.toStringTag](): string {
    return 'MediaStreamEvent';
  }
}

export interface MediaStreamEventMap {
  addtrack: MediaStreamTrackEvent;
  removetrack: MediaStreamTrackEvent;
}

/** wrtc's nonstandard `new MediaStream({id})`. */
export interface MediaStreamInit {
  id?: string;
}

let addRemote: (stream: MediaStream, track: MediaStreamTrack) => void;
let removeRemote: (stream: MediaStream, track: MediaStreamTrack) => void;
let isStream: (value: object) => boolean;

/**
 * A set of tracks. Constructible as in the spec (empty, from a stream's
 * tracks, or from a track list) and as in wrtc, `new MediaStream({id})`.
 *
 * Remote streams (a `track` event's `streams`) are one object per stream id
 * per peer connection; they gain and lose tracks as descriptions are
 * applied, firing `addtrack` and `removetrack`. Calling addTrack() or
 * removeTrack() yourself fires nothing (the spec).
 */
export class MediaStream extends EventTarget {
  #id: string;
  #tracks = new Set<MediaStreamTrack>();

  static {
    isStream = (value) => #tracks in value;
    registerInterface('MediaStream', isStream);
    addRemote = (stream, track) => {
      if (stream.#tracks.has(track)) return;
      stream.#tracks.add(track);
      stream.dispatchEvent(new MediaStreamTrackEvent('addtrack', { track }));
    };
    removeRemote = (stream, track) => {
      if (!stream.#tracks.delete(track)) return;
      stream.dispatchEvent(new MediaStreamTrackEvent('removetrack', { track }));
    };
  }

  constructor(streamOrTracks?: MediaStream | readonly MediaStreamTrackLike[] | MediaStreamInit) {
    super();
    this.#id = randomUUID();
    const context = "Failed to construct 'MediaStream': parameter 1";
    if (streamOrTracks === undefined) return;
    if (!isObject(streamOrTracks)) throw new TypeError(`${context} is not an object`);
    if (isStream(streamOrTracks)) {
      for (const track of (streamOrTracks as MediaStream).#tracks) this.#tracks.add(track);
      return;
    }
    const method = getIteratorMethod(streamOrTracks);
    if (method) {
      for (const track of toTracks.fromMethod(streamOrTracks, method, context)) {
        this.#tracks.add(track);
      }
      return;
    }
    const { id } = streamOrTracks as MediaStreamInit;
    if (id !== undefined) this.#id = String(id);
  }

  get [Symbol.toStringTag](): string {
    return 'MediaStream';
  }

  addEventListener<K extends keyof MediaStreamEventMap>(
    type: K,
    listener: Listener<MediaStream, MediaStreamEventMap[K]> | null,
    options?: AddListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: Listener<MediaStream, Event> | null,
    options?: AddListenerOptions,
  ): void;
  addEventListener(type: string, listener: unknown, options?: AddListenerOptions) {
    super.addEventListener(type, listener as AnyListener, options);
  }

  removeEventListener<K extends keyof MediaStreamEventMap>(
    type: K,
    listener: Listener<MediaStream, MediaStreamEventMap[K]> | null,
    options?: RemoveListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: Listener<MediaStream, Event> | null,
    options?: RemoveListenerOptions,
  ): void;
  removeEventListener(type: string, listener: unknown, options?: RemoveListenerOptions) {
    super.removeEventListener(type, listener as AnyListener, options);
  }

  get id(): string {
    return this.#id;
  }

  /** True while any track is live. */
  get active(): boolean {
    for (const track of this.#tracks) if (track.readyState === 'live') return true;
    return false;
  }

  /** Audio tracks, then video tracks (as libwebrtc and wrtc order them). */
  getTracks(): MediaStreamTrack[] {
    return [...this.getAudioTracks(), ...this.getVideoTracks()];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return [...this.#tracks].filter((track) => track.kind === 'audio');
  }

  getVideoTracks(): MediaStreamTrack[] {
    return [...this.#tracks].filter((track) => track.kind === 'video');
  }

  getTrackById(trackId: string): MediaStreamTrack | null {
    const id = String(trackId);
    for (const track of this.#tracks) if (track.id === id) return track;
    return null;
  }

  addTrack(track: MediaStreamTrackLike): void {
    this.#tracks.add(toTrack(track, "Failed to execute 'addTrack' on 'MediaStream': parameter 1"));
  }

  removeTrack(track: MediaStreamTrackLike): void {
    this.#tracks.delete(
      toTrack(track, "Failed to execute 'removeTrack' on 'MediaStream': parameter 1"),
    );
  }

  /** A new stream, with a new id, holding a clone of every track. */
  clone(): MediaStream {
    return new MediaStream([...this.#tracks].map((track) => track.clone()));
  }

  get onaddtrack(): AnyEventHandler {
    return getEventHandler(this, 'addtrack') as AnyEventHandler;
  }

  set onaddtrack(value: EventHandler<MediaStreamTrackEvent>) {
    setEventHandler(this, 'addtrack', value);
  }

  get onremovetrack(): AnyEventHandler {
    return getEventHandler(this, 'removetrack') as AnyEventHandler;
  }

  set onremovetrack(value: EventHandler<MediaStreamTrackEvent>) {
    setEventHandler(this, 'removetrack', value);
  }
}

/** Internal: adds a received track to a remote stream, firing `addtrack`. */
export function addRemoteTrack(stream: MediaStream, track: MediaStreamTrack): void {
  addRemote(stream, track);
}

/** Internal: removes a received track from a remote stream, firing `removetrack`. */
export function removeRemoteTrack(stream: MediaStream, track: MediaStreamTrack): void {
  removeRemote(stream, track);
}
