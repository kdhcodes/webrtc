// Shared helpers for the raw peer connection tests (pc*.test.ts, rtp*.test.ts).
import assert from 'node:assert/strict';
import { native } from '../../lib/internal/native.ts';
import type {
  NativeConfiguration,
  NativeDescriptionSnapshot,
  NativeError,
  NativeErrorType,
  NativePcEvent,
  NativePeerConnection,
} from '../../lib/internal/native-types.ts';

/** A failure guard only; tests wait on events, never on time. */
const WAIT_MS = 10_000;

/**
 * An assert.throws / assert.rejects validator for the one native error shape
 * (`NativeError`): a plain Error with `errorType`, and `sdpLine` only when
 * given.
 */
export function nativeError(
  errorType: NativeErrorType,
  message?: string | RegExp,
  sdpLine?: string,
): (err: unknown) => true {
  return (err) => {
    assert.ok(err instanceof Error, `not an Error: ${String(err)}`);
    const e = err as NativeError;
    assert.equal(Object.getPrototypeOf(e), Error.prototype, `${e.name} is not a plain Error`);
    assert.equal(e.name, 'Error');
    assert.equal(e.errorType, errorType, `errorType of "${e.message}"`);
    if (typeof message === 'string') assert.equal(e.message, message);
    if (message instanceof RegExp) assert.match(e.message, message);
    assert.equal(e.sdpLine, sdpLine);
    return true;
  };
}

/**
 * What a Peer needs from its test: somewhere to register its close(). A
 * TestContext, or a child process's own cleanup list.
 */
export interface Cleanup {
  after(fn: () => void): void;
}

export class Peer {
  readonly pc: NativePeerConnection;
  /** Every event received, in order. */
  readonly events: NativePcEvent[] = [];
  #waiters: { pred: (ev: NativePcEvent) => boolean; resolve: (ev: NativePcEvent) => void }[] = [];

  // Held here because native code only holds the callback weakly after
  // close(): without this reference, events still queued at close() (e.g.
  // an in-flight SRD's track events) are dropped if GC runs first.
  readonly #onEvent = (ev: NativePcEvent): void => {
    this.events.push(ev);
    for (const w of [...this.#waiters]) {
      if (w.pred(ev)) w.resolve(ev);
    }
  };

  constructor(t: Cleanup, config: NativeConfiguration = {}) {
    this.pc = new native.PeerConnection(config, this.#onEvent);
    t.after(() => this.pc.close());
  }

  /** Index to pass to waitFor() to only consider later events. */
  mark(): number {
    return this.events.length;
  }

  /** Resolves with the first event (at or after `from`) matching `pred`. */
  waitFor<K extends NativePcEvent['kind']>(
    kind: K,
    pred: (ev: Extract<NativePcEvent, { kind: K }>) => boolean = () => true,
    from = 0,
  ): Promise<Extract<NativePcEvent, { kind: K }>> {
    type E = Extract<NativePcEvent, { kind: K }>;
    const match = (ev: NativePcEvent): ev is E => ev.kind === kind && pred(ev as E);
    const found = this.events.slice(from).find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for ${kind}`));
      }, WAIT_MS);
      const waiter = {
        pred: match,
        resolve: (ev: NativePcEvent) => {
          clearTimeout(timer);
          this.#waiters = this.#waiters.filter((w) => w !== waiter);
          resolve(ev as E);
        },
      };
      this.#waiters.push(waiter);
    });
  }

  of<K extends NativePcEvent['kind']>(kind: K): Extract<NativePcEvent, { kind: K }>[] {
    return this.events.filter((ev) => ev.kind === kind) as Extract<NativePcEvent, { kind: K }>[];
  }
}

export interface Negotiation {
  offererLocal: NativeDescriptionSnapshot;
  answererRemote: NativeDescriptionSnapshot;
  answererLocal: NativeDescriptionSnapshot;
  offererRemote: NativeDescriptionSnapshot;
}

/** Offer/answer without ICE: enough for everything that is pure signaling. */
export async function negotiate(a: Peer, b: Peer): Promise<Negotiation> {
  const offer = await a.pc.createOffer();
  const offererLocal = await a.pc.setLocalDescription(offer);
  const answererRemote = await b.pc.setRemoteDescription(offer);
  const answer = await b.pc.createAnswer();
  const answererLocal = await b.pc.setLocalDescription(answer);
  const offererRemote = await a.pc.setRemoteDescription(answer);
  return { offererLocal, answererRemote, answererLocal, offererRemote };
}

/** Resolves once `peer` has finished gathering, with the local SDP then. */
export async function gathered(peer: Peer, from: number): Promise<string> {
  const ev = await peer.waitFor('icegatheringstatechange', (e) => e.state === 'complete', from);
  const sdp = ev.snapshot?.localDescription?.sdp;
  if (sdp === undefined) throw new Error('gathering-complete snapshot has no localDescription');
  return sdp;
}

/**
 * Full negotiation with complete (non-trickle) candidates, so the two PCs
 * connect over loopback. Resolves once both are connected.
 */
export async function connect(a: Peer, b: Peer): Promise<void> {
  const fromA = a.mark();
  await a.pc.setLocalDescription(await a.pc.createOffer());
  await b.pc.setRemoteDescription({ type: 'offer', sdp: await gathered(a, fromA) });
  const fromB = b.mark();
  await b.pc.setLocalDescription(await b.pc.createAnswer());
  await a.pc.setRemoteDescription({ type: 'answer', sdp: await gathered(b, fromB) });
  await Promise.all([
    a.waitFor('connectionstatechange', (e) => e.state === 'connected'),
    b.waitFor('connectionstatechange', (e) => e.state === 'connected'),
  ]);
}
