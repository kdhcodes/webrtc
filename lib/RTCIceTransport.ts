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
import type {
  RTCIceComponent,
  RTCIceGathererState,
  RTCIceParameters,
  RTCIceRole,
  RTCIceTransportState,
} from './internal/generated/idl.ts';
import type { IceSection } from './internal/sdp.ts';
import { registerInterface } from './internal/webidl.ts';
import { pairCandidate, parseCandidate, RTCIceCandidate } from './RTCIceCandidate.ts';
import { createIceCandidatePair, type RTCIceCandidatePair } from './RTCIceCandidatePair.ts';

export type { RTCIceGathererState, RTCIceParameters, RTCIceRole, RTCIceTransportState };

export interface RTCIceTransportEventMap {
  gatheringstatechange: Event;
  selectedcandidatepairchange: Event;
  statechange: Event;
}

/** What an ICE transport reads from its peer connection. */
export interface IceTransportOwner {
  /** The m-section with this mid in localDescription / remoteDescription, if any. */
  section(side: 'local' | 'remote', mid: string): IceSection | null;
}

/** What libwebrtc reports about an ICE transport (an `ice:state` event). */
export interface IceTransportInfo {
  state: RTCIceTransportState;
  role: 'controlling' | 'controlled' | 'unknown';
  /** The transport's name: the mid of the m-section it was created for. */
  mid: string;
  /** libwebrtc's own; only its 'gathering' is used (see the class). */
  gathering?: RTCIceGathererState;
  selectedPair: { local: string; remote: string } | null;
}

const constructToken = Symbol('RTCIceTransport');
let internals: {
  apply(transport: RTCIceTransport, info: IceTransportInfo): Event[];
  gathering(transport: RTCIceTransport, state: RTCIceGathererState, fire: boolean): void;
  roleKnown(transport: RTCIceTransport): void;
  role(transport: RTCIceTransport, role: RTCIceRole): void;
  close(transport: RTCIceTransport): void;
};

/**
 * The ICE transport under an RTCDtlsTransport. Not constructible.
 *
 * - `state`, `role` and the selected candidate pair are libwebrtc's, for
 *   this transport. `role` reads 'unknown' until an answer (or pranswer)
 *   that uses the transport has been applied, as WPT expects; libwebrtc
 *   picks one at the first offer.
 * - `gatheringState` follows the connection's iceGatheringState, in the
 *   same tasks (the transport's event first), as WPT's event-order test
 *   requires. With several unbundled transports a transport that already
 *   finished gathering reads 'gathering' again while another gathers.
 * - getLocalCandidates()/getRemoteCandidates() and the parameters are read
 *   from the local and remote descriptions' m-section of the transport (the
 *   spec's definition), so they include end-of-candidates-trickled and
 *   SDP-carried candidates alike, never peer-reflexive remote ones.
 */
export class RTCIceTransport extends EventTarget {
  #owner: IceTransportOwner;
  #state: RTCIceTransportState = 'new';
  #gatheringState: RTCIceGathererState = 'new';
  #nativeRole: RTCIceRole = 'unknown';
  #roleKnown = false;
  #mid = '';
  #pairKey: string | null = null;
  #pair: RTCIceCandidatePair | null = null;

  static {
    registerInterface('RTCIceTransport', (value) => #state in value);
    internals = {
      apply: (transport, info) => transport.#apply(info),
      gathering: (transport, state, fire) => transport.#setGathering(state, fire),
      roleKnown: (transport) => {
        transport.#roleKnown = true;
      },
      role: (transport, role) => {
        transport.#nativeRole = role;
      },
      close: (transport) => {
        transport.#state = 'closed';
      },
    };
  }

  /** @internal */
  constructor(...args: unknown[]) {
    super();
    if (args[0] !== constructToken) throw new TypeError('Illegal constructor');
    this.#owner = args[1] as IceTransportOwner;
  }

  get [Symbol.toStringTag](): string {
    return 'RTCIceTransport';
  }

  get role(): RTCIceRole {
    return this.#roleKnown ? this.#nativeRole : 'unknown';
  }

  /** Always 'rtp': RTCP is multiplexed (libwebrtc requires rtcp-mux). */
  get component(): RTCIceComponent {
    this.#state; // WebIDL's brand check: a foreign `this` throws a TypeError.
    return 'rtp';
  }

  get state(): RTCIceTransportState {
    return this.#state;
  }

  get gatheringState(): RTCIceGathererState {
    return this.#gatheringState;
  }

  /** The candidates in the local description's m-section of this transport. */
  getLocalCandidates(): RTCIceCandidate[] {
    return this.#candidates('local');
  }

  /**
   * The candidates in the remote description's m-section of this transport:
   * those signaled, through the description or addIceCandidate(). Never a
   * peer-reflexive one.
   */
  getRemoteCandidates(): RTCIceCandidate[] {
    return this.#candidates('remote').filter(
      (candidate) => parseCandidate(candidate.candidate, false)?.type !== 'prflx',
    );
  }

  /** Null while 'new' or 'closed', or before a pair is selected. */
  getSelectedCandidatePair(): RTCIceCandidatePair | null {
    if (this.#state === 'new' || this.#state === 'closed') return null;
    return this.#pair;
  }

  getLocalParameters(): RTCIceParameters | null {
    return this.#parameters('local');
  }

  getRemoteParameters(): RTCIceParameters | null {
    return this.#parameters('remote');
  }

  get onstatechange(): AnyEventHandler {
    return getEventHandler(this, 'statechange') as AnyEventHandler;
  }

  set onstatechange(value: EventHandler<Event>) {
    setEventHandler(this, 'statechange', value);
  }

  get ongatheringstatechange(): AnyEventHandler {
    return getEventHandler(this, 'gatheringstatechange') as AnyEventHandler;
  }

  set ongatheringstatechange(value: EventHandler<Event>) {
    setEventHandler(this, 'gatheringstatechange', value);
  }

  get onselectedcandidatepairchange(): AnyEventHandler {
    return getEventHandler(this, 'selectedcandidatepairchange') as AnyEventHandler;
  }

  set onselectedcandidatepairchange(value: EventHandler<Event>) {
    setEventHandler(this, 'selectedcandidatepairchange', value);
  }

  addEventListener<K extends keyof RTCIceTransportEventMap>(
    type: K,
    listener: Listener<RTCIceTransport, RTCIceTransportEventMap[K]> | null,
    options?: AddListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: Listener<RTCIceTransport, Event> | null,
    options?: AddListenerOptions,
  ): void;
  addEventListener(type: string, listener: unknown, options?: AddListenerOptions) {
    super.addEventListener(type, listener as AnyListener, options);
  }

  removeEventListener<K extends keyof RTCIceTransportEventMap>(
    type: K,
    listener: Listener<RTCIceTransport, RTCIceTransportEventMap[K]> | null,
    options?: RemoveListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: Listener<RTCIceTransport, Event> | null,
    options?: RemoveListenerOptions,
  ): void;
  removeEventListener(type: string, listener: unknown, options?: RemoveListenerOptions) {
    super.removeEventListener(type, listener as AnyListener, options);
  }

  #candidates(side: 'local' | 'remote'): RTCIceCandidate[] {
    const section = this.#owner.section(side, this.#mid);
    if (!section) return [];
    return section.candidates.map(
      (candidate) =>
        new RTCIceCandidate({
          candidate,
          sdpMid: this.#mid,
          sdpMLineIndex: section.index,
          usernameFragment: section.ufrag,
        }),
    );
  }

  #parameters(side: 'local' | 'remote'): RTCIceParameters | null {
    const section = this.#owner.section(side, this.#mid);
    if (section?.ufrag == null || section.pwd == null) return null;
    return { usernameFragment: section.ufrag, password: section.pwd };
  }

  /** Applies libwebrtc's report; returns the events it calls for, in order. */
  #apply(info: IceTransportInfo): Event[] {
    if (this.#state === 'closed') return [];
    this.#mid = info.mid;
    this.#nativeRole = info.role;
    const stateChanged = info.state !== this.#state;
    this.#state = info.state;
    const key = info.selectedPair && `${info.selectedPair.local}\n${info.selectedPair.remote}`;
    const pairChanged = key !== this.#pairKey;
    if (pairChanged) {
      this.#pairKey = key;
      this.#pair = info.selectedPair && this.#createPair(info.selectedPair);
    }
    const events: Event[] = [];
    // A transport that starts gathering while the connection is gathering
    // already (a later description added it) gets no connection-level
    // event: libwebrtc's own state starts it. Completion stays with the
    // connection's (see setIceGatheringState).
    if (info.gathering === 'gathering' && this.#gatheringState === 'new') {
      this.#gatheringState = 'gathering';
      events.push(new Event('gatheringstatechange'));
    }
    // webrtc-pc's "update the ICE transport state" fires the pair change
    // first; so does Chrome (two separate tasks there).
    if (pairChanged) events.push(new Event('selectedcandidatepairchange'));
    if (stateChanged) events.push(new Event('statechange'));
    return events;
  }

  #createPair(pair: { local: string; remote: string }): RTCIceCandidatePair {
    const index = (side: 'local' | 'remote') => this.#owner.section(side, this.#mid)?.index ?? null;
    const remotePrflx = / typ prflx( |$)/i.test(pair.remote);
    return createIceCandidatePair(
      pairCandidate(pair.local, this.#mid, index('local'), false),
      pairCandidate(pair.remote, this.#mid, index('remote'), remotePrflx),
    );
  }

  #setGathering(state: RTCIceGathererState, fire: boolean) {
    if (state === this.#gatheringState || this.#state === 'closed') return;
    this.#gatheringState = state;
    if (fire) this.dispatchEvent(new Event('gatheringstatechange'));
  }
}

/** A new ICE transport: 'new' until libwebrtc's first report is applied. */
export function createIceTransport(owner: IceTransportOwner): RTCIceTransport {
  return new RTCIceTransport(constructToken, owner);
}

/**
 * Applies libwebrtc's report and returns what fires the events that calls
 * for: statechange, then selectedcandidatepairchange. A closed transport
 * stays closed.
 */
export function applyIceTransport(transport: RTCIceTransport, info: IceTransportInfo): () => void {
  const events = internals.apply(transport, info);
  return () => {
    for (const event of events) transport.dispatchEvent(event);
  };
}

/** Sets gatheringState; with `fire`, fires gatheringstatechange if it changed. */
export function setIceGatheringState(
  transport: RTCIceTransport,
  state: RTCIceGathererState,
  fire = true,
): void {
  internals.gathering(transport, state, fire);
}

/** libwebrtc's role for the transport, which `role` shows once known. */
export function setIceRole(transport: RTCIceTransport, role: RTCIceRole): void {
  internals.role(transport, role);
}

/** From now on `role` is libwebrtc's (an answer using the transport was applied). */
export function markIceRoleKnown(transport: RTCIceTransport): void {
  internals.roleKnown(transport);
}

/** 'closed', without an event (the peer connection closed). */
export function closeIceTransport(transport: RTCIceTransport): void {
  internals.close(transport);
}
