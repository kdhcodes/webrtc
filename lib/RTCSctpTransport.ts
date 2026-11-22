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
import type { RTCSctpTransportState } from './internal/generated/idl.ts';
import { registerInterface } from './internal/webidl.ts';
import type { RTCDtlsTransport } from './RTCDtlsTransport.ts';

export type { RTCSctpTransportState };

export interface RTCSctpTransportEventMap {
  statechange: Event;
}

interface SctpState {
  state: RTCSctpTransportState;
  maxMessageSize: number;
  maxChannels: number | null;
}

const constructToken = Symbol('RTCSctpTransport');
let setState: (transport: RTCSctpTransport, update: Partial<SctpState>, fire: boolean) => void;

/**
 * The peer connection's SCTP transport (`pc.sctp`): libwebrtc's, which an
 * offer (local or remote) negotiating data channels creates. Not
 * constructible.
 *
 * `maxMessageSize` is 65536 until an answer, then the spec's computation
 * from the remote description's `a=max-message-size` and libwebrtc's
 * 256 KiB send limit, replaced by libwebrtc's own value once SCTP connects
 * (libwebrtc closes a channel that sends more). `maxChannels` is null until
 * connected.
 */
export class RTCSctpTransport extends EventTarget {
  #transport: RTCDtlsTransport;
  #state: SctpState = { state: 'connecting', maxMessageSize: 65536, maxChannels: null };

  static {
    registerInterface('RTCSctpTransport', (value) => #state in value);
    setState = (transport, update, fire) => transport.#setState(update, fire);
  }

  /** @internal */
  constructor(...args: unknown[]) {
    super();
    if (args[0] !== constructToken) throw new TypeError('Illegal constructor');
    this.#transport = args[1] as RTCDtlsTransport;
  }

  get [Symbol.toStringTag](): string {
    return 'RTCSctpTransport';
  }

  get transport(): RTCDtlsTransport {
    return this.#transport;
  }

  get state(): RTCSctpTransportState {
    return this.#state.state;
  }

  get maxMessageSize(): number {
    return this.#state.maxMessageSize;
  }

  get maxChannels(): number | null {
    return this.#state.maxChannels;
  }

  get onstatechange(): AnyEventHandler {
    return getEventHandler(this, 'statechange') as AnyEventHandler;
  }

  set onstatechange(value: EventHandler<Event>) {
    setEventHandler(this, 'statechange', value);
  }

  addEventListener<K extends keyof RTCSctpTransportEventMap>(
    type: K,
    listener: Listener<RTCSctpTransport, RTCSctpTransportEventMap[K]> | null,
    options?: AddListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: Listener<RTCSctpTransport, Event> | null,
    options?: AddListenerOptions,
  ): void;
  addEventListener(type: string, listener: unknown, options?: AddListenerOptions) {
    super.addEventListener(type, listener as AnyListener, options);
  }

  removeEventListener<K extends keyof RTCSctpTransportEventMap>(
    type: K,
    listener: Listener<RTCSctpTransport, RTCSctpTransportEventMap[K]> | null,
    options?: RemoveListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: Listener<RTCSctpTransport, Event> | null,
    options?: RemoveListenerOptions,
  ): void;
  removeEventListener(type: string, listener: unknown, options?: RemoveListenerOptions) {
    super.removeEventListener(type, listener as AnyListener, options);
  }

  #setState(update: Partial<SctpState>, fire: boolean) {
    const changed = update.state !== undefined && update.state !== this.#state.state;
    this.#state = { ...this.#state, ...update };
    if (changed && fire) this.dispatchEvent(new Event('statechange'));
  }
}

export function createSctpTransport(
  transport: RTCDtlsTransport,
  state: SctpState,
): RTCSctpTransport {
  const sctp = new RTCSctpTransport(constructToken, transport);
  setState(sctp, state, false);
  return sctp;
}

/** Applies `update`; with `fire`, fires statechange if `state` changed. */
export function updateSctpTransport(
  transport: RTCSctpTransport,
  update: Partial<SctpState>,
  fire = true,
): void {
  setState(transport, update, fire);
}
