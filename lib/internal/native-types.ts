/**
 * Types for the native addon (build/Release/wrtc.node).
 *
 * This is the contract between the native work packages (WP-M, WP-R) and the
 * JS layer (SPEC-LAYER-PLAN.md, "Native contract"). Members marked
 * `@stub` exist in the addon but throw ERR_WRTC_NOT_IMPLEMENTED until their
 * work package lands. Change this file only through the coordinator.
 *
 * Native handles are mechanical: no WebIDL conversion, no spec state
 * machines, live getters. The JS layer validates arguments, caches state and
 * dispatches events.
 *
 * Errors: see `NativeError`.
 *
 * Lifetime of a PeerConnection and its RTP handles (SPEC-LAYER-PLAN.md,
 * "Contract decisions after the WP-R review"):
 * - Until `close()` the event stream keeps the process alive. After it, only
 *   pending ops do: ops in flight at `close()` complete normally, and
 *   `getStats()` (PC, sender, receiver) still works. Every other async op
 *   rejects with `INVALID_STATE`. Events emitted by `close()` itself
 *   (`connectionstatechange` then `signalingstatechange`, both 'closed') are
 *   still delivered if the caller holds its callback (see the next point);
 *   the JS layer drops them either way.
 * - The `onEvent` callback is held strongly until `close()` and **only
 *   weakly after it** (so a callback that references its PC can't leak a
 *   closed PC). Events still queued at `close()`, e.g. the `track` events of
 *   an SRD that was in flight, are delivered only if the caller keeps its
 *   own reference to the callback. An inline closure that nothing else
 *   holds can be collected first, and those events are then dropped.
 * - Handles of a closed PC, and of transceivers the PC has removed, are held
 *   only weakly by native code, so a handle that references its PC can't
 *   keep it alive. Identity holds while JS holds the handle.
 * - Events delivered after the PeerConnection object was garbage collected
 *   may lack their RTP fields (`receiver`, `transceiver`, and `transceiver`
 *   in snapshots are then `undefined`).
 * - Native code doesn't check that a sender or receiver passed to a PC
 *   method (`removeTrack`, `getStats`) belongs to that PC. The JS layer
 *   must.
 */

/**
 * libwebrtc's RTCErrorType names.
 */
export type NativeErrorType =
  | 'UNSUPPORTED_OPERATION'
  | 'UNSUPPORTED_PARAMETER'
  | 'INVALID_PARAMETER'
  | 'INVALID_RANGE'
  | 'SYNTAX_ERROR'
  | 'INVALID_STATE'
  | 'INVALID_MODIFICATION'
  | 'NETWORK_ERROR'
  | 'RESOURCE_EXHAUSTED'
  | 'INTERNAL_ERROR'
  | 'OPERATION_ERROR_WITH_DATA';

/**
 * Every rejection or throw from native code for a runtime condition: a plain
 * `Error` (`name` is `'Error'`) whose `errorType` says what failed. The JS
 * layer maps it to the spec's exception.
 * - Ops on a closed PC, or on handles whose PC was destroyed:
 *   `INVALID_STATE`, message `'peer connection is closed'` (or `'peer
 *   connection closed'` for ops still pending when the PC is destroyed).
 * - SDP and candidate parse failures: `SYNTAX_ERROR`, with libwebrtc's parse
 *   error in `message` and the offending line in `sdpLine`.
 * - Everything libwebrtc rejects: its own type and message.
 *
 * `TypeError` is reserved for arguments of the wrong type. The JS layer
 * validates first, so one means a JS-layer bug.
 */
export interface NativeError extends Error {
  name: 'Error';
  errorType: NativeErrorType;
  /** Only for `SYNTAX_ERROR` from SDP or candidate parsing. */
  sdpLine?: string;
}

export type NativeSdpType = 'offer' | 'pranswer' | 'answer' | 'rollback';

export type NativeSignalingState =
  | 'stable'
  | 'have-local-offer'
  | 'have-remote-offer'
  | 'have-local-pranswer'
  | 'have-remote-pranswer'
  | 'closed';

export type NativeIceGatheringState = 'new' | 'gathering' | 'complete';

export type NativeIceConnectionState =
  | 'new'
  | 'checking'
  | 'connected'
  | 'completed'
  | 'disconnected'
  | 'failed'
  | 'closed';

export type NativePeerConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

export type NativeTransceiverDirection =
  | 'sendrecv'
  | 'sendonly'
  | 'recvonly'
  | 'inactive'
  | 'stopped';

export type NativeMediaKind = 'audio' | 'video';

export interface NativeSessionDescription {
  type: NativeSdpType;
  sdp: string;
}

export interface NativeIceCandidate {
  candidate: string;
  sdpMid: string;
  sdpMLineIndex: number;
}

export interface NativeIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Already validated and defaulted by the JS layer.
 */
export interface NativeConfiguration {
  iceServers?: NativeIceServer[];
  iceTransportPolicy?: 'all' | 'relay';
  bundlePolicy?: 'balanced' | 'max-compat' | 'max-bundle';
  /** `'negotiate'` stays out of the contract. */
  rtcpMuxPolicy?: 'require';
  iceCandidatePoolSize?: number;
  /**
   * Nonstandard (wrtc): the host ports ICE gathers on. `min` defaults to 0
   * and `max` to 65535, as in wrtc, so `{min: 60000}` means 60000-65535 and
   * `{max}` alone is unrestricted (libwebrtc lets the OS pick when it can
   * bind port 0). The JS layer checks `min <= max` (a TypeError, as in
   * wrtc).
   */
  portRange?: { min?: number; max?: number };
  /**
   * Construction only (`setConfiguration()` throws a TypeError if present:
   * libwebrtc compares certificates by pointer, so the JS layer checks they
   * didn't change). Each is parsed into a new libwebrtc certificate with
   * the same key; libwebrtc uses only the first. Absent or empty: libwebrtc
   * generates its default (ECDSA P-256) asynchronously, as without the
   * member. PEM libwebrtc can't parse throws `INVALID_PARAMETER`.
   */
  certificates?: NativeCertificatePem[];
}

/** A certificate and its private key, as PEM (RTCCertificate::ToPEM). */
export interface NativeCertificatePem {
  privateKey: string;
  certificate: string;
}

/** What `generateCertificate()` resolves with. */
export interface NativeGeneratedCertificate extends NativeCertificatePem {
  /**
   * The end of its validity, ms since the epoch (RTCCertificate::Expires:
   * the certificate's notAfter, so whole seconds).
   */
  expires: number;
  /**
   * libwebrtc's fingerprint of it (SSLFingerprint::CreateFromCertificate),
   * the one it writes into SDP: the signature's digest ('sha-256') and the
   * RFC 4572 value (upper-case hex pairs joined by colons).
   */
  fingerprint: { algorithm: string; value: string };
}

/**
 * libwebrtc's KeyParams: ECDSA is P-256. The JS layer passes RSA values that
 * fit in an int32; whatever KeyParams::IsValid() rejects (modulus outside
 * 1024-8192, exponent not above the modulus length) rejects with
 * `INVALID_PARAMETER`.
 */
export type NativeKeyParams =
  | { type: 'ecdsa' }
  | { type: 'rsa'; modulusLength: number; publicExponent: number };

/**
 * `offerToReceive*` can add transceivers, or change their direction, without
 * any event; the JS layer re-reads them after createOffer.
 */
export interface NativeOfferOptions {
  iceRestart?: boolean;
  /** Legacy (WPT still uses it). Unset = leave transceivers alone. */
  offerToReceiveAudio?: boolean;
  /** Legacy (WPT still uses it). Unset = leave transceivers alone. */
  offerToReceiveVideo?: boolean;
}

export interface NativeDataChannelInit {
  ordered?: boolean;
  maxPacketLifeTime?: number;
  maxRetransmits?: number;
  protocol?: string;
  negotiated?: boolean;
  id?: number;
}

/** One transceiver's state at the moment a description was applied. */
export interface NativeTransceiverState {
  /** Undefined only if the PeerConnection object was collected. */
  transceiver: NativeTransceiver;
  mid: string | null;
  direction: NativeTransceiverDirection;
  currentDirection: NativeTransceiverDirection | null;
  /** libwebrtc's [[FiredDirection]], passed through as-is (spec-correct). */
  firedDirection: NativeTransceiverDirection | null;
  stopped: boolean;
  stopping: boolean;
  /**
   * The receiver's stream ids. Used to update remote MediaStream membership
   * for every transceiver, not only those that fire `track`.
   */
  receiverStreamIds: string[];
  /**
   * The keys of the sender's and receiver's DTLS transports
   * (`dtls_transport()`), null for none. Equal keys are the same transport.
   */
  senderTransport: number | null;
  receiverTransport: number | null;
}

/**
 * State captured on the signaling thread when an operation completed.
 * SLD/SRD completions carry `signalingState` and `transceivers`; the
 * snapshots on icecandidate / icegatheringstatechange events carry only the
 * descriptions. See SPEC-LAYER-PLAN.md, "Description snapshots".
 *
 * `transceivers` lists every transceiver the PC still has. Removed ones
 * (stopped, then negotiated away) drop out of it and of `getTransceivers()`,
 * and native code stops holding their handles.
 */
export interface NativeDescriptionSnapshot {
  signalingState?: NativeSignalingState;
  localDescription: NativeSessionDescription | null;
  currentLocalDescription: NativeSessionDescription | null;
  pendingLocalDescription: NativeSessionDescription | null;
  remoteDescription: NativeSessionDescription | null;
  currentRemoteDescription: NativeSessionDescription | null;
  pendingRemoteDescription: NativeSessionDescription | null;
  transceivers?: NativeTransceiverState[];
  /**
   * With `transceivers`: the PC's SCTP transport (`GetSctpTransport()`),
   * or null for none. `key` changes when libwebrtc replaces it (e.g.
   * BUNDLE moved data channels onto another transport); `transport` is
   * its DTLS transport's key.
   */
  sctp?: { key: number; transport: number | null } | null;
  /**
   * With `transceivers`: the ICE role libwebrtc gave each transport the
   * snapshot names, by key (it sets roles while applying a description,
   * without a callback).
   */
  iceRoles?: Record<string, NativeIceRole>;
}

export type NativeIceRole = 'controlling' | 'controlled' | 'unknown';

// ---------------------------------------------------------------------------
// Events delivered to the PeerConnection's onEvent callback, in libwebrtc
// order, one libuv task each.

export type NativePcEvent =
  | { kind: 'signalingstatechange'; state: NativeSignalingState }
  | {
      kind: 'iceconnectionstatechange';
      state: NativeIceConnectionState;
      /**
       * Every watched ICE transport's state as libwebrtc had it when it
       * reported this, by transport key. The transports' own `ice:state`
       * reports follow this event.
       */
      transportStates?: Record<string, NativeIceTransportState>;
    }
  | {
      kind: 'icegatheringstatechange';
      state: NativeIceGatheringState;
      /** Descriptions after gathering state changed. */
      snapshot?: NativeDescriptionSnapshot;
    }
  | { kind: 'connectionstatechange'; state: NativePeerConnectionState }
  | {
      kind: 'icecandidate';
      candidate: NativeIceCandidate;
      /** Local descriptions including this candidate. */
      snapshot?: NativeDescriptionSnapshot;
    }
  | {
      kind: 'icecandidateerror';
      address: string;
      port: number;
      url: string;
      /**
       * As libwebrtc reports it, passed through unchanged. STUN binding
       * errors carry only the number part of the STUN code (a 420 arrives
       * as 20; the class digit is lost, so JS can't reconstruct it).
       * Unreachable servers report 701.
       */
      errorCode: number;
      errorText: string;
    }
  | {
      kind: 'negotiationneeded';
      eventId: number;
    }
  /** A task the JS layer queued with `queueTask(id, next)`. */
  | { kind: 'task'; id: number }
  | { kind: 'datachannel'; channel: NativeDataChannel; channelKey: number }
  | {
      kind: 'track';
      /** Undefined only if the PeerConnection object was collected. */
      receiver: NativeReceiver;
      /** Undefined only if the PeerConnection object was collected. */
      transceiver: NativeTransceiver;
      streamIds: string[];
    }
  | {
      kind: 'removetrack';
      /** Undefined only if the PeerConnection object was collected. */
      receiver: NativeReceiver;
    }
  | {
      /**
       * The first RTP packet for `receiver` since its transceiver's
       * [[Receptive]] last became true (libwebrtc's
       * OnFirstPacketReceivedAfterReceptiveChange): the spec's "receives
       * data on an RTP source", which unmutes the receiver's track. At most
       * once per [[Receptive]] period. Not sent once the PC is closed.
       */
      kind: 'receiver:unmute';
      /** Undefined only if the PeerConnection object was collected. */
      receiver: NativeReceiver;
    }
  | {
      kind: 'dc:state';
      channelKey: number;
      state: 'connecting' | 'open' | 'closing' | 'closed';
      /**
       * Only on 'closed', when the channel was closed abruptly rather than
       * by the closing procedure: an oversized send or a full send queue
       * (`NETWORK_ERROR`), or the SCTP association going away, e.g. the
       * remote PC closing (`OPERATION_ERROR_WITH_DATA`, `SCTP_FAILURE`,
       * cause 12).
       */
      error?: NativeErrorInfo;
    }
  | { kind: 'dc:message'; channelKey: number; data: Buffer; binary: boolean }
  | {
      kind: 'dc:bufferedamount';
      channelKey: number;
      /**
       * Bytes just handed to the SCTP stack (one message can be reported in
       * several parts); prefer this for JS-side tracking. A message libwebrtc
       * rejects as oversized is reported too, so the JS layer must never
       * send one.
       */
      sent: number;
    }
  | {
      /**
       * The PC's SCTP transport. The first one is emitted when an SLD/SRD
       * makes libwebrtc create the transport (it does for a local offer
       * already), before that SLD/SRD's completion; later ones on each
       * change. 'closed' follows `close()` and the remote closing.
       */
      kind: 'sctp:state';
      /** The SCTP transport's key: snapshots' `sctp.key`. */
      transport: number;
      state: 'new' | 'connecting' | 'connected' | 'closed';
      /** libwebrtc's negotiated limit; known once connected. */
      maxMessageSize: number | null;
      /** Known once connected. */
      maxChannels: number | null;
    }
  | {
      /**
       * A DTLS transport (a sender's, a receiver's or the SCTP
       * transport's), by its key in snapshots. The first is emitted when a
       * snapshot first names the transport, before that SLD/SRD's
       * completion, with its first `ice:state`; later ones on each change.
       * 'closed' also when libwebrtc drops the transport (bundled away,
       * rolled back, or the PC closed), together with an `ice:state`
       * 'closed'.
       */
      kind: 'dtls:state';
      transport: number;
      state: 'new' | 'connecting' | 'connected' | 'closed' | 'failed';
      /** DER of each certificate of the remote chain; empty until connected. */
      remoteCertificates: ArrayBuffer[];
    }
  | { kind: 'dtls:error'; transport: number; error: NativeErrorInfo }
  | {
      /**
       * The ICE transport under DTLS transport `transport`: emitted with
       * its first `dtls:state`, when its state or selected candidate pair
       * changes. Like the other transport events, it passes
       * through the signaling thread, so it follows the connection-level
       * state change it causes (as in Chrome).
       */
      kind: 'ice:state';
      transport: number;
      state: NativeIceTransportState;
      /** libwebrtc's role, which it sets from the first description on. */
      role: NativeIceRole;
      /** The transport's name: the mid of the m-section it was created for. */
      mid: string;
      /** libwebrtc's gathering state for this transport. */
      gathering: 'new' | 'gathering' | 'complete';
      /** Candidate-attributes, as in `icecandidate` events. */
      selectedPair: { local: string; remote: string } | null;
    };

export type NativeIceTransportState =
  | 'new'
  | 'checking'
  | 'connected'
  | 'completed'
  | 'failed'
  | 'disconnected'
  | 'closed';

/** An RTCError reported by an event rather than thrown. */
export interface NativeErrorInfo {
  errorType: NativeErrorType;
  message: string;
  /** libwebrtc's RTCErrorDetailType name, e.g. 'SCTP_FAILURE'. */
  errorDetail: string | null;
  sctpCauseCode: number | null;
}

export type NativePcEventKind = NativePcEvent['kind'];

// ---------------------------------------------------------------------------
// PeerConnection

export interface NativePeerConnection {
  createOffer(options?: NativeOfferOptions): Promise<NativeSessionDescription>;
  createAnswer(): Promise<NativeSessionDescription>;
  /**
   * No argument = implicit SLD. Resolves with a snapshot.
   */
  setLocalDescription(desc?: NativeSessionDescription): Promise<NativeDescriptionSnapshot>;
  /** Resolves with a snapshot. */
  setRemoteDescription(desc: NativeSessionDescription): Promise<NativeDescriptionSnapshot>;
  addIceCandidate(candidate: NativeIceCandidate): Promise<void>;
  /**
   * libwebrtc's checks: a negotiated `id` already in use throws
   * `INVALID_RANGE` ('StreamId reserved.'), one above 65534 `INVALID_RANGE`
   * ('StreamId out of range.'). The first channel fires `negotiationneeded`.
   * A channel created once SCTP is connected is reported open right away
   * (its `dc:state` is queued before this returns).
   */
  createDataChannel(label: string, init?: NativeDataChannelInit): NativeDataChannel;
  /**
   * libwebrtc's RTCStatsReport as JSON: an **array** of stats objects (each
   * with its `id` and `type`), or `{}` when nothing is selected (e.g. a
   * selector from another PC, which isn't detected). Key the report by each
   * entry's `id`, not by array index. Also works after `close()`, where
   * libwebrtc reports what is left (at least the `peer-connection` stats).
   */
  getStats(selector?: NativeSender | NativeReceiver): Promise<string>;
  setConfiguration(config: NativeConfiguration): void;
  restartIce(): void;
  addTrack(
    track: NativeTrack,
    streamIds: string[],
  ): { sender: NativeSender; transceiver: NativeTransceiver };
  removeTrack(sender: NativeSender): void;
  addTransceiver(
    trackOrKind: NativeTrack | NativeMediaKind,
    init?: {
      direction?: NativeTransceiverDirection;
      streams?: string[];
      sendEncodings?: Record<string, unknown>[];
    },
  ): NativeTransceiver;
  /**
   * Stable identity: same native transceiver, same object. Removed
   * transceivers drop out.
   */
  getTransceivers(): NativeTransceiver[];
  shouldFireNegotiationNeededEvent(eventId: number): boolean;
  /**
   * Queues a `{kind: 'task', id}` event: the spec's "queue a task", in the
   * one order every PC's events, op completions and tasks share. Delivered
   * after everything queued so far. With `next`, when called from an
   * onEvent callback (of any PC) while it runs, it goes before everything
   * queued so far instead, after the other `next` tasks that callback
   * queued: delivered right after the event being handled, in the order
   * queued. Anywhere else, even in a microtask of that event's task, `next`
   * is ignored. `id` is a uint32. Works after `close()`, like events;
   * never delivered once the PeerConnection object is gone.
   */
  queueTask(id: number, next: boolean): void;
  /** Live reads; the JS layer must answer getters from its own cache. */
  readonly signalingState: NativeSignalingState;
  readonly connectionState: NativePeerConnectionState;
  readonly iceConnectionState: NativeIceConnectionState;
  readonly iceGatheringState: NativeIceGatheringState;
  close(): void;
}

export interface NativePeerConnectionConstructor {
  new (config: NativeConfiguration, onEvent: (event: NativePcEvent) => void): NativePeerConnection;
}

/**
 * A data channel. The creation-time settings (`label` to `negotiated`) are
 * fixed; `id`, `readyState` and `bufferedAmount` are live reads.
 */
export interface NativeDataChannel {
  /** Matches `channelKey` on dc:* events. */
  readonly key: number;
  readonly label: string;
  readonly ordered: boolean;
  readonly maxPacketLifeTime: number | null;
  readonly maxRetransmits: number | null;
  readonly protocol: string;
  readonly negotiated: boolean;
  /**
   * -1 until assigned: an in-band channel gets its id once the DTLS role is
   * known (at creation if it already is, else when SCTP connects).
   */
  readonly id: number;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  readonly bufferedAmount: number;
  /** libwebrtc's send queue limit (16 MiB); a send that overflows it closes the channel. */
  readonly maxSendQueueSize: number;
  /**
   * Copies `data`. False if the channel isn't open or the send failed. A
   * message over the SCTP transport's maxMessageSize, or one that overflows
   * the send queue, also closes the channel (with an error).
   */
  send(data: Uint8Array, binary: boolean): boolean;
  close(): void;
}

// ---------------------------------------------------------------------------
// RTP objects (WP-R). Stable identity per PC.

export interface NativeTransceiver {
  readonly mid: string | null;
  direction: NativeTransceiverDirection;
  readonly currentDirection: NativeTransceiverDirection | null;
  readonly stopped: boolean;
  readonly stopping: boolean;
  stop(): void;
  readonly sender: NativeSender;
  readonly receiver: NativeReceiver;
  /** Throws `INVALID_STATE` once the PeerConnection object is destroyed. */
  setCodecPreferences(codecs: NativeRtpCodec[]): void;
}

export interface NativeRtpCodec {
  mimeType: string;
  clockRate: number;
  channels?: number;
  sdpFmtpLine?: string;
}

export interface NativeSender {
  /**
   * Live from libwebrtc. After the PC is closed this is whatever libwebrtc
   * left: the track for a sender that had one, `null` otherwise. The JS
   * layer answers from its own cache.
   */
  readonly track: NativeTrack | null;
  /**
   * Synchronous in libwebrtc; the JS layer chains it. Throws
   * `INVALID_STATE` for a track of the wrong kind or a stopped sender.
   */
  replaceTrack(track: NativeTrack | null): void;
  getParameters(): Record<string, unknown>;
  /**
   * Applies only the writable members (encodings, degradationPreference)
   * on top of the sender's parameters as they are when called; the JS layer
   * checks the read-only ones and `transactionId`, which is ignored here.
   * When all encodings have rids they are matched by rid, so entries for
   * layers a remote description removed are dropped; otherwise by index,
   * and a different count rejects with `INVALID_MODIFICATION`. A
   * `maxBitrate` above 2^31 - 1 rejects with `INVALID_RANGE` (libwebrtc
   * stores an int), as it throws from `addTransceiver`'s `sendEncodings`.
   */
  setParameters(parameters: Record<string, unknown>): Promise<void>;
  /**
   * Sets the degradation preference only if the sender has none, at once
   * (one signaling-thread task, no result; a failure is ignored). Throws
   * TypeError for an unknown value.
   */
  setDefaultDegradationPreference(preference: string): void;
  setStreams(streamIds: string[]): void;
  /** Works after close() (see `NativePeerConnection.getStats`). */
  getStats(): Promise<string>;
}

export interface NativeReceiver {
  readonly track: NativeTrack;
  getParameters(): Record<string, unknown>;
  /**
   * libwebrtc's SetJitterBufferMinimumDelay: the minimum jitter buffer delay
   * in seconds (>= 0), or null for libwebrtc's default. A blocking call to
   * the worker thread. libwebrtc keeps the value from before the receiver
   * gets media on; it does nothing after close(). TypeError for anything
   * else (the JS layer validates first).
   */
  setJitterBufferMinimumDelay(seconds: number | null): void;
  /** `{}` until packets arrive. Works after close(). */
  getStats(): Promise<string>;
  /**
   * libwebrtc's `GetSources()`: every SSRC and CSRC with a packet in the
   * last 10 s. Synchronous (a blocking call to the worker thread).
   */
  getSources(): NativeRtpSource[];
}

export interface NativeRtpSource {
  source: number;
  type: 'ssrc' | 'csrc';
  /** Milliseconds since its last packet was received. */
  age: number;
  rtpTimestamp: number;
  /** RFC 6464's level (0 to 127, in -dBov), when the packet carried one. */
  audioLevel?: number;
}

export interface NativeRtpCapabilities {
  codecs: NativeRtpCodec[];
  headerExtensions: { uri: string }[];
}

// ---------------------------------------------------------------------------
// Media (WP-M)

/** Process-wide identity: one JS handle per libwebrtc track. */
export interface NativeTrack {
  readonly id: string;
  readonly kind: NativeMediaKind;
  enabled: boolean;
  /**
   * A new track, with a new id, on the same source: a nonstandard source or
   * a receiver's remote source (wrtc's `MediaStreamTrack::Clone`). Its
   * `enabled` starts true; copying it is up to the JS layer.
   */
  clone(): NativeTrack;
}

/** Validated by the JS layer (wrtc's rules) before it gets here. */
export interface NativeAudioData {
  samples: Int16Array;
  sampleRate: number;
  bitsPerSample: number;
  channelCount: number;
  numberOfFrames: number;
}

export interface NativeAudioSource {
  createTrack(): NativeTrack;
  pushData(data: NativeAudioData): void;
}

export interface NativeAudioSourceConstructor {
  new (): NativeAudioSource;
}

/** Tightly packed I420. */
export interface NativeVideoFrame {
  width: number;
  height: number;
  data: Uint8Array;
  rotation: 0 | 90 | 180 | 270;
}

export interface NativeVideoSource {
  createTrack(): NativeTrack;
  /** Validated by the JS layer. */
  pushFrame(frame: NativeVideoFrame): void;
}

export interface NativeVideoSourceConstructor {
  new (init: { isScreencast: boolean; needsDenoising: boolean | null }): NativeVideoSource;
}

export interface NativeSink {
  /** Removes the sink and releases its TSFN; idempotent. */
  stop(): void;
}

export interface NativeAudioSinkConstructor {
  /** Delivered on the JS thread, every buffer, in order; `samples` is a fresh buffer. */
  new (track: NativeTrack, onData: (data: NativeAudioData) => void): NativeSink;
}

export interface NativeVideoSink extends NativeSink {
  /**
   * Frames dropped, oldest first, because 3 were already waiting for the
   * JS thread (src/media_sink.cc, kMaxQueuedFrames). An atomic read; frames
   * discarded by stop() aren't counted.
   */
  readonly framesDropped: number;
}

export interface NativeVideoSinkConstructor {
  /**
   * Delivered on the JS thread, in order; `data` is a fresh buffer. Only
   * the newest 3 frames wait for the JS thread (see `framesDropped`).
   */
  new (track: NativeTrack, onFrame: (frame: NativeVideoFrame) => void): NativeVideoSink;
}

export interface NativeFrameBuffer {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

// ---------------------------------------------------------------------------

export interface NativeModule {
  PeerConnection: NativePeerConnectionConstructor;
  /** Not constructible from JS. */
  DataChannel: abstract new () => NativeDataChannel;
  /** Not constructible from JS. */
  Track: abstract new () => NativeTrack;
  /** Not constructible from JS. */
  Transceiver: abstract new () => NativeTransceiver;
  /** Not constructible from JS. */
  Sender: abstract new () => NativeSender;
  /** Not constructible from JS. */
  Receiver: abstract new () => NativeReceiver;
  AudioSource: NativeAudioSourceConstructor;
  VideoSource: NativeVideoSourceConstructor;
  AudioSink: NativeAudioSinkConstructor;
  VideoSink: NativeVideoSinkConstructor;
  getRtpCapabilities(
    side: 'sender' | 'receiver',
    kind: NativeMediaKind,
  ): NativeRtpCapabilities | null;
  /**
   * Generates a key and self-signed certificate on a libuv threadpool thread
   * (RTCCertificateGenerator::GenerateCertificate), valid for `expires` ms
   * (libwebrtc caps it at a year; default 30 days). Unsupported key
   * parameters reject with `INVALID_PARAMETER` (at call time); a failed
   * generation with `INTERNAL_ERROR`.
   */
  generateCertificate(
    keyParams: NativeKeyParams,
    expires?: number,
  ): Promise<NativeGeneratedCertificate>;
  /**
   * Converts tightly packed I420 into RGBA (R, G, B, A in memory; libyuv
   * I420ToABGR), writing into `rgba.data` synchronously. Both views are
   * honoured (byteOffset); `data` may be any TypedArray. Throws a
   * TypeError, without writing, unless both sizes are the same whole
   * non-negative int32s and each byteLength is exact. An empty frame does
   * nothing. The JS layer validates first, with clearer messages.
   */
  i420ToRgba(i420: NativeFrameBuffer, rgba: NativeFrameBuffer): void;
  /**
   * The reverse, as wrtc 0.10.0's libyuv ABGRToI420 computed it (its
   * chroma rounding, which differs between arm and x86); same checks.
   */
  rgbaToI420(rgba: NativeFrameBuffer, i420: NativeFrameBuffer): void;
}
