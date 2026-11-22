import { mustBe } from './internal/errors.ts';
import type {
  MediaDeviceKind,
  MediaStreamConstraints,
  MediaTrackSupportedConstraints,
} from './internal/generated/idl.ts';
import { shapeInterface } from './internal/interface-shape.ts';
import { type Feed, startAudioFeed, startVideoFeed } from './internal/synthetic-media.ts';
import { MediaStream } from './MediaStream.ts';
import { initDeviceTrack, type MediaStreamTrack, trackFromNative } from './MediaStreamTrack.ts';

export type { MediaDeviceKind, MediaStreamConstraints };

/** The one fake device of each kind; getUserMedia's tracks report the same ids. */
const devices = [
  {
    deviceId: 'FakeAudioDevice',
    kind: 'audioinput',
    label: 'Fake audio device',
    groupId: 'FakeDeviceGroup',
  },
  {
    deviceId: 'FakeVideoDevice',
    kind: 'videoinput',
    label: 'Fake video device',
    groupId: 'FakeDeviceGroup',
  },
] as const;

const constructToken = Symbol('MediaDeviceInfo');

/** A device enumerateDevices() lists. Not constructible, as in the spec. */
export class MediaDeviceInfo {
  #deviceId: string;
  #kind: MediaDeviceKind;
  #label: string;
  #groupId: string;

  /** @internal */
  constructor(...args: unknown[]) {
    if (args[0] !== constructToken) throw new TypeError('Illegal constructor');
    const device = args[1] as (typeof devices)[number];
    this.#deviceId = device.deviceId;
    this.#kind = device.kind;
    this.#label = device.label;
    this.#groupId = device.groupId;
  }

  get [Symbol.toStringTag](): string {
    return 'MediaDeviceInfo';
  }

  get deviceId(): string {
    return this.#deviceId;
  }

  get kind(): MediaDeviceKind {
    return this.#kind;
  }

  get label(): string {
    return this.#label;
  }

  get groupId(): string {
    return this.#groupId;
  }

  toJSON(): { deviceId: string; kind: MediaDeviceKind; label: string; groupId: string } {
    return {
      deviceId: this.#deviceId,
      kind: this.#kind,
      label: this.#label,
      groupId: this.#groupId,
    };
  }
}

/**
 * A track on a new synthetic source; the feed stops when it and its clones
 * have all ended or been collected. Only `feed.stop` may reach the callback:
 * the native track would keep the wrapper alive (MediaStreamTrack.ts).
 */
function deviceTrack({ track: native, stop }: Feed, label: string): MediaStreamTrack {
  const track = trackFromNative(native);
  initDeviceTrack(track, label, stop);
  return track;
}

/**
 * getUserMedia's body; throws where getUserMedia rejects. `api` names the
 * method in messages (getDisplayMedia shares this).
 */
function openDevices(constraints: unknown, api: string): MediaStream {
  // wrtc's checks: what throws, and as which type. A function counts as an
  // object.
  if (
    (typeof constraints !== 'object' || constraints === null) &&
    typeof constraints !== 'function'
  ) {
    throw new TypeError(
      mustBe(`${api}: constraints`, 'an object such as {audio: true, video: true}', constraints),
    );
  }
  const { audio, video } = constraints as MediaStreamConstraints;
  if (audio === undefined && video === undefined) {
    throw new TypeError(
      `${api}: constraints must ask for audio or video (e.g. {audio: true}), but neither ` +
        'constraints.audio nor constraints.video is set',
    );
  }
  // Any truthy value asks for a track and any falsy one doesn't, so
  // `{audio: false, video: false}` gives an empty stream (wrtc; the spec
  // would reject). Constraint objects are accepted and ignored, as in wrtc:
  // the tracks are always the fixed formats getSettings() reports.
  const tracks: MediaStreamTrack[] = [];
  if (audio) tracks.push(deviceTrack(startAudioFeed(), devices[0].label));
  if (video) tracks.push(deviceTrack(startVideoFeed(), devices[1].label));
  return new MediaStream(tracks);
}

/**
 * A stream from the fake devices: an audio track of 48 kHz mono silence
 * and a video track of still 640x480 colour bars at 30 fps, as requested.
 * wrtc's tracks carry no media; the rest (validation, settings) matches it.
 * Stop the tracks when done: the generator runs until every track on its
 * source (clones included) has ended. It never keeps the process alive.
 */
export function getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
  return requestDevices(constraints, 'getUserMedia');
}

function requestDevices(constraints: unknown, api: string): Promise<MediaStream> {
  try {
    return Promise.resolve(openDevices(constraints, api));
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * wrtc's `mediaDevices`. Its methods also work when called detached, as
 * Node code copies them onto a plain `navigator.mediaDevices` object.
 */
export class MediaDevices extends EventTarget {
  constructor() {
    super();
    // wrtc's MediaDevices (event-target-shim) tolerates its listener methods
    // being called detached, and Node code relies on it:
    // @whereby.com/assistant-sdk's polyfills copy `addEventListener` and
    // `removeEventListener` onto a plain `navigator.mediaDevices` object.
    // Node's EventTarget throws ERR_INVALID_THIS for that, so bind them to the
    // instance (which also makes the detached listeners actually register).
    // The device methods are bound too, so subclass overrides that use
    // `this` work detached as well.
    this.addEventListener = this.addEventListener.bind(this);
    this.removeEventListener = this.removeEventListener.bind(this);
    this.dispatchEvent = this.dispatchEvent.bind(this);
    this.getUserMedia = this.getUserMedia.bind(this);
    this.getDisplayMedia = this.getDisplayMedia.bind(this);
    this.enumerateDevices = this.enumerateDevices.bind(this);
    this.getSupportedConstraints = this.getSupportedConstraints.bind(this);
  }

  getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    return getUserMedia(constraints);
  }

  /**
   * Exactly getUserMedia, as in wrtc: the same validation, and the same fake
   * devices (`{audio: true}` gives an audio track, too).
   */
  getDisplayMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    return requestDevices(constraints, 'getDisplayMedia');
  }

  /** wrtc's answer, a fresh object each call. Neither honours these constraints. */
  getSupportedConstraints(): MediaTrackSupportedConstraints {
    return { width: true, height: true };
  }

  /**
   * The fake devices getUserMedia uses: one audio input and one video
   * input, with non-empty labels (Node has no permission prompt to hide
   * them behind). wrtc throws "Not yet implemented" synchronously.
   */
  enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return Promise.resolve(devices.map((device) => new MediaDeviceInfo(constructToken, device)));
  }
}

// The singleton binds the prototype's methods, so shape the class first
// (lib/index.ts would only do it after this module has run): the bound
// copies then have the IDL lengths, and getUserMedia rejects rather than
// throws, as the prototype's do.
shapeInterface(MediaDevices, 'MediaDevices');

export const mediaDevices: MediaDevices = new MediaDevices();
