import { closedError, domError, fromNative, invalidStateError } from './internal/errors.ts';
import {
  type RTCDegradationPreference as GeneratedDegradationPreference,
  type RTCRtpSendParameters as GeneratedSendParameters,
  type RTCRtpCapabilities,
  type RTCSetParameterOptions,
  toRTCRtpSendParameters,
  toRTCSetParameterOptions,
} from './internal/generated/idl.ts';
import { nativeCompletions, nativeTask } from './internal/native-tasks.ts';
import type { NativeSender } from './internal/native-types.ts';
import {
  negotiatedCodecs,
  presentEncodings,
  unpresentEncodings,
} from './internal/rtp-parameters.ts';
import type { RtpOwner, SenderState, TransceiverState } from './internal/rtp-state.ts';
import { interfaceType, registerInterface, requireArguments } from './internal/webidl.ts';
import type { MediaStream } from './MediaStream.ts';
import {
  type MediaStreamTrack,
  type MediaStreamTrackLike,
  nativeTrackOf,
  trackFromNative,
} from './MediaStreamTrack.ts';
import type { RTCDtlsTransport } from './RTCDtlsTransport.ts';
import { capabilities } from './RTCRtpReceiver.ts';
import { type RTCStatsReport, statsReportFromJson } from './RTCStatsReport.ts';

export type { RTCSetParameterOptions };

// Through getBuiltinModule rather than an import, like node:crypto in
// MediaStream.ts: node:util itself is always loaded, but importing it builds
// an ESM facade over it, which added about 2 ms to this package's import
// time on Linux.
function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  return process.getBuiltinModule('node:util').isDeepStrictEqual(a, b);
}

/**
 * The DOM lib's values, so our senders stay assignable to the DOM's
 * RTCRtpSender. The newer 'maintain-framerate-and-resolution' still passes
 * setParameters' runtime conversion.
 */
export type RTCDegradationPreference = Exclude<
  GeneratedDegradationPreference,
  'maintain-framerate-and-resolution'
>;

export interface RTCRtpSendParameters
  extends Omit<GeneratedSendParameters, 'degradationPreference'> {
  degradationPreference?: RTCDegradationPreference;
}

/** Anything with a sender's identity, as for MediaStreamTrackLike. */
export interface RTCRtpSenderLike {
  readonly track: MediaStreamTrackLike | null;
}

/** Anything with a stream's identity, as for MediaStreamTrackLike. */
export interface MediaStreamLike {
  readonly id: string;
}

const constructToken = Symbol('RTCRtpSender');

/**
 * What a video sender does until the app sets a degradationPreference
 * (divergence, user decision 2026-11-21; SPEC-LAYER-PLAN.md, "Video send
 * path"): keep the pushed size, as wrtc did, rather than libwebrtc's and
 * Chrome's 'maintain-framerate', which starts a single layer small and
 * steps up only as quality allows. Frame rate still gives (maxFramerate,
 * CPU), and simulcast still drops layers under low bandwidth.
 */
const DEFAULT_DEGRADATION = 'maintain-resolution';
const wrappers = new WeakMap<NativeSender, RTCRtpSender>();
const toTrack = interfaceType('MediaStreamTrack') as (v: unknown, c: string) => MediaStreamTrack;
const toStream = interfaceType('MediaStream') as (v: unknown, c: string) => MediaStream;
let stateOf: (sender: RTCRtpSender) => SenderState;
let isSender: (value: object) => boolean;

/**
 * Sends one transceiver's media. Not constructible; get it from addTrack(),
 * a transceiver or getSenders().
 *
 * `track` is the JS layer's own record (the spec's [[SenderTrack]]), so it
 * keeps its value after the peer connection closes.
 */
export class RTCRtpSender {
  #state: SenderState;

  static {
    stateOf = (sender) => sender.#state;
    isSender = (value) => #state in value;
    registerInterface('RTCRtpSender', isSender);
  }

  /** @internal */
  constructor(...args: unknown[]) {
    if (args[0] !== constructToken) throw new TypeError('Illegal constructor');
    const [, owner, handle, transceiver] = args as [
      symbol,
      RtpOwner,
      NativeSender,
      TransceiverState,
    ];
    this.#state = {
      native: handle,
      owner,
      transceiver,
      track: handle.track ? trackFromNative(handle.track) : null,
      lastReturnedParameters: null,
      lastReturnedAt: 0,
      synthesizedScales: false,
      envelope: null,
      degradationSet: false,
    };
    // Every sender reaches JS here before it can send: from addTrack() or
    // addTransceiver(), or in the description that created its transceiver.
    // Native objects re-wrapped later keep what they have (only an unset
    // preference is filled in).
    if (transceiver.kind === 'video') {
      try {
        handle.setDefaultDegradationPreference(DEFAULT_DEGRADATION);
      } catch {}
    }
  }

  static getCapabilities(...args: [kind: string]): RTCRtpCapabilities | null {
    requireArguments(args.length, 1, 'getCapabilities', 'RTCRtpSender');
    return capabilities('sender', args[0], 'RTCRtpSender');
  }

  get [Symbol.toStringTag](): string {
    return 'RTCRtpSender';
  }

  get track(): MediaStreamTrack | null {
    return this.#state.track;
  }

  /**
   * The DTLS transport the sender sends on: null until a description
   * negotiated one, shared by everything BUNDLEd on it, and the same object
   * for as long as libwebrtc keeps that transport (ICE restarts included).
   */
  get transport(): RTCDtlsTransport | null {
    return this.#state.transceiver.senderTransport;
  }

  /** DTMF isn't supported; always null. */
  get dtmf(): null {
    this.#state; // WebIDL's brand check: a foreign `this` throws a TypeError.
    return null;
  }

  /** Encoded transforms aren't supported; always null. */
  get transform(): null {
    this.#state; // WebIDL's brand check: a foreign `this` throws a TypeError.
    return null;
  }

  set transform(_value: null) {}

  /**
   * The current parameters. Pass this object (modified) to setParameters()
   * within the same task: a task later it is stale (the spec). Calls in the
   * same task return the same values (and transactionId).
   */
  getParameters(): RTCRtpSendParameters {
    const state = this.#state;
    const cached = lastReturned(state);
    if (cached !== null) return structuredClone(cached) as unknown as RTCRtpSendParameters;
    let parameters: Record<string, unknown>;
    try {
      parameters = state.native.getParameters();
    } catch (error) {
      throw fromNative(error);
    }
    const { kind } = state.transceiver;
    // Our default isn't shown, as Chrome shows none for its own.
    if (!state.degradationSet) delete parameters.degradationPreference;
    const encodings = (parameters.encodings ?? []) as Record<string, unknown>[];
    state.envelope ??= encodings.every((e) => typeof e.rid === 'string')
      ? encodings.map((e) => e.rid as string)
      : [];
    const presented = presentEncodings(encodings, kind, state.envelope);
    state.synthesizedScales = presented.synthesized;
    parameters.encodings = presented.encodings;
    parameters.codecs = negotiatedCodecs(
      state.owner.currentSdp('remote'),
      state.transceiver.mid,
      kind,
      'sender',
    );
    state.lastReturnedParameters = structuredClone(parameters);
    state.lastReturnedAt = nativeCompletions();
    const returned = state.lastReturnedParameters;
    // "Queue a task that sets [[LastReturnedParameters]] to null": behind
    // the native events already queued, which a setImmediate would run
    // ahead of (WPT's setParameters-encodings fences with another
    // connection's negotiationneeded).
    state.owner.queueTask(() => {
      if (state.lastReturnedParameters === returned) state.lastReturnedParameters = null;
    });
    return parameters as unknown as RTCRtpSendParameters;
  }

  /**
   * Applies the writable members (encodings' bitrate, framerate, scaling,
   * active and priority, and degradationPreference). Changing anything
   * read-only, or passing parameters from an earlier task, rejects.
   */
  setParameters(
    parameters: RTCRtpSendParameters,
    setParameterOptions?: RTCSetParameterOptions,
  ): Promise<void> {
    const state = this.#state;
    let converted: GeneratedSendParameters;
    try {
      const context = "Failed to execute 'setParameters' on 'RTCRtpSender'";
      converted = toRTCRtpSendParameters(parameters, `${context}: parameter 1`);
      toRTCSetParameterOptions(setParameterOptions, `${context}: parameter 2`);
    } catch (error) {
      return Promise.reject(error);
    }
    if (state.transceiver.stopping) {
      return Promise.reject(invalidStateError('The transceiver is stopping.'));
    }
    const last = lastReturned(state);
    if (last === null) {
      return Promise.reject(
        invalidStateError(
          'getParameters() must be called in the same task before setParameters().',
        ),
      );
    }
    if (state.transceiver.kind === 'audio') {
      // The spec removes them (so invalid values pass) rather than rejecting.
      converted.encodings = converted.encodings.map(
        ({ scaleResolutionDownBy, maxFramerate, ...rest }) => rest,
      );
    }
    let problem: Error | null;
    try {
      problem = checkParameters(converted, toRTCRtpSendParameters(last));
    } catch (error) {
      return Promise.reject(error);
    }
    if (problem) return Promise.reject(problem);
    const toNative: Record<string, unknown> = {
      ...converted,
      encodings: unpresentEncodings(
        converted.encodings as unknown as Record<string, unknown>[],
        last.encodings as Record<string, unknown>[],
        state.synthesizedScales,
      ),
    };
    // Leaving degradationPreference out goes back to the default, which for
    // video is ours, not libwebrtc's.
    const degradationSet = converted.degradationPreference !== undefined;
    if (!degradationSet && state.transceiver.kind === 'video') {
      toNative.degradationPreference = DEFAULT_DEGRADATION;
    }
    return nativeTask(state.native.setParameters(toNative)).then(
      () => {
        state.lastReturnedParameters = null;
        state.degradationSet = degradationSet;
      },
      (error) => {
        throw fromNative(error, { INVALID_PARAMETER: 'OperationError' });
      },
    );
  }

  /**
   * Swaps the track without renegotiation. Chained on the peer connection's
   * operations chain; `null` stops sending.
   */
  replaceTrack(...args: [withTrack: MediaStreamTrackLike | null]): Promise<void> {
    const state = this.#state;
    const [withTrack] = args;
    let track: MediaStreamTrack | null;
    try {
      requireArguments(args.length, 1, 'replaceTrack', 'RTCRtpSender');
      track =
        withTrack === null || withTrack === undefined
          ? null
          : toTrack(withTrack, "Failed to execute 'replaceTrack' on 'RTCRtpSender': parameter 1");
    } catch (error) {
      return Promise.reject(error);
    }
    if (track && track.kind !== state.transceiver.kind) {
      return Promise.reject(
        new TypeError(
          `Failed to execute 'replaceTrack' on 'RTCRtpSender': A ${track.kind} track can't replace a ${state.transceiver.kind} track.`,
        ),
      );
    }
    const nativeTrack = track ? (nativeTrackOf(track) ?? null) : null;
    return state.owner.chain('replaceTrack', async () => {
      if (state.transceiver.stopping) throw invalidStateError('The transceiver is stopping.');
      try {
        state.native.replaceTrack(nativeTrack);
      } catch (error) {
        throw fromNative(error);
      }
      // The spec sets [[SenderTrack]] in a queued task, then resolves, even
      // if addTrack() or removeTrack() changed it meanwhile (Chrome shows
      // the same). They changed the native sender's track after we did,
      // possibly back to the one it had (removeTrack, then addTrack of the
      // same track), so ask libwebrtc and set it again if it differs: the
      // cache must say what libwebrtc sends.
      await new Promise((resolve) => setImmediate(resolve));
      if (state.owner.closed) return;
      // A stopping sender sends nothing (and libwebrtc would throw).
      if (!state.transceiver.stopping && state.native.track !== nativeTrack) {
        try {
          state.native.replaceTrack(nativeTrack);
        } catch (error) {
          throw fromNative(error);
        }
      }
      state.track = track;
    });
  }

  /** Sets the stream ids the remote side's track events will carry. */
  setStreams(...streams: MediaStreamLike[]): void {
    const state = this.#state;
    if (state.owner.closed) throw closedError('setStreams');
    const ids = new Set(
      streams.map(
        (stream, i) =>
          toStream(stream, `Failed to execute 'setStreams' on 'RTCRtpSender': parameter ${i + 1}`)
            .id,
      ),
    );
    try {
      state.native.setStreams([...ids]);
    } catch (error) {
      throw fromNative(error);
    }
    state.owner.changed();
  }

  /** Works after the peer connection is closed. */
  async getStats(): Promise<RTCStatsReport> {
    try {
      return statsReportFromJson(await nativeTask(this.#state.native.getStats()));
    } catch (error) {
      throw fromNative(error);
    }
  }
}

/**
 * [[LastReturnedParameters]], or null once a task has cleared it: the one
 * getParameters() queued, or a native result (a description applied, an
 * offer created) delivered before that.
 */
function lastReturned(state: SenderState): Record<string, unknown> | null {
  if (state.lastReturnedParameters !== null && state.lastReturnedAt !== nativeCompletions()) {
    state.lastReturnedParameters = null;
  }
  return state.lastReturnedParameters;
}

/** The spec's setParameters validation against [[LastReturnedParameters]]. */
function checkParameters(
  next: GeneratedSendParameters,
  last: GeneratedSendParameters,
): Error | null {
  const modified = (what: string) =>
    domError('InvalidModificationError', `setParameters: ${what} can't be modified.`);
  if (next.transactionId !== last.transactionId) return modified('transactionId');
  if (next.encodings.length !== last.encodings.length) return modified('the number of encodings');
  for (const [i, encoding] of next.encodings.entries()) {
    if (encoding.rid !== last.encodings[i]?.rid) return modified(`encodings[${i}].rid`);
  }
  if (!isDeepStrictEqual(next.rtcp, last.rtcp)) return modified('rtcp');
  if (!isDeepStrictEqual(next.headerExtensions, last.headerExtensions)) {
    return modified('headerExtensions');
  }
  if (!isDeepStrictEqual(next.codecs, last.codecs)) return modified('codecs');
  for (const [i, encoding] of next.encodings.entries()) {
    if (encoding.scaleResolutionDownBy !== undefined && encoding.scaleResolutionDownBy < 1) {
      return new RangeError(`encodings[${i}].scaleResolutionDownBy must be at least 1.`);
    }
    if (encoding.maxFramerate !== undefined && encoding.maxFramerate < 0) {
      return new RangeError(`encodings[${i}].maxFramerate must not be negative.`);
    }
  }
  return null;
}

/** Internal: the one wrapper for a native sender handle. */
export function senderFromNative(
  owner: RtpOwner,
  handle: NativeSender,
  transceiver: TransceiverState,
): RTCRtpSender {
  let sender = wrappers.get(handle);
  if (!sender) {
    sender = new RTCRtpSender(constructToken, owner, handle, transceiver);
    wrappers.set(handle, sender);
  }
  return sender;
}

/** Internal: the sender's state, or undefined for anything else. */
export function senderStateOf(value: unknown): SenderState | undefined {
  if (typeof value !== 'object' || value === null || !isSender(value)) return undefined;
  return stateOf(value as RTCRtpSender);
}
