/**
 * A scriptable fake of the native addon, for unit tests that need orderings
 * or failures real libwebrtc can't produce on demand (SPEC-LAYER-PLAN.md,
 * "Testing layers"). Not part of the published build.
 *
 * It is a stub, not a simulation: no SDP, no negotiation. Every async
 * method stays pending until the test settles it, every event is one the
 * test emits, and every live getter reads a field the test sets. Tests that
 * need libwebrtc's real behaviour belong in test/native or test/integration.
 * The exceptions are the synchronous rules a JS-layer test could otherwise
 * get wrong without noticing: addTrack's transceiver reuse, removeTrack,
 * transceiver stop() and the direction setter, close(), and
 * shouldFireNegotiationNeededEvent(). Those follow libwebrtc, and
 * test/native/fake-native-drift.test.ts runs the same scenarios against the
 * real addon so the two can't drift apart.
 *
 * The fakes `implements` the interfaces in native-types.ts, so a contract
 * change is a compile error here first.
 *
 * Timing: the real addon delivers every event and every op completion of a
 * peer connection as its own task (a TSFN call, run in a callback scope that
 * drains microtasks afterwards), in one order shared by all the PCs of an
 * environment. The fake models that with one `setImmediate` per delivery
 * (one queue for every fake), in the order the test queued them, the JS
 * layer's `queueTask()`s included (a `next` one from an onEvent callback
 * right after that delivery, in the order queued):
 * `emit()`, `resolve()` and `reject()` never call into JS synchronously,
 * and the microtasks one delivery causes (the JS layer's `await`
 * continuations) all run before the next delivery. `flush()` waits until
 * everything queued so far has been delivered. Sink fakes are simpler:
 * `deliver()` calls the callback synchronously, because the JS sinks
 * don't depend on task boundaries.
 *
 * Immediate rejections: some failures never go through the queue. The real
 * addon returns an already-rejected promise, at call time, for:
 * - SDP and candidate parse failures (`SYNTAX_ERROR`, with `sdpLine`). They
 *   are checked first, so they win even on a closed PC.
 * - any async op but `getStats()` on a closed PC (`INVALID_STATE`,
 *   `'peer connection is closed'`). The fake does this one itself.
 * - `TypeError`s for arguments of the wrong type.
 * `stub(method, () => Promise.reject(nativeError(...)))` models one;
 * `pending(method).reject(...)` models a rejection libwebrtc delivers later.
 *
 * Real orders the test must reproduce (checked against the addon; the
 * `complete*Description()` helpers do this for you):
 * - setLocalDescription: every `removetrack` (when applying a local answer
 *   stops receiving: these come **before** the state change, unlike SRD),
 *   then `signalingstatechange`, then the completion, then
 *   `icegatheringstatechange` and the `icecandidate` events. So the JS layer
 *   must buffer track events for any in-flight SLD or SRD.
 * - setRemoteDescription: `signalingstatechange`, then every `track`, then
 *   every `removetrack`, then the completion. It is one FIFO, so `track`
 *   always precedes the SRD completion.
 * - close(): `connectionstatechange` ('closed'), then `signalingstatechange`
 *   ('closed'). No `iceconnectionstatechange`.
 */
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { native } from '../native.ts';
import type {
  NativeAudioData,
  NativeConfiguration,
  NativeDataChannel,
  NativeDataChannelInit,
  NativeDescriptionSnapshot,
  NativeError,
  NativeErrorType,
  NativeGeneratedCertificate,
  NativeIceConnectionState,
  NativeIceGatheringState,
  NativeMediaKind,
  NativeModule,
  NativePcEvent,
  NativePeerConnection,
  NativePeerConnectionState,
  NativeReceiver,
  NativeRtpSource,
  NativeSender,
  NativeSignalingState,
  NativeSink,
  NativeTrack,
  NativeTransceiver,
  NativeTransceiverDirection,
  NativeTransceiverState,
  NativeVideoFrame,
  NativeVideoSink,
} from '../native-types.ts';

// ---------------------------------------------------------------------------
// Method typing helpers

type AnyMethod = (...args: never[]) => unknown;
type AsyncMethod = (...args: never[]) => Promise<unknown>;

/** Names of the methods of interface `I`. */
export type MethodOf<I> = { [K in keyof I]-?: I[K] extends AnyMethod ? K : never }[keyof I] &
  string;
/** Names of the methods of `I` that return a promise. */
export type AsyncMethodOf<I> = {
  [K in keyof I]-?: I[K] extends AsyncMethod ? K : never;
}[keyof I] &
  string;
/** The argument list of `I[K]`. */
export type ArgsOf<I, K extends keyof I> = I[K] extends (...args: infer A) => unknown ? A : never;
/** What the promise returned by `I[K]` resolves to. */
export type ResolvesTo<I, K extends keyof I> = I[K] extends (...args: never[]) => Promise<infer R>
  ? R
  : never;

// ---------------------------------------------------------------------------
// The per-PC stream

/** One recorded method call. */
export interface FakeCall {
  /** The fake whose method was called. */
  readonly target: object;
  readonly method: string;
  /** Exactly the arguments passed (an omitted optional argument is absent). */
  readonly args: readonly unknown[];
}

/** Every fake's deliveries, in delivery order (the real EventOrder). */
const deliveries: (() => void)[] = [];
/**
 * While a delivery runs (synchronously, not its microtasks): where the next
 * `next` delivery goes, so those it queues keep their order.
 */
let nextInsert: number | null = null;

/** Runs the first delivery, as each of the real addon's wakes does. */
function deliverFirst(): void {
  const run = deliveries.shift();
  if (!run) return;
  nextInsert = 0;
  try {
    run();
  } finally {
    nextInsert = null;
  }
}

/**
 * One peer connection's ordered delivery queue and call log, shared by the
 * PC and the transceivers, senders, receivers and data channels it creates
 * (their ops complete on the same native queue).
 */
export class FakeStream {
  /** Every call on the fakes sharing this stream, in call order. */
  readonly calls: FakeCall[] = [];
  /**
   * Set by the PC's close(). From then on every async op but getStats()
   * rejects at call time, as in the real addon.
   */
  closed = false;
  #queued = 0;

  /**
   * Runs `deliver` in its own task, after everything queued before it. With
   * `next` during a delivery (the real addon's `queueTask(id, true)` from
   * an onEvent callback), right after that delivery instead, after the
   * other `next` ones it queued; elsewhere `next` is ignored, as there.
   */
  enqueue(deliver: () => void, next = false): void {
    this.#queued++;
    const run = () => {
      this.#queued--;
      deliver();
    };
    if (next && nextInsert !== null) {
      deliveries.splice(nextInsert++, 0, run);
    } else {
      deliveries.push(run);
    }
    setImmediate(deliverFirst);
  }

  /**
   * Resolves once everything queued so far, and anything those deliveries
   * queue in turn, has been delivered and its microtasks have run.
   */
  async flush(): Promise<void> {
    do {
      // Immediates run in FIFO order with microtasks drained between them,
      // so this one runs after every delivery queued before it.
      await new Promise((resolve) => setImmediate(resolve));
    } while (this.#queued > 0);
  }
}

/** An async call the test settles. */
export interface PendingCall<A extends readonly unknown[], T> {
  readonly method: string;
  readonly args: A;
  /** Queues the promise's resolution as the next delivery on the stream. */
  resolve(value: T): void;
  /** Queues the promise's rejection, e.g. with `nativeError(...)`. */
  reject(error: unknown): void;
}

interface PendingEntry {
  method: string;
  args: readonly unknown[];
  settled: boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * Common machinery: call recording, pending async calls and stubs, typed
 * against the native interface `I` the subclass implements.
 */
abstract class FakeObject<I> {
  readonly stream: FakeStream;
  #pending: PendingEntry[] = [];
  #stubs = new Map<string, (...args: never[]) => unknown>();

  constructor(stream: FakeStream) {
    this.stream = stream;
  }

  /** This object's calls, in order (`stream.calls` has every object's). */
  get calls(): FakeCall[] {
    return this.stream.calls.filter((call) => call.target === this);
  }

  /** The arguments of each call of `method` on this object, in order. */
  callsTo<K extends MethodOf<I>>(method: K): ArgsOf<I, K>[] {
    return this.calls
      .filter((call) => call.method === method)
      .map((call) => call.args as ArgsOf<I, K>);
  }

  /** How many async calls (of `method`, or of any method) are unsettled. */
  pendingCount(method?: AsyncMethodOf<I>): number {
    return this.#pending.filter((p) => !p.settled && (method === undefined || p.method === method))
      .length;
  }

  /**
   * The oldest unsettled call of `method`. Throws if there is none, listing
   * what was called, so a test fails where the JS layer didn't call.
   */
  pending<K extends AsyncMethodOf<I>>(method: K): PendingCall<ArgsOf<I, K>, ResolvesTo<I, K>> {
    const entry = this.#pending.find((p) => !p.settled && p.method === method);
    if (!entry) {
      const called = this.calls.map((call) => call.method).join(', ') || 'nothing';
      throw new Error(
        `${this.constructor.name}: no unsettled ${method}() call (calls so far: ${called})`,
      );
    }
    const settle = (deliver: () => void) => {
      if (entry.settled) throw new Error(`${method}() was already settled`);
      entry.settled = true;
      this.stream.enqueue(deliver);
    };
    return {
      method,
      args: entry.args as ArgsOf<I, K>,
      resolve: (value) => settle(() => entry.resolve(value)),
      reject: (error) => settle(() => entry.reject(error)),
    };
  }

  /**
   * Replaces `method`'s behaviour (calls are still recorded). For an async
   * method the stub's promise is returned instead of a pending call.
   */
  stub<K extends MethodOf<I>>(method: K, impl: I[K]): void {
    this.#stubs.set(method, impl as (...args: never[]) => unknown);
  }

  /** Records a sync call and runs its stub, or `fallback`. */
  protected call<R>(
    method: MethodOf<I> | AsyncMethodOf<I>,
    args: readonly unknown[],
    fallback: () => R,
  ): R {
    this.stream.calls.push({ target: this, method, args });
    const stub = this.#stubs.get(method);
    return stub ? (stub.apply(this, args as never[]) as R) : fallback();
  }

  /**
   * Records an async call and returns a promise the test settles. On a
   * closed stream it rejects at call time instead, unless `worksAfterClose`.
   */
  protected callAsync<R>(
    method: AsyncMethodOf<I>,
    args: readonly unknown[],
    worksAfterClose = false,
  ): Promise<R> {
    return this.call(method, args, () => {
      if (this.stream.closed && !worksAfterClose) {
        return Promise.reject(nativeError('INVALID_STATE', 'peer connection is closed'));
      }
      const { promise, resolve, reject } = Promise.withResolvers<R>();
      this.#pending.push({
        method,
        args,
        settled: false,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      return promise;
    });
  }
}

// ---------------------------------------------------------------------------
// Media

/** A track handle: stable identity, settable fields, no source. */
export class FakeTrack implements NativeTrack {
  id: string;
  kind: NativeMediaKind;
  enabled = true;
  /** Tracks returned by clone(), in order. */
  readonly clones: FakeTrack[] = [];

  constructor(kind: NativeMediaKind = 'audio', id: string = randomUUID()) {
    this.kind = kind;
    this.id = id;
  }

  clone(): FakeTrack {
    const clone = new FakeTrack(this.kind);
    this.clones.push(clone);
    return clone;
  }
}

/** Base of the sink fakes: `deliver()` calls the JS callback synchronously. */
class FakeSink<D> implements NativeSink {
  readonly track: NativeTrack;
  /** How often stop() was called. */
  stopCount = 0;
  readonly #callback: (data: D) => void;

  constructor(track: NativeTrack, callback: (data: D) => void) {
    this.track = track;
    this.#callback = callback;
  }

  deliver(data: D): void {
    this.#callback(data);
  }

  stop(): void {
    this.stopCount++;
  }
}

/** For `useFakeNative(t, { AudioSink: FakeAudioSink })`. */
export class FakeAudioSink extends FakeSink<NativeAudioData> {}

/**
 * For `useFakeNative(t, { VideoSink: FakeVideoSink })`. `framesDropped` is
 * the test's to set: `deliver()` never drops.
 */
export class FakeVideoSink extends FakeSink<NativeVideoFrame> implements NativeVideoSink {
  framesDropped = 0;
}

// ---------------------------------------------------------------------------
// RTP objects

type SenderArgs<K extends keyof NativeSender> = ArgsOf<NativeSender, K>;

/** The values native's DegradationFromString accepts. */
const degradationPreferences = new Set([
  'maintain-framerate-and-resolution',
  'maintain-framerate',
  'maintain-resolution',
  'balanced',
]);

export class FakeSender extends FakeObject<NativeSender> implements NativeSender {
  track: NativeTrack | null;
  /** What getParameters() returns. */
  parameters: Record<string, unknown> = {};
  /** Set when its transceiver stops; replaceTrack() then throws, as in libwebrtc. */
  stopping = false;

  constructor(stream: FakeStream = new FakeStream(), track: NativeTrack | null = null) {
    super(stream);
    this.track = track;
  }

  /**
   * Sets `track` (unless stubbed). On a stopping sender it throws
   * INVALID_STATE, as libwebrtc does; the JS layer checks [[Stopping]] first.
   */
  replaceTrack(...args: SenderArgs<'replaceTrack'>): void {
    this.call('replaceTrack', args, () => {
      if (this.stopping) {
        throw nativeError('INVALID_STATE', "failed to replace the sender's track");
      }
      this.track = args[0];
    });
  }

  getParameters(...args: SenderArgs<'getParameters'>): Record<string, unknown> {
    return this.call('getParameters', args, () => this.parameters);
  }

  setParameters(...args: SenderArgs<'setParameters'>): Promise<void> {
    return this.callAsync('setParameters', args);
  }

  setDefaultDegradationPreference(...args: SenderArgs<'setDefaultDegradationPreference'>): void {
    this.call('setDefaultDegradationPreference', args, () => {
      const [preference] = args;
      if (!degradationPreferences.has(preference)) {
        throw new TypeError('invalid degradationPreference');
      }
      // As native: fills it in only if none is set.
      this.parameters.degradationPreference ??= preference;
    });
  }

  setStreams(...args: SenderArgs<'setStreams'>): void {
    this.call('setStreams', args, () => {});
  }

  getStats(...args: SenderArgs<'getStats'>): Promise<string> {
    return this.callAsync('getStats', args, true);
  }
}

type ReceiverArgs<K extends keyof NativeReceiver> = ArgsOf<NativeReceiver, K>;

export class FakeReceiver extends FakeObject<NativeReceiver> implements NativeReceiver {
  track: NativeTrack;
  /** What getParameters() returns. */
  parameters: Record<string, unknown> = {};

  constructor(stream: FakeStream = new FakeStream(), track: NativeTrack = new FakeTrack()) {
    super(stream);
    this.track = track;
  }

  getParameters(...args: ReceiverArgs<'getParameters'>): Record<string, unknown> {
    return this.call('getParameters', args, () => this.parameters);
  }

  /** Throws the addon's TypeError for anything but null or a number >= 0. */
  setJitterBufferMinimumDelay(...args: ReceiverArgs<'setJitterBufferMinimumDelay'>): void {
    this.call('setJitterBufferMinimumDelay', args, () => {
      const [seconds] = args as unknown[];
      if (seconds === null) return;
      if (typeof seconds !== 'number') throw new TypeError('seconds must be a number or null');
      if (!(seconds >= 0)) throw new TypeError('seconds must be a non-negative number');
    });
  }

  getStats(...args: ReceiverArgs<'getStats'>): Promise<string> {
    return this.callAsync('getStats', args, true);
  }

  /** What getSources() returns. */
  sources: NativeRtpSource[] = [];

  getSources(...args: ReceiverArgs<'getSources'>): NativeRtpSource[] {
    return this.call('getSources', args, () => this.sources);
  }
}

export interface FakeTransceiverInit {
  kind?: NativeMediaKind;
  /** The sender's track. */
  track?: NativeTrack | null;
  direction?: NativeTransceiverDirection;
}

type TransceiverArgs<K extends keyof NativeTransceiver> = ArgsOf<NativeTransceiver, K>;

/**
 * Every field is settable; `direction` goes through libwebrtc's checks (it
 * rejects a stopping transceiver and the value 'stopped'), so script it
 * with forceDirection(). As in libwebrtc, stop() sets `stopping` and
 * `direction` 'stopped'; `stopped` waits for negotiation, which the test
 * scripts. setCodecPreferences() only records.
 */
export class FakeTransceiver extends FakeObject<NativeTransceiver> implements NativeTransceiver {
  readonly kind: NativeMediaKind;
  mid: string | null = null;
  stopped = false;
  stopping = false;
  sender: FakeSender;
  receiver: FakeReceiver;
  /**
   * libwebrtc's has_ever_been_used_to_send: once set, addTrack won't reuse
   * this transceiver. Setting `currentDirection` to 'sendrecv' or
   * 'sendonly' sets it, as negotiating that does in libwebrtc.
   */
  hasEverBeenUsedToSend = false;
  #direction: NativeTransceiverDirection;
  #currentDirection: NativeTransceiverDirection | null = null;

  constructor(stream: FakeStream = new FakeStream(), init: FakeTransceiverInit = {}) {
    super(stream);
    this.kind = init.kind ?? init.track?.kind ?? 'audio';
    this.#direction = init.direction ?? 'sendrecv';
    this.sender = new FakeSender(stream, init.track ?? null);
    this.receiver = new FakeReceiver(stream, new FakeTrack(this.kind));
  }

  get direction(): NativeTransceiverDirection {
    return this.#direction;
  }

  /** libwebrtc's checks and messages. To script any value, use forceDirection(). */
  set direction(direction: NativeTransceiverDirection) {
    if (this.stopping) {
      throw nativeError('INVALID_STATE', 'Cannot set direction on a stopping transceiver.');
    }
    if (direction === 'stopped') {
      throw nativeError('INVALID_PARAMETER', "The set direction 'stopped' is invalid.");
    }
    this.#direction = direction;
  }

  get currentDirection(): NativeTransceiverDirection | null {
    return this.#currentDirection;
  }

  set currentDirection(direction: NativeTransceiverDirection | null) {
    if (direction === 'sendrecv' || direction === 'sendonly') this.hasEverBeenUsedToSend = true;
    this.#currentDirection = direction;
  }

  /**
   * Sets `stopping` and `direction` 'stopped' (unless stubbed). The
   * sender keeps its track, as in libwebrtc.
   */
  stop(...args: TransceiverArgs<'stop'>): void {
    this.call('stop', args, () => this.forceStopping());
  }

  /** stop()'s effect without recording a call (close() uses it too). */
  forceStopping(): void {
    this.stopping = true;
    this.sender.stopping = true;
    this.#direction = 'stopped';
  }

  /**
   * Sets the direction without the setter's checks, the way libwebrtc's
   * own addTrack/removeTrack do.
   */
  forceDirection(direction: NativeTransceiverDirection): void {
    this.#direction = direction;
  }

  setCodecPreferences(...args: TransceiverArgs<'setCodecPreferences'>): void {
    this.call('setCodecPreferences', args, () => {});
  }
}

type ChannelArgs<K extends keyof NativeDataChannel> = ArgsOf<NativeDataChannel, K>;

export interface FakeDataChannelInit extends NativeDataChannelInit {
  key: number;
  label: string;
}

/**
 * Settings from its init, as libwebrtc reports them (unset limits are
 * null). send() records a copy of the bytes and returns `sendResult`;
 * close() only records. Nothing changes the live getters or emits events:
 * the test does (`pc.emit({ kind: 'dc:state', channelKey: dc.key, ... })`).
 */
export class FakeDataChannel extends FakeObject<NativeDataChannel> implements NativeDataChannel {
  key: number;
  label: string;
  ordered: boolean;
  maxPacketLifeTime: number | null;
  maxRetransmits: number | null;
  protocol: string;
  negotiated: boolean;
  /** -1 until assigned, as in libwebrtc; set it to model the assignment. */
  id: number;
  readyState: NativeDataChannel['readyState'] = 'connecting';
  bufferedAmount = 0;
  maxSendQueueSize = 16 * 1024 * 1024;
  /** What send() returns. */
  sendResult = true;
  /** Copies of what send() was given, in order: [bytes, binary]. */
  readonly sent: [Uint8Array, boolean][] = [];

  constructor(stream: FakeStream, init: FakeDataChannelInit) {
    super(stream);
    this.key = init.key;
    this.label = init.label;
    this.ordered = init.ordered ?? true;
    this.maxPacketLifeTime = init.maxPacketLifeTime ?? null;
    this.maxRetransmits = init.maxRetransmits ?? null;
    this.protocol = init.protocol ?? '';
    this.negotiated = init.negotiated ?? false;
    this.id = init.negotiated ? (init.id ?? -1) : -1;
  }

  /** Records the bytes (copied, as the addon copies them) and returns `sendResult`. */
  send(...args: ChannelArgs<'send'>): boolean {
    return this.call('send', args, () => {
      this.sent.push([new Uint8Array(args[0]), args[1]]);
      return this.sendResult;
    });
  }

  close(...args: ChannelArgs<'close'>): void {
    this.call('close', args, () => {});
  }
}

// ---------------------------------------------------------------------------
// PeerConnection

type PcArgs<K extends keyof NativePeerConnection> = ArgsOf<NativePeerConnection, K>;

/** What `completeSetLocalDescription()` takes. */
export interface CompleteSldInit {
  /**
   * The signaling state after the SLD. `signalingstatechange` fires only if
   * it differs from the current one, as in libwebrtc.
   */
  signalingState: NativeSignalingState;
  /**
   * Overrides for the completion snapshot (see `FakePeerConnection.snapshot()`).
   * Its `transceivers` entries are also applied to the fake transceivers'
   * own fields (`mid`, `direction`, `currentDirection`, `stopped`,
   * `stopping`), as applying a description changes them in libwebrtc.
   */
  snapshot?: Partial<NativeDescriptionSnapshot>;
  /**
   * A `removetrack` event per receiver. When the SLD applies a local answer
   * that stops receiving, libwebrtc fires these **before**
   * `signalingstatechange`; in an SRD they come after the `track` events.
   */
  removedReceivers?: FakeReceiver[];
}

/** What `completeSetRemoteDescription()` takes. */
export interface CompleteSrdInit extends CompleteSldInit {
  /**
   * A `track` event per entry, in order. A transceiver not yet in
   * `transceivers` is appended first, as libwebrtc creates one for a new
   * remote m-line.
   */
  tracks?: { transceiver: FakeTransceiver; streamIds?: string[] }[];
}

/**
 * A native PeerConnection whose outcomes the test decides. Install it with
 * `useFakeNative(t, { PeerConnection: FakePeerConnection })` and get the
 * instance the code under test created with `fakes.last(...)`.
 *
 * Defaults, when not stubbed (each checked against the real addon in
 * test/native/fake-native-drift.test.ts):
 * - addTrack(track) reuses the first transceiver in `transceivers` of the
 *   track's kind whose sender has no track, that isn't `stopped` and was
 *   never used to send (`hasEverBeenUsedToSend`), flipping 'recvonly' to
 *   'sendrecv' and 'inactive' to 'sendonly'. If that transceiver is
 *   `stopping`, it throws INVALID_PARAMETER (libwebrtc does, though the
 *   spec would create a new one). Otherwise it appends a new 'sendrecv'
 *   one. A track that already has a sender throws INVALID_PARAMETER.
 * - addTransceiver() appends a new FakeTransceiver.
 * - removeTrack(sender) clears the sender's track and turns 'sendrecv' into
 *   'recvonly' and 'sendonly' into 'inactive'. It does nothing to a stopping
 *   transceiver, a sender without a track, or a sender this PC doesn't have.
 * - getTransceivers() returns a copy of `transceivers`.
 * - shouldFireNegotiationNeededEvent(id) is true only for the id of the
 *   last `negotiationneeded` passed to emit(), while `signalingState` is
 *   'stable' and the PC isn't closed. (libwebrtc also returns false while
 *   its own operations chain is busy; the JS chain mirrors that one, so
 *   it isn't modelled. Stub it to test that.)
 * - createDataChannel() returns a FakeDataChannel with the next key and
 *   the init's settings; `id` is the init's for a negotiated channel, else
 *   -1. A negotiated id above 65534, or one a channel that isn't closed
 *   has, throws INVALID_RANGE (libwebrtc's messages). Channels never
 *   change on their own (see FakeDataChannel).
 * - close() does what the real one does (see close()).
 * - everything else only records.
 * Apart from close() and the `complete*Description()` helpers, no method
 * changes the live getters: set them yourself.
 *
 * `onEvent` is held strongly for the fake's whole life. The real addon holds
 * it only weakly after close(), so events still queued then may be dropped
 * if nothing else references the callback (native-types.ts, "Lifetime").
 * That difference doesn't matter to the JS layer, which drops every event
 * after close() anyway; a test that wants the drop can simply not emit.
 */
export class FakePeerConnection
  extends FakeObject<NativePeerConnection>
  implements NativePeerConnection
{
  readonly config: NativeConfiguration;
  readonly onEvent: (event: NativePcEvent) => void;
  signalingState: NativeSignalingState = 'stable';
  connectionState: NativePeerConnectionState = 'new';
  iceConnectionState: NativeIceConnectionState = 'new';
  iceGatheringState: NativeIceGatheringState = 'new';
  /** What getTransceivers() returns; addTrack/addTransceiver append. */
  transceivers: FakeTransceiver[] = [];
  /** Transport keys with a `dtls:state` or `ice:state` emitted. */
  readonly #reportedTransports = new Set<number>();
  /** What completion snapshots report as the SCTP transport (`snapshot.sctp`). */
  sctp: { key: number; transport: number | null } | null = null;
  /** Every channel createDataChannel() returned, in order. */
  readonly dataChannels: FakeDataChannel[] = [];
  #nextChannelKey = 1;
  #lastNegotiationNeededEventId: number | undefined;

  constructor(config: NativeConfiguration, onEvent: (event: NativePcEvent) => void) {
    super(new FakeStream());
    this.config = config;
    this.onEvent = onEvent;
  }

  /**
   * Queues `event` for delivery to onEvent (see the module comment). A
   * `negotiationneeded` event's id becomes the one
   * shouldFireNegotiationNeededEvent() accepts, from this call on.
   */
  emit(event: NativePcEvent): void {
    if (event.kind === 'negotiationneeded') this.#lastNegotiationNeededEventId = event.eventId;
    if (event.kind === 'dtls:state' || event.kind === 'ice:state') {
      this.#reportedTransports.add(event.transport);
    }
    this.stream.enqueue(() => this.onEvent(event));
  }

  /**
   * As libwebrtc's addon does, a completion that names a transport key for
   * the first time is preceded by that transport's first `dtls:state` and
   * `ice:state` ('new'), unless the test emitted reports for it already.
   */
  #announceTransports(snapshot: NativeDescriptionSnapshot): void {
    const keys = [
      snapshot.sctp?.transport,
      ...(snapshot.transceivers ?? []).flatMap((t) => [t.senderTransport, t.receiverTransport]),
    ];
    for (const key of keys) {
      if (key === null || key === undefined || this.#reportedTransports.has(key)) continue;
      this.emit({ kind: 'dtls:state', transport: key, state: 'new', remoteCertificates: [] });
      this.emit({
        kind: 'ice:state',
        transport: key,
        state: 'new',
        role: snapshot.iceRoles?.[key] ?? 'unknown',
        mid: '0',
        gathering: 'new',
        selectedPair: null,
      });
    }
  }

  /** See FakeStream.flush(). */
  flush(): Promise<void> {
    return this.stream.flush();
  }

  /**
   * An SLD/SRD completion snapshot of the fake's current state:
   * `signalingState`, and every transceiver in `transceivers` via
   * transceiverState(). Descriptions are null unless overridden.
   */
  snapshot(overrides: Partial<NativeDescriptionSnapshot> = {}): NativeDescriptionSnapshot {
    return snapshot({
      signalingState: this.signalingState,
      transceivers: this.transceivers.map((transceiver) => transceiverState(transceiver)),
      sctp: this.sctp,
      ...overrides,
    });
  }

  /**
   * Completes the oldest pending setLocalDescription() in the real order:
   * each `removetrack` (applying a local answer that stops receiving), then
   * `signalingstatechange` (if the state changed), then the resolution with
   * `this.snapshot(init.snapshot)`. Queue the gathering and candidate events
   * after this call.
   */
  completeSetLocalDescription(init: CompleteSldInit): void {
    const pending = this.pending('setLocalDescription');
    for (const receiver of init.removedReceivers ?? []) {
      this.emit({ kind: 'removetrack', receiver });
    }
    this.#changeSignalingState(init.signalingState);
    this.#applyTransceiverStates(init.snapshot);
    const snapshot = this.snapshot(init.snapshot);
    this.#announceTransports(snapshot);
    pending.resolve(snapshot);
  }

  /**
   * Completes the oldest pending setRemoteDescription() in the real order:
   * sets `signalingState` and queues `signalingstatechange` (if it
   * changed), then each `track` event, then each `removetrack`, then the
   * resolution with `this.snapshot(init.snapshot)`.
   */
  completeSetRemoteDescription(init: CompleteSrdInit): void {
    const pending = this.pending('setRemoteDescription');
    this.#changeSignalingState(init.signalingState);
    for (const { transceiver, streamIds = [] } of init.tracks ?? []) {
      if (!this.transceivers.includes(transceiver)) this.transceivers.push(transceiver);
      this.emit({ kind: 'track', receiver: transceiver.receiver, transceiver, streamIds });
    }
    for (const receiver of init.removedReceivers ?? []) {
      this.emit({ kind: 'removetrack', receiver });
    }
    this.#applyTransceiverStates(init.snapshot);
    const snapshot = this.snapshot(init.snapshot);
    this.#announceTransports(snapshot);
    pending.resolve(snapshot);
  }

  /**
   * Copies snapshot overrides onto the fake transceivers, so later defaults
   * (e.g. addTrack's reuse rule via `hasEverBeenUsedToSend`) see the state
   * the test said the description produced.
   */
  #applyTransceiverStates(overrides: Partial<NativeDescriptionSnapshot> | undefined): void {
    for (const state of overrides?.transceivers ?? []) {
      const transceiver = state.transceiver;
      if (!(transceiver instanceof FakeTransceiver)) continue;
      transceiver.mid = state.mid;
      transceiver.currentDirection = state.currentDirection;
      transceiver.stopped = state.stopped;
      if (state.stopping && !transceiver.stopping) transceiver.forceStopping();
      transceiver.forceDirection(state.direction);
    }
  }

  #changeSignalingState(state: NativeSignalingState): void {
    if (state === this.signalingState) return;
    this.signalingState = state;
    this.emit({ kind: 'signalingstatechange', state });
  }

  createOffer(...args: PcArgs<'createOffer'>) {
    return this.callAsync<ResolvesTo<NativePeerConnection, 'createOffer'>>('createOffer', args);
  }

  createAnswer(...args: PcArgs<'createAnswer'>) {
    return this.callAsync<ResolvesTo<NativePeerConnection, 'createAnswer'>>('createAnswer', args);
  }

  setLocalDescription(...args: PcArgs<'setLocalDescription'>) {
    return this.callAsync<NativeDescriptionSnapshot>('setLocalDescription', args);
  }

  setRemoteDescription(...args: PcArgs<'setRemoteDescription'>) {
    return this.callAsync<NativeDescriptionSnapshot>('setRemoteDescription', args);
  }

  addIceCandidate(...args: PcArgs<'addIceCandidate'>) {
    return this.callAsync<void>('addIceCandidate', args);
  }

  getStats(...args: PcArgs<'getStats'>) {
    return this.callAsync<string>('getStats', args, true);
  }

  createDataChannel(...args: PcArgs<'createDataChannel'>): FakeDataChannel {
    return this.call('createDataChannel', args, () => {
      this.#throwIfClosed('CreateDataChannelOrError: ');
      const [label, init = {}] = args;
      if (init.negotiated && init.id !== undefined) {
        if (init.id > 65534) throw nativeError('INVALID_RANGE', 'StreamId out of range.');
        const taken = this.dataChannels.some(
          (dc) => dc.id === init.id && dc.readyState !== 'closed',
        );
        if (taken) throw nativeError('INVALID_RANGE', 'StreamId reserved.');
      }
      const channel = new FakeDataChannel(this.stream, {
        ...init,
        key: this.#nextChannelKey++,
        label,
      });
      this.dataChannels.push(channel);
      return channel;
    });
  }

  /** Certificates only at construction (a TypeError, checked first). */
  setConfiguration(...args: PcArgs<'setConfiguration'>): void {
    this.call('setConfiguration', args, () => {
      if (args[0].certificates !== undefined) {
        throw new TypeError('certificates can only be set at construction');
      }
      this.#throwIfClosed('SetConfiguration: ');
    });
  }

  /** Records only; a no-op after close() too, as in the real addon. */
  restartIce(...args: PcArgs<'restartIce'>): void {
    this.call('restartIce', args, () => {});
  }

  addTrack(...args: PcArgs<'addTrack'>): { sender: FakeSender; transceiver: FakeTransceiver } {
    return this.call('addTrack', args, () => {
      const [track] = args;
      this.#throwIfClosed();
      if (this.transceivers.some((t) => t.sender.track === track)) {
        throw nativeError('INVALID_PARAMETER', `Sender already exists for track ${track.id}.`);
      }
      // libwebrtc's FindFirstTransceiverForAddedTrack: it skips stopped
      // transceivers but not stopping ones, and AddTrack then fails on those.
      const reusable = this.transceivers.find(
        (t) =>
          t.kind === track.kind &&
          t.sender.track === null &&
          !t.hasEverBeenUsedToSend &&
          !t.stopped,
      );
      if (reusable?.stopping) {
        throw nativeError('INVALID_PARAMETER', 'The existing transceiver is stopping.');
      }
      if (reusable) {
        reusable.sender.track = track;
        if (reusable.direction === 'recvonly') reusable.forceDirection('sendrecv');
        if (reusable.direction === 'inactive') reusable.forceDirection('sendonly');
        return { sender: reusable.sender, transceiver: reusable };
      }
      const transceiver = new FakeTransceiver(this.stream, { track });
      this.transceivers.push(transceiver);
      return { sender: transceiver.sender, transceiver };
    });
  }

  removeTrack(...args: PcArgs<'removeTrack'>): void {
    this.call('removeTrack', args, () => {
      const [sender] = args;
      this.#throwIfClosed();
      const transceiver = this.transceivers.find((t) => t.sender === sender);
      if (!transceiver || transceiver.stopping || transceiver.sender.track === null) return;
      transceiver.sender.track = null;
      if (transceiver.direction === 'sendrecv') transceiver.forceDirection('recvonly');
      if (transceiver.direction === 'sendonly') transceiver.forceDirection('inactive');
    });
  }

  addTransceiver(...args: PcArgs<'addTransceiver'>): FakeTransceiver {
    return this.call('addTransceiver', args, () => {
      this.#throwIfClosed();
      const [trackOrKind, init] = args;
      const transceiver = new FakeTransceiver(
        this.stream,
        typeof trackOrKind === 'string'
          ? { kind: trackOrKind, direction: init?.direction }
          : { track: trackOrKind, direction: init?.direction },
      );
      this.transceivers.push(transceiver);
      return transceiver;
    });
  }

  getTransceivers(...args: PcArgs<'getTransceivers'>): FakeTransceiver[] {
    return this.call('getTransceivers', args, () => [...this.transceivers]);
  }

  /**
   * Queues `{kind: 'task', id}` like an emitted event (see
   * FakeStream.enqueue for `next`). As in the addon, `id` arrives as a
   * uint32, and arguments of the wrong type throw a TypeError.
   */
  queueTask(...args: PcArgs<'queueTask'>): void {
    this.call('queueTask', args, () => {
      const [id, next] = args as unknown[];
      if (typeof id !== 'number' || typeof next !== 'boolean') {
        throw new TypeError('queueTask(id, next)');
      }
      const task = id >>> 0;
      this.stream.enqueue(() => this.onEvent({ kind: 'task', id: task }), next);
    });
  }

  shouldFireNegotiationNeededEvent(...args: PcArgs<'shouldFireNegotiationNeededEvent'>): boolean {
    return this.call(
      'shouldFireNegotiationNeededEvent',
      args,
      () =>
        args[0] === this.#lastNegotiationNeededEventId &&
        this.signalingState === 'stable' &&
        !this.stream.closed,
    );
  }

  /**
   * As the real one (unless stubbed), the first time:
   * - sets `signalingState`, `connectionState` and `iceConnectionState` to
   *   'closed' synchronously
   * - stops every transceiver: `stopping`, `stopped`, `direction` and
   *   `currentDirection` 'stopped' (senders keep their tracks)
   * - queues `connectionstatechange` then `signalingstatechange`, 'closed'
   * - closes the stream: async ops but getStats() then reject at call time,
   *   and addTrack, removeTrack, addTransceiver, createDataChannel and
   *   setConfiguration throw INVALID_STATE with libwebrtc's messages
   * Pending ops stay pending (they complete normally in the real addon).
   * Data channels are left alone.
   */
  close(...args: PcArgs<'close'>): void {
    this.call('close', args, () => {
      if (this.stream.closed) return;
      this.stream.closed = true;
      this.signalingState = 'closed';
      this.connectionState = 'closed';
      this.iceConnectionState = 'closed';
      for (const transceiver of this.transceivers) {
        transceiver.forceStopping();
        transceiver.stopped = true;
        transceiver.currentDirection = 'stopped';
      }
      this.emit({ kind: 'connectionstatechange', state: 'closed' });
      this.emit({ kind: 'signalingstatechange', state: 'closed' });
    });
  }

  /** libwebrtc's closed-PC error; `prefix` is the method tag some messages carry. */
  #throwIfClosed(prefix = ''): void {
    if (this.stream.closed) {
      throw nativeError('INVALID_STATE', `${prefix}PeerConnection is closed.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Builders

/**
 * An SLD/SRD completion snapshot: `signalingState` 'stable', no
 * descriptions and no transceivers unless overridden. For a snapshot of a
 * FakePeerConnection, prefer `pc.snapshot()`: an empty `transceivers` here
 * tells the JS layer that every transceiver was removed.
 */
export function snapshot(
  overrides: Partial<NativeDescriptionSnapshot> = {},
): NativeDescriptionSnapshot {
  return {
    signalingState: 'stable',
    ...descriptionSnapshot(),
    transceivers: [],
    ...overrides,
  };
}

/**
 * The descriptions-only snapshot carried by `icecandidate` and
 * `icegatheringstatechange` events: all six null unless overridden.
 */
export function descriptionSnapshot(
  overrides: Partial<NativeDescriptionSnapshot> = {},
): NativeDescriptionSnapshot {
  return {
    localDescription: null,
    currentLocalDescription: null,
    pendingLocalDescription: null,
    remoteDescription: null,
    currentRemoteDescription: null,
    pendingRemoteDescription: null,
    ...overrides,
  };
}

/**
 * A snapshot entry for `transceiver`, from its current fields;
 * `firedDirection` defaults to null and `receiverStreamIds` to [].
 */
export function transceiverState(
  transceiver: FakeTransceiver,
  overrides: Partial<NativeTransceiverState> = {},
): NativeTransceiverState {
  return {
    transceiver,
    mid: transceiver.mid,
    direction: transceiver.direction,
    currentDirection: transceiver.currentDirection,
    firedDirection: null,
    stopped: transceiver.stopped,
    stopping: transceiver.stopping,
    receiverStreamIds: [],
    senderTransport: null,
    receiverTransport: null,
    ...overrides,
  };
}

/** An error shaped like the addon's (see `NativeError`). */
export function nativeError(
  errorType: NativeErrorType,
  message: string,
  sdpLine?: string,
): NativeError {
  const error = new Error(message) as NativeError;
  error.errorType = errorType;
  if (sdpLine !== undefined) error.sdpLine = sdpLine;
  return error;
}

/** A fake `generateCertificate`, with the calls it got. */
export interface FakeCertificateGenerator {
  (...args: Parameters<NativeModule['generateCertificate']>): Promise<NativeGeneratedCertificate>;
  readonly calls: Parameters<NativeModule['generateCertificate']>[];
}

/**
 * A fake of the addon's `generateCertificate` (install it with
 * useFakeNative). Unlike the PC fakes it settles on its own, a task later
 * (the real one completes from the threadpool): with distinct fake PEM, an
 * `expires` of now plus the requested ms (30 days by default, no cap), and
 * a distinct upper-case sha-256 fingerprint. Rejects with `INVALID_PARAMETER`,
 * at call time as the real one does, for RSA outside 1024-8192 bits.
 */
export function fakeCertificateGenerator(): FakeCertificateGenerator {
  const calls: Parameters<NativeModule['generateCertificate']>[] = [];
  const generate = (...args: Parameters<NativeModule['generateCertificate']>) => {
    calls.push(args);
    const [params, expires] = args;
    if (params.type === 'rsa' && (params.modulusLength < 1024 || params.modulusLength > 8192)) {
      return Promise.reject(nativeError('INVALID_PARAMETER', 'unsupported key parameters'));
    }
    const n = calls.length;
    const value = Array.from({ length: 32 }, (_, i) =>
      ((n + i) % 256).toString(16).padStart(2, '0'),
    )
      .join(':')
      .toUpperCase();
    return new Promise<NativeGeneratedCertificate>((resolve) => {
      setImmediate(() =>
        resolve({
          privateKey: `fake private key ${n}`,
          certificate: `fake certificate ${n}`,
          expires: Date.now() + (expires ?? 30 * 24 * 3600 * 1000),
          fingerprint: { algorithm: 'sha-256', value },
        }),
      );
    });
  };
  return Object.assign(generate, { calls });
}

// ---------------------------------------------------------------------------
// Installing fakes on the loaded addon

type ConstructibleMember =
  | 'PeerConnection'
  | 'AudioSource'
  | 'VideoSource'
  | 'AudioSink'
  | 'VideoSink';
const constructible = new Set<string>([
  'PeerConnection',
  'AudioSource',
  'VideoSource',
  'AudioSink',
  'VideoSink',
]);
type InstanceOf<C> = C extends abstract new (...args: never[]) => infer R ? R : never;

/** What useFakeNative() returns. */
export interface FakeNative<M extends Partial<NativeModule>> {
  /** Instances constructed through a replaced constructor, oldest first. */
  instances<K extends keyof M & ConstructibleMember>(member: K): InstanceOf<M[K]>[];
  /** The newest such instance; throws if there is none. */
  last<K extends keyof M & ConstructibleMember>(member: K): InstanceOf<M[K]>;
}

// Members replaced right now. The addon is process-wide, so a member can be
// faked by one test at a time (node:test runs a file's tests sequentially
// unless told otherwise).
const replaced = new Set<string>();

/**
 * Replaces `members` of the loaded native module for the duration of test
 * `t`, restoring the real ones in `t.after`. Code under test that reads
 * `native.X` at call time (as lib/ does) then gets the fake.
 *
 * Constructors in `members` are wrapped (transparently) so the instances
 * the code under test creates can be fetched with `instances()` / `last()`.
 *
 * This patches the one `native` object of the process, so it relies on
 * node:test running each test file in its own process (the default). Under
 * `--test-isolation=none` with file concurrency, a fake installed by one
 * file would be seen by another file's tests running at the same time.
 */
export function useFakeNative<M extends Partial<NativeModule>>(
  t: TestContext,
  members: M,
): FakeNative<M> {
  const slot = native as unknown as Record<string, unknown>;
  const created = new Map<string, object[]>();
  for (const key of Object.keys(members)) {
    if (!(key in slot)) throw new Error(`useFakeNative: the addon has no member ${key}`);
    if (replaced.has(key)) throw new Error(`useFakeNative: ${key} is already faked`);
  }
  for (const [key, value] of Object.entries(members)) {
    const original = slot[key];
    let replacement: unknown = value;
    if (constructible.has(key) && typeof value === 'function') {
      const list: object[] = [];
      created.set(key, list);
      replacement = new Proxy(value, {
        construct(target, args, newTarget) {
          const instance = Reflect.construct(target, args, newTarget) as object;
          list.push(instance);
          return instance;
        },
      });
    }
    slot[key] = replacement;
    replaced.add(key);
    t.after(() => {
      slot[key] = original;
      replaced.delete(key);
    });
  }
  const instances = (member: string) => created.get(member) ?? [];
  return {
    instances: (member) => [...instances(member)] as never,
    last(member) {
      const list = instances(member);
      if (list.length === 0) throw new Error(`useFakeNative: no ${member} was constructed`);
      return list[list.length - 1] as never;
    },
  };
}
