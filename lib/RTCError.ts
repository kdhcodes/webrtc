import { type RTCErrorDetailType, toRTCErrorInit } from './internal/generated/idl.ts';
import { registerInterface } from './internal/webidl.ts';

export type { RTCErrorDetailType };

export interface RTCErrorInit {
  errorDetail: RTCErrorDetailType;
  sdpLineNumber?: number;
  sctpCauseCode?: number;
  receivedAlert?: number;
  sentAlert?: number;
}

/**
 * The WebRTC-specific DOMException (always named 'OperationError'), e.g. for
 * SDP syntax errors, where `sdpLineNumber` says which line failed.
 */
export class RTCError extends DOMException {
  #errorDetail: RTCErrorDetailType;
  #sdpLineNumber: number | null;
  #sctpCauseCode: number | null;
  #receivedAlert: number | null;
  #sentAlert: number | null;

  static {
    registerInterface('RTCError', (value) => #errorDetail in value);
  }

  constructor(init: RTCErrorInit, message = '') {
    const dict = toRTCErrorInit(init, "Failed to construct 'RTCError': init");
    super(String(message), 'OperationError');
    this.#errorDetail = dict.errorDetail;
    this.#sdpLineNumber = dict.sdpLineNumber ?? null;
    this.#sctpCauseCode = dict.sctpCauseCode ?? null;
    this.#receivedAlert = dict.receivedAlert ?? null;
    this.#sentAlert = dict.sentAlert ?? null;
  }

  get [Symbol.toStringTag](): string {
    return 'RTCError';
  }

  get errorDetail(): RTCErrorDetailType {
    return this.#errorDetail;
  }

  get sdpLineNumber(): number | null {
    return this.#sdpLineNumber;
  }

  get sctpCauseCode(): number | null {
    return this.#sctpCauseCode;
  }

  get receivedAlert(): number | null {
    return this.#receivedAlert;
  }

  get sentAlert(): number | null {
    return this.#sentAlert;
  }
}
