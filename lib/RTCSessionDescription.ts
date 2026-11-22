import {
  type RTCSdpType,
  type RTCSessionDescriptionInit,
  toRTCSessionDescriptionInit,
} from './internal/generated/idl.ts';
import { registerInterface } from './internal/webidl.ts';

export type { RTCSdpType, RTCSessionDescriptionInit };

/**
 * An SDP description. Unlike wrtc's, `type` and `sdp` are getters on the
 * prototype (the spec), so `{...desc}` is empty; `JSON.stringify(desc)` and
 * `desc.toJSON()` give `{type, sdp}` as in wrtc and browsers.
 */
export class RTCSessionDescription {
  #type: RTCSdpType;
  #sdp: string;

  static {
    registerInterface('RTCSessionDescription', (value) => #type in value);
  }

  constructor(descriptionInitDict: RTCSessionDescriptionInit) {
    const init = toRTCSessionDescriptionInit(
      descriptionInitDict,
      "Failed to construct 'RTCSessionDescription': descriptionInitDict",
    );
    this.#type = init.type;
    this.#sdp = init.sdp ?? '';
  }

  get [Symbol.toStringTag](): string {
    return 'RTCSessionDescription';
  }

  get type(): RTCSdpType {
    return this.#type;
  }

  get sdp(): string {
    return this.#sdp;
  }

  toJSON(): RTCSessionDescriptionInit {
    return { type: this.#type, sdp: this.#sdp };
  }
}
