import { fromNative } from './internal/errors.ts';
import { native } from './internal/native.ts';
import type {
  NativeCertificatePem,
  NativeGeneratedCertificate,
  NativeKeyParams,
} from './internal/native-types.ts';
import * as webidl from './internal/webidl.ts';

/** A WebCrypto algorithm: a name, or a dictionary with one. */
export type AlgorithmIdentifier = object | string;

export interface RTCDtlsFingerprint {
  algorithm?: string;
  value?: string;
}

/**
 * A certificate's shape. `RTCConfiguration.certificates` is typed with it so
 * code annotated with the DOM's RTCConfiguration (wrtc's types re-export
 * it) still compiles; at runtime it needs our RTCCertificate objects.
 */
export interface RTCCertificateLike {
  readonly expires: number;
  getFingerprints(): RTCDtlsFingerprint[];
}

const constructToken = Symbol('RTCCertificate');

let pemOf: (certificate: RTCCertificate) => NativeCertificatePem;

/**
 * A DTLS certificate and its private key, from
 * `RTCPeerConnection.generateCertificate()`, for
 * `RTCConfiguration.certificates`. Not constructible.
 *
 * The key stays in this object as PEM (a private field, never exposed); a
 * peer connection constructed with the certificate hands it to libwebrtc.
 * Not serializable: there are no workers or iframes to post it to here.
 */
export class RTCCertificate {
  #pem: NativeCertificatePem;
  #expires: number;
  #fingerprint: { algorithm: string; value: string };

  static {
    webidl.registerInterface('RTCCertificate', (value) => #pem in value);
    pemOf = (certificate) => certificate.#pem;
  }

  /** @internal */
  constructor(...args: unknown[]) {
    if (args[0] !== constructToken) {
      throw new TypeError("Failed to construct 'RTCCertificate': Illegal constructor");
    }
    const generated = args[1] as NativeGeneratedCertificate;
    this.#pem = { privateKey: generated.privateKey, certificate: generated.certificate };
    this.#expires = generated.expires;
    // RTCDtlsFingerprint's value is lower case (webrtc-pc, and Chrome);
    // the SDP's is upper case.
    this.#fingerprint = {
      algorithm: generated.fingerprint.algorithm,
      value: generated.fingerprint.value.toLowerCase(),
    };
  }

  get [Symbol.toStringTag](): string {
    return 'RTCCertificate';
  }

  /** When it stops being valid, in ms since the epoch (whole seconds). */
  get expires(): number {
    return this.#expires;
  }

  /**
   * Its fingerprint as libwebrtc writes it into SDP, the signature's digest
   * (sha-256): one, as in Chrome. A new array each call.
   */
  getFingerprints(): RTCDtlsFingerprint[] {
    return [{ ...this.#fingerprint }];
  }
}

/** The PEM a peer connection passes to libwebrtc. */
export function certificatePem(certificate: RTCCertificate): NativeCertificatePem {
  return { ...pemOf(certificate) };
}

const context = "Failed to execute 'generateCertificate' on 'RTCPeerConnection'";
const unsupportedParameters =
  'The 1st argument provided is an AlgorithmIdentifier with a supported algorithm name, but the parameters are not supported.';

function notSupported(message: string): DOMException {
  return new DOMException(`${context}: ${message}`, 'NotSupportedError');
}

/** WebCrypto's algorithm name, matched case-insensitively. */
function algorithmName(value: object, what: string, known: readonly string[]): string {
  const raw = (value as { name?: unknown }).name;
  if (raw === undefined) webidl.requiredMember(`${context}: ${what}`, 'name');
  const name = webidl.DOMString(raw, `${context}: ${what}.name`);
  const match = known.find((k) => k.toUpperCase() === name.toUpperCase());
  if (!match) throw notSupported(`${what}: Unrecognized name`);
  return match;
}

/** An AlgorithmIdentifier as a dictionary: a string is `{name}`. */
function algorithmDictionary(value: unknown, what: string): object {
  return webidl.isObject(value) ? value : { name: webidl.DOMString(value, `${context}: ${what}`) };
}

/** A BigInteger (big-endian Uint8Array) as a number, or null above 2^32 - 1. */
function bigIntegerToUint32(bytes: Uint8Array): number | null {
  let value = 0;
  for (const byte of bytes) {
    value = value * 256 + byte;
    if (value > 0xffffffff) return null;
  }
  return value;
}

/**
 * WebCrypto's normalization of a generateKey algorithm, as far as
 * generateCertificate needs it, then libwebrtc's subset of it (Chrome's
 * rules): ECDSA on P-256, and RSASSA-PKCS1-v1_5 with SHA-256 and int-sized
 * parameters. Throws TypeError for a malformed dictionary, NotSupportedError
 * for anything else unsupported. Other WebCrypto algorithms are
 * NotSupportedError without checking their parameters (Chrome checks them
 * first, so a malformed one is a TypeError there).
 */
function keyParams(keygenAlgorithm: unknown): {
  params: NativeKeyParams;
  expires: number | undefined;
} {
  const algorithm = algorithmDictionary(keygenAlgorithm, 'Algorithm');
  const name = algorithmName(algorithm, 'Algorithm', ['ECDSA', 'RSASSA-PKCS1-v1_5']);
  const fields = algorithm as Record<string, unknown>;
  let params: NativeKeyParams | null = null;
  if (name === 'ECDSA') {
    const what = `${context}: EcKeyGenParams`;
    if (fields.namedCurve === undefined) webidl.requiredMember(what, 'namedCurve');
    const curve = webidl.DOMString(fields.namedCurve, `${what}.namedCurve`);
    if (!['P-256', 'P-384', 'P-521'].includes(curve)) {
      throw notSupported('EcKeyGenParams: Unrecognized namedCurve');
    }
    if (curve === 'P-256') params = { type: 'ecdsa' };
  } else {
    const what = `${context}: RsaHashedKeyGenParams`;
    if (fields.modulusLength === undefined) webidl.requiredMember(what, 'modulusLength');
    const modulusLength = webidl.unsignedLong(fields.modulusLength, `${what}.modulusLength`, {
      enforceRange: true,
    });
    if (!(fields.publicExponent instanceof Uint8Array)) {
      throw new TypeError(`${what}.publicExponent: is not a Uint8Array`);
    }
    const publicExponent = bigIntegerToUint32(fields.publicExponent);
    if (fields.hash === undefined) webidl.requiredMember(what, 'hash');
    const hash = algorithmName(algorithmDictionary(fields.hash, 'hash'), 'RsaHashedKeyGenParams', [
      'SHA-1',
      'SHA-256',
      'SHA-384',
      'SHA-512',
    ]);
    if (
      publicExponent !== null &&
      publicExponent <= 0x7fffffff &&
      modulusLength <= 0x7fffffff &&
      hash === 'SHA-256'
    ) {
      params = { type: 'rsa', modulusLength, publicExponent };
    }
  }
  // Chrome reads `expires` after normalizing, and only takes a number
  // (webrtc-pc's RTCCertificateExpiration conversion would also take
  // anything ToNumber accepts); then [EnforceRange] unsigned long long.
  let expires: number | undefined;
  if (webidl.isObject(keygenAlgorithm) && 'expires' in keygenAlgorithm) {
    const value = (keygenAlgorithm as { expires: unknown }).expires;
    if (typeof value !== 'number') {
      throw new TypeError(`${context}: Invalid type for expires attribute.`);
    }
    expires = webidl.unsignedLongLong(value, `${context}: expires`, { enforceRange: true });
  }
  if (!params) throw notSupported(unsupportedParameters);
  return { params, expires };
}

/**
 * `RTCPeerConnection.generateCertificate()`: normalizes the algorithm, then
 * generates the key off the JS thread. Throws (the caller turns that into a
 * rejection) for invalid arguments.
 */
export async function generateCertificate(
  argumentCount: number,
  keygenAlgorithm: unknown,
): Promise<RTCCertificate> {
  webidl.requireArguments(argumentCount, 1, 'generateCertificate', 'RTCPeerConnection');
  const { params, expires } = keyParams(keygenAlgorithm);
  let generated: NativeGeneratedCertificate;
  try {
    generated = await native.generateCertificate(params, expires);
  } catch (error) {
    // INVALID_PARAMETER: KeyParams::IsValid() said no (an RSA modulus
    // outside 1024-8192, or an exponent below the modulus length).
    if ((error as { errorType?: unknown }).errorType === 'INVALID_PARAMETER') {
      throw notSupported(unsupportedParameters);
    }
    throw fromNative(error, { INTERNAL_ERROR: 'OperationError' });
  }
  return new RTCCertificate(constructToken, generated);
}

/** Whether `certificate` has expired at `now` (libwebrtc's HasExpired). */
export function hasExpired(certificate: RTCCertificate, now: number): boolean {
  return now >= certificate.expires;
}
