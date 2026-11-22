import { type EventInit, toRTCErrorEventInit } from './internal/generated/idl.ts';
import { registerInterface } from './internal/webidl.ts';
import type { RTCError } from './RTCError.ts';

export interface RTCErrorEventInit extends EventInit {
  error: RTCError;
}

/**
 * The `error` event of an RTCDataChannel or RTCDtlsTransport. `error` is a
 * WebIDL attribute: a getter on the prototype, as in browsers
 * (SPEC-LAYER-PLAN.md, "Events").
 */
export class RTCErrorEvent extends Event {
  readonly #error: RTCError;

  static {
    registerInterface('RTCErrorEvent', (value) => #error in value);
  }

  constructor(type: string, eventInitDict: RTCErrorEventInit) {
    const init = toRTCErrorEventInit(
      eventInitDict,
      "Failed to construct 'RTCErrorEvent': eventInitDict",
    );
    super(String(type), init);
    this.#error = init.error as RTCError;
  }

  get error(): RTCError {
    return this.#error;
  }

  get [Symbol.toStringTag](): string {
    return 'RTCErrorEvent';
  }
}
