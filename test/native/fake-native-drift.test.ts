// The behaviours lib/internal/testing/fake-native.ts models on libwebrtc,
// run against both the real addon and the fake with the same expectations,
// so the fake can't silently drift from what the JS layer will meet in
// production. Each scenario runs twice: "[real]" and "[fake]".
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { native } from '../../lib/internal/native.ts';
import type {
  NativeDataChannel,
  NativeError,
  NativeMediaKind,
  NativePcEvent,
  NativePeerConnection,
  NativeTrack,
  NativeTransceiver,
  NativeVideoSink,
} from '../../lib/internal/native-types.ts';
import {
  FakePeerConnection,
  FakeTrack,
  FakeTransceiver,
  FakeVideoSink,
  transceiverState,
} from '../../lib/internal/testing/fake-native.ts';
import { negotiate, Peer } from './pc-harness.ts';

interface Side {
  pc: NativePeerConnection;
  events: NativePcEvent[];
  track(kind: NativeMediaKind): NativeTrack;
  /** A video sink on `track`, which a test must stop. */
  videoSink(track: NativeTrack): NativeVideoSink;
  /** Resolves once every event queued so far has been delivered. */
  drain(): Promise<void>;
  /** Makes `transceiver` count as having sent (a negotiated send direction). */
  markSent(transceiver: NativeTransceiver): Promise<void>;
}

function realSide(t: TestContext): Side {
  const peer = new Peer(t);
  const audio = new native.AudioSource();
  const video = new native.VideoSource({ isScreencast: false, needsDenoising: null });
  return {
    pc: peer.pc,
    events: peer.events,
    track: (kind) => (kind === 'audio' ? audio : video).createTrack(),
    videoSink: (track) => new native.VideoSink(track, () => {}),
    // getStats completes on the PC's event queue, behind everything already
    // queued, and works after close().
    drain: async () => {
      await peer.pc.getStats();
    },
    markSent: async () => {
      await negotiate(peer, new Peer(t));
    },
  };
}

function fakeSide(): Side {
  const events: NativePcEvent[] = [];
  const pc = new FakePeerConnection({}, (event) => events.push(event));
  return {
    pc,
    events,
    track: (kind) => new FakeTrack(kind),
    videoSink: (track) => new FakeVideoSink(track, () => {}),
    drain: () => pc.flush(),
    markSent: async (transceiver) => {
      (transceiver as FakeTransceiver).currentDirection = 'sendonly';
    },
  };
}

/** Defines `name` twice, once per side, with the same body. */
function onBothSides(name: string, body: (side: Side) => Promise<void> | void): void {
  test(`${name} [real]`, (t) => body(realSide(t)));
  test(`${name} [fake]`, () => body(fakeSide()));
}

/** `'<errorType>: <message>'` of what `fn` throws, or `'no error'`. */
function errorOf(fn: () => unknown): string {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return `${(error as NativeError).errorType}: ${(error as Error).message}`;
  }
}

/** How `promise` has settled after a few microtasks: no task may run. */
async function settledAtCallTime(promise: Promise<unknown>): Promise<string> {
  let state = 'pending';
  promise.then(
    () => {
      state = 'resolved';
    },
    (error: NativeError) => {
      state = `${error.errorType}: ${error.message}`;
    },
  );
  for (let i = 0; i < 3; i++) await Promise.resolve();
  return state;
}

onBothSides(
  'addTrack reuses a free transceiver of its kind, recvonly -> sendrecv',
  ({ pc, track }) => {
    pc.addTransceiver('video', { direction: 'recvonly' });
    const free = pc.addTransceiver('audio', { direction: 'recvonly' });
    const added = pc.addTrack(track('audio'), ['s']);
    assert.equal(added.transceiver, free);
    assert.equal(added.sender, free.sender);
    assert.equal(free.direction, 'sendrecv');
    assert.equal(pc.getTransceivers().length, 2);
  },
);

onBothSides('addTrack reuses an inactive transceiver as sendonly', ({ pc, track }) => {
  const free = pc.addTransceiver('audio', { direction: 'inactive' });
  assert.equal(pc.addTrack(track('audio'), []).transceiver, free);
  assert.equal(free.direction, 'sendonly');
});

onBothSides('addTrack appends a sendrecv transceiver when none is free', ({ pc, track }) => {
  const busy = pc.addTrack(track('audio'), []).transceiver;
  const added = pc.addTrack(track('audio'), []).transceiver;
  assert.notEqual(added, busy);
  assert.equal(added.direction, 'sendrecv');
  assert.deepEqual(pc.getTransceivers(), [busy, added]);
});

onBothSides('addTrack of a track that already has a sender throws INVALID_PARAMETER', (side) => {
  const audio = side.track('audio');
  side.pc.addTrack(audio, []);
  assert.equal(
    errorOf(() => side.pc.addTrack(audio, [])),
    `INVALID_PARAMETER: Sender already exists for track ${audio.id}.`,
  );
});

onBothSides(
  'addTrack fails, rather than skipping, when the free transceiver is stopping',
  (side) => {
    side.pc.addTransceiver('audio', { direction: 'recvonly' }).stop();
    assert.equal(
      errorOf(() => side.pc.addTrack(side.track('audio'), [])),
      'INVALID_PARAMETER: The existing transceiver is stopping.',
    );
    assert.equal(side.pc.getTransceivers().length, 1);
  },
);

onBothSides('addTrack never reuses a transceiver that has sent', async (side) => {
  const { sender, transceiver } = side.pc.addTrack(side.track('audio'), []);
  await side.markSent(transceiver);
  side.pc.removeTrack(sender);
  assert.notEqual(side.pc.addTrack(side.track('audio'), []).transceiver, transceiver);
});

onBothSides(
  'removeTrack clears the track: sendrecv -> recvonly, then addTrack reuses it',
  (side) => {
    const { sender, transceiver } = side.pc.addTrack(side.track('audio'), []);
    side.pc.removeTrack(sender);
    assert.deepEqual([sender.track, transceiver.direction], [null, 'recvonly']);
    assert.equal(side.pc.addTrack(side.track('audio'), []).transceiver, transceiver);
  },
);

onBothSides('removeTrack turns sendonly into inactive', (side) => {
  const transceiver = side.pc.addTransceiver(side.track('audio'), { direction: 'sendonly' });
  side.pc.removeTrack(transceiver.sender);
  assert.deepEqual([transceiver.sender.track, transceiver.direction], [null, 'inactive']);
});

onBothSides('stop() sets stopping and direction stopped, and keeps the track', (side) => {
  const audio = side.track('audio');
  const transceiver = side.pc.addTransceiver(audio);
  transceiver.stop();
  assert.deepEqual(
    [transceiver.stopping, transceiver.stopped, transceiver.direction, transceiver.sender.track],
    [true, false, 'stopped', audio],
  );
});

onBothSides('the direction of a stopping transceiver cannot be set', (side) => {
  const transceiver = side.pc.addTransceiver('audio');
  transceiver.stop();
  assert.equal(
    errorOf(() => {
      transceiver.direction = 'sendonly';
    }),
    'INVALID_STATE: Cannot set direction on a stopping transceiver.',
  );
});

onBothSides("direction cannot be set to 'stopped'", (side) => {
  const transceiver = side.pc.addTransceiver('audio');
  assert.equal(
    errorOf(() => {
      transceiver.direction = 'stopped';
    }),
    "INVALID_PARAMETER: The set direction 'stopped' is invalid.",
  );
  assert.equal(transceiver.direction, 'sendrecv');
});

onBothSides(
  'close() sets the states to closed synchronously and stops every transceiver',
  (side) => {
    const audio = side.track('audio');
    const transceiver = side.pc.addTransceiver(audio);
    side.pc.close();
    const { pc } = side;
    assert.deepEqual(
      [pc.signalingState, pc.connectionState, pc.iceConnectionState, pc.iceGatheringState],
      ['closed', 'closed', 'closed', 'new'],
    );
    assert.deepEqual(pc.getTransceivers(), [transceiver]);
    assert.deepEqual(
      [
        transceiver.stopping,
        transceiver.stopped,
        transceiver.direction,
        transceiver.currentDirection,
      ],
      [true, true, 'stopped', 'stopped'],
    );
    assert.equal(transceiver.sender.track, audio);
  },
);

onBothSides(
  'close() queues connectionstatechange then signalingstatechange, once',
  async (side) => {
    await side.drain();
    side.events.length = 0;
    side.pc.close();
    side.pc.close();
    await side.drain();
    assert.deepEqual(side.events, [
      { kind: 'connectionstatechange', state: 'closed' },
      { kind: 'signalingstatechange', state: 'closed' },
    ]);
  },
);

onBothSides('after close(), async ops but getStats reject at call time', async (side) => {
  const { pc } = side;
  const sender = pc.addTransceiver('audio').sender;
  pc.close();
  const closed = 'INVALID_STATE: peer connection is closed';
  const candidate = 'candidate:1 1 udp 2122260223 192.0.2.1 50000 typ host';
  const offer = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n';
  const ops: [string, () => Promise<unknown>][] = [
    ['createOffer', () => pc.createOffer()],
    ['createAnswer', () => pc.createAnswer()],
    ['setLocalDescription', () => pc.setLocalDescription()],
    ['setRemoteDescription', () => pc.setRemoteDescription({ type: 'offer', sdp: offer })],
    ['addIceCandidate', () => pc.addIceCandidate({ candidate, sdpMid: '0', sdpMLineIndex: 0 })],
    ['sender.setParameters', () => sender.setParameters(sender.getParameters())],
  ];
  const results = [];
  for (const [name, op] of ops) results.push([name, await settledAtCallTime(op())]);
  assert.deepEqual(
    results,
    ops.map(([name]) => [name, closed]),
  );
  // getStats isn't rejected; whether it has resolved yet is up to libwebrtc.
  assert.notEqual(await settledAtCallTime(pc.getStats().catch(() => {})), closed);
});

onBothSides("after close(), PC methods throw libwebrtc's INVALID_STATE", (side) => {
  const { pc } = side;
  const sender = pc.addTransceiver('audio').sender;
  pc.close();
  const audio = side.track('audio');
  const results = {
    addTrack: errorOf(() => pc.addTrack(audio, [])),
    removeTrack: errorOf(() => pc.removeTrack(sender)),
    addTransceiver: errorOf(() => pc.addTransceiver('audio')),
    createDataChannel: errorOf(() => pc.createDataChannel('x')),
    setConfiguration: errorOf(() => pc.setConfiguration({})),
    restartIce: errorOf(() => pc.restartIce()),
  };
  assert.deepEqual(results, {
    addTrack: 'INVALID_STATE: PeerConnection is closed.',
    removeTrack: 'INVALID_STATE: PeerConnection is closed.',
    addTransceiver: 'INVALID_STATE: PeerConnection is closed.',
    createDataChannel: 'INVALID_STATE: CreateDataChannelOrError: PeerConnection is closed.',
    setConfiguration: 'INVALID_STATE: SetConfiguration: PeerConnection is closed.',
    restartIce: 'no error',
  });
});

test('shouldFireNegotiationNeededEvent accepts only the latest event id while stable [real]', async (t) => {
  const peer = new Peer(t);
  peer.pc.addTransceiver('audio');
  const { eventId } = await peer.waitFor('negotiationneeded');
  assert.deepEqual(
    [eventId - 1, eventId, eventId + 1].map((id) => peer.pc.shouldFireNegotiationNeededEvent(id)),
    [false, true, false],
  );
  peer.pc.close();
  assert.equal(peer.pc.shouldFireNegotiationNeededEvent(eventId), false, 'after close()');
});

test('shouldFireNegotiationNeededEvent accepts only the latest event id while stable [fake]', () => {
  const pc = new FakePeerConnection({}, () => {});
  pc.emit({ kind: 'negotiationneeded', eventId: 1 });
  pc.emit({ kind: 'negotiationneeded', eventId: 2 });
  assert.deepEqual(
    [1, 2, 3].map((id) => pc.shouldFireNegotiationNeededEvent(id)),
    [false, true, false],
  );
  pc.close();
  assert.equal(pc.shouldFireNegotiationNeededEvent(2), false, 'after close()');
});

// The order completeSetRemoteDescription() reproduces.
const srdOrder = ['signalingstatechange=have-remote-offer', 'track', 'resolved'];

test('SRD delivers signalingstatechange, then track, then its completion [real]', async (t) => {
  const offerer = new Peer(t);
  offerer.pc.addTransceiver('audio');
  const offer = await offerer.pc.createOffer();
  const log: string[] = [];
  const pc = new native.PeerConnection({}, (event) => {
    log.push(event.kind === 'signalingstatechange' ? `${event.kind}=${event.state}` : event.kind);
  });
  t.after(() => pc.close());
  await pc.setRemoteDescription(offer).then(() => log.push('resolved'));
  assert.deepEqual(log, srdOrder);
});

test('SRD delivers signalingstatechange, then track, then its completion [fake]', async () => {
  const log: string[] = [];
  const pc = new FakePeerConnection({}, (event) => {
    log.push(event.kind === 'signalingstatechange' ? `${event.kind}=${event.state}` : event.kind);
  });
  const done = pc.setRemoteDescription({ type: 'offer', sdp: '' }).then(() => log.push('resolved'));
  pc.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    tracks: [{ transceiver: new FakeTransceiver(pc.stream, { direction: 'recvonly' }) }],
  });
  await done;
  assert.deepEqual(log, srdOrder);
});

test('shouldFireNegotiationNeededEvent is false for the latest id outside stable [real]', async (t) => {
  const peer = new Peer(t);
  peer.pc.addTransceiver('audio');
  const { eventId } = await peer.waitFor('negotiationneeded');
  await peer.pc.setLocalDescription(await peer.pc.createOffer());
  assert.equal(peer.pc.signalingState, 'have-local-offer');
  assert.equal(peer.pc.shouldFireNegotiationNeededEvent(eventId), false);
});

test('shouldFireNegotiationNeededEvent is false for the latest id outside stable [fake]', () => {
  const pc = new FakePeerConnection({}, () => {});
  pc.emit({ kind: 'negotiationneeded', eventId: 1 });
  pc.signalingState = 'have-local-offer';
  assert.equal(pc.shouldFireNegotiationNeededEvent(1), false);
});

// The order completeSetLocalDescription() reproduces with removedReceivers
// (the answer names the transceiver's transport for the first time).
const sldAnswerOrder = [
  'removetrack',
  'signalingstatechange=stable',
  'dtls:state',
  'ice:state',
  'resolved',
];

test('SLD of an answer that stops receiving delivers removetrack before signalingstatechange [real]', async (t) => {
  const offerer = new Peer(t);
  offerer.pc.addTrack(new native.AudioSource().createTrack(), ['s']);
  const offer = await offerer.pc.createOffer();
  const log: string[] = [];
  // Held (not inline) so events queued around SLD can't be lost to GC.
  const onEvent = (event: NativePcEvent): void => {
    log.push(event.kind === 'signalingstatechange' ? `${event.kind}=${event.state}` : event.kind);
  };
  const pc = new native.PeerConnection({}, onEvent);
  t.after(() => pc.close());
  await pc.setRemoteDescription(offer);
  const [transceiver] = pc.getTransceivers();
  assert.ok(transceiver);
  transceiver.direction = 'inactive';
  const answer = await pc.createAnswer();
  log.length = 0;
  await pc.setLocalDescription(answer).then(() => log.push('resolved'));
  assert.deepEqual(log, sldAnswerOrder);
});

test('SLD of an answer that stops receiving delivers removetrack before signalingstatechange [fake]', async () => {
  const log: string[] = [];
  const pc = new FakePeerConnection({}, (event) => {
    log.push(event.kind === 'signalingstatechange' ? `${event.kind}=${event.state}` : event.kind);
  });
  pc.signalingState = 'have-remote-offer';
  const transceiver = new FakeTransceiver(pc.stream, { direction: 'inactive' });
  pc.transceivers.push(transceiver);
  const done = pc.setLocalDescription({ type: 'answer', sdp: '' }).then(() => log.push('resolved'));
  pc.completeSetLocalDescription({
    signalingState: 'stable',
    removedReceivers: [transceiver.receiver],
    snapshot: {
      transceivers: [transceiverState(transceiver, { senderTransport: 1, receiverTransport: 1 })],
    },
  });
  await done;
  assert.deepEqual(log, sldAnswerOrder);
});

onBothSides('createDataChannel reports its settings; ids are -1 until assigned', ({ pc }) => {
  const settings = (dc: NativeDataChannel) => [
    dc.label,
    dc.ordered,
    dc.maxPacketLifeTime,
    dc.maxRetransmits,
    dc.protocol,
    dc.negotiated,
    dc.id,
    dc.readyState,
    dc.maxSendQueueSize,
  ];
  const inBand = pc.createDataChannel('a', { ordered: false, maxRetransmits: 3, protocol: 'p' });
  const negotiated = pc.createDataChannel('b', { negotiated: true, id: 7, maxPacketLifeTime: 50 });
  assert.deepEqual(settings(inBand), ['a', false, null, 3, 'p', false, -1, 'connecting', 2 ** 24]);
  assert.deepEqual(settings(negotiated), ['b', true, 50, null, '', true, 7, 'connecting', 2 ** 24]);
});

onBothSides('a negotiated id in use or above 65534 throws INVALID_RANGE', ({ pc }) => {
  pc.createDataChannel('a', { negotiated: true, id: 5 });
  assert.equal(
    errorOf(() => pc.createDataChannel('b', { negotiated: true, id: 5 })),
    'INVALID_RANGE: StreamId reserved.',
  );
  assert.equal(
    errorOf(() => pc.createDataChannel('c', { negotiated: true, id: 65535 })),
    'INVALID_RANGE: StreamId out of range.',
  );
});

// Only the starting value is modelled: the fake's deliver() never drops
// (test/native/media.test.ts covers the real count).
onBothSides('a video sink starts with framesDropped 0, still readable after stop()', (side) => {
  const sink = side.videoSink(side.track('video'));
  assert.equal(sink.framesDropped, 0);
  sink.stop();
  assert.equal(sink.framesDropped, 0);
});

onBothSides('replaceTrack throws on a stopping sender', (side) => {
  const { transceiver } = side.pc.addTrack(side.track('audio'), []);
  transceiver.stop();
  assert.equal(
    errorOf(() => transceiver.sender.replaceTrack(side.track('audio'))),
    "INVALID_STATE: failed to replace the sender's track",
  );
});

onBothSides(
  'setJitterBufferMinimumDelay takes seconds or null, also after close(), and TypeError otherwise',
  ({ pc }) => {
    const { receiver } = pc.addTransceiver('video', { direction: 'recvonly' });
    receiver.setJitterBufferMinimumDelay(1);
    receiver.setJitterBufferMinimumDelay(0);
    receiver.setJitterBufferMinimumDelay(null);
    const set = (value: unknown) => () => receiver.setJitterBufferMinimumDelay(value as null);
    const negative = { name: 'TypeError', message: 'seconds must be a non-negative number' };
    const notNumber = { name: 'TypeError', message: 'seconds must be a number or null' };
    assert.throws(set(-0.5), negative);
    assert.throws(set(Number.NaN), negative);
    assert.throws(set('1'), notNumber);
    assert.throws(set(undefined), notNumber);
    pc.close();
    receiver.setJitterBufferMinimumDelay(0.5);
  },
);

onBothSides(
  'setDefaultDegradationPreference fills the preference only if unset, and TypeError otherwise',
  ({ pc }) => {
    const { sender } = pc.addTransceiver('video', { direction: 'sendonly' });
    sender.setDefaultDegradationPreference('maintain-resolution');
    sender.setDefaultDegradationPreference('balanced');
    assert.equal(sender.getParameters().degradationPreference, 'maintain-resolution');
    assert.throws(() => sender.setDefaultDegradationPreference('sideways'), {
      name: 'TypeError',
      message: 'invalid degradationPreference',
    });
  },
);

onBothSides('setConfiguration with certificates throws a TypeError, open or closed', ({ pc }) => {
  const rejected = { name: 'TypeError', message: 'certificates can only be set at construction' };
  assert.throws(() => pc.setConfiguration({ certificates: [] }), rejected);
  pc.close();
  assert.throws(() => pc.setConfiguration({ certificates: [] }), rejected);
});

type MakePc = (onEvent: (event: NativePcEvent) => void) => NativePeerConnection;

/**
 * The delivery order of tasks queued on two connections (`a`, `b`):
 * - a1, b2, a3 queued in that order, then b9 with `next` outside any
 *   callback, which goes to the back like the rest;
 * - while a1 is delivered, b11 and b12 with `next` (right after a1, in that
 *   order), and from a microtask of a1's task a14 with `next` (to the back:
 *   not in the callback any more);
 * - while b11 is delivered, a13 with `next` (right after b11, before b12).
 */
async function taskOrder(make: MakePc): Promise<string[]> {
  const order: string[] = [];
  const done = Promise.withResolvers<void>();
  const pcs: Record<string, NativePeerConnection> = {};
  const onEvent = (name: string) => (event: NativePcEvent) => {
    if (event.kind !== 'task') return;
    const task = `${name}${event.id}`;
    order.push(task);
    if (task === 'a1') {
      pcs.b?.queueTask(11, true);
      pcs.b?.queueTask(12, true);
      queueMicrotask(() => pcs.a?.queueTask(14, true));
    }
    if (task === 'b11') pcs.a?.queueTask(13, true);
    if (order.length === 8) done.resolve();
  };
  pcs.a = make(onEvent('a'));
  pcs.b = make(onEvent('b'));
  pcs.a.queueTask(1, false);
  pcs.b.queueTask(2, false);
  pcs.a.queueTask(3, false);
  pcs.b.queueTask(9, true);
  const timer = setTimeout(() => done.reject(new Error(`only ${order} delivered`)), 10_000);
  await done.promise.finally(() => clearTimeout(timer));
  return order;
}

const expectedTaskOrder = ['a1', 'b11', 'a13', 'b12', 'b2', 'a3', 'b9', 'a14'];

function realPc(t: TestContext): MakePc {
  return (onEvent) => {
    const pc = new native.PeerConnection({}, onEvent);
    t.after(() => pc.close());
    return pc;
  };
}

const fakePc: MakePc = (onEvent) => new FakePeerConnection({}, onEvent);

test('queueTask: queue order across connections; next only from a callback, FIFO per delivery [real]', async (t) => {
  assert.deepEqual(await taskOrder(realPc(t)), expectedTaskOrder);
});

test('queueTask: queue order across connections; next only from a callback, FIFO per delivery [fake]', async () => {
  assert.deepEqual(await taskOrder(fakePc), expectedTaskOrder);
});

/** What each bad queueTask() call throws, as `name: message`. */
function queueTaskErrors(make: MakePc): string[] {
  const pc = make(() => {});
  const queueTask = pc.queueTask.bind(pc) as (...args: unknown[]) => void;
  return [[], [1], ['1', false], [1, 'true']].map((args) => {
    try {
      queueTask(...args);
      return 'no error';
    } catch (error) {
      return `${(error as Error).name}: ${(error as Error).message}`;
    }
  });
}

test('queueTask rejects arguments of the wrong type with a TypeError [real]', (t) => {
  assert.deepEqual(queueTaskErrors(realPc(t)), Array(4).fill('TypeError: queueTask(id, next)'));
});

test('queueTask rejects arguments of the wrong type with a TypeError [fake]', () => {
  assert.deepEqual(queueTaskErrors(fakePc), Array(4).fill('TypeError: queueTask(id, next)'));
});
