import { registerInterface } from './internal/webidl.ts';
import type { RTCIceCandidate } from './RTCIceCandidate.ts';

const constructToken = Symbol('RTCIceCandidatePair');

/**
 * An ICE transport's selected candidate pair
 * (`RTCIceTransport.getSelectedCandidatePair()`). An interface, as webrtc-pc
 * now defines it (Chrome still returns a plain dictionary). Not
 * constructible.
 */
export class RTCIceCandidatePair {
  #local: RTCIceCandidate;
  #remote: RTCIceCandidate;

  static {
    registerInterface('RTCIceCandidatePair', (value) => #local in value);
  }

  /** @internal */
  constructor(...args: unknown[]) {
    if (args[0] !== constructToken) throw new TypeError('Illegal constructor');
    this.#local = args[1] as RTCIceCandidate;
    this.#remote = args[2] as RTCIceCandidate;
  }

  get [Symbol.toStringTag](): string {
    return 'RTCIceCandidatePair';
  }

  get local(): RTCIceCandidate {
    return this.#local;
  }

  get remote(): RTCIceCandidate {
    return this.#remote;
  }
}

export function createIceCandidatePair(
  local: RTCIceCandidate,
  remote: RTCIceCandidate,
): RTCIceCandidatePair {
  return new RTCIceCandidatePair(constructToken, local, remote);
}
