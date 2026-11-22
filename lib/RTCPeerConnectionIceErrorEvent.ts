import {
  type RTCPeerConnectionIceErrorEventInit,
  toRTCPeerConnectionIceErrorEventInit,
} from './internal/generated/idl.ts';
import { registerInterface } from './internal/webidl.ts';

export type { RTCPeerConnectionIceErrorEventInit };

/**
 * The `icecandidateerror` event. Its fields are WebIDL attributes: getters
 * on the prototype, as in browsers (SPEC-LAYER-PLAN.md, "Events").
 * `errorCode` is libwebrtc's: a STUN error arrives without its class digit
 * (a 420 reads 20), and 701 means unreachable.
 */
export class RTCPeerConnectionIceErrorEvent extends Event {
  readonly #address: string | null;
  readonly #port: number | null;
  readonly #url: string;
  readonly #errorCode: number;
  readonly #errorText: string;

  static {
    registerInterface('RTCPeerConnectionIceErrorEvent', (value) => #errorCode in value);
  }

  constructor(type: string, eventInitDict: RTCPeerConnectionIceErrorEventInit) {
    const init = toRTCPeerConnectionIceErrorEventInit(
      eventInitDict,
      "Failed to construct 'RTCPeerConnectionIceErrorEvent': eventInitDict",
    );
    super(String(type), init);
    this.#address = init.address ?? null;
    this.#port = init.port ?? null;
    this.#url = init.url ?? '';
    this.#errorCode = init.errorCode;
    this.#errorText = init.errorText ?? '';
  }

  get address(): string | null {
    return this.#address;
  }

  get port(): number | null {
    return this.#port;
  }

  get url(): string {
    return this.#url;
  }

  get errorCode(): number {
    return this.#errorCode;
  }

  get errorText(): string {
    return this.#errorText;
  }

  get [Symbol.toStringTag](): string {
    return 'RTCPeerConnectionIceErrorEvent';
  }
}
