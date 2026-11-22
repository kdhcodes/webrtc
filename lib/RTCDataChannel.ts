import { domError, invalidStateError, rtcErrorFromInfo } from './internal/errors.ts';
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
import type { RTCDataChannelInit, RTCDataChannelState } from './internal/generated/idl.ts';
import type { NativeDataChannel, NativeErrorInfo } from './internal/native-types.ts';
import { DOMString, registerInterface, USVString, unsignedLong } from './internal/webidl.ts';
import { RTCErrorEvent } from './RTCErrorEvent.ts';

export type { RTCDataChannelInit, RTCDataChannelState };

export type BinaryType = 'blob' | 'arraybuffer';

export interface RTCDataChannelEventMap {
  bufferedamountlow: Event;
  close: Event;
  closing: Event;
  error: RTCErrorEvent;
  message: MessageEvent;
  open: Event;
}

/** What a channel needs from its peer connection. */
export interface DataChannelOwner {
  /** [[IsClosed]]. */
  readonly closed: boolean;
  /** The SCTP transport's maxMessageSize, or null while there is none. */
  readonly maxMessageSize: number | null;
  /** The channel was announced closed: the connection lets it go. */
  forget(key: number): void;
}

/** The channel's settings: from createDataChannel(), or from libwebrtc for a remote channel. */
export interface DataChannelSettings {
  label: string;
  ordered: boolean;
  maxPacketLifeTime: number | null;
  maxRetransmits: number | null;
  protocol: string;
  negotiated: boolean;
  id: number | null;
}

/** A send waiting behind a Blob that is still being read. */
interface PendingSend {
  /** A copy taken at send() time, or null for a Blob. */
  bytes: Uint8Array | null;
  blob: Blob | null;
  binary: boolean;
  size: number;
}

/** What the peer connection forwards to a channel. */
interface ChannelInternals {
  state(channel: RTCDataChannel, state: RTCDataChannelState, error?: NativeErrorInfo): void;
  message(channel: RTCDataChannel, data: Uint8Array, binary: boolean): void;
  sent(channel: RTCDataChannel, bytes: number): void;
  sctpConnected(channel: RTCDataChannel): void;
  connectionClosed(channel: RTCDataChannel): void;
}

const constructToken = Symbol('RTCDataChannel');
const sendContext = "Failed to execute 'send' on 'RTCDataChannel'";
let internals: ChannelInternals;

/**
 * A data channel (webrtc-pc, "Peer-to-peer data API"). Not constructible:
 * get one from createDataChannel() or a `datachannel` event.
 *
 * - `readyState`, `id` and `bufferedAmount` are the JS layer's own record,
 *   updated by events, never live libwebrtc reads.
 * - `bufferedAmount` grows by each message's size when send() is called and
 *   shrinks as libwebrtc hands bytes to SCTP; `bufferedamountlow` fires when
 *   it falls to `bufferedAmountLowThreshold` or below.
 * - A Blob is read asynchronously; sends made after it wait for it, so
 *   messages always leave in call order.
 * - send() throws a TypeError for a message over `pc.sctp.maxMessageSize`
 *   and an OperationError when libwebrtc's 16 MiB send queue can't take it
 *   (libwebrtc would close the channel instead).
 * - Closing the peer connection sets `readyState` to 'closed' without any
 *   event; the remote side's channels get `error` (an RTCError with
 *   errorDetail 'sctp-failure') and `close`.
 */
export class RTCDataChannel extends EventTarget {
  #native: NativeDataChannel;
  #owner: DataChannelOwner;
  #settings: DataChannelSettings;
  #maxSendQueueSize: number;
  #readyState: RTCDataChannelState;
  #bufferedAmount = 0;
  #bufferedAmountLowThreshold = 0;
  #binaryType: BinaryType = 'arraybuffer';
  /** Sends from the first unread Blob on, in call order. */
  #pending: PendingSend[] = [];
  #reading = false;

  static {
    registerInterface('RTCDataChannel', (value) => #native in value);
    internals = {
      state: (channel, state, error) => channel.#onState(state, error),
      message: (channel, data, binary) => channel.#onMessage(data, binary),
      sent: (channel, bytes) => channel.#onSent(bytes),
      sctpConnected: (channel) => channel.#assignId(),
      connectionClosed: (channel) => {
        channel.#readyState = 'closed';
        channel.#pending = [];
      },
    };
  }

  /** @internal */
  constructor(...args: unknown[]) {
    super();
    if (args[0] !== constructToken) throw new TypeError('Illegal constructor');
    const [, owner, handle, settings, readyState] = args as [
      symbol,
      DataChannelOwner,
      NativeDataChannel,
      DataChannelSettings,
      RTCDataChannelState,
    ];
    this.#owner = owner;
    this.#native = handle;
    this.#settings = { ...settings };
    this.#readyState = readyState;
    this.#maxSendQueueSize = handle.maxSendQueueSize;
  }

  get [Symbol.toStringTag](): string {
    return 'RTCDataChannel';
  }

  // -------------------------------------------------------------------------
  // Attributes

  get label(): string {
    return this.#settings.label;
  }

  get ordered(): boolean {
    return this.#settings.ordered;
  }

  get maxPacketLifeTime(): number | null {
    return this.#settings.maxPacketLifeTime;
  }

  get maxRetransmits(): number | null {
    return this.#settings.maxRetransmits;
  }

  get protocol(): string {
    return this.#settings.protocol;
  }

  get negotiated(): boolean {
    return this.#settings.negotiated;
  }

  /** Null until assigned: an in-band channel gets one once the DTLS role is known. */
  get id(): number | null {
    return this.#settings.id;
  }

  get readyState(): RTCDataChannelState {
    return this.#readyState;
  }

  get bufferedAmount(): number {
    return this.#bufferedAmount;
  }

  get bufferedAmountLowThreshold(): number {
    return this.#bufferedAmountLowThreshold;
  }

  set bufferedAmountLowThreshold(value: number) {
    this.#bufferedAmountLowThreshold = unsignedLong(
      value,
      "Failed to set the 'bufferedAmountLowThreshold' property on 'RTCDataChannel'",
      { enforceRange: true },
    );
  }

  /** 'arraybuffer' (the default) or 'blob'; other values are ignored. */
  get binaryType(): BinaryType {
    return this.#binaryType;
  }

  set binaryType(value: BinaryType) {
    this.#native; // WebIDL's brand check: a foreign `this` throws a TypeError.
    const type = DOMString(value, "Failed to set the 'binaryType' property on 'RTCDataChannel'");
    // A WebIDL enum attribute ignores values outside the enum.
    if (type === 'blob' || type === 'arraybuffer') this.#binaryType = type;
  }

  // -------------------------------------------------------------------------
  // Event handlers

  get onopen(): AnyEventHandler {
    return getEventHandler(this, 'open') as AnyEventHandler;
  }

  set onopen(value: EventHandler<Event>) {
    setEventHandler(this, 'open', value);
  }

  get onbufferedamountlow(): AnyEventHandler {
    return getEventHandler(this, 'bufferedamountlow') as AnyEventHandler;
  }

  set onbufferedamountlow(value: EventHandler<Event>) {
    setEventHandler(this, 'bufferedamountlow', value);
  }

  get onerror(): AnyEventHandler {
    return getEventHandler(this, 'error') as AnyEventHandler;
  }

  set onerror(value: EventHandler<RTCErrorEvent>) {
    setEventHandler(this, 'error', value);
  }

  get onclosing(): AnyEventHandler {
    return getEventHandler(this, 'closing') as AnyEventHandler;
  }

  set onclosing(value: EventHandler<Event>) {
    setEventHandler(this, 'closing', value);
  }

  get onclose(): AnyEventHandler {
    return getEventHandler(this, 'close') as AnyEventHandler;
  }

  set onclose(value: EventHandler<Event>) {
    setEventHandler(this, 'close', value);
  }

  get onmessage(): AnyEventHandler {
    return getEventHandler(this, 'message') as AnyEventHandler;
  }

  set onmessage(value: EventHandler<MessageEvent>) {
    setEventHandler(this, 'message', value);
  }

  addEventListener<K extends keyof RTCDataChannelEventMap>(
    type: K,
    listener: Listener<RTCDataChannel, RTCDataChannelEventMap[K]> | null,
    options?: AddListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: Listener<RTCDataChannel, Event> | null,
    options?: AddListenerOptions,
  ): void;
  addEventListener(type: string, listener: unknown, options?: AddListenerOptions) {
    super.addEventListener(type, listener as AnyListener, options);
  }

  removeEventListener<K extends keyof RTCDataChannelEventMap>(
    type: K,
    listener: Listener<RTCDataChannel, RTCDataChannelEventMap[K]> | null,
    options?: RemoveListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: Listener<RTCDataChannel, Event> | null,
    options?: RemoveListenerOptions,
  ): void;
  removeEventListener(type: string, listener: unknown, options?: RemoveListenerOptions) {
    super.removeEventListener(type, listener as AnyListener, options);
  }

  // -------------------------------------------------------------------------
  // Methods

  /**
   * Sends a string (as UTF-8 text), or an ArrayBuffer, view or Blob (as
   * binary). Throws InvalidStateError unless open.
   */
  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void;
  send(...args: unknown[]): void {
    if (args.length < 1) {
      throw new TypeError(`${sendContext}: 1 argument required, but only 0 present.`);
    }
    const [data] = args;
    // WebIDL overload resolution: Blob, ArrayBuffer, ArrayBufferView, else
    // the USVString overload.
    let bytes: Uint8Array | null = null;
    let blob: Blob | null = null;
    let binary = true;
    if (data instanceof Blob) {
      blob = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      if (data.buffer instanceof SharedArrayBuffer) {
        throw new TypeError(`${sendContext}: parameter 1 is backed by a SharedArrayBuffer.`);
      }
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      bytes = Buffer.from(USVString(data, `${sendContext}: parameter 1`), 'utf8');
      binary = false;
    }
    if (this.#readyState !== 'open') {
      throw invalidStateError(`${sendContext}: RTCDataChannel.readyState is not 'open'.`);
    }
    const size = blob ? blob.size : (bytes as Uint8Array).byteLength;
    const max = this.#owner.maxMessageSize;
    if (max !== null && size > max) {
      throw new TypeError(
        `${sendContext}: The message is ${size} bytes, more than the SCTP transport's maxMessageSize (${max}).`,
      );
    }
    if (this.#bufferedAmount + size > this.#maxSendQueueSize) {
      throw domError(
        'OperationError',
        `${sendContext}: The send queue is full (bufferedAmount ${this.#bufferedAmount} + ${size} bytes is over ${this.#maxSendQueueSize}).`,
      );
    }
    if (blob || this.#pending.length > 0) {
      // Keep call order: wait behind the Blob (or the Blob before this one).
      this.#pending.push({ bytes: bytes?.slice() ?? null, blob, binary, size });
      this.#bufferedAmount += size;
      void this.#sendPending();
      return;
    }
    // libwebrtc refuses only once the channel is no longer open there: our
    // readyState trails libwebrtc's by an event, and `closing` / `close`
    // are on their way. The message is dropped, as one the closing
    // procedure didn't get to send would be; throwing here would surprise
    // code that just checked readyState (e.g. mediasoup-client's send()).
    if (this.#native.send(bytes as Uint8Array, binary)) this.#bufferedAmount += size;
  }

  /**
   * Starts closing: `readyState` becomes 'closing' now and 'closed' (with a
   * `close` event) once the closing procedure completes. Pending Blob sends
   * still go out first.
   */
  close(): void {
    if (this.#readyState === 'closing' || this.#readyState === 'closed') return;
    this.#readyState = 'closing';
    if (this.#pending.length === 0) this.#native.close();
  }

  // -------------------------------------------------------------------------
  // Internals

  /** Sends the pending messages in order, reading each Blob first. */
  async #sendPending(): Promise<void> {
    if (this.#reading) return;
    this.#reading = true;
    try {
      while (this.#pending.length > 0) {
        const next = this.#pending[0] as PendingSend;
        let bytes = next.bytes;
        if (next.blob) {
          try {
            bytes = new Uint8Array(await next.blob.arrayBuffer());
          } catch {
            bytes = null;
          }
        }
        // Closed meanwhile (by the remote, or with the connection): dropped.
        if (this.#readyState === 'closed') return;
        this.#pending.shift();
        // An unreadable Blob is skipped, and a message libwebrtc refuses
        // (the channel is closing there) is dropped: neither stays counted.
        if (bytes === null || !this.#native.send(bytes, next.binary)) {
          this.#bufferedAmount = Math.max(0, this.#bufferedAmount - next.size);
        }
      }
      // close() waited for the pending sends.
      if (this.#readyState === 'closing') this.#native.close();
    } finally {
      this.#reading = false;
    }
  }

  #assignId(): void {
    if (this.#settings.id !== null) return;
    const id = this.#native.id;
    if (id >= 0) this.#settings.id = id;
  }

  #onState(state: RTCDataChannelState, error: NativeErrorInfo | undefined): void {
    switch (state) {
      case 'open':
        // "Announce the data channel as open".
        if (this.#readyState === 'closing' || this.#readyState === 'closed') return;
        this.#assignId();
        this.#readyState = 'open';
        this.dispatchEvent(new Event('open'));
        return;
      case 'closing':
        // Only a closing procedure the remote started fires `closing`.
        if (this.#readyState !== 'open' && this.#readyState !== 'connecting') return;
        this.#readyState = 'closing';
        this.dispatchEvent(new Event('closing'));
        return;
      case 'closed':
        this.#announceClosed(error);
        return;
      default:
        return;
    }
  }

  #announceClosed(error: NativeErrorInfo | undefined): void {
    if (this.#readyState === 'closed') return;
    this.#readyState = 'closed';
    this.#pending = [];
    this.#owner.forget(this.#native.key);
    if (error) {
      this.dispatchEvent(
        new RTCErrorEvent('error', { error: rtcErrorFromInfo(error, 'data-channel-failure') }),
      );
    }
    this.dispatchEvent(new Event('close'));
  }

  #onMessage(data: Uint8Array, binary: boolean): void {
    // "Receiving messages": discarded unless open.
    if (this.#readyState !== 'open') return;
    let payload: string | ArrayBuffer | Blob;
    if (!binary) {
      payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    } else if (this.#binaryType === 'blob') {
      payload = new Blob([data as Uint8Array<ArrayBuffer>]);
    } else if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
      // The addon hands over a fresh buffer per message; no copy needed.
      payload = data.buffer as ArrayBuffer;
    } else {
      payload = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;
    }
    this.dispatchEvent(new MessageEvent('message', { data: payload }));
  }

  #onSent(bytes: number): void {
    const before = this.#bufferedAmount;
    this.#bufferedAmount = Math.max(0, before - bytes);
    const threshold = this.#bufferedAmountLowThreshold;
    if (before > threshold && this.#bufferedAmount <= threshold) {
      this.dispatchEvent(new Event('bufferedamountlow'));
    }
  }
}

/** A channel for `handle`, in `readyState`. */
export function dataChannelFromNative(
  owner: DataChannelOwner,
  handle: NativeDataChannel,
  settings: DataChannelSettings,
  readyState: RTCDataChannelState,
): RTCDataChannel {
  return new RTCDataChannel(constructToken, owner, handle, settings, readyState);
}

/** A remote channel's settings, as libwebrtc received them. */
export function remoteChannelSettings(handle: NativeDataChannel): DataChannelSettings {
  return {
    label: handle.label,
    ordered: handle.ordered,
    maxPacketLifeTime: handle.maxPacketLifeTime,
    maxRetransmits: handle.maxRetransmits,
    protocol: handle.protocol,
    negotiated: handle.negotiated,
    id: handle.id >= 0 ? handle.id : null,
  };
}

/** Native events for `channel`, forwarded by its peer connection. */
export const channelEvents: ChannelInternals = {
  state: (channel, state, error) => internals.state(channel, state, error),
  message: (channel, data, binary) => internals.message(channel, data, binary),
  sent: (channel, bytes) => internals.sent(channel, bytes),
  sctpConnected: (channel) => internals.sctpConnected(channel),
  connectionClosed: (channel) => internals.connectionClosed(channel),
};
