import { type EventInit, toRTCPeerConnectionIceEventInit } from './internal/generated/idl.ts';
import { registerInterface } from './internal/webidl.ts';
import type { RTCIceCandidate } from './RTCIceCandidate.ts';

export interface RTCPeerConnectionIceEventInit extends EventInit {
  candidate?: RTCIceCandidate | null;
  url?: string | null;
}

/**
 * The `icecandidate` event. `candidate` and `url` are WebIDL attributes:
 * getters on the prototype, as in browsers, so `({candidate}) => ...`
 * works but spreading the event doesn't copy them (wrtc's event is a plain
 * object; SPEC-LAYER-PLAN.md, "Events").
 */
export class RTCPeerConnectionIceEvent extends Event {
  readonly #candidate: RTCIceCandidate | null;
  readonly #url: string | null;

  static {
    registerInterface('RTCPeerConnectionIceEvent', (value) => #candidate in value);
  }

  // A rest parameter so that a missing `type` can be told from `undefined`.
  constructor(...args: [type: string, eventInitDict?: RTCPeerConnectionIceEventInit]) {
    if ((args as unknown[]).length === 0) {
      throw new TypeError(
        "Failed to construct 'RTCPeerConnectionIceEvent': 1 argument required, but only 0 present.",
      );
    }
    const [type, eventInitDict = {}] = args;
    const init = toRTCPeerConnectionIceEventInit(
      eventInitDict,
      "Failed to construct 'RTCPeerConnectionIceEvent': eventInitDict",
    );
    super(String(type), init);
    this.#candidate = (init.candidate as RTCIceCandidate | null | undefined) ?? null;
    this.#url = init.url ?? null;
  }

  get candidate(): RTCIceCandidate | null {
    return this.#candidate;
  }

  get url(): string | null {
    return this.#url;
  }

  get [Symbol.toStringTag](): string {
    return 'RTCPeerConnectionIceEvent';
  }
}
