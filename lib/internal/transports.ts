/**
 * A peer connection's RTCDtlsTransport and RTCIceTransport objects, one per
 * native transport key (src/transport.h): the objects senders, receivers
 * and the SCTP transport share. Their state comes from the native
 * `dtls:state`, `dtls:error` and `ice:state` reports, cached here so getters
 * never call into native code.
 *
 * - Reports arrive before the description that names a new transport
 *   completes, so the latest one per key is kept until the object exists.
 * - A transport closing while a description is being applied closes a task
 *   after it completes: libwebrtc drops a bundled-away or rolled-back
 *   transport (DTLS and ICE 'closed') inside the SLD/SRD, and WPT expects it
 *   to be still open when the promise resolves. Other reports take effect
 *   at once.
 */
import {
  applyDtlsTransport,
  createDtlsTransport,
  dtlsTransportError,
  type RTCDtlsTransport,
  updateDtlsTransport,
} from '../RTCDtlsTransport.ts';
import {
  applyIceTransport,
  closeIceTransport,
  createIceTransport,
  type IceTransportOwner,
  markIceRoleKnown,
  type RTCIceGathererState,
  setIceGatheringState,
  setIceRole,
} from '../RTCIceTransport.ts';
import type {
  NativeIceConnectionState,
  NativeIceRole,
  NativeIceTransportState,
  NativePcEvent,
} from './native-types.ts';
import { iceSectionReader } from './sdp.ts';

export type TransportEvent = Extract<
  NativePcEvent,
  { kind: 'dtls:state' } | { kind: 'dtls:error' } | { kind: 'ice:state' }
>;

/**
 * An ICE transport's state as Chrome shows it: libwebrtc's, except that
 * 'failed' reads 'disconnected'. Blink remaps it (`RTCIceTransport::
 * OnStateChanged`, crbug.com/957487): libwebrtc reports 'failed' once every
 * candidate pair has timed out, though the spec's 'failed' also needs the
 * end of the remote candidates, which libwebrtc doesn't track.
 */
export function chromeIceTransportState<S extends NativeIceTransportState>(
  state: S,
): Exclude<S, 'failed'> | 'disconnected' {
  return state === 'failed' ? 'disconnected' : (state as Exclude<S, 'failed'>);
}

/**
 * The connection's iceConnectionState as Chrome shows it. Blink computes it
 * from its ICE transports' states (`RTCPeerConnection::
 * ComputeIceConnectionState`), so it is libwebrtc's aggregate with two
 * differences: a 'failed' transport reads 'disconnected' (see
 * chromeIceTransportState()), and it is never 'completed', which libwebrtc
 * derives from its legacy aggregate (no libwebrtc ICE transport is ever
 * 'completed'); every transport is connected then, which reads 'connected'.
 */
export function chromeIceConnectionState(
  state: NativeIceConnectionState,
): Exclude<NativeIceConnectionState, 'failed' | 'completed'> {
  if (state === 'completed') return 'connected';
  return chromeIceTransportState(state);
}

const nothing = () => {};

/** Connection states that can be a single transport's own (see followConnection()). */
const followed = new Set(['checking', 'connected', 'disconnected']);

export class Transports {
  readonly #owner: IceTransportOwner;
  readonly #objects = new Map<number, RTCDtlsTransport>();
  /** The latest report of each kind per key, for objects created later. */
  readonly #dtls = new Map<number, Extract<TransportEvent, { kind: 'dtls:state' }>>();
  readonly #ice = new Map<number, Extract<TransportEvent, { kind: 'ice:state' }>>();
  #deferred: TransportEvent[] = [];
  #flushQueued = false;
  #closed = false;

  /** `sdp` gives the SDP of localDescription / remoteDescription, or null. */
  constructor(descriptions: { sdp(side: 'local' | 'remote'): string | null }) {
    const readers = { local: iceSectionReader(), remote: iceSectionReader() };
    this.#owner = {
      section: (side, mid) => {
        const sdp = descriptions.sdp(side);
        return sdp === null ? null : readers[side](sdp, mid);
      },
    };
  }

  /** The transport for `key` (created on first use), or null for null. */
  get(key: number | null | undefined): RTCDtlsTransport | null {
    if (key === null || key === undefined) return null;
    const existing = this.#objects.get(key);
    if (existing) return existing;
    const ice = createIceTransport(this.#owner);
    const iceInfo = this.#ice.get(key);
    if (iceInfo) applyIceTransport(ice, iceInfo);
    const dtlsInfo = this.#dtls.get(key);
    const transport = createDtlsTransport(
      ice,
      dtlsInfo?.state ?? 'new',
      dtlsInfo?.remoteCertificates ?? [],
    );
    this.#objects.set(key, transport);
    // It starts from the latest reports, which held-back ones precede.
    this.#deferred = this.#deferred.filter((event) => event.transport !== key);
    return transport;
  }

  /**
   * A native report, applied now with its events. While `describing`, one
   * that closes the transport takes effect once `release()` has been called
   * and a task has passed.
   */
  handle(report: TransportEvent, describing: boolean): void {
    if (this.#closed) return;
    const event: TransportEvent =
      report.kind === 'ice:state'
        ? { ...report, state: chromeIceTransportState(report.state) }
        : report;
    if (event.kind === 'dtls:state') {
      const previous = this.#dtls.get(event.transport);
      // The remote certificates stay once connected; libwebrtc drops them
      // when the transport closes.
      const certificates =
        event.remoteCertificates.length > 0
          ? event.remoteCertificates
          : (previous?.remoteCertificates ?? []);
      this.#dtls.set(event.transport, { ...event, remoteCertificates: certificates });
    } else if (event.kind === 'ice:state') {
      this.#ice.set(event.transport, event);
    }
    if (describing && event.kind !== 'dtls:error' && event.state === 'closed') {
      this.#deferred.push(event);
      return;
    }
    if (!describing) this.flush();
    this.#apply(event)();
  }

  /** The description completed: held-back reports take effect a task later. */
  release(): void {
    if (this.#deferred.length === 0 || this.#flushQueued) return;
    this.#flushQueued = true;
    setImmediate(() => {
      this.#flushQueued = false;
      this.flush();
    });
  }

  /** Applies held-back reports now, so a later one can't overtake them. */
  flush(): void {
    const deferred = this.#deferred;
    this.#deferred = [];
    for (const event of deferred) {
      if (this.#closed) return;
      this.#apply(event)();
    }
  }

  /** The connection's iceGatheringState changed: every open ICE transport follows. */
  gathering(state: RTCIceGathererState): void {
    for (const transport of this.#objects.values()) {
      setIceGatheringState(transport.iceTransport, state);
    }
  }

  /**
   * libwebrtc reported the connection's iceConnectionState, with every
   * watched ICE transport's state as it had it then (`transportStates`, by
   * key, including transports no sender or receiver shows yet). A
   * transport's own report reaches JS a moment later (it passes through the
   * signaling thread after the connection's), so with a single open ICE
   * transport (everything BUNDLEd, the usual case) this applies its state
   * now, as Chrome does, so the two read alike in each other's events.
   * Returns what fires the transport's statechange, for after the
   * connection's event.
   *
   * Only ever a state the transport has or is about to report: its state
   * then, when that is the connection's; or the connection's, when a report
   * of a later state is on its way (the transport moved on already). Never
   * the connection's 'completed', which libwebrtc derives differently (an
   * ICE transport is never 'completed' in libwebrtc). `state` and
   * `transportStates` are Chrome's (see chromeIceConnectionState()).
   */
  followConnection(
    state: string,
    transportStates: Record<string, NativeIceTransportState> | undefined,
  ): () => void {
    if (!followed.has(state) || !transportStates) return nothing;
    const open = Object.entries(transportStates)
      .map(([key, s]) => [key, chromeIceTransportState(s)] as const)
      .filter(([, s]) => s !== 'closed');
    if (open.length !== 1) return nothing;
    const [[key, current]] = open as [[string, string]];
    const reported = this.#ice.get(Number(key));
    const transport = this.#objects.get(Number(key));
    if (!reported || !transport) return nothing;
    // Its own report of `current` is still to come unless it was the last.
    if (current !== state && current === reported.state) return nothing;
    return applyIceTransport(transport.iceTransport, {
      ...reported,
      state: state as typeof reported.state,
    });
  }

  /** The ICE roles a description's snapshot reports, by key. */
  roles(roles: Record<string, NativeIceRole> | undefined): void {
    for (const [key, role] of Object.entries(roles ?? {})) {
      const info = this.#ice.get(Number(key));
      if (info) this.#ice.set(Number(key), { ...info, role });
      const transport = this.#objects.get(Number(key));
      if (transport) setIceRole(transport.iceTransport, role);
    }
  }

  /** An answer using `transports` was applied: their ICE role is known. */
  roleKnown(transports: Iterable<RTCDtlsTransport | null>): void {
    for (const transport of transports) {
      if (transport) markIceRoleKnown(transport.iceTransport);
    }
  }

  /** The connection closed: every transport is 'closed', without events. */
  close(): void {
    this.#closed = true;
    this.#deferred = [];
    for (const transport of this.#objects.values()) {
      updateDtlsTransport(transport, 'closed', null, false);
      closeIceTransport(transport.iceTransport);
    }
  }

  #apply(event: TransportEvent): () => void {
    const transport = this.#objects.get(event.transport);
    if (!transport) return nothing;
    switch (event.kind) {
      case 'dtls:state':
        return applyDtlsTransport(transport, event.state, event.remoteCertificates);
      case 'dtls:error':
        return () => dtlsTransportError(transport, event.error);
      case 'ice:state':
        return applyIceTransport(transport.iceTransport, event);
    }
  }
}
