import { isBlockedCandidate, withoutBlockedCandidates } from './internal/blocked-ports.ts';
import {
  closedError,
  domError,
  type ErrorName,
  fromNative,
  fromNativeDescriptionError,
  invalidStateError,
  isNativeError,
} from './internal/errors.ts';
import {
  type AddListenerOptions,
  type AnyEventHandler,
  type AnyListener,
  type EventHandler,
  getEventHandler,
  type Listener,
  type RemoveListenerOptions,
  setEventHandler,
} from './internal/events.ts';
import { fixBundledExtmapCollisions, isExtmapCollision } from './internal/extmap-fix.ts';
import {
  type RTCRtpTransceiverInit as GeneratedTransceiverInit,
  type RTCAnswerOptions,
  type RTCBundlePolicy,
  type RTCIceConnectionState,
  type RTCIceGatheringState,
  type RTCIceServer,
  type RTCIceTransportPolicy,
  type RTCLocalSessionDescriptionInit,
  type RTCOfferOptions,
  type RTCPeerConnectionState,
  type RTCPortRange,
  type RTCRtcpMuxPolicy,
  type RTCRtpEncodingParameters,
  type RTCSdpSemantics,
  type RTCSdpType,
  type RTCSignalingState,
  toRTCAnswerOptions,
  toRTCConfiguration,
  toRTCDataChannelInit,
  toRTCIceCandidateInit,
  toRTCLocalSessionDescriptionInit,
  toRTCOfferOptions,
  toRTCRtpTransceiverInit,
  toRTCSessionDescriptionInit,
} from './internal/generated/idl.ts';
import { native } from './internal/native.ts';
import { nativeTask } from './internal/native-tasks.ts';
import type {
  NativeConfiguration,
  NativeDataChannel,
  NativeDataChannelInit,
  NativeDescriptionSnapshot,
  NativeErrorType,
  NativeIceCandidate,
  NativeIceGatheringState,
  NativeOfferOptions,
  NativePcEvent,
  NativePeerConnection,
  NativeReceiver,
  NativeSessionDescription,
  NativeTransceiver,
  NativeTransceiverState,
} from './internal/native-types.ts';
import { OperationsChain } from './internal/ops-chain.ts';
import type { RtpOwner } from './internal/rtp-state.ts';
import {
  appendToSections,
  type MediaSection,
  parseSdp,
  sctpSection,
  transportSections,
} from './internal/sdp.ts';
import { chromeIceConnectionState, Transports } from './internal/transports.ts';
import { DOMString, interfaceType, registerInterface, USVString } from './internal/webidl.ts';
import { addRemoteTrack, MediaStream, MediaStreamEvent, removeRemoteTrack } from './MediaStream.ts';
import {
  type MediaStreamTrack,
  type MediaStreamTrackLike,
  markTrackEnded,
  nativeTrackOf,
  setTrackMuted,
} from './MediaStreamTrack.ts';
import {
  type AlgorithmIdentifier,
  certificatePem,
  generateCertificate,
  hasExpired,
  type RTCCertificate,
  type RTCCertificateLike,
} from './RTCCertificate.ts';
import {
  channelEvents,
  type DataChannelOwner,
  dataChannelFromNative,
  type RTCDataChannel,
  type RTCDataChannelInit,
  remoteChannelSettings,
} from './RTCDataChannel.ts';
import { RTCDataChannelEvent } from './RTCDataChannelEvent.ts';
import type { RTCDtlsTransport } from './RTCDtlsTransport.ts';
import { parseCandidate, RTCIceCandidate, type RTCIceCandidateInit } from './RTCIceCandidate.ts';
import { RTCPeerConnectionIceErrorEvent } from './RTCPeerConnectionIceErrorEvent.ts';
import { RTCPeerConnectionIceEvent } from './RTCPeerConnectionIceEvent.ts';
import { nativeReceiverOf, type RTCRtpReceiver, wrappedReceiver } from './RTCRtpReceiver.ts';
import {
  type MediaStreamLike,
  type RTCRtpSender,
  type RTCRtpSenderLike,
  senderStateOf,
} from './RTCRtpSender.ts';
import {
  type RTCRtpTransceiver,
  transceiverFromNative,
  transceiverStateOf,
} from './RTCRtpTransceiver.ts';
import {
  createSctpTransport,
  type RTCSctpTransport,
  updateSctpTransport,
} from './RTCSctpTransport.ts';
import { RTCSessionDescription, type RTCSessionDescriptionInit } from './RTCSessionDescription.ts';
import { type RTCStatsReport, statsReportFromJson } from './RTCStatsReport.ts';
import { RTCTrackEvent } from './RTCTrackEvent.ts';

export type {
  RTCAnswerOptions,
  RTCBundlePolicy,
  RTCIceConnectionState,
  RTCIceGatheringState,
  RTCIceServer,
  RTCIceTransportPolicy,
  RTCLocalSessionDescriptionInit,
  RTCOfferOptions,
  RTCPeerConnectionState,
  RTCPortRange,
  RTCRtcpMuxPolicy,
  RTCRtpEncodingParameters,
  RTCSdpSemantics,
  RTCSignalingState,
};

/**
 * What the constructor and setConfiguration() take. `portRange` and
 * `sdpSemantics` are wrtc's nonstandard members.
 */
export interface RTCConfiguration {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  bundlePolicy?: RTCBundlePolicy;
  rtcpMuxPolicy?: RTCRtcpMuxPolicy;
  iceCandidatePoolSize?: number;
  /**
   * From RTCPeerConnection.generateCertificate(). libwebrtc uses only the
   * first (as in Chrome). Without any, one is generated per connection.
   */
  certificates?: RTCCertificateLike[];
  /** Nonstandard (wrtc): the host ports ICE gathers on, `min <= max`. */
  portRange?: RTCPortRange;
  /** Nonstandard (wrtc). Only 'unified-plan' exists. */
  sdpSemantics?: RTCSdpSemantics;
}

/** What getConfiguration() returns: every member, with defaults filled in. */
export interface RTCConfigurationResult {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
  bundlePolicy: RTCBundlePolicy;
  rtcpMuxPolicy: RTCRtcpMuxPolicy;
  iceCandidatePoolSize: number;
  /** The ones it was constructed with (the same objects), else empty. */
  certificates: RTCCertificate[];
  portRange: RTCPortRange;
  sdpSemantics: RTCSdpSemantics;
}

export interface RTCRtpTransceiverInit {
  direction?: GeneratedTransceiverInit['direction'];
  streams?: MediaStreamLike[];
  sendEncodings?: RTCRtpEncodingParameters[];
}

export interface RTCPeerConnectionEventMap {
  connectionstatechange: Event;
  datachannel: RTCDataChannelEvent;
  icecandidate: RTCPeerConnectionIceEvent;
  icecandidateerror: RTCPeerConnectionIceErrorEvent;
  iceconnectionstatechange: Event;
  icegatheringstatechange: Event;
  negotiationneeded: Event;
  signalingstatechange: Event;
  track: RTCTrackEvent;
  /**
   * Legacy, fired as Chrome still fires it: a remote stream appeared. Only
   * for addEventListener: there is no `onaddstream` (webrtc-pc's historical
   * list says it must not exist; wrtc has none either).
   */
  addstream: MediaStreamEvent;
  /** Legacy, as `addstream`: a remote stream went away. No `onremovestream`. */
  removestream: MediaStreamEvent;
}

export type RTCSessionDescriptionCallback = (description: RTCSessionDescriptionInit) => void;
export type RTCPeerConnectionErrorCallback = (error: DOMException) => void;

type StoredConfiguration = RTCConfigurationResult;

const toTrack = interfaceType('MediaStreamTrack') as (v: unknown, c: string) => MediaStreamTrack;
const toStream = interfaceType('MediaStream') as (v: unknown, c: string) => MediaStream;
const toSender = interfaceType('RTCRtpSender') as (v: unknown, c: string) => RTCRtpSender;

/**
 * The most libwebrtc can send in one data channel message, the spec's
 * "canSendSize" (kSctpSendBufferSize; libwebrtc also offers it as
 * a=max-message-size).
 */
const SCTP_SEND_LIMIT = 262144;

/** Every failure of an operation the spec reports as OperationError. */
const operationErrors: Partial<Record<NativeErrorType, ErrorName>> = {
  INVALID_PARAMETER: 'OperationError',
  INVALID_RANGE: 'OperationError',
  INVALID_MODIFICATION: 'OperationError',
  SYNTAX_ERROR: 'OperationError',
};

/**
 * The signaling states each description type may be applied in (JSEP). A
 * rollback undoes that side's own offer: a local one only in
 * have-local-offer, a remote one only in have-remote-offer (libwebrtc
 * would accept either in both states; Chrome and WPT reject the other).
 */
const validStates: Record<'local' | 'remote', Record<RTCSdpType, RTCSignalingState[]>> = {
  local: {
    offer: ['stable', 'have-local-offer'],
    answer: ['have-remote-offer', 'have-local-pranswer'],
    pranswer: ['have-remote-offer', 'have-local-pranswer'],
    rollback: ['have-local-offer'],
  },
  remote: {
    // In have-local-offer, an offer is an implicit rollback first.
    offer: ['stable', 'have-remote-offer', 'have-local-offer'],
    answer: ['have-local-offer', 'have-remote-pranswer'],
    pranswer: ['have-local-offer', 'have-remote-pranswer'],
    rollback: ['have-remote-offer'],
  },
};

function context(method: string): string {
  return `Failed to execute '${method}' on 'RTCPeerConnection'`;
}

const iceSchemes = new Set(['stun:', 'stuns:', 'turn:', 'turns:']);

/**
 * Whether a STUN/TURN URL's path is RFC 7064/7065's `host [":" port]`:
 * a non-empty host, IPv6 in brackets (a zone id is allowed), and an
 * optional port up to 65535, with no userinfo or path. Only the shape is
 * checked, not the host itself: as a wrtc drop-in this rejects only what
 * WPT's RTCConfiguration-iceServers requires, so names libwebrtc accepts
 * (`host.123`, `256.1.1.1`, `[fe80::1%en0]`) still pass.
 */
function isHostAndPort(path: string): boolean {
  const match = /^(?:\[([^\]]*)\]|([^:[\]]*))(?::(\d+))?$/.exec(path);
  if (!match) return false;
  const [, ipv6, name, port] = match;
  if (port !== undefined && Number(port) > 65535) return false;
  if (ipv6 !== undefined) return /^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(%.+)?$/.test(ipv6);
  return name !== '' && !/[/\\@]/.test(name ?? '');
}

/** The spec's ICE server validation ("set a configuration", step 4). */
function validateIceServers(servers: RTCIceServer[], ctx: string): void {
  for (const [i, server] of servers.entries()) {
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (urls.length === 0) {
      throw new DOMException(`${ctx}: iceServers[${i}].urls is empty.`, 'SyntaxError');
    }
    for (const url of urls) {
      const parsed = URL.parse(url);
      const bad = (why: string) =>
        new DOMException(`${ctx}: '${url}' is not a valid ICE server URL: ${why}.`, 'SyntaxError');
      if (!parsed) throw bad('it does not parse');
      if (!iceSchemes.has(parsed.protocol))
        throw bad('the scheme must be stun, stuns, turn or turns');
      if (parsed.host !== '' || parsed.pathname.startsWith('/'))
        throw bad('it must have no authority');
      if (parsed.hash !== '') throw bad('it must have no fragment');
      if (!isHostAndPort(parsed.pathname)) throw bad('it must be scheme:host[:port]');
      const turn = parsed.protocol === 'turn:' || parsed.protocol === 'turns:';
      if (parsed.search !== '') {
        if (!turn) throw bad('a stun URL must have no query');
        if (parsed.search !== '?transport=udp' && parsed.search !== '?transport=tcp') {
          throw bad("the query must be 'transport=udp' or 'transport=tcp'");
        }
      }
      if (turn && (server.username === undefined || server.credential === undefined)) {
        throw new DOMException(
          `${ctx}: '${url}' needs both a username and a credential.`,
          'InvalidAccessError',
        );
      }
    }
  }
}

/**
 * The WebIDL conversion of a configuration, plus wrtc's portRange check
 * (both TypeErrors). The ICE servers are validated separately, after the
 * checks setConfiguration() makes first.
 */
function convertConfiguration(value: unknown, ctx: string): StoredConfiguration {
  const config = toRTCConfiguration(value, `${ctx}: configuration`);
  const portRange = config.portRange ?? {};
  // wrtc's check (a TypeError); min == max is allowed.
  const [min, max] = [portRange.min ?? 0, portRange.max ?? 65535];
  if (min > max) {
    throw new TypeError(
      `${ctx}: configuration.portRange.min (${min}) must not be greater than ` +
        `portRange.max (${max})`,
    );
  }
  return {
    iceServers: config.iceServers ?? [],
    iceTransportPolicy: config.iceTransportPolicy ?? 'all',
    bundlePolicy: config.bundlePolicy ?? 'balanced',
    rtcpMuxPolicy: config.rtcpMuxPolicy ?? 'require',
    iceCandidatePoolSize: config.iceCandidatePoolSize ?? 0,
    certificates: (config.certificates ?? []) as RTCCertificate[],
    portRange,
    sdpSemantics: config.sdpSemantics ?? 'unified-plan',
  };
}

/**
 * Whether two configurations' certificates are the same objects in the same
 * order. Chrome compares the same way (libwebrtc compares its certificate
 * pointers), so a reordered, partial or missing list is a change.
 */
function sameCertificates(a: readonly RTCCertificate[], b: readonly RTCCertificate[]): boolean {
  return a.length === b.length && a.every((certificate, i) => certificate === b[i]);
}

/**
 * The configuration libwebrtc gets. Certificates only at construction:
 * libwebrtc can't change them later, and setConfiguration() checks they
 * didn't. With none, libwebrtc generates its own default certificate, as it
 * always has.
 */
function toNativeConfiguration(
  config: StoredConfiguration,
  construction: boolean,
): NativeConfiguration {
  return {
    ...(construction && config.certificates.length > 0
      ? { certificates: config.certificates.map(certificatePem) }
      : {}),
    iceServers: config.iceServers.map((server) => ({
      urls: server.urls,
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential }),
    })),
    iceTransportPolicy: config.iceTransportPolicy,
    bundlePolicy: config.bundlePolicy,
    rtcpMuxPolicy: config.rtcpMuxPolicy,
    iceCandidatePoolSize: config.iceCandidatePoolSize,
    portRange: { ...config.portRange },
  };
}

/**
 * getConfiguration()'s copy. Each ICE server reads as Chrome's do: `urls`
 * always a list (the spec's "set a configuration" makes a string one), and
 * `username` and `credential` always present, '' when not given.
 */
function copyConfiguration(config: StoredConfiguration): RTCConfigurationResult {
  return {
    ...config,
    iceServers: config.iceServers.map((server) => ({
      urls: typeof server.urls === 'string' ? [server.urls] : [...server.urls],
      username: server.username ?? '',
      credential: server.credential ?? '',
    })),
    certificates: [...config.certificates],
    portRange: { ...config.portRange },
  };
}

/** Whether a [[FiredDirection]] includes receiving. */
function hasRecv(direction: string | null): boolean {
  return direction === 'sendrecv' || direction === 'recvonly';
}

/**
 * Chrome's FingerprintMismatch(): whether `next` (a local description's SDP)
 * has a first `a=fingerprint` line that `last` (the last created offer or
 * answer, or '') doesn't. SDP without one is allowed: only createOffer() and
 * createAnswer() can produce a valid fingerprint.
 */
function fingerprintChanged(last: string, next: string): boolean {
  const first = (sdp: string) => /^a=fingerprint:([^\r\n]*)/m.exec(sdp)?.[1];
  const fingerprint = first(next);
  return fingerprint !== undefined && fingerprint !== first(last);
}

/** A media section's identity across descriptions: its mid, else its m-line index. */
function sectionKey(section: MediaSection): string {
  return section.mid ?? `#${section.index}`;
}

/** Reuses a cached description object when the snapshot's is the same. */
function description(
  value: NativeSessionDescription | null,
  ...cached: (RTCSessionDescription | null)[]
): RTCSessionDescription | null {
  if (value === null) return null;
  for (const c of cached) if (c && c.type === value.type && c.sdp === value.sdp) return c;
  return new RTCSessionDescription(value);
}

/**
 * WebIDL's conversion of a legacy overload's success and failure callbacks:
 * anything not callable is a TypeError.
 */
function toCallbacks(
  method: string,
  first: number,
  success: unknown,
  failure: unknown,
): [(value?: unknown) => void, (error: DOMException) => void] {
  for (const [i, callback] of [success, failure].entries()) {
    if (typeof callback !== 'function') {
      throw new TypeError(
        `${context(method)}: The callback provided as parameter ${first + i} is not a function.`,
      );
    }
  }
  return [success, failure] as [(value?: unknown) => void, (error: DOMException) => void];
}

/**
 * A legacy callback overload (webrtc-pc "Legacy interface extensions"):
 * converts the callbacks, runs the promise-based method, calls back with
 * its outcome, and returns a promise for undefined. A callback that isn't
 * a function rejects the returned promise with a TypeError instead, as
 * WebIDL's conversion does.
 */
function legacy<T>(
  method: string,
  first: number,
  success: unknown,
  failure: unknown,
  run: () => Promise<T>,
): Promise<void> {
  let callbacks: ReturnType<typeof toCallbacks>;
  try {
    callbacks = toCallbacks(method, first, success, failure);
  } catch (error) {
    return Promise.reject(error);
  }
  const [onSuccess, onFailure] = callbacks;
  run().then(
    (value) => onSuccess(value),
    (error) => onFailure(error as DOMException),
  );
  return Promise.resolve();
}

/** Too few arguments for any overload (WebIDL overload resolution). */
function notEnoughArguments(method: string, required: number, given: number): Promise<never> {
  return Promise.reject(
    new TypeError(`${context(method)}: ${required} arguments required, but only ${given} present.`),
  );
}

/**
 * A WebRTC peer connection, on libwebrtc. Spec semantics with wrtc's
 * nonstandard configuration (`portRange`, `sdpSemantics`).
 *
 * - Operations (createOffer, createAnswer, setLocalDescription,
 *   setRemoteDescription, addIceCandidate, replaceTrack) run one at a time
 *   in call order. Checks against the current state happen when an
 *   operation starts, which is during the call when nothing else is queued.
 * - Every attribute is answered from the state at the last applied
 *   description (or event), never from a live libwebrtc read.
 * - Applying a description updates every attribute and then fires its
 *   events in spec order (signalingstatechange, remote stream changes,
 *   track) before the promise resolves.
 * - After close(), no event fires and operations still in flight never
 *   settle (the spec). getStats() keeps working. Receivers' tracks end (with `ended`).
 * - An open peer connection keeps the process alive (as in wrtc); close it.
 */
export class RTCPeerConnection extends EventTarget {
  #native: NativePeerConnection;
  // Held here: after close() the addon only holds the callback weakly.
  readonly #onEvent: (event: NativePcEvent) => void;
  readonly #owner: RtpOwner;
  readonly #chain: OperationsChain;
  #closed = false;
  #configuration: StoredConfiguration;

  #signalingState: RTCSignalingState = 'stable';
  #iceGatheringState: RTCIceGatheringState = 'new';
  #iceConnectionState: RTCIceConnectionState = 'new';
  #connectionState: RTCPeerConnectionState = 'new';
  #pendingLocal: RTCSessionDescription | null = null;
  #currentLocal: RTCSessionDescription | null = null;
  #pendingRemote: RTCSessionDescription | null = null;
  #currentRemote: RTCSessionDescription | null = null;

  /** The set of transceivers, in the order JS first saw them. */
  #transceivers: RTCRtpTransceiver[] = [];
  /** When each transceiver was first wrapped (see #applyTransceivers). */
  #createdAt = new WeakMap<RTCRtpTransceiver, number>();
  #epoch = 0;
  /**
   * Remote streams by id: one MediaStream per id on this connection while
   * it's reachable (a transceiver's associated streams or the app hold it).
   * Weak, so a long-lived connection doesn't keep every stream it has seen;
   * one created again after collection can't be told from the old one.
   */
  #remoteStreams = new Map<string, WeakRef<MediaStream>>();
  #collectedStreams = new FinalizationRegistry<string>((id) => {
    if (this.#remoteStreams.get(id)?.deref() === undefined) this.#remoteStreams.delete(id);
  });

  /** An SLD/SRD is in flight: its signaling and track events wait for it. */
  #describing = false;
  #buffered: NativePcEvent[] = [];
  /** The latest negotiationneeded id not fired yet. */
  #negotiationNeededId: number | undefined;
  /** Tasks queued in the native event order (#queueTask), by id. */
  #tasks = new Map<number, () => void>();
  #nextTask = 1;

  /**
   * Bumped by every change a new offer or answer would reflect. The spec's
   * [[LastCreatedOffer]] / [[LastCreatedAnswer]] are reused by an
   * empty-SDP setLocalDescription only while it "still accurately
   * represents" the system state, i.e. while this hasn't moved on.
   */
  #version = 0;
  #lastCreatedOffer: { sdp: string; version: number } | null = null;
  #lastCreatedAnswer: { sdp: string; version: number } | null = null;

  /** Transports (by mid) that produced candidates in this gathering round. */
  #gathering = new Map<string, { index: number; ufrag: string | null }>();
  /**
   * Media sections (by sectionKey) whose ICE generation, by ufrag (null:
   * any), has ended: local ones finished gathering, remote ones got an
   * end-of-candidates from addIceCandidate(). See #withEndOfCandidates.
   */
  #localEnded = new Map<string, string | null>();
  #remoteEnded = new Map<string, string | null>();

  /** [[DataChannels]] that aren't closed, by native key. */
  #channels = new Map<number, RTCDataChannel>();
  readonly #channelOwner: DataChannelOwner;
  #createdDataChannel = false;
  /** [[SctpTransport]]. */
  #sctp: RTCSctpTransport | null = null;
  /** The native key of the SCTP transport #sctp stands for. */
  #sctpKey: number | null = null;
  /** An answer has updated #sctp's maxMessageSize. */
  #sctpAnswered = false;
  /** The latest native SCTP state, which may precede #sctp. */
  #sctpInfo: Extract<NativePcEvent, { kind: 'sctp:state' }> | null = null;
  /**
   * [[LastStableStateSenderTransport]] and [[LastStableStateReceiverTransport]]
   * of each transceiver, as of the last description that ended in 'stable'.
   */
  readonly #lastStableTransports = new WeakMap<
    RTCRtpTransceiver,
    [RTCDtlsTransport | null, RTCDtlsTransport | null]
  >();
  /** The DTLS and ICE transports, by native key. */
  readonly #transports = new Transports({
    sdp: (side) => (side === 'local' ? this.localDescription : this.remoteDescription)?.sdp ?? null,
  });

  static {
    registerInterface('RTCPeerConnection', (value) => #native in value);
  }

  constructor(configuration: RTCConfiguration = {}) {
    super();
    const ctx = "Failed to construct 'RTCPeerConnection'";
    this.#configuration = convertConfiguration(configuration, ctx);
    const now = Date.now();
    if (this.#configuration.certificates.some((certificate) => hasExpired(certificate, now))) {
      throw new DOMException(`${ctx}: Expired certificate(s).`, 'InvalidAccessError');
    }
    validateIceServers(this.#configuration.iceServers, ctx);
    this.#chain = new OperationsChain(
      () => this.#closed,
      () => this.#onChainEmpty(),
    );
    const pc = this;
    this.#owner = {
      get closed() {
        return pc.#closed;
      },
      chain: (what, operation) => pc.#chain.chain(what, operation),
      changed: () => {
        pc.#version++;
      },
      currentSdp: (side) => (side === 'local' ? pc.#currentLocal : pc.#currentRemote)?.sdp ?? null,
      queueTask: (run) => {
        // Closed, tasks in the event order are dropped; there are no
        // native events left to keep an order with.
        if (pc.#closed) setImmediate(run).unref();
        else pc.#queueTask(run);
      },
    };
    this.#channelOwner = {
      get closed() {
        return pc.#closed;
      },
      get maxMessageSize() {
        return pc.#sctp?.maxMessageSize ?? null;
      },
      forget: (key) => {
        pc.#channels.delete(key);
      },
    };
    this.#onEvent = (event) => this.#handleEvent(event);
    try {
      this.#native = new native.PeerConnection(
        toNativeConfiguration(this.#configuration, true),
        this.#onEvent,
      );
    } catch (error) {
      throw fromNative(error);
    }
  }

  get [Symbol.toStringTag](): string {
    return 'RTCPeerConnection';
  }

  // Typed per event, as the DOM's RTCPeerConnection is.
  addEventListener<K extends keyof RTCPeerConnectionEventMap>(
    type: K,
    listener: Listener<RTCPeerConnection, RTCPeerConnectionEventMap[K]> | null,
    options?: AddListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: Listener<RTCPeerConnection, Event> | null,
    options?: AddListenerOptions,
  ): void;
  addEventListener(type: string, listener: unknown, options?: AddListenerOptions) {
    super.addEventListener(type, listener as AnyListener, options);
  }

  removeEventListener<K extends keyof RTCPeerConnectionEventMap>(
    type: K,
    listener: Listener<RTCPeerConnection, RTCPeerConnectionEventMap[K]> | null,
    options?: RemoveListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: Listener<RTCPeerConnection, Event> | null,
    options?: RemoveListenerOptions,
  ): void;
  removeEventListener(type: string, listener: unknown, options?: RemoveListenerOptions) {
    super.removeEventListener(type, listener as AnyListener, options);
  }

  // -------------------------------------------------------------------------
  // Attributes

  get signalingState(): RTCSignalingState {
    return this.#signalingState;
  }

  get iceGatheringState(): RTCIceGatheringState {
    return this.#iceGatheringState;
  }

  get iceConnectionState(): RTCIceConnectionState {
    return this.#iceConnectionState;
  }

  get connectionState(): RTCPeerConnectionState {
    return this.#connectionState;
  }

  get localDescription(): RTCSessionDescription | null {
    return this.#pendingLocal ?? this.#currentLocal;
  }

  get currentLocalDescription(): RTCSessionDescription | null {
    return this.#currentLocal;
  }

  get pendingLocalDescription(): RTCSessionDescription | null {
    return this.#pendingLocal;
  }

  get remoteDescription(): RTCSessionDescription | null {
    return this.#pendingRemote ?? this.#currentRemote;
  }

  get currentRemoteDescription(): RTCSessionDescription | null {
    return this.#currentRemote;
  }

  get pendingRemoteDescription(): RTCSessionDescription | null {
    return this.#pendingRemote;
  }

  /** Null until a remote description is set; then whether it offers trickle. */
  get canTrickleIceCandidates(): boolean | null {
    const remote = this.#pendingRemote ?? this.#currentRemote;
    return remote ? parseSdp(remote.sdp).trickle : null;
  }

  /** The SCTP transport, once an answer negotiating data channels is applied. */
  get sctp(): RTCSctpTransport | null {
    return this.#sctp;
  }

  // -------------------------------------------------------------------------
  // Event handlers

  get onnegotiationneeded(): AnyEventHandler {
    return getEventHandler(this, 'negotiationneeded') as AnyEventHandler;
  }

  set onnegotiationneeded(value: EventHandler<Event>) {
    setEventHandler(this, 'negotiationneeded', value);
  }

  get onicecandidate(): AnyEventHandler {
    return getEventHandler(this, 'icecandidate') as AnyEventHandler;
  }

  set onicecandidate(value: EventHandler<RTCPeerConnectionIceEvent>) {
    setEventHandler(this, 'icecandidate', value);
  }

  get onicecandidateerror(): AnyEventHandler {
    return getEventHandler(this, 'icecandidateerror') as AnyEventHandler;
  }

  set onicecandidateerror(value: EventHandler<RTCPeerConnectionIceErrorEvent>) {
    setEventHandler(this, 'icecandidateerror', value);
  }

  get onsignalingstatechange(): AnyEventHandler {
    return getEventHandler(this, 'signalingstatechange') as AnyEventHandler;
  }

  set onsignalingstatechange(value: EventHandler<Event>) {
    setEventHandler(this, 'signalingstatechange', value);
  }

  get oniceconnectionstatechange(): AnyEventHandler {
    return getEventHandler(this, 'iceconnectionstatechange') as AnyEventHandler;
  }

  set oniceconnectionstatechange(value: EventHandler<Event>) {
    setEventHandler(this, 'iceconnectionstatechange', value);
  }

  get onicegatheringstatechange(): AnyEventHandler {
    return getEventHandler(this, 'icegatheringstatechange') as AnyEventHandler;
  }

  set onicegatheringstatechange(value: EventHandler<Event>) {
    setEventHandler(this, 'icegatheringstatechange', value);
  }

  get onconnectionstatechange(): AnyEventHandler {
    return getEventHandler(this, 'connectionstatechange') as AnyEventHandler;
  }

  set onconnectionstatechange(value: EventHandler<Event>) {
    setEventHandler(this, 'connectionstatechange', value);
  }

  get ontrack(): AnyEventHandler {
    return getEventHandler(this, 'track') as AnyEventHandler;
  }

  set ontrack(value: EventHandler<RTCTrackEvent>) {
    setEventHandler(this, 'track', value);
  }

  get ondatachannel(): AnyEventHandler {
    return getEventHandler(this, 'datachannel') as AnyEventHandler;
  }

  set ondatachannel(value: EventHandler<RTCDataChannelEvent>) {
    setEventHandler(this, 'datachannel', value);
  }

  // -------------------------------------------------------------------------
  // Offer/answer

  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createOffer(
    successCallback: RTCSessionDescriptionCallback,
    failureCallback: RTCPeerConnectionErrorCallback,
    options?: RTCOfferOptions,
  ): Promise<void>;
  // Overloads are told apart by argument count, as WebIDL does: one
  // argument is always the options, even a function.
  createOffer(...args: unknown[]): Promise<unknown> {
    if (args.length >= 2) {
      return legacy('createOffer', 1, args[0], args[1], () => this.#createOffer(args[2]));
    }
    return this.#createOffer(args[0]);
  }

  #createOffer(options: unknown): Promise<RTCSessionDescriptionInit> {
    let converted: RTCOfferOptions;
    try {
      converted = toRTCOfferOptions(options, `${context('createOffer')}: options`);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#chain.chain('createOffer', () => this.#doCreateOffer(converted));
  }

  /** The spec's "creating an offer", run as (or within) a chained operation. */
  async #doCreateOffer(options: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    const state = this.#signalingState;
    if (state !== 'stable' && state !== 'have-local-offer') {
      throw invalidStateError(
        `${context('createOffer')}: An offer can't be created in state '${state}'.`,
      );
    }
    const nativeOptions: NativeOfferOptions = { iceRestart: options.iceRestart ?? false };
    const legacyReceive =
      options.offerToReceiveAudio !== undefined || options.offerToReceiveVideo !== undefined;
    if (options.offerToReceiveAudio !== undefined) {
      nativeOptions.offerToReceiveAudio = options.offerToReceiveAudio;
    }
    if (options.offerToReceiveVideo !== undefined) {
      nativeOptions.offerToReceiveVideo = options.offerToReceiveVideo;
    }
    // The offer describes the state when its native call started. The
    // spec's final steps: if the connection changed meanwhile (say
    // addTransceiver() right after createOffer()), create it again.
    let offer: NativeSessionDescription;
    let version: number;
    do {
      version = this.#version;
      try {
        offer = await nativeTask(this.#native.createOffer(nativeOptions));
      } catch (error) {
        throw fromNative(error, operationErrors);
      }
      if (this.#closed) return { type: offer.type, sdp: offer.sdp };
    } while (version !== this.#version);
    // offerToReceive* can add transceivers or change directions silently.
    if (legacyReceive) this.#syncTransceivers();
    // libwebrtc can collide with itself after a rollback (internal/extmap-fix.ts).
    const negotiated = parseSdp(this.#currentLocal?.sdp ?? '').sections.flatMap((s) =>
      s.mid === null ? [] : [s.mid],
    );
    const sdp = fixBundledExtmapCollisions(offer.sdp, new Set(negotiated));
    this.#lastCreatedOffer = { sdp, version };
    return { type: offer.type, sdp };
  }

  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(
    successCallback: RTCSessionDescriptionCallback,
    failureCallback: RTCPeerConnectionErrorCallback,
  ): Promise<void>;
  createAnswer(...args: unknown[]): Promise<unknown> {
    if (args.length >= 2) {
      return legacy('createAnswer', 1, args[0], args[1], () => this.#createAnswer(undefined));
    }
    return this.#createAnswer(args[0]);
  }

  #createAnswer(options: unknown): Promise<RTCSessionDescriptionInit> {
    try {
      toRTCAnswerOptions(options, `${context('createAnswer')}: options`);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#chain.chain('createAnswer', () => this.#doCreateAnswer());
  }

  /** The spec's "creating an answer", run as (or within) a chained operation. */
  async #doCreateAnswer(): Promise<RTCSessionDescriptionInit> {
    const state = this.#signalingState;
    if (state !== 'have-remote-offer' && state !== 'have-local-pranswer') {
      throw invalidStateError(
        `${context('createAnswer')}: An answer can't be created in state '${state}'.`,
      );
    }
    // As for offers: a change while the native call is in flight means
    // creating it again.
    let answer: NativeSessionDescription;
    let version: number;
    do {
      version = this.#version;
      try {
        answer = await nativeTask(this.#native.createAnswer());
      } catch (error) {
        throw fromNative(error, operationErrors);
      }
      if (this.#closed) return { type: answer.type, sdp: answer.sdp };
    } while (version !== this.#version);
    this.#lastCreatedAnswer = { sdp: answer.sdp, version };
    return { type: answer.type, sdp: answer.sdp };
  }

  setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void>;
  setLocalDescription(
    description: RTCLocalSessionDescriptionInit,
    successCallback: () => void,
    failureCallback: RTCPeerConnectionErrorCallback,
  ): Promise<void>;
  setLocalDescription(...args: unknown[]): Promise<void> {
    if (args.length === 2) return notEnoughArguments('setLocalDescription', 3, 2);
    if (args.length >= 3) {
      return legacy('setLocalDescription', 2, args[1], args[2], () =>
        this.#setLocalDescription(args[0]),
      );
    }
    return this.#setLocalDescription(args[0]);
  }

  #setLocalDescription(description: unknown): Promise<void> {
    let init: RTCLocalSessionDescriptionInit;
    try {
      init = toRTCLocalSessionDescriptionInit(
        description,
        `${context('setLocalDescription')}: description`,
      );
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#chain.chain('setLocalDescription', async () => {
      const state = this.#signalingState;
      const type =
        init.type ??
        (state === 'stable' || state === 'have-local-offer' || state === 'have-remote-pranswer'
          ? 'offer'
          : 'answer');
      this.#checkDescriptionState('local', type);
      // Munged SDP is passed through: libwebrtc accepts it, as Chrome and
      // wrtc do (the spec would reject it with InvalidModificationError).
      let sdp = init.sdp ?? '';
      if (type === 'rollback') {
        sdp = '';
      } else if (sdp !== '') {
        // Except a changed (or added) DTLS fingerprint, which Chrome rejects
        // before libwebrtc sees it. libwebrtc would reject it too, but as an
        // OperationError that leaves the connection unable to negotiate.
        const last = type === 'offer' ? this.#lastCreatedOffer : this.#lastCreatedAnswer;
        if (fingerprintChanged(last?.sdp ?? '', sdp)) {
          throw new DOMException(
            `${context('setLocalDescription')}: The SDP does not match the previously generated SDP for this type`,
            'InvalidModificationError',
          );
        }
      } else {
        // The spec's [[LastCreatedOffer]] / [[LastCreatedAnswer]], if still
        // valid; otherwise create one. libwebrtc's implicit SLD (no
        // description) creates one of the type the state calls for, which
        // is right for everything but a pranswer.
        const last = type === 'offer' ? this.#lastCreatedOffer : this.#lastCreatedAnswer;
        if (last && last.version === this.#version) {
          sdp = last.sdp;
        } else if (type === 'pranswer') {
          sdp = (await this.#doCreateAnswer()).sdp ?? '';
          if (this.#closed) return;
        }
      }
      try {
        await this.#applyDescription(
          false,
          sdp === '' && type !== 'rollback' ? undefined : { type, sdp },
        );
      } catch (error) {
        // libwebrtc's own implicit offer can collide with itself after a
        // rollback (internal/extmap-fix.ts). Create the offer here, where
        // the fix applies, and set that instead. Only this case: the
        // happy path stays a single native call.
        if (!(sdp === '' && type === 'offer' && isExtmapCollision(error))) throw error;
        sdp = (await this.#doCreateOffer({})).sdp ?? '';
        if (this.#closed) return;
        await this.#applyDescription(false, { type, sdp });
      }
    });
  }

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(
    description: RTCSessionDescriptionInit,
    successCallback: () => void,
    failureCallback: RTCPeerConnectionErrorCallback,
  ): Promise<void>;
  setRemoteDescription(...args: unknown[]): Promise<void> {
    if (args.length === 2) return notEnoughArguments('setRemoteDescription', 3, 2);
    if (args.length >= 3) {
      return legacy('setRemoteDescription', 2, args[1], args[2], () =>
        this.#setRemoteDescription(args[0]),
      );
    }
    return this.#setRemoteDescription(args[0]);
  }

  #setRemoteDescription(description: unknown): Promise<void> {
    let init: RTCSessionDescriptionInit;
    try {
      init = toRTCSessionDescriptionInit(
        description,
        `${context('setRemoteDescription')}: description`,
      );
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#chain.chain('setRemoteDescription', async () => {
      this.#checkDescriptionState('remote', init.type);
      if (init.type === 'offer' && this.#signalingState === 'have-local-offer') {
        // The spec's implicit rollback (as Blink does it): libwebrtc rejects
        // a remote offer in have-local-offer, so roll the local offer back
        // first. Its signalingstatechange ('stable') fires before the
        // remote offer's.
        await this.#applyDescription(false, { type: 'rollback', sdp: '' });
        if (this.#closed) return;
      }
      // TCP candidates to Fetch's bad ports are ignored (blocked-ports.ts).
      const sdp = init.type === 'rollback' ? '' : (init.sdp ?? '');
      // An error's sdpLineNumber counts lines of the caller's SDP.
      await this.#applyDescription(
        true,
        { type: init.type, sdp: withoutBlockedCandidates(sdp) },
        sdp,
      );
    });
  }

  #checkDescriptionState(side: 'local' | 'remote', type: RTCSdpType): void {
    if (!validStates[side][type].includes(this.#signalingState)) {
      const method = side === 'local' ? 'setLocalDescription' : 'setRemoteDescription';
      throw invalidStateError(
        `${context(method)}: A ${side} ${type} can't be set in state '${this.#signalingState}'.`,
      );
    }
  }

  /**
   * Runs a native SLD/SRD with this connection's signaling and track
   * events held back, then applies its snapshot and fires them in spec
   * order, all before the caller's promise settles. `callerSdp` is the SDP
   * an error's line number refers to, when libwebrtc got a modified one.
   */
  async #applyDescription(
    remote: boolean,
    desc: NativeSessionDescription | undefined,
    callerSdp = desc?.sdp ?? '',
  ) {
    const epoch = this.#epoch;
    this.#describing = true;
    let snapshot: NativeDescriptionSnapshot;
    try {
      snapshot = remote
        ? await nativeTask(this.#native.setRemoteDescription(desc as NativeSessionDescription))
        : desc === undefined
          ? await nativeTask(this.#native.setLocalDescription())
          : await nativeTask(this.#native.setLocalDescription(desc));
    } catch (error) {
      this.#describing = false;
      this.#transports.release();
      // Whatever libwebrtc did change still gets reported.
      const held = this.#takeBuffered();
      for (const event of held) this.#handleEvent(event);
      throw fromNativeDescriptionError(error, callerSdp);
    }
    this.#describing = false;
    this.#transports.release();
    const held = this.#takeBuffered();
    if (this.#closed) return;
    // A description changes what the next offer or answer would be.
    this.#version++;
    this.#applySnapshot(snapshot, held, epoch, remote, desc?.type === 'rollback');
  }

  #takeBuffered(): NativePcEvent[] {
    const held = this.#buffered;
    this.#buffered = [];
    return held;
  }

  /** The spec's "set the session description" from step "update state" on. */
  #applySnapshot(
    snapshot: NativeDescriptionSnapshot,
    held: NativePcEvent[],
    epoch: number,
    remote: boolean,
    rollback: boolean,
  ): void {
    this.#applyDescriptions(snapshot);
    this.#updateSctpTransport(snapshot);
    const removeList: [MediaStream, MediaStreamTrack][] = [];
    const addList: [MediaStream, MediaStreamTrack][] = [];
    const muteTracks: MediaStreamTrack[] = [];
    // Chrome's track events for an SRD or a rollback (see #applyTransceivers).
    const trackEvents: RTCRtpTransceiver[] | null = remote || rollback ? [] : null;
    const streamsBefore = this.#legacyRemoteStreams();
    if (snapshot.transceivers) {
      this.#applyTransceivers(
        snapshot.transceivers,
        epoch,
        removeList,
        addList,
        muteTracks,
        trackEvents,
      );
      // [[SenderTransport]] / [[ReceiverTransport]]: set by local
      // descriptions and remote answers, not by a remote offer (libwebrtc
      // has transports for it already), and restored to the last stable
      // state's by a rollback (libwebrtc may leave the rolled-back offer's).
      if (rollback) {
        this.#restoreRtpTransports(snapshot.transceivers);
      } else if (!(remote && snapshot.signalingState === 'have-remote-offer')) {
        this.#applyRtpTransports(snapshot.transceivers);
      }
      if (snapshot.signalingState === 'stable') {
        for (const transceiver of this.#transceivers) {
          const state = transceiverStateOf(transceiver);
          this.#lastStableTransports.set(transceiver, [
            state.senderTransport,
            state.receiverTransport,
          ]);
        }
      }
    }
    this.#transports.roles(snapshot.iceRoles);
    const state = snapshot.signalingState;
    if (state === 'stable' || state === 'have-local-pranswer' || state === 'have-remote-pranswer') {
      // An answer sets the ICE role (webrtc-pc's [[IceRole]]).
      this.#transports.roleKnown([
        ...this.#transceivers.flatMap((t) => {
          const transceiver = transceiverStateOf(t);
          return [transceiver.senderTransport, transceiver.receiverTransport];
        }),
        this.#sctp?.transport ?? null,
      ]);
    }

    // signalingstatechange, once per state libwebrtc went through (an
    // implicit rollback passes through 'stable'), ending in the snapshot's.
    const states = held.flatMap((event) =>
      event.kind === 'signalingstatechange' ? [event.state] : [],
    );
    if (snapshot.signalingState) states.push(snapshot.signalingState);
    for (const state of states) {
      if (state === this.#signalingState || state === 'closed') continue;
      this.#signalingState = state;
      this.#fire(new Event('signalingstatechange'));
      if (this.#closed) return;
    }

    for (const track of muteTracks) {
      setTrackMuted(track, true);
      if (this.#closed) return;
    }
    for (const [stream, track] of removeList) {
      removeRemoteTrack(stream, track);
      if (this.#closed) return;
    }
    for (const [stream, track] of addList) {
      addRemoteTrack(stream, track);
      if (this.#closed) return;
    }
    // The legacy addstream/removestream events, as Chrome still fires them.
    const streamsAfter = this.#legacyRemoteStreams();
    for (const stream of streamsAfter) {
      if (streamsBefore.has(stream)) continue;
      this.#fire(new MediaStreamEvent('addstream', stream));
      if (this.#closed) return;
    }
    for (const stream of streamsBefore) {
      if (streamsAfter.has(stream)) continue;
      this.#fire(new MediaStreamEvent('removestream', stream));
      if (this.#closed) return;
    }
    // libwebrtc's OnTrack covers the FiredDirection half of Chrome's rule,
    // so it adds nothing on an SRD or rollback; it is what an SLD fires.
    const fired = new Set<RTCRtpTransceiver>();
    const onTrack = held.flatMap((event) =>
      event.kind === 'track' && event.transceiver ? [this.#wrap(event.transceiver)] : [],
    );
    for (const transceiver of [...(trackEvents ?? []), ...onTrack]) {
      if (fired.has(transceiver)) continue;
      fired.add(transceiver);
      this.#fireTrack(transceiver);
      if (this.#closed) return;
    }
  }

  /**
   * Chrome's getRemoteStreams(), which its addstream/removestream events
   * compare: the streams of every transceiver whose `direction` receives.
   */
  #legacyRemoteStreams(): Set<MediaStream> {
    const streams = new Set<MediaStream>();
    for (const transceiver of this.#transceivers) {
      if (!hasRecv(transceiverStateOf(transceiver).direction)) continue;
      for (const stream of transceiverStateOf(transceiver).remoteStreams) streams.add(stream);
    }
    return streams;
  }

  #applyDescriptions(snapshot: NativeDescriptionSnapshot): void {
    this.#refreshLocal(snapshot);
    const remote = [this.#pendingRemote, this.#currentRemote];
    const withEnd = (value: NativeSessionDescription | null) =>
      value && { type: value.type, sdp: this.#withEndOfCandidates(value.sdp, false) };
    this.#pendingRemote = description(withEnd(snapshot.pendingRemoteDescription), ...remote);
    this.#currentRemote = description(withEnd(snapshot.currentRemoteDescription), ...remote);
  }

  /**
   * `sdp` with `a=end-of-candidates` in each media section whose ICE
   * generation is finished: on the local side, gathering completed (for the
   * section's own transport or its BUNDLE group's); on the remote side,
   * addIceCandidate() got an end-of-candidates. libwebrtc's descriptions
   * never carry the line, so it is added to every snapshot.
   */
  #withEndOfCandidates(sdp: string, local: boolean): string {
    const ended = local ? this.#localEnded : this.#remoteEnded;
    if (ended.size === 0) return sdp;
    const parsed = parseSdp(sdp);
    const done = (section: MediaSection | undefined): boolean => {
      if (!section) return false;
      const ufrag = ended.get(sectionKey(section));
      return ufrag !== undefined && (ufrag === null || ufrag === section.ufrag);
    };
    const indices = parsed.sections.filter((section) => {
      if (section.rejected) return false;
      if (done(section)) return true;
      if (!local) return false;
      const group = parsed.bundles.find((g) => section.mid !== null && g.includes(section.mid));
      return done(parsed.sections.find((s) => s.mid === group?.[0]));
    });
    return appendToSections(
      sdp,
      indices.map((section) => section.index),
      'a=end-of-candidates',
    );
  }

  /** Replaces the cached local or remote descriptions whose SDP `update` changes. */
  #updateDescriptions(local: boolean, update: (sdp: string) => string): void {
    const next = (desc: RTCSessionDescription | null) => {
      if (!desc) return desc;
      const sdp = update(desc.sdp);
      return sdp === desc.sdp ? desc : new RTCSessionDescription({ type: desc.type, sdp });
    };
    if (local) {
      this.#pendingLocal = next(this.#pendingLocal);
      this.#currentLocal = next(this.#currentLocal);
    } else {
      this.#pendingRemote = next(this.#pendingRemote);
      this.#currentRemote = next(this.#currentRemote);
    }
  }

  /**
   * Takes each transceiver's state from the snapshot, apart from `direction`
   * (below). Transceivers the snapshot leaves out were removed, unless they
   * were created after the operation started (the snapshot may predate them).
   *
   * The set keeps JS's order: a transceiver joins it when JS first sees it,
   * as in Chrome. libwebrtc's own order differs when addTrack() or
   * addTransceiver() runs while a description that creates transceivers is
   * in flight (libwebrtc applies it first; the spec creates its
   * transceivers when it completes).
   *
   * `direction` only changes here when libwebrtc stopped the transceiver (a
   * rejected m-section): descriptions never change it otherwise, and the
   * snapshot can predate a change JS made while the operation ran. Stopping
   * and stopped never revert, for the same reason.
   *
   * A receiver whose [[FiredDirection]] stops including recv gets "process
   * the removal of a remote track": its track goes on `muteTracks` unless
   * it is muted already. libwebrtc tracks [[FiredDirection]] for SLD, SRD
   * and rollback alike (as Chrome's DidModifyTransceivers uses it).
   *
   * `trackEvents` (an SRD or a rollback) gets each transceiver that should
   * fire `track` by Chrome's rule (DidModifyTransceivers) and webrtc-pc's:
   * not stopped, receiving, and either its [[FiredDirection]] didn't include
   * recv before or it gained a remote stream. libwebrtc's OnTrack covers
   * only the first, so a description that only changes the msid would fire
   * nothing. (Chrome doesn't check that it receives: libwebrtc clears a
   * receiver's streams when it stops receiving, so it can't gain one then.)
   */
  #applyTransceivers(
    states: NativeTransceiverState[],
    epoch: number,
    removeList: [MediaStream, MediaStreamTrack][],
    addList: [MediaStream, MediaStreamTrack][],
    muteTracks: MediaStreamTrack[],
    trackEvents: RTCRtpTransceiver[] | null,
  ): void {
    const present = new Set<RTCRtpTransceiver>();
    for (const entry of states) {
      if (!entry.transceiver) continue;
      const transceiver = this.#wrap(entry.transceiver);
      const state = transceiverStateOf(transceiver);
      state.mid = entry.mid;
      state.currentDirection = entry.currentDirection;
      const track = transceiver.receiver.track;
      const hadRecv = hasRecv(state.firedDirection);
      if (hadRecv && !hasRecv(entry.firedDirection) && !track.muted) {
        muteTracks.push(track);
      }
      state.firedDirection = entry.firedDirection;
      state.stopped ||= entry.stopped;
      state.stopping ||= entry.stopping || entry.stopped;
      if (state.stopping) state.direction = 'stopped';
      if (entry.currentDirection === 'sendrecv' || entry.currentDirection === 'sendonly') {
        state.hasSent = true;
      }
      if (state.stopping) markTrackEnded(transceiver.receiver.track);
      const added = this.#setRemoteStreams(
        transceiver,
        entry.receiverStreamIds,
        removeList,
        addList,
      );
      if (trackEvents && !state.stopped && hasRecv(entry.firedDirection) && (!hadRecv || added)) {
        trackEvents.push(transceiver);
      }
      present.add(transceiver);
    }
    this.#transceivers = this.#transceivers.filter((transceiver) => {
      if (present.has(transceiver)) return true;
      if ((this.#createdAt.get(transceiver) ?? 0) > epoch) return true;
      // Removed from the set (stopped and negotiated away, or created by a
      // rolled-back description): webrtc-pc's stopped, dissociated state,
      // as Chrome and wrtc show it. libwebrtc no longer reports on it.
      const state = transceiverStateOf(transceiver);
      state.stopped = true;
      state.stopping = true;
      state.mid = null;
      state.direction = 'stopped';
      state.currentDirection = 'stopped';
      markTrackEnded(transceiver.receiver.track);
      this.#setRemoteStreams(transceiver, [], removeList, addList);
      return false;
    });
  }

  #restoreRtpTransports(states: NativeTransceiverState[]): void {
    for (const entry of states) {
      if (!entry.transceiver) continue;
      const transceiver = this.#wrap(entry.transceiver);
      const state = transceiverStateOf(transceiver);
      [state.senderTransport, state.receiverTransport] = this.#lastStableTransports.get(
        transceiver,
      ) ?? [null, null];
    }
  }

  #applyRtpTransports(states: NativeTransceiverState[]): void {
    for (const entry of states) {
      if (!entry.transceiver) continue;
      const state = transceiverStateOf(this.#wrap(entry.transceiver));
      state.senderTransport = this.#transports.get(entry.senderTransport);
      state.receiverTransport = this.#transports.get(entry.receiverTransport);
    }
  }

  /** The spec's "set the associated remote streams". True if it added any. */
  #setRemoteStreams(
    transceiver: RTCRtpTransceiver,
    ids: readonly string[],
    removeList: [MediaStream, MediaStreamTrack][],
    addList: [MediaStream, MediaStreamTrack][],
  ): boolean {
    const state = transceiverStateOf(transceiver);
    const track = transceiver.receiver.track;
    const streams = [...new Set(ids)].map((id) => this.#remoteStream(id));
    for (const stream of state.remoteStreams) {
      if (!streams.includes(stream)) removeList.push([stream, track]);
    }
    const before = addList.length;
    for (const stream of streams) {
      if (!state.remoteStreams.includes(stream)) addList.push([stream, track]);
    }
    state.remoteStreams = streams;
    return addList.length > before;
  }

  #remoteStream(id: string): MediaStream {
    let stream = this.#remoteStreams.get(id)?.deref();
    if (!stream) {
      stream = new MediaStream({ id });
      this.#remoteStreams.set(id, new WeakRef(stream));
      this.#collectedStreams.register(stream, id);
    }
    return stream;
  }

  /**
   * Fires `track` for libwebrtc's OnTrack, except on a stopped transceiver:
   * libwebrtc reports one for a remote offer's rejected (port 0) m-section,
   * which webrtc-pc and Chrome don't (its track is ended, and the
   * transceiver is about to be removed).
   */
  #fireTrack(transceiver: RTCRtpTransceiver): void {
    if (transceiverStateOf(transceiver).stopped) return;
    this.#fire(
      new RTCTrackEvent('track', {
        receiver: transceiver.receiver,
        track: transceiver.receiver.track,
        streams: transceiverStateOf(transceiver).remoteStreams,
        transceiver,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // ICE

  addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void>;
  addIceCandidate(
    candidate: RTCIceCandidateInit,
    successCallback: () => void,
    failureCallback: RTCPeerConnectionErrorCallback,
  ): Promise<void>;
  addIceCandidate(...args: unknown[]): Promise<void> {
    if (args.length === 2) return notEnoughArguments('addIceCandidate', 3, 2);
    if (args.length >= 3) {
      return legacy('addIceCandidate', 2, args[1], args[2], () => this.#addIceCandidate(args[0]));
    }
    return this.#addIceCandidate(args[0]);
  }

  /**
   * An empty `candidate` (also no argument, `null` or `{}`) means
   * end-of-candidates, which is validated and then resolves: libwebrtc has
   * no API for it.
   */
  #addIceCandidate(candidate: unknown): Promise<void> {
    let init: RTCIceCandidateInit;
    try {
      init = toRTCIceCandidateInit(candidate, `${context('addIceCandidate')}: candidate`);
    } catch (error) {
      return Promise.reject(error);
    }
    const text = init.candidate ?? '';
    const sdpMid = init.sdpMid ?? null;
    const sdpMLineIndex = init.sdpMLineIndex ?? null;
    const ufrag = init.usernameFragment ?? null;
    if (text !== '' && sdpMid === null && sdpMLineIndex === null) {
      return Promise.reject(
        new TypeError(`${context('addIceCandidate')}: sdpMid and sdpMLineIndex are both null.`),
      );
    }
    return this.#chain.chain('addIceCandidate', async () => {
      const remote = this.remoteDescription;
      if (!remote) {
        throw invalidStateError(`${context('addIceCandidate')}: The remote description was null.`);
      }
      const parsed = parseSdp(remote.sdp);
      const fail = (why: string) =>
        domError('OperationError', `${context('addIceCandidate')}: ${why}`);
      let section: MediaSection | undefined;
      if (sdpMid !== null) {
        section = parsed.sections.find((s) => s.mid === sdpMid);
        if (!section) throw fail(`No media description has mid '${sdpMid}'.`);
      } else if (sdpMLineIndex !== null) {
        section = parsed.sections[sdpMLineIndex];
        if (!section) throw fail(`No media description has index ${sdpMLineIndex}.`);
      }
      if (ufrag !== null) {
        const known = section
          ? section.ufrag === ufrag
          : parsed.sections.some((s) => s.ufrag === ufrag);
        if (!known) throw fail(`The ICE ufrag '${ufrag}' isn't in the remote description.`);
      }
      if (text === '') {
        // End-of-candidates for one media description, or for all of them
        // (all of that ufrag's generation, if given).
        const ended = section
          ? [section]
          : parsed.sections.filter((s) => !s.rejected && (ufrag === null || s.ufrag === ufrag));
        for (const s of ended) this.#remoteEnded.set(sectionKey(s), ufrag ?? s.ufrag);
        this.#updateDescriptions(false, (sdp) => this.#withEndOfCandidates(sdp, false));
        return;
      }
      // Ignored, as if it got no response (blocked-ports.ts). libwebrtc
      // never sees it, so it isn't added to the remote description either.
      if (!section || isBlockedCandidate(text)) return;
      try {
        await nativeTask(
          this.#native.addIceCandidate({
            candidate: text,
            sdpMid: sdpMid ?? section.mid ?? '',
            sdpMLineIndex: section.index,
          }),
        );
      } catch (error) {
        if (!isNativeError(error)) throw error;
        throw domError('OperationError', `${context('addIceCandidate')}: ${error.message}`);
      }
      if (this.#closed) return;
      // The spec adds it to the remote descriptions of its ICE generation.
      // (libwebrtc adds it to its own copy, so later snapshots carry it.)
      const generation = ufrag ?? parseCandidate(text)?.ufrag ?? section.ufrag;
      const line = text.startsWith('a=') ? text : `a=${text}`;
      const key = sectionKey(section);
      this.#updateDescriptions(false, (sdp) => {
        const target = parseSdp(sdp).sections.find((s) => sectionKey(s) === key);
        if (!target || (generation !== null && target.ufrag !== generation)) return sdp;
        return appendToSections(sdp, [target.index], line);
      });
    });
  }

  /** Requests an ICE restart at the next offer. A no-op once closed. */
  restartIce(): void {
    if (this.#closed) return;
    this.#native.restartIce();
    this.#version++;
  }

  // -------------------------------------------------------------------------
  // Configuration

  /**
   * A certificate for `certificates`: ECDSA P-256, or RSASSA-PKCS1-v1_5
   * with SHA-256 (1024 to 8192 bits), optionally with `expires` (ms, capped
   * at a year; default 30 days). The key is generated off the JS thread.
   * Doesn't use `this`, so a detached reference works.
   */
  static generateCertificate(keygenAlgorithm: AlgorithmIdentifier): Promise<RTCCertificate>;
  static generateCertificate(...args: unknown[]): Promise<RTCCertificate> {
    return generateCertificate(args.length, args[0]);
  }

  getConfiguration(): RTCConfigurationResult {
    return copyConfiguration(this.#configuration);
  }

  setConfiguration(configuration: RTCConfiguration = {}): void {
    // The spec's order: argument conversion (TypeError), closed, then
    // "set a configuration": the members that can't change, then the ICE
    // servers.
    const ctx = context('setConfiguration');
    const next = convertConfiguration(configuration, ctx);
    if (this.#closed) throw closedError('setConfiguration');
    const current = this.#configuration;
    const modified = (what: string) =>
      new DOMException(`${ctx}: ${what} can't be changed.`, 'InvalidModificationError');
    if (next.bundlePolicy !== current.bundlePolicy) throw modified('bundlePolicy');
    if (next.rtcpMuxPolicy !== current.rtcpMuxPolicy) throw modified('rtcpMuxPolicy');
    if (!sameCertificates(next.certificates, current.certificates)) throw modified('certificates');
    if (next.iceCandidatePoolSize !== current.iceCandidatePoolSize && this.localDescription) {
      throw modified('iceCandidatePoolSize after setLocalDescription');
    }
    validateIceServers(next.iceServers, ctx);
    try {
      this.#native.setConfiguration(toNativeConfiguration(next, false));
    } catch (error) {
      throw fromNative(error);
    }
    this.#configuration = next;
    this.#version++;
  }

  // -------------------------------------------------------------------------
  // Media

  getTransceivers(): RTCRtpTransceiver[] {
    return [...this.#transceivers];
  }

  getSenders(): RTCRtpSender[] {
    return this.#liveTransceivers().map((transceiver) => transceiver.sender);
  }

  getReceivers(): RTCRtpReceiver[] {
    return this.#liveTransceivers().map((transceiver) => transceiver.receiver);
  }

  #liveTransceivers(): RTCRtpTransceiver[] {
    return this.#transceivers.filter((t) => !transceiverStateOf(t).stopped);
  }

  /**
   * Sends `track`, reusing a free transceiver of its kind when there is
   * one (the spec's rules), and returns its sender. `streams` become the
   * stream ids the remote `track` event carries.
   */
  addTrack(track: MediaStreamTrackLike, ...streams: MediaStreamLike[]): RTCRtpSender {
    const ctx = context('addTrack');
    const t = toTrack(track, `${ctx}: parameter 1`);
    const ids = [
      ...new Set(streams.map((stream, i) => toStream(stream, `${ctx}: parameter ${i + 2}`).id)),
    ];
    if (this.#closed) throw closedError('addTrack');
    const live = this.#liveTransceivers();
    if (live.some((transceiver) => transceiver.sender.track === t)) {
      throw new DOMException(
        `${ctx}: A sender already exists for the track.`,
        'InvalidAccessError',
      );
    }
    // The spec reuses the first transceiver of the kind whose
    // [[SenderTrack]] is null, that never sent and isn't stopping.
    const specPick = live.find((transceiver) => {
      const state = transceiverStateOf(transceiver);
      return (
        transceiver.sender.track === null &&
        state.kind === t.kind &&
        !state.hasSent &&
        !state.stopping
      );
    });
    const nativeTrack = nativeTrackOf(t);
    if (!nativeTrack) throw new TypeError(`${ctx}: parameter 1 is not a MediaStreamTrack.`);

    // libwebrtc's AddTrack picks from its own, live state instead, and the
    // two can differ: a stopping transceiver (which libwebrtc picks and
    // then throws INVALID_PARAMETER for), or a sender whose track a
    // replaceTrack() in this task changed natively but not yet in
    // [[SenderTrack]] (that waits for a queued task). Use libwebrtc's
    // AddTrack only when it would pick the same transceiver, or when the
    // spec finds none and libwebrtc's pick is one JS hasn't seen: a remote
    // offer still in flight created it. In the spec that offer would
    // associate the transceiver addTrack creates instead, which comes to
    // the same (and Chrome and wrtc reuse it too).
    let handle: NativeTransceiver;
    try {
      const specHandle = specPick && transceiverStateOf(specPick).native;
      const nativePick = this.#libwebrtcAddTrackPick(t.kind);
      if (
        nativePick === specHandle ||
        (!specHandle &&
          nativePick &&
          !this.#transceivers.some((known) => transceiverStateOf(known).native === nativePick))
      ) {
        handle = this.#native.addTrack(nativeTrack, ids).transceiver;
      } else if (specHandle) {
        handle = this.#reuseTransceiver(specHandle, nativeTrack, ids);
      } else {
        // Unlike AddTrack, this leaves libwebrtc's created_by_addtrack
        // unset, and libwebrtc only associates a transceiver with a remote
        // offer's m-line on its own if that flag is set. So an answerer
        // that adds a track before setRemoteDescription(offer), on this
        // path only, gets a new m-line in its next offer instead of
        // answering on the offered one. No native API sets the flag.
        handle = this.#native.addTransceiver(nativeTrack, { direction: 'sendrecv', streams: ids });
      }
    } catch (error) {
      throw fromNative(error);
    }
    const transceiver = this.#wrap(handle);
    const state = transceiverStateOf(transceiver);
    state.direction = handle.direction;
    const sender = senderStateOf(transceiver.sender);
    if (sender) sender.track = t;
    this.#version++;
    return transceiver.sender;
  }

  /**
   * The transceiver libwebrtc's AddTrack would reuse
   * (FindFirstTransceiverForAddedTrack): the first of the kind, in its
   * order, whose sender has no track right now, that never sent and isn't
   * stopped. Stopping ones count.
   */
  #libwebrtcAddTrackPick(kind: string): NativeTransceiver | undefined {
    const hasSent = (handle: NativeTransceiver) =>
      this.#transceivers.some((t) => {
        const state = transceiverStateOf(t);
        return state.native === handle && state.hasSent;
      });
    return this.#native
      .getTransceivers()
      .find(
        (handle) =>
          handle.receiver.track.kind === kind &&
          handle.sender.track === null &&
          !handle.stopped &&
          !hasSent(handle),
      );
  }

  /** addTrack's reuse of a transceiver, done by hand (see addTrack). */
  #reuseTransceiver(
    handle: NativeTransceiver,
    track: NonNullable<ReturnType<typeof nativeTrackOf>>,
    ids: string[],
  ): NativeTransceiver {
    handle.sender.replaceTrack(track);
    handle.sender.setStreams(ids);
    if (handle.direction === 'recvonly') handle.direction = 'sendrecv';
    if (handle.direction === 'inactive') handle.direction = 'sendonly';
    return handle;
  }

  /** Stops sending the sender's track; renegotiate to tell the remote side. */
  removeTrack(sender: RTCRtpSenderLike): void {
    const ctx = context('removeTrack');
    toSender(sender, `${ctx}: parameter 1`);
    if (this.#closed) throw closedError('removeTrack');
    const state = senderStateOf(sender);
    if (!state || state.owner !== this.#owner) {
      throw new DOMException(
        `${ctx}: The sender was not created by this peer connection.`,
        'InvalidAccessError',
      );
    }
    // libwebrtc's RemoveTrack leaves a stopping transceiver's sender alone
    // (it keeps its track), so [[SenderTrack]] must too.
    if (state.transceiver.stopping || state.track === null) return;
    try {
      this.#native.removeTrack(state.native);
    } catch (error) {
      throw fromNative(error);
    }
    state.track = null;
    state.transceiver.direction = state.transceiver.native.direction;
    this.#version++;
  }

  addTransceiver(
    trackOrKind: MediaStreamTrackLike | string,
    init: RTCRtpTransceiverInit = {},
  ): RTCRtpTransceiver {
    const ctx = context('addTransceiver');
    let kind: 'audio' | 'video';
    let track: MediaStreamTrack | null = null;
    if (
      typeof trackOrKind === 'string' ||
      typeof trackOrKind !== 'object' ||
      trackOrKind === null
    ) {
      const value = DOMString(trackOrKind, `${ctx}: parameter 1`);
      if (value !== 'audio' && value !== 'video') {
        throw new TypeError(`${ctx}: '${value}' is not a valid kind ('audio' or 'video').`);
      }
      kind = value;
    } else {
      track = toTrack(trackOrKind, `${ctx}: parameter 1`);
      kind = track.kind as 'audio' | 'video';
    }
    const converted = toRTCRtpTransceiverInit(init, `${ctx}: init`);
    const ids = [...new Set((converted.streams ?? []).map((stream) => (stream as MediaStream).id))];
    const encodings = checkSendEncodings(converted.sendEncodings ?? [], kind, ctx);
    if (this.#closed) throw closedError('addTransceiver');
    let handle: NativeTransceiver;
    try {
      const nativeTrack = track ? nativeTrackOf(track) : undefined;
      handle = this.#native.addTransceiver(nativeTrack ?? kind, {
        direction: converted.direction ?? 'sendrecv',
        streams: ids,
        ...(encodings.length > 0 ? { sendEncodings: encodings } : {}),
      });
    } catch (error) {
      throw fromNative(error, { INVALID_PARAMETER: 'TypeError' });
    }
    const transceiver = this.#wrap(handle);
    const sender = senderStateOf(transceiver.sender);
    if (sender) {
      sender.track = track;
      sender.envelope = encodings.map((e) => e.rid as string | undefined);
    }
    this.#version++;
    return transceiver;
  }

  /**
   * The wrapper for a native transceiver, appended to the set of
   * transceivers when it is new.
   */
  #wrap(handle: NativeTransceiver): RTCRtpTransceiver {
    const { transceiver, created } = transceiverFromNative(this.#owner, handle);
    if (created) {
      this.#createdAt.set(transceiver, ++this.#epoch);
      this.#transceivers.push(transceiver);
    }
    return transceiver;
  }

  /**
   * The wrapper for one of this connection's native receivers, wrapping
   * its transceiver first if JS hasn't yet (a receiver's state includes
   * its transceiver's).
   */
  #receiverOf(handle: NativeReceiver): RTCRtpReceiver | undefined {
    const wrapped = wrappedReceiver(handle);
    if (wrapped) return wrapped;
    const transceiver = this.#native.getTransceivers().find((t) => t.receiver === handle);
    return transceiver ? this.#wrap(transceiver).receiver : undefined;
  }

  /** Picks up transceivers libwebrtc changed without an event. */
  #syncTransceivers(): void {
    for (const handle of this.#native.getTransceivers()) {
      const transceiver = this.#wrap(handle);
      transceiverStateOf(transceiver).direction = handle.direction;
    }
  }

  // -------------------------------------------------------------------------
  // Stats

  /**
   * Stats for the whole connection, or for the one sender or receiver of
   * `selector`. Works after close().
   */
  getStats(selector: MediaStreamTrackLike | null = null): Promise<RTCStatsReport> {
    let track: MediaStreamTrack | null = null;
    try {
      if (selector !== null && selector !== undefined) {
        track = toTrack(selector, `${context('getStats')}: parameter 1`);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    let nativeSelector: Parameters<NativePeerConnection['getStats']>[0];
    if (track) {
      // Every sender and receiver the connection has, including those of
      // stopped transceivers and after close() (the spec's set of
      // transceivers, not getSenders()).
      const senders = this.#transceivers.map((t) => t.sender).filter((s) => s.track === track);
      const receivers = this.#transceivers.map((t) => t.receiver).filter((r) => r.track === track);
      if (senders.length + receivers.length !== 1) {
        return Promise.reject(
          new DOMException(
            `${context('getStats')}: The selector must match exactly one sender or receiver.`,
            'InvalidAccessError',
          ),
        );
      }
      const [sender] = senders;
      const [receiver] = receivers;
      nativeSelector = sender
        ? senderStateOf(sender)?.native
        : nativeReceiverOf(receiver as RTCRtpReceiver);
    }
    const pending = nativeTask(
      nativeSelector === undefined
        ? this.#native.getStats()
        : this.#native.getStats(nativeSelector),
    );
    return pending.then(statsReportFromJson, (error) => {
      throw fromNative(error);
    });
  }

  // -------------------------------------------------------------------------
  // Data channels

  /**
   * A new data channel, 'connecting' until SCTP is up (or 'open' at once
   * on a connected transport, as an `open` event in a later task). The
   * first one makes the connection need negotiation. A `negotiated`
   * channel needs an `id`, and the remote side must create one with the
   * same id; otherwise the remote gets a `datachannel` event.
   */
  createDataChannel(label: string, dataChannelDict?: RTCDataChannelInit): RTCDataChannel;
  createDataChannel(...args: unknown[]): RTCDataChannel {
    const ctx = context('createDataChannel');
    if (args.length < 1) {
      throw new TypeError(`${ctx}: 1 argument required, but only 0 present.`);
    }
    const [label, dataChannelDict] = args;
    const name = USVString(label, `${ctx}: parameter 1`);
    const init = toRTCDataChannelInit(dataChannelDict, `${ctx}: dataChannelDict`);
    if (this.#closed) throw closedError('createDataChannel');
    if (Buffer.byteLength(name, 'utf8') > 65535) {
      throw new TypeError(`${ctx}: The label is longer than 65535 bytes.`);
    }
    const protocol = init.protocol ?? '';
    if (Buffer.byteLength(protocol, 'utf8') > 65535) {
      throw new TypeError(`${ctx}: The protocol is longer than 65535 bytes.`);
    }
    const negotiated = init.negotiated ?? false;
    // The id of a channel negotiated in-band is chosen by the user agent;
    // a given one is ignored (the spec).
    const id = negotiated ? (init.id ?? null) : null;
    if (negotiated && id === null) {
      throw new TypeError(`${ctx}: A negotiated channel needs an id.`);
    }
    if (init.maxPacketLifeTime !== undefined && init.maxRetransmits !== undefined) {
      throw new TypeError(`${ctx}: maxPacketLifeTime and maxRetransmits can't both be set.`);
    }
    if (id === 65535) {
      throw new TypeError(`${ctx}: The id 65535 is above the maximum of 65534.`);
    }
    const maxChannels = this.#sctp?.state === 'connected' ? this.#sctp.maxChannels : null;
    if (id !== null && maxChannels !== null && id >= maxChannels) {
      throw domError(
        'OperationError',
        `${ctx}: The id ${id} is not below the SCTP transport's maxChannels (${maxChannels}).`,
      );
    }
    const nativeInit: NativeDataChannelInit = {
      ordered: init.ordered ?? true,
      protocol,
      negotiated,
      ...(init.maxPacketLifeTime === undefined
        ? {}
        : { maxPacketLifeTime: init.maxPacketLifeTime }),
      ...(init.maxRetransmits === undefined ? {} : { maxRetransmits: init.maxRetransmits }),
      ...(id === null ? {} : { id }),
    };
    let handle: NativeDataChannel;
    try {
      handle = this.#native.createDataChannel(name, nativeInit);
    } catch (error) {
      // libwebrtc: an id in use ('StreamId reserved.') or none left.
      throw fromNative(error, {
        INVALID_RANGE: 'OperationError',
        INVALID_PARAMETER: 'OperationError',
        RESOURCE_EXHAUSTED: 'OperationError',
      });
    }
    const channel = dataChannelFromNative(
      this.#channelOwner,
      handle,
      {
        label: name,
        ordered: nativeInit.ordered ?? true,
        maxPacketLifeTime: init.maxPacketLifeTime ?? null,
        maxRetransmits: init.maxRetransmits ?? null,
        protocol,
        negotiated,
        // An in-band channel gets its id now if the DTLS role is known.
        id: id ?? (handle.id >= 0 ? handle.id : null),
      },
      'connecting',
    );
    this.#channels.set(handle.key, channel);
    if (!this.#createdDataChannel) {
      // libwebrtc fires negotiationneeded for the first channel; an offer
      // created before it no longer describes the connection.
      this.#createdDataChannel = true;
      this.#version++;
    }
    return channel;
  }

  /** "Announcing a data channel": the remote opened an in-band one. */
  #onRemoteChannel(handle: NativeDataChannel): void {
    // Open before the `datachannel` event, so its handler can send; the
    // `open` event follows in the channel's own `dc:state` task.
    const channel = dataChannelFromNative(
      this.#channelOwner,
      handle,
      remoteChannelSettings(handle),
      'open',
    );
    this.#channels.set(handle.key, channel);
    this.#fire(new RTCDataChannelEvent('datachannel', { channel }));
  }

  /**
   * [[SctpTransport]] after an SLD/SRD: libwebrtc's, as Chrome does. It
   * exists once an offer (local or remote) negotiates data channels, is
   * replaced when libwebrtc replaces it (BUNDLE moving data channels onto
   * another transport) and goes away on a rollback to a state without it.
   *
   * maxMessageSize is 65536 until an answer, then follows the remote
   * description (the spec's "update the data max message size", with
   * libwebrtc's 256 KiB as what we can send).
   */
  #updateSctpTransport(snapshot: NativeDescriptionSnapshot): void {
    const native = snapshot.sctp;
    if (native === undefined) return;
    const dtls = native && this.#transports.get(native.transport);
    if (!native || !dtls) {
      this.#sctp = null;
      this.#sctpKey = null;
      return;
    }
    const info = this.#sctpInfo?.transport === native.key ? this.#sctpInfo : null;
    if (!this.#sctp || this.#sctpKey !== native.key) {
      this.#sctpKey = native.key;
      this.#sctpAnswered = false;
      this.#sctp = createSctpTransport(dtls, {
        state: info?.state === 'connected' || info?.state === 'closed' ? info.state : 'connecting',
        maxMessageSize: 65536,
        maxChannels: info?.maxChannels ?? null,
      });
    }
    const state = snapshot.signalingState;
    if (state !== 'stable' && state !== 'have-local-pranswer' && state !== 'have-remote-pranswer') {
      return;
    }
    const remote = sctpSection(this.remoteDescription?.sdp ?? '');
    const local = sctpSection(this.localDescription?.sdp ?? '');
    if (!remote || !local) return;
    // Absent means 65536 and 0 means unlimited (RFC 8841); our own limit is
    // never 0, so the spec's infinite case can't arise.
    const remoteMax = remote.maxMessageSize ?? 65536;
    const specMax = remoteMax === 0 ? SCTP_SEND_LIMIT : Math.min(remoteMax, SCTP_SEND_LIMIT);
    // Once connected, libwebrtc's own (enforced) value wins. But on a
    // renegotiation libwebrtc restarts SCTP with the new remote value
    // without reporting it (no state change), so what it reported is stale.
    const maxMessageSize = this.#sctpAnswered ? specMax : (info?.maxMessageSize ?? specMax);
    this.#sctpAnswered = true;
    updateSctpTransport(this.#sctp, { maxMessageSize }, false);
  }

  #onSctpState(event: Extract<NativePcEvent, { kind: 'sctp:state' }>): void {
    this.#sctpInfo = event;
    const sctp = this.#sctp;
    if (!sctp || event.transport !== this.#sctpKey) return;
    const state = event.state === 'new' ? 'connecting' : event.state;
    if (state === 'connected' && sctp.state !== 'connected') {
      // The "connected procedure": in-band channels get their ids first.
      for (const channel of this.#channels.values()) channelEvents.sctpConnected(channel);
    }
    updateSctpTransport(sctp, {
      state,
      maxChannels: event.maxChannels,
      ...(event.maxMessageSize === null ? {} : { maxMessageSize: event.maxMessageSize }),
    });
  }

  // -------------------------------------------------------------------------
  // Close

  /**
   * Closes the connection. Fires no events on it; operations in flight never
   * settle; attributes keep answering. Receivers' tracks end in a queued
   * task, each with an `ended` event (webrtc-pc "close the connection",
   * with disappear false).
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffered = [];
    this.#tasks.clear();
    this.#native.close();
    this.#signalingState = 'closed';
    this.#iceConnectionState = 'closed';
    this.#connectionState = 'closed';
    for (const transceiver of this.#transceivers) {
      // The tasks that would clear [[LastReturnedParameters]] are dropped
      // with the rest; clear it now, as they would have.
      const sender = senderStateOf(transceiver.sender);
      if (sender) sender.lastReturnedParameters = null;
      const state = transceiverStateOf(transceiver);
      state.stopped = true;
      state.stopping = true;
      state.direction = 'stopped';
      state.currentDirection = state.native.currentDirection;
      markTrackEnded(transceiver.receiver.track);
    }
    // Channels close abruptly, without the closing procedure or events.
    for (const channel of this.#channels.values()) channelEvents.connectionClosed(channel);
    this.#channels.clear();
    if (this.#sctp) updateSctpTransport(this.#sctp, { state: 'closed' }, false);
    this.#transports.close();
  }

  // -------------------------------------------------------------------------
  // Native events

  #fire(event: Event): void {
    if (!this.#closed) this.dispatchEvent(event);
  }

  /**
   * The spec's "queue a task", in the order native events, op completions
   * and other tasks of every peer connection share (a setImmediate would
   * run before native events libwebrtc reported earlier, and after later
   * ones delivered in the same poll phase). With `next`, called
   * synchronously from #handleEvent, it runs right after the event being
   * handled, before anything reported meanwhile; elsewhere `next` is
   * ignored.
   */
  #queueTask(run: () => void, next = false): void {
    const id = this.#nextTask;
    // The addon takes ids as uint32s.
    this.#nextTask = (id + 1) >>> 0;
    this.#tasks.set(id, run);
    this.#native.queueTask(id, next);
  }

  #handleEvent(event: NativePcEvent): void {
    if (this.#closed) return;
    switch (event.kind) {
      case 'task': {
        const run = this.#tasks.get(event.id);
        this.#tasks.delete(event.id);
        run?.();
        return;
      }
      case 'signalingstatechange':
      case 'track':
      case 'removetrack':
        if (this.#describing) {
          this.#buffered.push(event);
          return;
        }
        this.#handleUnheld(event);
        return;
      case 'receiver:unmute':
        // Not held back during an SLD/SRD: libwebrtc only sends it while
        // the transceiver is receptive, in order with the descriptions'
        // completions, so an SLD/SRD that mutes the track again completes
        // (and mutes) after this.
        if (event.receiver) {
          const receiver = this.#receiverOf(event.receiver);
          if (receiver) setTrackMuted(receiver.track, false);
        }
        return;
      case 'negotiationneeded':
        this.#negotiationNeededId = event.eventId;
        this.#maybeFireNegotiationNeeded();
        return;
      case 'icecandidate':
        this.#onIceCandidate(event.candidate, event.snapshot);
        return;
      case 'icegatheringstatechange':
        this.#onIceGatheringState(event.state, event.snapshot);
        return;
      case 'iceconnectionstatechange': {
        // Chrome's state: never 'failed' or 'completed' (see
        // chromeIceConnectionState()), so libwebrtc's disconnected -> failed
        // and connected -> completed fire nothing.
        const state = chromeIceConnectionState(event.state);
        if (state === this.#iceConnectionState) return;
        this.#iceConnectionState = state;
        const fireTransport = this.#transports.followConnection(state, event.transportStates);
        this.#fire(new Event('iceconnectionstatechange'));
        if (!this.#closed) fireTransport();
        return;
      }
      case 'connectionstatechange':
        if (event.state === this.#connectionState) return;
        this.#connectionState = event.state;
        this.#fire(new Event('connectionstatechange'));
        return;
      case 'icecandidateerror':
        // libwebrtc reports port 0 and address '' when no local socket was
        // involved (a TCP TURN connection that failed); Chrome, like the
        // spec, shows both as null then.
        this.#fire(
          new RTCPeerConnectionIceErrorEvent('icecandidateerror', {
            address: event.port === 0 ? null : event.address,
            port: event.port === 0 ? null : event.port,
            url: event.url,
            errorCode: event.errorCode,
            errorText: event.errorText,
          }),
        );
        return;
      case 'datachannel':
        this.#onRemoteChannel(event.channel);
        return;
      case 'dc:state': {
        const channel = this.#channels.get(event.channelKey);
        if (channel) channelEvents.state(channel, event.state, event.error);
        return;
      }
      case 'dc:message': {
        const channel = this.#channels.get(event.channelKey);
        if (channel) channelEvents.message(channel, event.data, event.binary);
        return;
      }
      case 'dc:bufferedamount': {
        const channel = this.#channels.get(event.channelKey);
        if (channel) channelEvents.sent(channel, event.sent);
        return;
      }
      case 'sctp:state':
        this.#onSctpState(event);
        return;
      case 'dtls:state':
      case 'dtls:error':
      case 'ice:state':
        this.#transports.handle(event, this.#describing);
        return;
      default:
        return;
    }
  }

  /** Signaling and track events outside an SLD/SRD (not expected). */
  #handleUnheld(event: NativePcEvent): void {
    if (event.kind === 'signalingstatechange') {
      if (event.state === this.#signalingState || event.state === 'closed') return;
      this.#signalingState = event.state;
      this.#fire(new Event('signalingstatechange'));
    } else if (event.kind === 'track' && event.transceiver) {
      const transceiver = this.#wrap(event.transceiver);
      const removeList: [MediaStream, MediaStreamTrack][] = [];
      const addList: [MediaStream, MediaStreamTrack][] = [];
      this.#setRemoteStreams(transceiver, event.streamIds, removeList, addList);
      for (const [stream, track] of removeList) removeRemoteTrack(stream, track);
      for (const [stream, track] of addList) addRemoteTrack(stream, track);
      this.#fireTrack(transceiver);
    }
    // removetrack: stream membership follows the next snapshot.
  }

  #onChainEmpty(): void {
    if (this.#negotiationNeededId === undefined) return;
    // The spec queues a task to fire it.
    setImmediate(() => this.#maybeFireNegotiationNeeded());
  }

  /**
   * Fires negotiationneeded for the latest event id if libwebrtc still
   * wants it, unless operations are queued: then the chain re-checks when
   * it empties. libwebrtc itself holds the event back outside 'stable'.
   */
  #maybeFireNegotiationNeeded(): void {
    const id = this.#negotiationNeededId;
    if (id === undefined || this.#closed || this.#chain.length > 0) return;
    if (!this.#native.shouldFireNegotiationNeededEvent(id)) return;
    this.#negotiationNeededId = undefined;
    this.#fire(new Event('negotiationneeded'));
  }

  /**
   * The cached local descriptions follow ICE gathering (outside SLD/SRD),
   * plus the end-of-candidates lines libwebrtc leaves out.
   */
  #refreshLocal(snapshot: NativeDescriptionSnapshot | undefined): void {
    if (!snapshot || this.#describing) return;
    const local = [this.#pendingLocal, this.#currentLocal];
    const withEnd = (value: NativeSessionDescription | null) =>
      value && { type: value.type, sdp: this.#withEndOfCandidates(value.sdp, true) };
    this.#pendingLocal = description(withEnd(snapshot.pendingLocalDescription), ...local);
    this.#currentLocal = description(withEnd(snapshot.currentLocalDescription), ...local);
  }

  #onIceCandidate(
    candidate: NativeIceCandidate,
    snapshot: NativeDescriptionSnapshot | undefined,
  ): void {
    this.#refreshLocal(snapshot);
    const ufrag = parseCandidate(candidate.candidate)?.ufrag ?? null;
    if (!this.#gathering.has(candidate.sdpMid)) {
      this.#gathering.set(candidate.sdpMid, { index: candidate.sdpMLineIndex, ufrag });
    }
    this.#fire(
      new RTCPeerConnectionIceEvent('icecandidate', {
        candidate: new RTCIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: ufrag,
        }),
      }),
    );
  }

  #onIceGatheringState(
    state: NativeIceGatheringState,
    snapshot: NativeDescriptionSnapshot | undefined,
  ): void {
    this.#refreshLocal(snapshot);
    if (state === this.#iceGatheringState) return;
    if (state === 'complete') {
      this.#completeGathering();
      return;
    }
    if (state === 'gathering') {
      this.#gathering.clear();
      this.#transports.gathering('gathering');
    }
    this.#iceGatheringState = state;
    this.#fire(new Event('icegatheringstatechange'));
  }

  /**
   * Gathering finished, in the spec's two tasks (webrtc-pc PR 2894). This
   * one adds `a=end-of-candidates` to the local descriptions and fires an
   * end-of-candidates ('' candidate) for each ICE transport that gathered.
   * The second, queued, sets iceGatheringState, fires
   * icegatheringstatechange and then the null candidate. Separate tasks let
   * an `onicecandidate = resolve` loop see every event.
   */
  #completeGathering(): void {
    const transports = this.#gatheredTransports();
    this.#gathering.clear();
    for (const t of transports) this.#localEnded.set(t.mid, t.ufrag);
    this.#updateDescriptions(true, (sdp) => this.#withEndOfCandidates(sdp, true));
    for (const t of transports) {
      this.#fire(
        new RTCPeerConnectionIceEvent('icecandidate', {
          candidate: new RTCIceCandidate({
            candidate: '',
            sdpMid: t.mid,
            sdpMLineIndex: t.index,
            usernameFragment: t.ufrag,
          }),
        }),
      );
      if (this.#closed) return;
    }
    // Next, so it runs before any later native event, of this connection
    // or another: in protocol/dtls-close.html the answerer's channel 'open'
    // (which makes the test close the offerer) would otherwise overtake the
    // answerer's null candidate, whose addIceCandidate() on the closed
    // offerer then rejects unhandled. That includes op completions: another
    // connection's setRemoteDescription() resolves after it.
    this.#queueTask(() => {
      this.#iceGatheringState = 'complete';
      this.#transports.gathering('complete');
      this.#fire(new Event('icegatheringstatechange'));
      this.#fire(new RTCPeerConnectionIceEvent('icecandidate', { candidate: null }));
    }, true);
  }

  /**
   * The ICE transports whose gathering just completed: those that produced
   * candidates this round, which in an initial offer under 'balanced' or
   * 'max-compat' is every m-section, not only the BUNDLE tag. If none did
   * (no usable interface), one per transport the local description names.
   */
  #gatheredTransports(): { mid: string; index: number; ufrag: string | null }[] {
    const parsed = parseSdp(this.localDescription?.sdp ?? '');
    if (this.#gathering.size > 0) {
      const ufragOf = (mid: string) => parsed.sections.find((s) => s.mid === mid)?.ufrag ?? null;
      return [...this.#gathering]
        .map(([mid, { index, ufrag }]) => ({ mid, index, ufrag: ufrag ?? ufragOf(mid) }))
        .sort((a, b) => a.index - b.index);
    }
    return transportSections(parsed).flatMap((section) =>
      section.mid === null
        ? []
        : [{ mid: section.mid, index: section.index, ufrag: section.ufrag }],
    );
  }
}

/**
 * addTransceiver's sendEncodings checks (spec step "validate
 * sendEncodings"): rids all present or all absent, valid and unique;
 * scaleResolutionDownBy >= 1 and maxFramerate >= 0. Audio drops the video
 * members.
 */
function checkSendEncodings(
  encodings: RTCRtpEncodingParameters[],
  kind: 'audio' | 'video',
  ctx: string,
): Record<string, unknown>[] {
  const rids = encodings.map((e) => e.rid);
  const withRid = rids.filter((rid) => rid !== undefined);
  if (withRid.length > 0 && withRid.length !== encodings.length) {
    throw new TypeError(`${ctx}: Either every sendEncodings entry has a rid or none has.`);
  }
  for (const rid of withRid) {
    if (!/^[A-Za-z0-9]{1,16}$/.test(rid as string)) {
      throw new TypeError(`${ctx}: '${rid}' is not a valid rid.`);
    }
  }
  if (new Set(withRid).size !== withRid.length) {
    throw new TypeError(`${ctx}: sendEncodings rids must be unique.`);
  }
  return encodings.map((encoding) => {
    const copy: Record<string, unknown> = { ...encoding };
    if (kind === 'audio') {
      delete copy.scaleResolutionDownBy;
      delete copy.maxFramerate;
      return copy;
    }
    if (encoding.scaleResolutionDownBy !== undefined && encoding.scaleResolutionDownBy < 1) {
      throw new RangeError(`${ctx}: scaleResolutionDownBy must be at least 1.`);
    }
    if (encoding.maxFramerate !== undefined && encoding.maxFramerate < 0) {
      throw new RangeError(`${ctx}: maxFramerate must not be negative.`);
    }
    return copy;
  });
}
