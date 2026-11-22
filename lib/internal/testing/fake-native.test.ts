import assert from 'node:assert/strict';
import { test } from 'node:test';
import { native } from '../native.ts';
import type { NativeError, NativePcEvent } from '../native-types.ts';
import {
  FakeAudioSink,
  FakePeerConnection,
  FakeTrack,
  FakeTransceiver,
  FakeVideoSink,
  nativeError,
  snapshot,
  transceiverState,
  useFakeNative,
} from './fake-native.ts';

const offer = { type: 'offer', sdp: 'v=0 offer' } as const;
const answer = { type: 'answer', sdp: 'v=0 answer' } as const;

function newFakePc(events: NativePcEvent[] = []): FakePeerConnection {
  return new FakePeerConnection({}, (event) => events.push(event));
}

test('calls on a PC and its RTP objects are logged in order, with exact arguments', () => {
  const pc = newFakePc();
  const track = new FakeTrack('video');
  const { sender } = pc.addTrack(track, ['s1']);
  void pc.createOffer();
  sender.replaceTrack(null);
  void pc.setLocalDescription(offer);

  assert.deepEqual(
    pc.stream.calls.map((call) => [call.target === pc ? 'pc' : 'sender', call.method, call.args]),
    [
      ['pc', 'addTrack', [track, ['s1']]],
      ['pc', 'createOffer', []],
      ['sender', 'replaceTrack', [null]],
      ['pc', 'setLocalDescription', [offer]],
    ],
  );
  assert.deepEqual(pc.callsTo('setLocalDescription'), [[offer]]);
  assert.deepEqual(
    pc.calls.map((call) => call.method),
    ['addTrack', 'createOffer', 'setLocalDescription'],
  );
});

test('async calls settle only when, and in the order, the test settles them', async () => {
  const pc = newFakePc();
  const settled: string[] = [];
  pc.createOffer().then((d) => settled.push(`offer:${d.sdp}`));
  pc.setRemoteDescription(answer).then((s) => settled.push(`srd:${s.signalingState}`));
  await pc.flush();
  assert.deepEqual(settled, [], 'nothing settles on its own');

  pc.pending('setRemoteDescription').resolve(snapshot({ signalingState: 'have-remote-offer' }));
  pc.pending('createOffer').resolve(offer);
  await pc.flush();

  assert.deepEqual(settled, ['srd:have-remote-offer', 'offer:v=0 offer']);
});

test('pending() gives the oldest unsettled call of that method', async () => {
  const pc = newFakePc();
  const first = pc.addIceCandidate({ candidate: 'a', sdpMid: '0', sdpMLineIndex: 0 });
  void pc.addIceCandidate({ candidate: 'b', sdpMid: '0', sdpMLineIndex: 0 });

  const oldest = pc.pending('addIceCandidate');
  assert.equal(oldest.args[0].candidate, 'a');
  oldest.reject(nativeError('OPERATION_ERROR_WITH_DATA', 'bad candidate'));
  assert.equal(pc.pending('addIceCandidate').args[0].candidate, 'b');
  assert.equal(pc.pendingCount('addIceCandidate'), 1);
  assert.throws(() => oldest.resolve(), /addIceCandidate\(\) was already settled/);

  await assert.rejects(first, { errorType: 'OPERATION_ERROR_WITH_DATA', message: 'bad candidate' });
});

test('pending() without such a call throws, listing what was called', () => {
  const pc = newFakePc();
  pc.restartIce();
  assert.throws(() => pc.pending('createAnswer'), {
    message: 'FakePeerConnection: no unsettled createAnswer() call (calls so far: restartIce)',
  });
});

test('emit() delivers in a later task, never synchronously', async () => {
  const events: NativePcEvent[] = [];
  const pc = newFakePc(events);
  pc.emit({ kind: 'negotiationneeded', eventId: 1 });
  await Promise.resolve();
  assert.deepEqual(events, [], 'not delivered within the same task');
  await pc.flush();
  assert.deepEqual(events, [{ kind: 'negotiationneeded', eventId: 1 }]);
});

test('events and settlements are delivered in queue order, one task each, microtasks between', async () => {
  const log: string[] = [];
  const pc = new FakePeerConnection({}, (event) => {
    log.push(`event:${event.kind}`);
    queueMicrotask(() => log.push(`microtask after ${event.kind}`));
  });
  pc.setRemoteDescription(offer).then(() => log.push('srd continuation'));

  pc.emit({ kind: 'signalingstatechange', state: 'have-remote-offer' });
  pc.pending('setRemoteDescription').resolve(snapshot());
  pc.emit({ kind: 'negotiationneeded', eventId: 2 });
  await pc.flush();

  assert.deepEqual(log, [
    'event:signalingstatechange',
    'microtask after signalingstatechange',
    'srd continuation',
    'event:negotiationneeded',
    'microtask after negotiationneeded',
  ]);
});

test('flush() also waits for deliveries queued by earlier deliveries', async () => {
  const events: string[] = [];
  const pc: FakePeerConnection = new FakePeerConnection({}, (event) => {
    events.push(event.kind);
    if (event.kind === 'negotiationneeded') {
      queueMicrotask(() => pc.emit({ kind: 'connectionstatechange', state: 'connecting' }));
    }
  });
  pc.emit({ kind: 'negotiationneeded', eventId: 1 });
  await pc.flush();
  assert.deepEqual(events, ['negotiationneeded', 'connectionstatechange']);
});

test('stub() replaces a method and still records the call', () => {
  const pc = newFakePc();
  pc.stub('addTransceiver', () => {
    throw nativeError('INVALID_STATE', 'peer connection is closed');
  });
  assert.throws(() => pc.addTransceiver('audio'), {
    name: 'Error',
    errorType: 'INVALID_STATE',
    message: 'peer connection is closed',
  });
  assert.deepEqual(pc.callsTo('addTransceiver'), [['audio']]);
});

test('addTransceiver() returns the transceiver it appends, of the given kind and direction', () => {
  const pc = newFakePc();
  const returned = pc.addTransceiver('video', { direction: 'recvonly' });
  assert.deepEqual(pc.transceivers, [returned]);
  assert.deepEqual([returned.direction, returned.receiver.track.kind], ['recvonly', 'video']);
});

test("RTP objects' settlements are queued in order with the PC's events", async () => {
  const log: string[] = [];
  const pc = new FakePeerConnection({}, (event) => log.push(`event ${event.kind}`));
  const transceiver = pc.addTransceiver('video');
  transceiver.receiver.getStats().then(() => log.push('receiver stats'));
  pc.emit({ kind: 'negotiationneeded', eventId: 1 });
  transceiver.receiver.pending('getStats').resolve('{}');
  pc.emit({ kind: 'connectionstatechange', state: 'connecting' });
  await pc.flush();
  assert.deepEqual(log, [
    'event negotiationneeded',
    'receiver stats',
    'event connectionstatechange',
  ]);
});

// The libwebrtc-modelled defaults (addTrack, removeTrack, stop(), close(),
// shouldFire...) are tested against the real addon too, in
// test/native/fake-native-drift.test.ts. These cover what only the fake has.

test('setting currentDirection to a sending direction marks the transceiver as used to send', () => {
  const pc = newFakePc();
  const transceiver = pc.addTransceiver('audio');
  transceiver.currentDirection = 'sendonly';
  transceiver.currentDirection = 'inactive';
  assert.equal(transceiver.hasEverBeenUsedToSend, true, 'sticky, as in libwebrtc');
});

test('forceDirection() scripts any direction, bypassing the setter checks', () => {
  const transceiver = new FakeTransceiver();
  transceiver.stop();
  transceiver.forceDirection('sendonly');
  assert.equal(transceiver.direction, 'sendonly');
});

test('pc.snapshot() describes the current signaling state and transceivers', () => {
  const pc = newFakePc();
  const transceiver = pc.addTransceiver('audio');
  transceiver.mid = '0';
  pc.signalingState = 'have-local-offer';
  assert.deepEqual(pc.snapshot({ localDescription: offer }), {
    ...snapshot({ signalingState: 'have-local-offer', localDescription: offer }),
    transceivers: [transceiverState(transceiver)],
    sctp: null,
  });
  assert.deepEqual(pc.snapshot({ transceivers: [] }).transceivers, [], 'overrides win');
});

test('completeSetRemoteDescription() delivers state change, tracks, removals, completion', async () => {
  const log: string[] = [];
  const pc = new FakePeerConnection({}, (event) => {
    log.push(event.kind === 'signalingstatechange' ? `${event.kind}=${event.state}` : event.kind);
  });
  const old = pc.addTransceiver('audio');
  const srd = pc.setRemoteDescription(offer).then((s) => {
    log.push('resolved');
    return s;
  });
  const remote = new FakeTransceiver(pc.stream, { kind: 'video', direction: 'recvonly' });
  pc.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    tracks: [{ transceiver: remote, streamIds: ['s'] }],
    removedReceivers: [old.receiver],
  });
  assert.equal(pc.signalingState, 'have-remote-offer', 'the live getter changes at once');
  const result = await srd;

  assert.deepEqual(log, [
    'signalingstatechange=have-remote-offer',
    'track',
    'removetrack',
    'resolved',
  ]);
  assert.deepEqual(pc.transceivers, [old, remote], 'a new remote transceiver is appended');
  assert.deepEqual(
    result.transceivers?.map((s) => s.transceiver),
    [old, remote],
  );
});

test('complete*Description() skips signalingstatechange when the state does not change', async () => {
  const events: NativePcEvent[] = [];
  const pc = newFakePc(events);
  pc.signalingState = 'have-remote-pranswer';
  const srd = pc.setRemoteDescription({ type: 'pranswer', sdp: '' });
  pc.completeSetRemoteDescription({ signalingState: 'have-remote-pranswer' });
  assert.equal((await srd).signalingState, 'have-remote-pranswer');
  assert.deepEqual(events, []);
});

test('completeSetLocalDescription() delivers the state change, then the completion', async () => {
  const log: string[] = [];
  const pc = new FakePeerConnection({}, (event) => log.push(event.kind));
  const sld = pc.setLocalDescription(offer).then(() => log.push('resolved'));
  pc.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: { localDescription: offer },
  });
  pc.emit({ kind: 'icegatheringstatechange', state: 'gathering' });
  await sld;
  await pc.flush();
  assert.deepEqual(log, ['signalingstatechange', 'resolved', 'icegatheringstatechange']);
});

test('ops pending at close() can still be settled, and getStats still pends', async () => {
  const pc = newFakePc();
  const sender = pc.addTransceiver('audio').sender;
  const offerPromise = pc.createOffer();
  pc.close();
  void sender.getStats();
  void pc.getStats();
  assert.equal(pc.pendingCount('getStats'), 1);
  assert.equal(sender.pendingCount('getStats'), 1);
  pc.pending('createOffer').resolve(offer);
  assert.equal(await offerPromise, offer);
});

test('a stub overrides the closed-PC behaviour', () => {
  const pc = newFakePc();
  pc.close();
  pc.stub('addTransceiver', () => new FakeTransceiver(pc.stream));
  assert.doesNotThrow(() => pc.addTransceiver('audio'));
});

test('nativeError() has the same shape as a real native error', async (t) => {
  const real = new native.PeerConnection({}, () => {});
  t.after(() => real.close());
  real.close();
  const realError = (await real.createOffer().catch((e: unknown) => e)) as NativeError;
  const fake = nativeError('INVALID_STATE', 'peer connection is closed');

  assert.equal(Object.getPrototypeOf(fake), Object.getPrototypeOf(realError));
  assert.deepEqual(
    Object.getOwnPropertyNames(fake).sort(),
    Object.getOwnPropertyNames(realError).sort(),
  );
  assert.deepEqual(
    [fake.name, fake.errorType, fake.message],
    [realError.name, realError.errorType, realError.message],
  );
  assert.equal(nativeError('SYNTAX_ERROR', 'x', 'a=bad').sdpLine, 'a=bad');
});

test('useFakeNative() replaces members for one test and restores them after it', async (t) => {
  const originals = { AudioSink: native.AudioSink, VideoSink: native.VideoSink };
  await t.test('inner test with fakes', (t) => {
    useFakeNative(t, { AudioSink: FakeAudioSink, VideoSink: FakeVideoSink });
    assert.notEqual(native.AudioSink, originals.AudioSink);
    assert.notEqual(native.VideoSink, originals.VideoSink);
  });
  assert.equal(native.AudioSink, originals.AudioSink);
  assert.equal(native.VideoSink, originals.VideoSink);
});

test('useFakeNative() exposes the instances the code under test constructed', (t) => {
  const fakes = useFakeNative(t, { PeerConnection: FakePeerConnection });
  const config = { iceCandidatePoolSize: 1 };
  const pc = new native.PeerConnection(config, () => {});

  assert.equal(fakes.last('PeerConnection'), pc);
  assert.ok(pc instanceof FakePeerConnection);
  assert.equal(fakes.last('PeerConnection').config, config);
  assert.deepEqual(fakes.instances('PeerConnection'), [pc]);
});

test('useFakeNative() rejects unknown members and faking a member twice', (t) => {
  useFakeNative(t, { AudioSink: FakeAudioSink });
  assert.throws(() => useFakeNative(t, { AudioSink: FakeAudioSink }), {
    message: 'useFakeNative: AudioSink is already faked',
  });
  assert.throws(() => useFakeNative(t, { AudioSnik: FakeAudioSink } as never), {
    message: 'useFakeNative: the addon has no member AudioSnik',
  });
});

test('complete*Description() applies snapshot transceiver state to the fakes', async () => {
  const pc = new FakePeerConnection({}, () => {});
  const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
  const done = pc.setRemoteDescription({ type: 'offer', sdp: '' });
  pc.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    snapshot: {
      transceivers: [
        transceiverState(transceiver, {
          mid: '0',
          direction: 'sendrecv',
          currentDirection: 'sendrecv',
        }),
      ],
    },
  });
  await done;
  assert.deepEqual(
    {
      mid: transceiver.mid,
      direction: transceiver.direction,
      currentDirection: transceiver.currentDirection,
      hasEverBeenUsedToSend: transceiver.hasEverBeenUsedToSend,
    },
    { mid: '0', direction: 'sendrecv', currentDirection: 'sendrecv', hasEverBeenUsedToSend: true },
  );
});
