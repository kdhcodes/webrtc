import { fromNative } from './internal/errors.ts';
import type {
  RTCRtpCapabilities,
  RTCRtpContributingSource,
  RTCRtpReceiveParameters,
  RTCRtpSynchronizationSource,
} from './internal/generated/idl.ts';
import { native } from './internal/native.ts';
import { nativeTask } from './internal/native-tasks.ts';
import type { NativeReceiver } from './internal/native-types.ts';
import { negotiatedCodecs } from './internal/rtp-parameters.ts';
import type { ReceiverState, TransceiverState } from './internal/rtp-state.ts';
import {
  DOMString,
  registerInterface,
  requireArguments,
  unrestrictedDouble,
} from './internal/webidl.ts';
import { initRemoteTrack, type MediaStreamTrack, trackFromNative } from './MediaStreamTrack.ts';
import type { RTCDtlsTransport } from './RTCDtlsTransport.ts';
import { type RTCStatsReport, statsReportFromJson } from './RTCStatsReport.ts';

export type { RTCRtpCapabilities, RTCRtpReceiveParameters };

const constructToken = Symbol('RTCRtpReceiver');
const wrappers = new WeakMap<NativeReceiver, RTCRtpReceiver>();
let stateOf: (receiver: RTCRtpReceiver) => ReceiverState;

/** The capabilities libwebrtc has for `side`, or null for an unknown kind. */
export function capabilities(
  side: 'sender' | 'receiver',
  kind: unknown,
  what: string,
): RTCRtpCapabilities | null {
  const k = DOMString(kind, `Failed to execute 'getCapabilities' on '${what}': parameter 1`);
  if (k !== 'audio' && k !== 'video') return null;
  return native.getRtpCapabilities(side, k) as RTCRtpCapabilities | null;
}

/**
 * Receives one transceiver's media. Not constructible; get it from a
 * transceiver, getReceivers() or a `track` event. `track` is the same
 * MediaStreamTrack object for the receiver's whole life. It starts muted,
 * unmutes when the first packet arrives after the transceiver starts
 * receiving, and mutes when a description stops it receiving.
 */
export class RTCRtpReceiver {
  #state: ReceiverState;
  #jitterBufferTarget: number | null = null;

  static {
    stateOf = (receiver) => receiver.#state;
    registerInterface('RTCRtpReceiver', (value) => #state in value);
  }

  /** @internal */
  constructor(...args: unknown[]) {
    if (args[0] !== constructToken) throw new TypeError('Illegal constructor');
    const [, handle, transceiver] = args as [symbol, NativeReceiver, TransceiverState];
    const track = trackFromNative(handle.track);
    // Muted until media arrives (the spec's "create an RTCRtpReceiver").
    initRemoteTrack(track);
    this.#state = { native: handle, track, transceiver };
  }

  static getCapabilities(...args: [kind: string]): RTCRtpCapabilities | null {
    requireArguments(args.length, 1, 'getCapabilities', 'RTCRtpReceiver');
    return capabilities('receiver', args[0], 'RTCRtpReceiver');
  }

  get [Symbol.toStringTag](): string {
    return 'RTCRtpReceiver';
  }

  get track(): MediaStreamTrack {
    return this.#state.track;
  }

  /** The DTLS transport the receiver receives on (see RTCRtpSender.transport). */
  get transport(): RTCDtlsTransport | null {
    return this.#state.transceiver.receiverTransport;
  }

  /** Encoded transforms aren't supported; always null. */
  get transform(): null {
    this.#state; // WebIDL's brand check: a foreign `this` throws a TypeError.
    return null;
  }

  set transform(_value: null) {
    this.#state; // WebIDL's brand check: a foreign `this` throws a TypeError.
  }

  /**
   * Validated as in the spec (0 to 4000 ms) and passed to libwebrtc as the
   * jitter buffer's minimum delay, as Chrome does; null restores libwebrtc's
   * default. It reads back what was set, not the delay libwebrtc reaches.
   */
  get jitterBufferTarget(): number | null {
    return this.#jitterBufferTarget;
  }

  set jitterBufferTarget(value: number | null) {
    const { native } = this.#state; // Also WebIDL's brand check.
    let ms: number | null = null;
    if (value !== null) {
      ms = unrestrictedDouble(value, "Failed to set 'jitterBufferTarget'");
      if (!(ms >= 0 && ms <= 4000)) {
        throw new RangeError(`jitterBufferTarget ${ms} is outside the range [0, 4000]`);
      }
    }
    native.setJitterBufferMinimumDelay(ms === null ? null : ms / 1000);
    this.#jitterBufferTarget = ms;
  }

  /** The codecs are the ones the current local description negotiated. */
  getParameters(): RTCRtpReceiveParameters {
    let parameters: Record<string, unknown>;
    try {
      parameters = this.#state.native.getParameters();
    } catch (error) {
      throw fromNative(error);
    }
    const { transceiver } = this.#state;
    parameters.codecs = negotiatedCodecs(
      transceiver.owner.currentSdp('local'),
      transceiver.mid,
      transceiver.kind,
      'receiver',
    );
    return parameters as unknown as RTCRtpReceiveParameters;
  }

  /** The CSRCs of packets received in the last 10 s (libwebrtc's GetSources()). */
  getContributingSources(): RTCRtpContributingSource[] {
    return this.#sources('csrc');
  }

  /** The SSRCs of packets received in the last 10 s (libwebrtc's GetSources()). */
  getSynchronizationSources(): RTCRtpSynchronizationSource[] {
    return this.#sources('ssrc');
  }

  /**
   * `timestamp` is when the source's last packet arrived, as
   * `performance.timeOrigin + performance.now()` then; `audioLevel` is
   * RFC 6464's -dBov converted to linear (127 is silence, 0), as webrtc-pc
   * and Chrome do, and only there when the packet carried the extension.
   */
  #sources(type: 'ssrc' | 'csrc'): RTCRtpContributingSource[] {
    const { native } = this.#state; // WebIDL's brand check first.
    const now = performance.timeOrigin + performance.now();
    const sources: RTCRtpContributingSource[] = [];
    for (const entry of native.getSources()) {
      if (entry.type !== type) continue;
      const source: RTCRtpContributingSource = {
        timestamp: now - entry.age,
        source: entry.source,
        rtpTimestamp: entry.rtpTimestamp,
      };
      if (entry.audioLevel !== undefined && this.track.kind === 'audio') {
        source.audioLevel = entry.audioLevel >= 127 ? 0 : 10 ** (-entry.audioLevel / 20);
      }
      sources.push(source);
    }
    return sources;
  }

  /** Works after the peer connection is closed. Empty until packets arrive. */
  async getStats(): Promise<RTCStatsReport> {
    try {
      return statsReportFromJson(await nativeTask(this.#state.native.getStats()));
    } catch (error) {
      throw fromNative(error);
    }
  }
}

/** Internal: the wrapper for a native receiver handle, if there is one yet. */
export function wrappedReceiver(handle: NativeReceiver): RTCRtpReceiver | undefined {
  return wrappers.get(handle);
}

/** Internal: the one wrapper for a native receiver handle. */
export function receiverFromNative(
  handle: NativeReceiver,
  transceiver: TransceiverState,
): RTCRtpReceiver {
  let receiver = wrappers.get(handle);
  if (!receiver) {
    receiver = new RTCRtpReceiver(constructToken, handle, transceiver);
    wrappers.set(handle, receiver);
  }
  return receiver;
}

/** Internal: the native handle behind a receiver. */
export function nativeReceiverOf(receiver: RTCRtpReceiver): NativeReceiver {
  return stateOf(receiver).native;
}
