import { rtcErrorFromInfo } from './internal/errors.ts';
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
import type { RTCDtlsTransportState } from './internal/generated/idl.ts';
import type { NativeErrorInfo } from './internal/native-types.ts';
import { registerInterface } from './internal/webidl.ts';
import { RTCErrorEvent } from './RTCErrorEvent.ts';
import type { RTCIceTransport } from './RTCIceTransport.ts';

export type { RTCDtlsTransportState };

export interface RTCDtlsTransportEventMap {
  error: RTCErrorEvent;
  statechange: Event;
}

const constructToken = Symbol('RTCDtlsTransport');
let internals: {
  setState(
    transport: RTCDtlsTransport,
    state: RTCDtlsTransportState,
    certificates: ArrayBuffer[] | null,
  ): Event[];
  error(transport: RTCDtlsTransport, info: NativeErrorInfo): void;
};

/**
 * A DTLS transport: a sender's and receiver's `transport`, and the SCTP
 * transport's, one object per libwebrtc transport (shared under BUNDLE).
 * Not constructible. `state` and the remote certificates come from
 * libwebrtc.
 *
 * Going to 'failed' fires only `statechange`, as in Chrome and wrtc.
 * webrtc-pc also asks for an `error` event with the cause (e.g.
 * 'fingerprint-failure'), but libwebrtc doesn't report one: `error` fires
 * only if libwebrtc's DtlsTransportObserver ever reports an error, which
 * m150 never does.
 */
export class RTCDtlsTransport extends EventTarget {
  #iceTransport: RTCIceTransport;
  #state: RTCDtlsTransportState = 'new';
  #certificates: ArrayBuffer[] = [];

  static {
    registerInterface('RTCDtlsTransport', (value) => #state in value);
    internals = {
      setState(transport, state, certificates) {
        return transport.#setState(state, certificates);
      },
      error(transport, info) {
        const error = rtcErrorFromInfo(info, 'dtls-failure');
        transport.dispatchEvent(new RTCErrorEvent('error', { error }));
      },
    };
  }

  /** @internal */
  constructor(...args: unknown[]) {
    super();
    if (args[0] !== constructToken) throw new TypeError('Illegal constructor');
    this.#iceTransport = args[1] as RTCIceTransport;
  }

  get [Symbol.toStringTag](): string {
    return 'RTCDtlsTransport';
  }

  get iceTransport(): RTCIceTransport {
    return this.#iceTransport;
  }

  get state(): RTCDtlsTransportState {
    return this.#state;
  }

  /** The remote certificate chain, DER-encoded; copies, empty until connected. */
  getRemoteCertificates(): ArrayBuffer[] {
    return this.#certificates.map((der) => der.slice(0));
  }

  get onstatechange(): AnyEventHandler {
    return getEventHandler(this, 'statechange') as AnyEventHandler;
  }

  set onstatechange(value: EventHandler<Event>) {
    setEventHandler(this, 'statechange', value);
  }

  get onerror(): AnyEventHandler {
    return getEventHandler(this, 'error') as AnyEventHandler;
  }

  set onerror(value: EventHandler<RTCErrorEvent>) {
    setEventHandler(this, 'error', value);
  }

  addEventListener<K extends keyof RTCDtlsTransportEventMap>(
    type: K,
    listener: Listener<RTCDtlsTransport, RTCDtlsTransportEventMap[K]> | null,
    options?: AddListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: Listener<RTCDtlsTransport, Event> | null,
    options?: AddListenerOptions,
  ): void;
  addEventListener(type: string, listener: unknown, options?: AddListenerOptions) {
    super.addEventListener(type, listener as AnyListener, options);
  }

  removeEventListener<K extends keyof RTCDtlsTransportEventMap>(
    type: K,
    listener: Listener<RTCDtlsTransport, RTCDtlsTransportEventMap[K]> | null,
    options?: RemoveListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: Listener<RTCDtlsTransport, Event> | null,
    options?: RemoveListenerOptions,
  ): void;
  removeEventListener(type: string, listener: unknown, options?: RemoveListenerOptions) {
    super.removeEventListener(type, listener as AnyListener, options);
  }

  /** Sets the state; returns the events it calls for, in order. */
  #setState(state: RTCDtlsTransportState, certificates: ArrayBuffer[] | null): Event[] {
    // The spec keeps the remote certificates once connected; libwebrtc
    // drops them when the transport closes.
    if (certificates && certificates.length > 0) this.#certificates = certificates;
    if (state === this.#state) return [];
    this.#state = state;
    return [new Event('statechange')];
  }
}

export function createDtlsTransport(
  iceTransport: RTCIceTransport,
  state: RTCDtlsTransportState,
  certificates: ArrayBuffer[],
): RTCDtlsTransport {
  const transport = new RTCDtlsTransport(constructToken, iceTransport);
  internals.setState(transport, state, certificates);
  return transport;
}

/**
 * Sets the state (and certificates, when given) and returns what fires the
 * `statechange` that calls for, if any.
 */
export function applyDtlsTransport(
  transport: RTCDtlsTransport,
  state: RTCDtlsTransportState,
  certificates: ArrayBuffer[] | null,
): () => void {
  const events = internals.setState(transport, state, certificates);
  return () => {
    for (const event of events) transport.dispatchEvent(event);
  };
}

/** applyDtlsTransport(), firing the events now unless `fire` is false. */
export function updateDtlsTransport(
  transport: RTCDtlsTransport,
  state: RTCDtlsTransportState,
  certificates: ArrayBuffer[] | null,
  fire = true,
): void {
  const dispatch = applyDtlsTransport(transport, state, certificates);
  if (fire) dispatch();
}

/** Fires `error` with the RTCError for `info` (errorDetail 'dtls-failure' by default). */
export function dtlsTransportError(transport: RTCDtlsTransport, info: NativeErrorInfo): void {
  internals.error(transport, info);
}
