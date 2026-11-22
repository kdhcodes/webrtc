import { closedError, fromNative, invalidStateError } from './internal/errors.ts';
import {
  type RTCRtpCodec,
  type RTCRtpTransceiverDirection,
  toRTCRtpCodec,
  toRTCRtpTransceiverDirection,
} from './internal/generated/idl.ts';
import type { NativeRtpCodec, NativeTransceiver } from './internal/native-types.ts';
import type { RtpOwner, TransceiverState } from './internal/rtp-state.ts';
import { registerInterface, sequence } from './internal/webidl.ts';
import { markTrackEnded } from './MediaStreamTrack.ts';
import { type RTCRtpReceiver, receiverFromNative } from './RTCRtpReceiver.ts';
import { type RTCRtpSender, senderFromNative } from './RTCRtpSender.ts';

export type { RTCRtpCodec, RTCRtpTransceiverDirection };

const constructToken = Symbol('RTCRtpTransceiver');
const wrappers = new WeakMap<NativeTransceiver, RTCRtpTransceiver>();
const toCodecs = sequence(toRTCRtpCodec);
let stateOf: (transceiver: RTCRtpTransceiver) => TransceiverState;

/**
 * A sender and receiver pair sharing one m-line. Not constructible; get it
 * from addTransceiver(), getTransceivers() or a `track` event.
 *
 * `mid`, `direction` and `currentDirection` are the JS layer's record of
 * the state when the last description was applied (plus local changes),
 * not live libwebrtc reads.
 */
export class RTCRtpTransceiver {
  #state: TransceiverState;
  #sender: RTCRtpSender;
  #receiver: RTCRtpReceiver;

  static {
    stateOf = (transceiver) => transceiver.#state;
    registerInterface('RTCRtpTransceiver', (value) => #state in value);
  }

  /** @internal */
  constructor(...args: unknown[]) {
    if (args[0] !== constructToken) throw new TypeError('Illegal constructor');
    const [, owner, handle] = args as [symbol, RtpOwner, NativeTransceiver];
    const stopped = handle.stopped;
    this.#state = {
      native: handle,
      owner,
      kind: handle.receiver.track.kind,
      mid: handle.mid,
      direction: handle.direction,
      currentDirection: handle.currentDirection,
      firedDirection: null,
      stopped,
      stopping: handle.stopping || stopped,
      hasSent: handle.currentDirection === 'sendrecv' || handle.currentDirection === 'sendonly',
      remoteStreams: [],
      senderTransport: null,
      receiverTransport: null,
    };
    this.#sender = senderFromNative(owner, handle.sender, this.#state);
    this.#receiver = receiverFromNative(handle.receiver, this.#state);
  }

  get [Symbol.toStringTag](): string {
    return 'RTCRtpTransceiver';
  }

  get mid(): string | null {
    return this.#state.mid;
  }

  get sender(): RTCRtpSender {
    return this.#sender;
  }

  get receiver(): RTCRtpReceiver {
    return this.#receiver;
  }

  get direction(): RTCRtpTransceiverDirection {
    return this.#state.direction;
  }

  set direction(value: RTCRtpTransceiverDirection) {
    const direction = toRTCRtpTransceiverDirection(
      value,
      "Failed to set the 'direction' property on 'RTCRtpTransceiver'",
    );
    const state = this.#state;
    if (state.stopping) throw invalidStateError('The transceiver is stopping.');
    if (direction === 'stopped') {
      throw new TypeError(
        "Failed to set the 'direction' property on 'RTCRtpTransceiver': 'stopped' can't be set.",
      );
    }
    if (direction === state.direction) return;
    try {
      state.native.direction = direction;
    } catch (error) {
      throw fromNative(error);
    }
    state.direction = direction;
    state.owner.changed();
  }

  get currentDirection(): RTCRtpTransceiverDirection | null {
    return this.#state.currentDirection;
  }

  /**
   * Nonstandard (wrtc, and an older spec): true once the transceiver is
   * stopped for good.
   */
  get stopped(): boolean {
    return this.#state.stopped;
  }

  /**
   * Stops sending and receiving at once and removes the m-line at the next
   * negotiation. The receiver's track ends in a queued task, with an
   * `ended` event (webrtc-pc "stop sending and receiving").
   */
  stop(): void {
    const state = this.#state;
    if (state.owner.closed) throw closedError('stop');
    if (state.stopping) return;
    try {
      state.native.stop();
    } catch (error) {
      throw fromNative(error);
    }
    state.stopping = true;
    state.direction = 'stopped';
    state.owner.changed();
    markTrackEnded(this.#receiver.track);
  }

  /** An empty list restores libwebrtc's default codec order. */
  setCodecPreferences(codecs: Iterable<RTCRtpCodec>): void {
    const list = toCodecs(
      codecs,
      "Failed to execute 'setCodecPreferences' on 'RTCRtpTransceiver': parameter 1",
    );
    try {
      this.#state.native.setCodecPreferences(list as NativeRtpCodec[]);
    } catch (error) {
      throw fromNative(error, { INVALID_PARAMETER: 'InvalidModificationError' });
    }
    this.#state.owner.changed();
  }
}

/**
 * Internal: the one wrapper for a native transceiver handle, and whether
 * this call created it.
 */
export function transceiverFromNative(
  owner: RtpOwner,
  handle: NativeTransceiver,
): { transceiver: RTCRtpTransceiver; created: boolean } {
  let transceiver = wrappers.get(handle);
  if (transceiver) return { transceiver, created: false };
  transceiver = new RTCRtpTransceiver(constructToken, owner, handle);
  wrappers.set(handle, transceiver);
  return { transceiver, created: true };
}

/** Internal: the transceiver's state. */
export function transceiverStateOf(transceiver: RTCRtpTransceiver): TransceiverState {
  return stateOf(transceiver);
}
