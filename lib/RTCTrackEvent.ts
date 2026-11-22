import { type EventInit, toRTCTrackEventInit } from './internal/generated/idl.ts';
import { registerInterface } from './internal/webidl.ts';
import type { MediaStream } from './MediaStream.ts';
import type { MediaStreamTrack } from './MediaStreamTrack.ts';
import type { RTCRtpReceiver } from './RTCRtpReceiver.ts';
import type { RTCRtpTransceiver } from './RTCRtpTransceiver.ts';

export interface RTCTrackEventInit extends EventInit {
  receiver: RTCRtpReceiver;
  track: MediaStreamTrack;
  streams?: MediaStream[];
  transceiver: RTCRtpTransceiver;
}

/**
 * The `track` event. `receiver`, `track`, `streams` and `transceiver` are
 * WebIDL attributes: getters on the prototype, as in browsers (wrtc's
 * event is a plain object with them as own properties; SPEC-LAYER-PLAN.md,
 * "Events"). `streams` is a frozen array, the same object on every read
 * ([SameObject]). A remote stream id maps to the same MediaStream object on
 * its peer connection while that object is reachable (see #remoteStreams).
 */
export class RTCTrackEvent extends Event {
  readonly #receiver: RTCRtpReceiver;
  readonly #track: MediaStreamTrack;
  readonly #streams: readonly MediaStream[];
  readonly #transceiver: RTCRtpTransceiver;

  static {
    registerInterface('RTCTrackEvent', (value) => #track in value);
  }

  constructor(type: string, eventInitDict: RTCTrackEventInit) {
    const init = toRTCTrackEventInit(
      eventInitDict,
      "Failed to construct 'RTCTrackEvent': eventInitDict",
    );
    super(String(type), init);
    this.#receiver = init.receiver as RTCRtpReceiver;
    this.#track = init.track as MediaStreamTrack;
    this.#streams = Object.freeze([...((init.streams ?? []) as MediaStream[])]);
    this.#transceiver = init.transceiver as RTCRtpTransceiver;
  }

  get receiver(): RTCRtpReceiver {
    return this.#receiver;
  }

  get track(): MediaStreamTrack {
    return this.#track;
  }

  get streams(): readonly MediaStream[] {
    return this.#streams;
  }

  get transceiver(): RTCRtpTransceiver {
    return this.#transceiver;
  }

  get [Symbol.toStringTag](): string {
    return 'RTCTrackEvent';
  }
}
