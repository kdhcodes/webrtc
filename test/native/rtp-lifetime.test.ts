// Lifetime edge cases of the RTP handles: identity across garbage
// collection, what native code stops holding once a PC is closed or a
// transceiver removed, handles and events outliving their PeerConnection,
// and env teardown in a worker with handles and RTP events in flight.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Worker } from 'node:worker_threads';
import { native } from '../../lib/internal/native.ts';
import type {
  NativeDescriptionSnapshot,
  NativePcEvent,
  NativePeerConnection,
  NativeSessionDescription,
  NativeTransceiver,
} from '../../lib/internal/native-types.ts';
import { nativeError, negotiate, Peer } from './pc-harness.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/** Full GC plus a turn of the event loop so finalizers run. */
async function collect(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Counts collected objects. Create the objects inside a function that has
 * returned before collect(): a suspended async frame can keep its last
 * locals alive.
 */
function collectionCounter() {
  let collected = 0;
  const registry = new FinalizationRegistry(() => {
    collected++;
  });
  return {
    watch: (o: object) => registry.register(o, undefined),
    get collected() {
      return collected;
    },
  };
}

test('handles of live transceivers survive GC with their identity', async (t) => {
  const a = new Peer(t);
  (() => {
    const tr = a.pc.addTransceiver('audio') as NativeTransceiver & { marker?: string };
    tr.marker = 'kept';
    (tr.sender as unknown as { marker: string }).marker = 'sender';
  })();
  await collect();

  const tr = a.pc.getTransceivers()[0] as NativeTransceiver & { marker?: string };
  assert.equal(tr.marker, 'kept');
  assert.equal((tr.sender as unknown as { marker: string }).marker, 'sender');
});

test('handles keep working after their PeerConnection is collected', async () => {
  const counter = collectionCounter();
  const opus = native
    .getRtpCapabilities('receiver', 'audio')
    ?.codecs.find((c) => c.mimeType === 'audio/opus');
  assert.ok(opus);
  const { tr, params } = (() => {
    const pc = new native.PeerConnection({}, () => {});
    counter.watch(pc);
    const t = pc.addTransceiver('audio');
    const p = t.sender.getParameters();
    pc.close();
    return { tr: t, params: p };
  })();
  await collect();
  assert.equal(counter.collected, 1, 'the PeerConnection was not collected');

  assert.equal(tr.stopped, true);
  assert.equal(tr.sender, tr.sender);
  assert.equal(tr.receiver.track.kind, 'audio');
  const closed = nativeError('INVALID_STATE', 'peer connection is closed');
  await assert.rejects(tr.sender.getStats(), closed);
  await assert.rejects(tr.receiver.getStats(), closed);
  await assert.rejects(tr.sender.setParameters(params), closed);
  // libwebrtc's transceiver would read freed memory of the destroyed PC
  // here (it keeps a raw pointer to the PC's codec lookup).
  assert.throws(() => tr.setCodecPreferences([opus]), closed);
});

test('closed PCs are collected even when their handles and callback reference them', async () => {
  const counter = collectionCounter();
  const N = 10;
  (() => {
    for (let i = 0; i < N; i++) {
      // Like a spec-layer wrapper: its callback and the handles' expando
      // state both lead back to the PC.
      const wrapper: { pc?: NativePeerConnection; events: NativePcEvent[] } = { events: [] };
      wrapper.pc = new native.PeerConnection({}, (ev) => wrapper.events.push(ev));
      counter.watch(wrapper.pc);
      const tr = wrapper.pc.addTransceiver('audio');
      Object.assign(tr, { wrapper });
      Object.assign(tr.sender, { wrapper });
      wrapper.pc.close();
    }
  })();
  await collect();
  assert.equal(counter.collected, N);
});

test('handles of removed transceivers are collected without getTransceivers()', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const counter = collectionCounter();
  const addNegotiateStopNegotiate = async () => {
    const tr = a.pc.addTransceiver('audio');
    counter.watch(tr);
    counter.watch(tr.sender);
    counter.watch(tr.receiver);
    await negotiate(a, b);
    tr.stop();
    await negotiate(a, b);
  };
  const N = 5;
  for (let i = 0; i < N; i++) await addNegotiateStopNegotiate();
  await collect();
  assert.equal(counter.collected, 3 * N);
});

test('handles first created after removal or close are not held', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const removed = a.pc.addTransceiver('audio');
  await negotiate(a, b);
  removed.stop();
  await negotiate(a, b);
  const closing = new Peer(t);
  const kept = closing.pc.addTransceiver('video');
  closing.pc.close();

  // Neither sender was wrapped before, so these handles are new.
  const counter = collectionCounter();
  (() => {
    counter.watch(removed.sender);
    counter.watch(kept.sender);
  })();
  await collect();
  assert.equal(counter.collected, 2);
  assert.equal(removed.sender, removed.sender);
});

test('a transceiver added while an SRD completes stays held', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.addTransceiver('audio');
  const offer = await a.pc.createOffer();
  await a.pc.setLocalDescription(offer);
  // The SRD's snapshot may be captured before the transceiver below exists;
  // converting it must not demote that transceiver's handle.
  const srd = b.pc.setRemoteDescription(offer);
  (() => {
    const added = b.pc.addTransceiver('video') as NativeTransceiver & { marker?: string };
    added.marker = 'added';
  })();
  await srd;
  await collect();
  const markers = b.pc
    .getTransceivers()
    .map((tr) => (tr as NativeTransceiver & { marker?: string }).marker);
  assert.deepEqual(markers, [undefined, 'added']);
});

test('events delivered after the PeerConnection is collected lack RTP fields', async (t) => {
  // Deterministic, but tied to Node/libuv internals: re-check this test on
  // every Node upgrade (it would break outright, not flake).
  // libuv runs a TSFN's queued calls in the poll phase and Node runs N-API
  // finalizers from setImmediate (the check phase). So: from inside another
  // PC's event callback (poll phase), queue `gone`'s SRD events and collect
  // `gone`. `gone` was created first, so libuv has already passed its async
  // handle in this poll phase: its finalizer runs before its events are
  // delivered, on the next loop iteration.
  const src = new Peer(t);
  src.pc.addTransceiver('audio', { streams: ['s'] });
  src.pc.addTransceiver('video', { streams: ['s'] });
  const offer = await src.pc.createOffer();

  const counter = collectionCounter();
  const delivered: NativePcEvent[] = [];
  const holder: { gone?: NativePeerConnection } = {};
  (() => {
    holder.gone = new native.PeerConnection({}, (ev) => delivered.push(ev));
    counter.watch(holder.gone);
  })();

  let srd: Promise<NativeDescriptionSnapshot> | undefined;
  // Separate, so no frame still holds `gone` when gc() runs.
  const startSrd = (desc: NativeSessionDescription) => {
    srd = holder.gone?.setRemoteDescription(desc);
    holder.gone = undefined;
  };
  const triggered = new Promise<void>((resolve) => {
    const trigger = new native.PeerConnection({}, (ev) => {
      if (ev.kind !== 'negotiationneeded' || srd) return;
      startSrd(offer);
      gc();
      resolve();
    });
    t.after(() => trigger.close());
    trigger.addTransceiver('audio');
  });
  await triggered;
  assert.ok(srd);
  const snapshot = await srd;
  await collect();
  assert.equal(counter.collected, 1, 'the PeerConnection was not collected');

  const tracks = delivered.filter((ev) => ev.kind === 'track');
  assert.equal(tracks.length, 2);
  for (const ev of tracks) {
    assert.equal(ev.receiver, undefined);
    assert.equal(ev.transceiver, undefined);
    assert.deepEqual(ev.streamIds, ['s']);
  }
  assert.equal(snapshot.signalingState, 'have-remote-offer');
  assert.deepEqual(
    snapshot.transceivers?.map((s) => [s.transceiver, s.mid]),
    [
      [undefined, '0'],
      [undefined, '1'],
    ],
  );
});

/**
 * Starts a worker that negotiates two PCs and then blocks its thread (so
 * every event and op completion libwebrtc produces stays queued) at
 * `point`: right after starting an SRD, or inside the k-th track event.
 * Ops are in flight there too: getStats on both PCs and a sender, and a
 * setParameters.
 */
function stalledWorker(point: 'srd' | number): Worker {
  const code = `
    const { createRequire } = require('node:module');
    const { parentPort, workerData } = require('node:worker_threads');
    const native = createRequire(${JSON.stringify(import.meta.url)})('../../build/Release/wrtc.node');
    const { point } = workerData;
    const keep = [];
    let tracks = 0;
    const stall = () => {
      const sender = a.getTransceivers()[0].sender;
      keep.push(a.getStats(), b.getStats(), sender.getStats());
      keep.push(sender.setParameters(sender.getParameters()));
      keep.push(a.getTransceivers(), b.getTransceivers());
      parentPort.postMessage('stalled');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
    const a = new native.PeerConnection({}, (ev) => keep.push(ev));
    const b = new native.PeerConnection({}, (ev) => {
      keep.push(ev);
      if (ev.kind === 'track' && ++tracks === point) stall();
    });
    for (let i = 0; i < 4; i++) {
      a.addTrack(b.addTransceiver(i % 2 ? 'audio' : 'video').receiver.track, ['s' + i]);
    }
    (async () => {
      const offer = await a.createOffer();
      await a.setLocalDescription(offer);
      keep.push(b.setRemoteDescription(offer));
      if (point === 'srd') stall();
    })();
  `;
  return new Worker(code, { eval: true, workerData: { point } });
}

for (const point of ['srd', 1, 2, 4] as const) {
  const where = point === 'srd' ? 'right after an SRD starts' : `in track event ${point}`;
  test(`terminating a worker stalled ${where} is clean`, async () => {
    // A FATAL error in the worker's teardown aborts this whole process.
    const worker = stalledWorker(point);
    const errors: Error[] = [];
    worker.on('error', (e) => errors.push(e));
    await new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve());
      worker.once('exit', (c) => reject(new Error(`worker exited early (${c})`)));
    });
    assert.equal(await worker.terminate(), 1);
    assert.deepEqual(errors, []);
  });
}
