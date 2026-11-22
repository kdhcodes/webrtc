/**
 * Turning failures into the exceptions the spec names. Native code reports
 * every runtime failure as a `NativeError` with libwebrtc's `errorType`
 * (native-types.ts); which DOMException that becomes depends on the spec
 * step that failed, so callers pass overrides for their step.
 */
import { RTCError, type RTCErrorDetailType } from '../RTCError.ts';
import type { NativeError, NativeErrorInfo, NativeErrorType } from './native-types.ts';

// Not an import, for import time (see lib/internal/addon-path.ts).
const { isProxy } = process.getBuiltinModule('node:util/types');

export type ErrorName =
  | 'InvalidStateError'
  | 'InvalidAccessError'
  | 'InvalidModificationError'
  | 'OperationError'
  | 'SyntaxError'
  | 'NotSupportedError'
  | 'RangeError'
  | 'TypeError';

/** An exception by its spec name: a DOMException, or a RangeError/TypeError. */
export function domError(name: ErrorName, message: string): Error {
  if (name === 'RangeError') return new RangeError(message);
  if (name === 'TypeError') return new TypeError(message);
  return new DOMException(message, name);
}

export function invalidStateError(message: string): DOMException {
  return new DOMException(message, 'InvalidStateError');
}

/** The error every method that the spec guards with [[IsClosed]] throws. */
export function closedError(what: string): DOMException {
  return invalidStateError(
    `Failed to execute '${what}' on 'RTCPeerConnection': The RTCPeerConnection is closed.`,
  );
}

export function isNativeError(error: unknown): error is NativeError {
  return error instanceof Error && typeof (error as NativeError).errorType === 'string';
}

const defaults: Record<NativeErrorType, ErrorName> = {
  UNSUPPORTED_OPERATION: 'OperationError',
  UNSUPPORTED_PARAMETER: 'OperationError',
  INVALID_PARAMETER: 'InvalidAccessError',
  INVALID_RANGE: 'RangeError',
  SYNTAX_ERROR: 'SyntaxError',
  INVALID_STATE: 'InvalidStateError',
  INVALID_MODIFICATION: 'InvalidModificationError',
  NETWORK_ERROR: 'OperationError',
  RESOURCE_EXHAUSTED: 'OperationError',
  INTERNAL_ERROR: 'OperationError',
  OPERATION_ERROR_WITH_DATA: 'OperationError',
};

/**
 * The spec exception for a native failure, keeping libwebrtc's message.
 * `overrides` maps the error types whose meaning differs at this step.
 * Anything that isn't a NativeError (a TypeError from native code means a
 * JS-layer bug) is returned unchanged.
 */
export function fromNative(
  error: unknown,
  overrides: Partial<Record<NativeErrorType, ErrorName>> = {},
): unknown {
  if (!isNativeError(error)) return error;
  return domError(overrides[error.errorType] ?? defaults[error.errorType], error.message);
}

const errorDetails: Record<string, RTCErrorDetailType> = {
  DATA_CHANNEL_FAILURE: 'data-channel-failure',
  DTLS_FAILURE: 'dtls-failure',
  FINGERPRINT_FAILURE: 'fingerprint-failure',
  SCTP_FAILURE: 'sctp-failure',
  SDP_SYNTAX_ERROR: 'sdp-syntax-error',
  HARDWARE_ENCODER_NOT_AVAILABLE: 'hardware-encoder-not-available',
  HARDWARE_ENCODER_ERROR: 'hardware-encoder-error',
};

/**
 * The RTCError for an error a native event reported (an abruptly closed
 * data channel, a DTLS failure), with `fallback` as its errorDetail when
 * libwebrtc gave none.
 */
export function rtcErrorFromInfo(info: NativeErrorInfo, fallback: RTCErrorDetailType): RTCError {
  const errorDetail = (info.errorDetail && errorDetails[info.errorDetail]) || fallback;
  return new RTCError(
    {
      errorDetail,
      ...(info.sctpCauseCode === null ? {} : { sctpCauseCode: info.sctpCauseCode }),
    },
    info.message,
  );
}

/**
 * For setLocalDescription / setRemoteDescription ("set the session
 * description"): a parse failure is an RTCError with errorDetail
 * 'sdp-syntax-error' and the 1-based number of the offending line (except
 * semanticParseFailure); invalid content is InvalidAccessError; a
 * description invalid for the signaling state is InvalidStateError;
 * everything else OperationError.
 */
export function fromNativeDescriptionError(error: unknown, sdp: string): unknown {
  if (!isNativeError(error)) return error;
  if (error.errorType === 'SYNTAX_ERROR' && semanticParseFailure.test(error.message)) {
    return new DOMException(error.message, 'OperationError');
  }
  if (error.errorType === 'SYNTAX_ERROR') {
    return new RTCError(
      { errorDetail: 'sdp-syntax-error', ...lineNumberOf(sdp, error.sdpLine, error.message) },
      error.message,
    );
  }
  return fromNative(error, {
    INVALID_PARAMETER: 'InvalidAccessError',
    INVALID_RANGE: 'InvalidAccessError',
    UNSUPPORTED_PARAMETER: 'InvalidAccessError',
  });
}

/**
 * Failures libwebrtc's SDP parser reports that aren't syntax errors (the
 * spec's sdp-syntax-error excludes semantics), so "all other errors":
 * OperationError. A duplicate msid (RFC 8830) is a description-wide check;
 * WPT RTCPeerConnection-setRemoteDescription-offer.html expects this.
 */
const semanticParseFailure = /Duplicate a=msid lines detected/;

/**
 * The 1-based number of the line libwebrtc rejected. libwebrtc reports the
 * line's text, not where it is, so a line that occurs more than once is
 * ambiguous. libwebrtc stops at the first failure: a line that is invalid
 * in itself fails at its first occurrence, but one rejected for repeating
 * ("Multiple Simulcast attributes specified.") fails at the first repeat
 * within one section (the session part or an m-section).
 */
function lineNumberOf(
  sdp: string,
  line: string | undefined,
  message: string,
): { sdpLineNumber?: number } {
  if (line === undefined) return {};
  const lines = sdp.split(/\r?\n/);
  const at = lines.flatMap((l, i) => (l === line ? [i] : []));
  const [first] = at;
  if (first === undefined) return {};
  if (at.length > 1 && /multiple|duplicate/i.test(message)) {
    const sectionStart = (i: number) => lines.findLastIndex((l, j) => j <= i && l.startsWith('m='));
    const repeat = at.find(
      (i, n) => n > 0 && sectionStart(at[n - 1] as number) === sectionStart(i),
    );
    if (repeat !== undefined) return { sdpLineNumber: repeat + 1 };
  }
  return { sdpLineNumber: first + 1 };
}

// --- Messages ---------------------------------------------------------------
// Our messages say what was expected and what was given, starting with the
// API: "RTCAudioSource.onData: data.sampleRate must be a number from 0 to
// 65535, not the string "48000"". Frame sizes are written 640x480;
// arithmetic uses × ("480 frames × 2 channels × 2 bytes").

/**
 * "a <noun>" or "an <noun>". A leading U said "you" takes "a": "a
 * Uint8Array", "a URL", "a user", but "an undefined".
 */
export function article(noun: string): string {
  const you = /^U[A-Z]/.test(noun) || /^u(?:int|nif|niq|s[aeiu]|tf)/i.test(noun);
  return /^[aeiou]/i.test(noun) && !you ? `an ${noun}` : `a ${noun}`;
}

/** Long strings, BigInts and names are cut to this many characters. */
const MAX_SHOWN = 40;
const shorten = (text: string): string =>
  text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}...` : text;

/**
 * How `value` reads in a message: its type, or a primitive's value. Runs no
 * user code (no getters, no proxy traps) and never throws, so building a
 * message can't change what a call reads or which error wins.
 */
export function describe(value: unknown): string {
  switch (typeof value) {
    case 'undefined':
    case 'boolean':
    case 'number':
      return String(value);
    case 'bigint':
      return `the BigInt ${shorten(String(value))}n`;
    case 'string':
      return `the string ${JSON.stringify(shorten(value))}`;
    case 'symbol':
      return 'a symbol';
    case 'function':
      return 'a function';
  }
  if (value === null) return 'null';
  try {
    // A proxy, even a revoked one, is just an object: Array.isArray and
    // getPrototypeOf would run its traps, or throw.
    if (isProxy(value)) return 'an object';
    if (Array.isArray(value)) return 'an array';
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === null || isProxy(proto)) return 'an object';
    const ctor: unknown = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
    if (typeof ctor !== 'function' || isProxy(ctor)) return 'an object';
    // Only an own data property: a static `name` getter is user code.
    const name: unknown = Object.getOwnPropertyDescriptor(ctor, 'name')?.value;
    if (typeof name !== 'string' || name === '' || name === 'Object') return 'an object';
    return article(shorten(name));
  } catch {
    return 'an object';
  }
}

/**
 * "<name> must be <expected>, not <value>", or "<name> is missing" for
 * undefined. `name` starts with the API, e.g. "RTCAudioSource.onData: data".
 */
export function mustBe(name: string, expected: string, value: unknown): string {
  return value === undefined
    ? `${name} is missing: it must be ${expected}`
    : `${name} must be ${expected}, not ${describe(value)}`;
}
