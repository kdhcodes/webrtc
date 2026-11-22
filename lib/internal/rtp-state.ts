/**
 * The JS-side state of the RTP wrappers, shared between RTCPeerConnection
 * (which updates it from snapshots and its own methods) and the wrapper
 * classes (which answer their getters from it). Getters never read native
 * handles live: libwebrtc changes them on its own threads while JS still
 * has events for the previous state queued (SPEC-LAYER-PLAN.md,
 * "Description snapshots").
 */
import type { MediaStream } from '../MediaStream.ts';
import type { MediaStreamTrack } from '../MediaStreamTrack.ts';
import type { RTCDtlsTransport } from '../RTCDtlsTransport.ts';
import type { RTCRtpTransceiverDirection } from './generated/idl.ts';
import type {
  NativeReceiver,
  NativeSender,
  NativeTransceiver,
  NativeTransceiverDirection,
} from './native-types.ts';

/** What the wrappers need from their peer connection. */
export interface RtpOwner {
  /** [[IsClosed]]. */
  readonly closed: boolean;
  /** Chains an operation on the connection's operations chain. */
  chain<T>(what: string, operation: () => Promise<T>): Promise<T>;
  /**
   * Called after a change that a new offer or answer would reflect
   * (direction, stop, codec preferences, stream ids), so the connection
   * stops reusing its last created offer or answer.
   */
  changed(): void;
  /** The SDP of currentLocalDescription or currentRemoteDescription. */
  currentSdp(side: 'local' | 'remote'): string | null;
  /**
   * The spec's "queue a task", in the order the connection's native events
   * share; once the connection is closed, a setImmediate. A task queued
   * before close() and not yet run is dropped.
   */
  queueTask(run: () => void): void;
}

export interface TransceiverState {
  readonly native: NativeTransceiver;
  readonly owner: RtpOwner;
  readonly kind: 'audio' | 'video';
  mid: string | null;
  direction: RTCRtpTransceiverDirection;
  currentDirection: RTCRtpTransceiverDirection | null;
  firedDirection: NativeTransceiverDirection | null;
  stopped: boolean;
  stopping: boolean;
  /** currentDirection has been 'sendrecv' or 'sendonly' at some point. */
  hasSent: boolean;
  /** The receiver's [[AssociatedRemoteMediaStreams]]. */
  remoteStreams: MediaStream[];
  /** The sender's [[SenderTransport]] and the receiver's [[ReceiverTransport]]. */
  senderTransport: RTCDtlsTransport | null;
  receiverTransport: RTCDtlsTransport | null;
}

export interface SenderState {
  readonly native: NativeSender;
  readonly owner: RtpOwner;
  readonly transceiver: TransceiverState;
  track: MediaStreamTrack | null;
  /**
   * [[LastReturnedParameters]], cleared a task after getParameters(): by a
   * task queued in the native event order (RtpOwner.queueTask), or by any
   * native result delivered first (see `lastReturnedAt`).
   */
  lastReturnedParameters: Record<string, unknown> | null;
  /** nativeCompletions() when lastReturnedParameters was set. */
  lastReturnedAt: number;
  /** Its encodings' scales are all defaults (see presentEncodings). */
  synthesizedScales: boolean;
  /**
   * The rids of the encodings the sender was created with (its simulcast
   * envelope), or null until known.
   */
  envelope: (string | undefined)[] | null;
  /**
   * The app set a degradationPreference with setParameters(). Until then a
   * video sender runs with DEFAULT_DEGRADATION and getParameters() shows
   * none, as Chrome shows none for its own default.
   */
  degradationSet: boolean;
}

export interface ReceiverState {
  readonly native: NativeReceiver;
  readonly track: MediaStreamTrack;
  readonly transceiver: TransceiverState;
}
