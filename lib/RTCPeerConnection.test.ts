// RTCPeerConnection against the fake native addon: the orderings, state
// caching and error mapping that real libwebrtc can't produce on demand.
// End-to-end behaviour is in test/integration/.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { NativeSessionDescription } from './internal/native-types.ts';
import {
  descriptionSnapshot,
  FakePeerConnection,
  FakeTrack,
  FakeTransceiver,
  fakeCertificateGenerator,
  nativeError,
  transceiverState,
  useFakeNative,
} from './internal/testing/fake-native.ts';
import type { MediaStream, MediaStreamEvent, MediaStreamTrackEvent } from './MediaStream.ts';
import { nativeTrackOf, trackFromNative } from './MediaStreamTrack.ts';
import type { RTCCertificate } from './RTCCertificate.ts';
import { RTCError } from './RTCError.ts';
import { type RTCConfiguration, RTCPeerConnection } from './RTCPeerConnection.ts';
import type { RTCPeerConnectionIceErrorEvent } from './RTCPeerConnectionIceErrorEvent.ts';
import type { RTCPeerConnectionIceEvent } from './RTCPeerConnectionIceEvent.ts';
import { transceiverStateOf } from './RTCRtpTransceiver.ts';
import type { RTCTrackEvent } from './RTCTrackEvent.ts';

setFlagsFromString('--expose-gc');

// Two unbundled transports (mids 0 and 1), trickle, ufrag 'uf'.
const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=ice-options:trickle',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=mid:0',
  'a=ice-ufrag:uf',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:1',
  'a=ice-ufrag:uf',
  '',
].join('\r\n');
const offer: NativeSessionDescription = { type: 'offer', sdp: SDP };
const answer: NativeSessionDescription = { type: 'answer', sdp: SDP };
// The same two m-sections offered as one BUNDLE group, as libwebrtc's
// initial offer under 'balanced' does.
const bundledOffer: NativeSessionDescription = {
  type: 'offer',
  sdp: SDP.replace('a=ice-options:trickle\r\n', 'a=ice-options:trickle\r\na=group:BUNDLE 0 1\r\n'),
};
// Two m-sections with different ufrags: 'u0' (mid 0) and 'u1' (mid 1).
const twoUfrags: NativeSessionDescription = {
  type: 'offer',
  sdp: SDP.replace('a=ice-ufrag:uf', 'a=ice-ufrag:u0').replace('a=ice-ufrag:uf', 'a=ice-ufrag:u1'),
};
const CANDIDATE = 'candidate:1 1 udp 2122260223 192.0.2.1 50000 typ host generation 0 ufrag uf';

function setup(t: TestContext, config?: RTCConfiguration) {
  const fakes = useFakeNative(t, { PeerConnection: FakePeerConnection });
  const pc = new RTCPeerConnection(config);
  t.after(() => pc.close());
  return { pc, fake: fakes.last('PeerConnection') };
}

/** Logs each event of `types` on `target` as `type` plus `describe(event)`. */
function record(
  target: EventTarget,
  types: string[],
  log: string[],
  describe: (event: Event) => string = () => '',
): void {
  for (const type of types) {
    target.addEventListener(type, (event) => log.push(`${type}${describe(event)}`.trim()));
  }
}

/** 'pending', 'resolved' or 'rejected: <name>' once queued deliveries have run. */
async function stateOf(promise: Promise<unknown>, fake: FakePeerConnection): Promise<string> {
  let state = 'pending';
  promise.then(
    () => {
      state = 'resolved';
    },
    (e: Error) => {
      state = `rejected: ${e.name}`;
    },
  );
  await fake.flush();
  return state;
}

const audioTrack = () => trackFromNative(new FakeTrack('audio'));

/** How many a=end-of-candidates lines `sdp` has. */
const endOfCandidates = (sdp: string | undefined) =>
  (sdp ?? '').split('\r\n').filter((line) => line === 'a=end-of-candidates').length;

/** The media section (from its m= line to the next) of `sdp` at `index`. */
const mediaSection = (sdp: string | undefined, index: number) =>
  (sdp ?? '').split(/\r\n(?=m=)/)[index + 1] ?? '';

/**
 * Collects uncaught exceptions (as a throwing event listener raises) for
 * the rest of the test, instead of node:test failing the test on them.
 */
function captureUncaught(t: TestContext): unknown[] {
  const caught: unknown[] = [];
  const runners = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (error) => caught.push(error));
  t.after(() => {
    process.removeAllListeners('uncaughtException');
    for (const listener of runners) process.on('uncaughtException', listener);
  });
  return caught;
}

/**
 * Applies a remote offer whose audio m-line (mid 0) creates `remote`,
 * received in stream `s`. Returns the fake transceiver.
 */
async function receiveAudio(
  pc: RTCPeerConnection,
  fake: FakePeerConnection,
): Promise<{ remote: FakeTransceiver; event: RTCTrackEvent }> {
  const remote = new FakeTransceiver(fake.stream, { kind: 'audio', direction: 'recvonly' });
  const tracked = Promise.withResolvers<RTCTrackEvent>();
  pc.addEventListener('track', (e) => tracked.resolve(e as RTCTrackEvent), { once: true });
  const srd = pc.setRemoteDescription(offer);
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    tracks: [{ transceiver: remote, streamIds: ['s'] }],
    snapshot: {
      remoteDescription: offer,
      pendingRemoteDescription: offer,
      transceivers: [
        transceiverState(remote, {
          mid: '0',
          firedDirection: 'sendrecv',
          receiverStreamIds: ['s'],
        }),
      ],
    },
  });
  await srd;
  return { remote, event: await tracked.promise };
}

// ---------------------------------------------------------------------------
// Operations chain

test('a description invalid for the signaling state rejects with InvalidStateError before libwebrtc', async (t) => {
  const { pc, fake } = setup(t);
  await assert.rejects(pc.setRemoteDescription(answer), {
    name: 'InvalidStateError',
    message: /remote answer can't be set in state 'stable'/,
  });
  await assert.rejects(pc.createAnswer(), { name: 'InvalidStateError' });
  await assert.rejects(pc.setLocalDescription({ type: 'rollback' }), { name: 'InvalidStateError' });
  assert.deepEqual(
    fake.calls.map((c) => c.method),
    [],
  );
});

test('operations run in call order, each checking the state when it starts', async (t) => {
  const { pc, fake } = setup(t);
  const created = pc.createOffer();
  const sld = pc.setLocalDescription();
  // Queued while still 'stable'; valid once the SLD has made it have-local-offer.
  const srd = pc.setRemoteDescription(answer);
  assert.equal(fake.callsTo('setLocalDescription').length, 0, 'SLD waits for createOffer');

  fake.pending('createOffer').resolve(offer);
  await created;
  await fake.flush();
  assert.equal(fake.callsTo('setLocalDescription').length, 1);
  assert.equal(fake.callsTo('setRemoteDescription').length, 0, 'SRD waits for SLD');
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: { localDescription: offer, pendingLocalDescription: offer },
  });
  await sld;
  await fake.flush();
  assert.deepEqual(fake.callsTo('setRemoteDescription'), [[answer]]);
  fake.completeSetRemoteDescription({ signalingState: 'stable' });
  await srd;
  assert.equal(pc.signalingState, 'stable');
});

/** SDP of `type` with an a=fingerprint line in its first section. */
function withFingerprint(
  type: NativeSessionDescription['type'],
  fp: string,
): NativeSessionDescription {
  return { type, sdp: SDP.replace('a=mid:0\r\n', `a=mid:0\r\na=fingerprint:sha-256 ${fp}\r\n`) };
}

/** Asserts that setLocalDescription(description) gets Chrome's fingerprint rejection. */
async function rejectsAsModified(pc: RTCPeerConnection, description: NativeSessionDescription) {
  const error = await pc.setLocalDescription(description).then(
    () => null,
    (e: Error) => e,
  );
  assert.equal(error?.name, 'InvalidModificationError', description.sdp);
  assert.match(error?.message ?? '', /does not match the previously generated SDP/);
}

test("setLocalDescription rejects a fingerprint the last created offer didn't have, before libwebrtc (as Chrome)", async (t) => {
  const { pc, fake } = setup(t);
  const created = pc.createOffer();
  fake.pending('createOffer').resolve(withFingerprint('offer', 'AA'));
  await created;

  await rejectsAsModified(pc, withFingerprint('offer', 'BB'));
  assert.deepEqual(fake.callsTo('setLocalDescription'), []);

  // Other munging, and SDP with no fingerprint, still go to libwebrtc.
  const munged = {
    type: 'offer' as const,
    sdp: `${withFingerprint('offer', 'AA').sdp}a=x-munged\r\n`,
  };
  const sld = pc.setLocalDescription(munged);
  await fake.flush();
  assert.deepEqual(fake.callsTo('setLocalDescription'), [[munged]]);
  fake.completeSetLocalDescription({ signalingState: 'have-local-offer' });
  await sld;
  const plain = pc.setLocalDescription(offer);
  await fake.flush();
  assert.deepEqual(fake.callsTo('setLocalDescription')[1], [offer]);
  fake.completeSetLocalDescription({ signalingState: 'have-local-offer' });
  await plain;
});

test('a fingerprint with no offer from createOffer() is rejected, even our own SDP (as Chrome)', async (t) => {
  const { pc, fake } = setup(t);
  // libwebrtc creates the implicit SLD's offer itself: no [[LastCreatedOffer]].
  const own = withFingerprint('offer', 'AA');
  const implicit = pc.setLocalDescription();
  await fake.flush();
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: { localDescription: own, pendingLocalDescription: own },
  });
  await implicit;
  // Chromium 159 rejects setLocalDescription(pc.localDescription) here too.
  await rejectsAsModified(pc, { type: 'offer', sdp: pc.localDescription?.sdp ?? '' });
  assert.equal(fake.callsTo('setLocalDescription').length, 1, 'only the implicit SLD');
});

test('a pranswer is checked against the last created answer', async (t) => {
  const { pc, fake } = setup(t);
  await setRemoteOffer(pc, fake, offer);
  // No answer created yet: any fingerprint is foreign.
  await rejectsAsModified(pc, withFingerprint('pranswer', 'AA'));

  const created = pc.createAnswer();
  fake.pending('createAnswer').resolve(withFingerprint('answer', 'AA'));
  await created;
  await rejectsAsModified(pc, withFingerprint('pranswer', 'BB'));
  assert.deepEqual(fake.callsTo('setLocalDescription'), []);

  const pranswer = withFingerprint('pranswer', 'AA');
  const sld = pc.setLocalDescription(pranswer);
  await fake.flush();
  assert.deepEqual(fake.callsTo('setLocalDescription'), [[pranswer]]);
  fake.completeSetLocalDescription({ signalingState: 'have-local-pranswer' });
  await sld;
});

test('createOffer outside stable/have-local-offer rejects with InvalidStateError in the same task', async (t) => {
  const { pc, fake } = setup(t);
  await receiveAudio(pc, fake);
  let outcome = 'pending';
  pc.createOffer().catch((e: Error) => {
    outcome = e.name;
  });
  // Microtasks only: no task boundary (WPT RTCPeerConnection-operations).
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(outcome, 'InvalidStateError');
  assert.deepEqual(fake.callsTo('createOffer'), []);
});

test('a remote rollback in have-local-offer rejects with InvalidStateError before libwebrtc', async (t) => {
  const { pc, fake } = setup(t);
  await setLocalOffer(pc, fake, offer);
  await assert.rejects(pc.setRemoteDescription({ type: 'rollback' }), {
    name: 'InvalidStateError',
    message: /remote rollback can't be set in state 'have-local-offer'/,
  });
  assert.deepEqual(fake.callsTo('setRemoteDescription'), []);
});

test('a local rollback in have-remote-offer rejects with InvalidStateError before libwebrtc', async (t) => {
  const { pc, fake } = setup(t);
  await setRemoteOffer(pc, fake, offer);
  const callsBefore = fake.callsTo('setLocalDescription').length;
  await assert.rejects(pc.setLocalDescription({ type: 'rollback' }), {
    name: 'InvalidStateError',
    message: /local rollback can't be set in state 'have-remote-offer'/,
  });
  assert.equal(fake.callsTo('setLocalDescription').length, callsBefore);
});

test('a remote offer in have-local-offer rolls the local offer back first (implicit rollback)', async (t) => {
  const { pc, fake } = setup(t);
  await setLocalOffer(pc, fake, offer);
  const log: string[] = [];
  record(pc, ['signalingstatechange'], log, () => ` ${pc.signalingState}`);
  const srd = pc.setRemoteDescription(offer).then(() => log.push('resolved'));
  assert.deepEqual(fake.callsTo('setLocalDescription').at(-1), [{ type: 'rollback', sdp: '' }]);
  assert.deepEqual(fake.callsTo('setRemoteDescription'), [], 'waits for the rollback');
  fake.completeSetLocalDescription({ signalingState: 'stable' });
  await fake.flush();
  assert.deepEqual(log, ['signalingstatechange stable']);
  assert.deepEqual(fake.callsTo('setRemoteDescription'), [[offer]]);
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    snapshot: { remoteDescription: offer, pendingRemoteDescription: offer },
  });
  await srd;
  assert.deepEqual(log, [
    'signalingstatechange stable',
    'signalingstatechange have-remote-offer',
    'resolved',
  ]);
});

test('setLocalDescription without SDP uses the last created offer while nothing has changed', async (t) => {
  const { pc, fake } = setup(t);
  const created = pc.createOffer();
  fake.pending('createOffer').resolve(offer);
  await created;
  await fake.flush();
  const sld = pc.setLocalDescription({ type: 'offer' });
  assert.deepEqual(fake.callsTo('setLocalDescription'), [[offer]]);
  fake.completeSetLocalDescription({ signalingState: 'have-local-offer' });
  await sld;

  // A change since createOffer() makes libwebrtc create a fresh one.
  await fake.flush();
  const again = pc.createOffer();
  fake.pending('createOffer').resolve(offer);
  await again;
  await fake.flush();
  pc.addTransceiver('audio');
  const implicit = pc.setLocalDescription();
  assert.deepEqual(fake.callsTo('setLocalDescription').at(-1), []);
  fake.completeSetLocalDescription({ signalingState: 'have-local-offer' });
  await implicit;
});

test('a change made while createOffer is in flight creates the offer again (final steps)', async (t) => {
  const { pc, fake } = setup(t);
  const created = pc.createOffer();
  // The native call is in flight; the PC changes before it completes.
  pc.addTransceiver('audio');
  fake.pending('createOffer').resolve(offer);
  await fake.flush();
  assert.equal(fake.callsTo('createOffer').length, 2, 'created again');
  fake.pending('createOffer').resolve(bundledOffer);
  assert.equal((await created).sdp, bundledOffer.sdp);
  await fake.flush();
  // The second offer is current, so an implicit SLD reuses it.
  const implicit = pc.setLocalDescription();
  assert.deepEqual(fake.callsTo('setLocalDescription').at(-1), [bundledOffer]);
  fake.completeSetLocalDescription({ signalingState: 'have-local-offer' });
  await implicit;
});

test('a change made while createAnswer is in flight creates the answer again', async (t) => {
  const { pc, fake } = setup(t);
  await setRemoteOffer(pc, fake, offer);
  const created = pc.createAnswer();
  await fake.flush();
  pc.addTransceiver('video');
  fake.pending('createAnswer').resolve(answer);
  await fake.flush();
  const second = { type: 'answer' as const, sdp: bundledOffer.sdp };
  fake.pending('createAnswer').resolve(second);
  assert.equal((await created).sdp, second.sdp);
  assert.equal(fake.callsTo('createAnswer').length, 2);
});

// An offer whose second section reuses the first's extmap id 1 within one
// BUNDLE group, as libwebrtc creates after a rollback
// (lib/internal/extmap-fix.ts).
const TOFFSET = 'urn:ietf:params:rtp-hdrext:toffset';
const collidingOffer: NativeSessionDescription = {
  type: 'offer',
  sdp: bundledOffer.sdp
    .replace('a=mid:0\r\n', 'a=mid:0\r\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\n')
    .replace('a=mid:1\r\n', `a=mid:1\r\na=extmap:1 ${TOFFSET}\r\n`),
};
const collision = () =>
  nativeError(
    'INVALID_PARAMETER',
    'Failed to set local offer sdp: A BUNDLE group contains a codec collision for header ' +
      'extension id=1. The id must be the same across all bundled media descriptions',
  );

test('createOffer renumbers extmap ids that collide within a BUNDLE group', async (t) => {
  const { pc, fake } = setup(t);
  const created = pc.createOffer();
  fake.pending('createOffer').resolve(collidingOffer);
  const { sdp } = await created;
  assert.equal(sdp, collidingOffer.sdp.replace(`a=extmap:1 ${TOFFSET}`, `a=extmap:14 ${TOFFSET}`));
  // That fixed offer is what an SLD without SDP applies.
  await fake.flush();
  const sld = pc.setLocalDescription();
  assert.deepEqual(fake.callsTo('setLocalDescription'), [[{ type: 'offer', sdp }]]);
  fake.completeSetLocalDescription({ signalingState: 'have-local-offer' });
  await sld;
});

test('an implicit offer libwebrtc rejects for its own extmap collision is retried once, created and fixed', async (t) => {
  const { pc, fake } = setup(t);
  const sld = pc.setLocalDescription();
  assert.deepEqual(fake.callsTo('setLocalDescription'), [[]]);
  fake.pending('setLocalDescription').reject(collision());
  await fake.flush();
  fake.pending('createOffer').resolve(collidingOffer);
  await fake.flush();
  const [, retry] = fake.callsTo('setLocalDescription') as [unknown, [NativeSessionDescription]];
  assert.equal(fake.callsTo('setLocalDescription').length, 2);
  assert.match(retry[0].sdp, /a=extmap:14 urn:ietf:params:rtp-hdrext:toffset/);
  fake.completeSetLocalDescription({ signalingState: 'have-local-offer' });
  await sld;
  assert.equal(pc.signalingState, 'have-local-offer');
});

test('other implicit SLD failures, and explicit offers, are not retried', async (t) => {
  const { pc, fake } = setup(t);
  const implicit = pc.setLocalDescription();
  fake.pending('setLocalDescription').reject(nativeError('INVALID_PARAMETER', 'something else'));
  await assert.rejects(implicit, { name: 'InvalidAccessError', message: 'something else' });
  const explicit = pc.setLocalDescription(collidingOffer);
  fake.pending('setLocalDescription').reject(collision());
  await assert.rejects(explicit, { name: 'InvalidAccessError' });
  assert.equal(fake.callsTo('createOffer').length, 0);
  assert.equal(fake.callsTo('setLocalDescription').length, 2);
});

test('setLocalDescription without SDP uses the last created answer, also as a pranswer', async (t) => {
  const { pc, fake } = setup(t);
  await receiveAudio(pc, fake);
  const created = pc.createAnswer();
  fake.pending('createAnswer').resolve(answer);
  await created;
  await fake.flush();
  const sld = pc.setLocalDescription({ type: 'pranswer' });
  assert.deepEqual(fake.callsTo('setLocalDescription'), [[{ type: 'pranswer', sdp: SDP }]]);
  fake.completeSetLocalDescription({ signalingState: 'have-local-pranswer' });
  await sld;
});

test('a pranswer without SDP or a last created answer creates one and applies it as a pranswer', async (t) => {
  const { pc, fake } = setup(t);
  await receiveAudio(pc, fake);
  const sld = pc.setLocalDescription({ type: 'pranswer' });
  assert.equal(fake.callsTo('createAnswer').length, 1);
  fake.pending('createAnswer').resolve(answer);
  await fake.flush();
  assert.deepEqual(fake.callsTo('setLocalDescription'), [[{ type: 'pranswer', sdp: SDP }]]);
  fake.completeSetLocalDescription({ signalingState: 'have-local-pranswer' });
  await sld;
  assert.equal(pc.signalingState, 'have-local-pranswer');
});

test('argument conversion errors reject the promise rather than throwing', async (t) => {
  const { pc } = setup(t);
  const results = [
    pc.setRemoteDescription({} as never),
    pc.addIceCandidate({ candidate: CANDIDATE }),
    pc.createOffer('nope' as never),
  ];
  for (const result of results) await assert.rejects(result, { name: 'TypeError' });
});

test('legacy callback overloads call back and resolve with undefined', async (t) => {
  const { pc, fake } = setup(t);
  const offered = Promise.withResolvers<unknown>();
  const returned = pc.createOffer(offered.resolve, offered.reject);
  fake.pending('createOffer').resolve(offer);
  assert.equal(await returned, undefined);
  assert.deepEqual(await offered.promise, offer);
  const failed = Promise.withResolvers<DOMException>();
  await pc.setRemoteDescription(answer, () => {}, failed.resolve);
  assert.equal((await failed.promise).name, 'InvalidStateError');
});

test('legacy overloads are picked by argument count, and a callback that is not a function rejects', async (t) => {
  const { pc, fake } = setup(t);
  // One argument is always the options dictionary, even a function.
  const promised = (pc.createAnswer as (options: unknown) => Promise<unknown>)(() => {});
  await assert.rejects(promised, { name: 'InvalidStateError' });
  // WebIDL's callback conversion: TypeError, nothing runs.
  await assert.rejects(
    pc.createOffer(() => {}, 'nope' as never),
    {
      name: 'TypeError',
      message: /parameter 2 is not a function/,
    },
  );
  await assert.rejects(
    (pc.setLocalDescription as (...args: unknown[]) => Promise<void>)({ type: 'offer' }, () => {}),
    { name: 'TypeError', message: /3 arguments required/ },
  );
  assert.deepEqual(
    fake.calls.map((c) => c.method),
    [],
  );
});

// ---------------------------------------------------------------------------
// close()

test('after close, an operation in flight never settles, even when libwebrtc completes it', async (t) => {
  const { pc, fake } = setup(t);
  const created = pc.createOffer();
  const queued = pc.createOffer();
  pc.close();
  fake.pending('createOffer').reject(nativeError('INTERNAL_ERROR', 'closed under it'));
  assert.equal(await stateOf(created, fake), 'pending');
  assert.equal(await stateOf(queued, fake), 'pending');
  assert.equal(fake.callsTo('createOffer').length, 1, 'the queued one never started');
});

test('no events fire after close, including those close() itself causes', async (t) => {
  const { pc, fake } = setup(t);
  const log: string[] = [];
  record(
    pc,
    ['signalingstatechange', 'connectionstatechange', 'icecandidate', 'negotiationneeded', 'track'],
    log,
  );
  pc.close();
  fake.emit({
    kind: 'icecandidate',
    candidate: { candidate: CANDIDATE, sdpMid: '0', sdpMLineIndex: 0 },
  });
  fake.emit({ kind: 'negotiationneeded', eventId: 1 });
  await fake.flush();
  assert.deepEqual(log, []);
});

test("close() ends receivers' tracks in a queued task, with ended (webrtc-pc close: disappear false)", async (t) => {
  const { pc } = setup(t);
  const live = pc.addTransceiver('audio');
  const stopped = pc.addTransceiver('video');
  const log: string[] = [];
  for (const { receiver } of [live, stopped]) {
    receiver.track.onended = () => log.push(`ended ${receiver.track.kind}`);
  }
  stopped.receiver.track.stop();
  pc.close();
  assert.equal(live.receiver.track.readyState, 'live');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(live.receiver.track.readyState, 'ended');
  assert.deepEqual(log, ['ended audio'], 'not for a track the app had stopped');
});

test('after close, getters and getStats work, restartIce is a no-op, other methods throw InvalidStateError', async (t) => {
  const { pc, fake } = setup(t);
  const transceiver = pc.addTransceiver('audio');
  pc.close();
  pc.close();

  assert.deepEqual(
    [pc.signalingState, pc.connectionState, pc.iceConnectionState],
    ['closed', 'closed', 'closed'],
  );
  assert.deepEqual(pc.getTransceivers(), [transceiver]);
  assert.equal(transceiver.stopped, true);
  assert.equal(transceiver.direction, 'stopped');
  assert.deepEqual(pc.getSenders(), []);
  assert.equal(pc.getConfiguration().bundlePolicy, 'balanced');
  pc.restartIce();

  const stats = pc.getStats();
  fake.pending('getStats').resolve('[{"id":"P","type":"peer-connection","timestamp":1}]');
  assert.equal((await stats).get('P').type, 'peer-connection');

  const closed = { name: 'InvalidStateError', message: /closed/ };
  await assert.rejects(pc.createOffer(), closed);
  await assert.rejects(pc.setRemoteDescription(offer), closed);
  await assert.rejects(transceiver.sender.replaceTrack(null), closed);
  assert.throws(() => pc.addTransceiver('audio'), closed);
  assert.throws(() => pc.addTrack(audioTrack()), closed);
  assert.throws(() => pc.setConfiguration({}), closed);
  assert.throws(() => transceiver.stop(), closed);
  assert.throws(
    () => {
      transceiver.direction = 'sendrecv';
    },
    { name: 'InvalidStateError' },
  );
});

// ---------------------------------------------------------------------------
// Description snapshots

test('SRD events wait for the completion, which applies all state before firing in spec order', async (t) => {
  const { pc, fake } = setup(t);
  const remote = new FakeTransceiver(fake.stream, { kind: 'audio' });
  const log: string[] = [];
  record(
    pc,
    ['signalingstatechange', 'track'],
    log,
    () => ` ${pc.signalingState} ${pc.remoteDescription?.type} mid=${pc.getTransceivers()[0]?.mid}`,
  );
  const srd = pc.setRemoteDescription(offer).then(() => log.push('resolved'));

  // libwebrtc's order: signalingstatechange and track arrive first.
  fake.emit({ kind: 'signalingstatechange', state: 'have-remote-offer' });
  fake.emit({ kind: 'track', receiver: remote.receiver, transceiver: remote, streamIds: ['s'] });
  await fake.flush();
  assert.deepEqual(log, [], 'held until the SRD completes');
  assert.equal(pc.signalingState, 'stable');

  fake.pending('setRemoteDescription').resolve({
    ...descriptionSnapshot({ remoteDescription: offer, pendingRemoteDescription: offer }),
    signalingState: 'have-remote-offer',
    transceivers: [transceiverState(remote, { mid: '0', receiverStreamIds: ['s'] })],
  });
  await srd;
  assert.deepEqual(log, [
    'signalingstatechange have-remote-offer offer mid=0',
    'track have-remote-offer offer mid=0',
    'resolved',
  ]);
});

test('an SLD answer whose removetrack precedes signalingstatechange still fires in spec order', async (t) => {
  const { pc, fake } = setup(t);
  const { remote, event } = await receiveAudio(pc, fake);
  const [stream] = event.streams;
  assert.ok(stream);
  const log: string[] = [];
  record(pc, ['signalingstatechange'], log);
  stream.onremovetrack = (e) => log.push(`removetrack ${e.track === event.track}`);

  const sld = pc.setLocalDescription(answer).then(() => log.push('resolved'));
  fake.completeSetLocalDescription({
    signalingState: 'stable',
    removedReceivers: [remote.receiver],
    snapshot: {
      localDescription: answer,
      currentLocalDescription: answer,
      remoteDescription: offer,
      currentRemoteDescription: offer,
      transceivers: [transceiverState(remote, { mid: '0', currentDirection: 'inactive' })],
    },
  });
  await sld;
  assert.deepEqual(log, ['signalingstatechange', 'removetrack true', 'resolved']);
  assert.deepEqual(stream.getTracks(), []);
});

/**
 * Starts an SRD whose completion creates an audio and a video transceiver,
 * each firing `track`. Once libwebrtc has delivered everything, resolves
 * with the SRD's promise (wrapped, so a never-settling SRD can be returned).
 */
async function srdWithTwoTracks(
  pc: RTCPeerConnection,
  fake: FakePeerConnection,
): Promise<{ srd: Promise<void> }> {
  const a = new FakeTransceiver(fake.stream, { kind: 'audio', direction: 'recvonly' });
  const v = new FakeTransceiver(fake.stream, { kind: 'video', direction: 'recvonly' });
  const srd = pc.setRemoteDescription(offer);
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    tracks: [{ transceiver: a }, { transceiver: v }],
    snapshot: {
      transceivers: [transceiverState(a, { mid: '0' }), transceiverState(v, { mid: '1' })],
    },
  });
  await fake.flush();
  return { srd };
}

test('close() in signalingstatechange mid-snapshot: no track events, the SRD never settles', async (t) => {
  const { pc, fake } = setup(t);
  const log: string[] = [];
  pc.onsignalingstatechange = () => {
    log.push(`signalingstatechange ${pc.signalingState}`);
    pc.close();
  };
  pc.ontrack = () => log.push('track');
  const { srd } = await srdWithTwoTracks(pc, fake);
  assert.equal(await stateOf(srd, fake), 'pending');
  assert.deepEqual(log, ['signalingstatechange have-remote-offer']);
  assert.equal(pc.signalingState, 'closed');
  assert.deepEqual(
    pc.getTransceivers().map((tr) => tr.receiver.track.readyState),
    ['ended', 'ended'],
  );
});

test('close() in the first track handler stops the rest of the track events', async (t) => {
  const { pc, fake } = setup(t);
  const log: string[] = [];
  pc.ontrack = (e) => {
    log.push(`track ${e.track.kind}`);
    pc.close();
  };
  const { srd } = await srdWithTwoTracks(pc, fake);
  assert.equal(await stateOf(srd, fake), 'pending');
  assert.deepEqual(log, ['track audio']);
});

test('throwing listeners are reported, and the rest of the events still fire and the SRD resolves', async (t) => {
  const { pc, fake } = setup(t);
  const caught = captureUncaught(t);
  const log: string[] = [];
  pc.onsignalingstatechange = () => {
    log.push('signalingstatechange');
    throw new Error('from signalingstatechange');
  };
  pc.ontrack = (e) => {
    log.push(`track ${e.track.kind}`);
    throw new Error(`from track ${e.track.kind}`);
  };
  const { srd } = await srdWithTwoTracks(pc, fake);
  await srd;
  log.push('resolved');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ['signalingstatechange', 'track audio', 'track video', 'resolved']);
  assert.deepEqual(
    caught.map((e) => (e as Error).message),
    ['from signalingstatechange', 'from track audio', 'from track video'],
  );
  // The chain carries on.
  const created = pc.createAnswer();
  fake.pending('createAnswer').resolve(answer);
  assert.deepEqual(await created, answer);
});

test('getters answer from the last snapshot, not live libwebrtc state', async (t) => {
  const { pc, fake } = setup(t);
  const { remote } = await receiveAudio(pc, fake);
  remote.mid = 'changed';
  remote.forceDirection('inactive');
  fake.signalingState = 'stable';
  const [transceiver] = pc.getTransceivers();
  assert.equal(transceiver?.mid, '0');
  assert.equal(transceiver?.direction, 'recvonly');
  assert.equal(pc.signalingState, 'have-remote-offer');
  assert.equal(pc.remoteDescription, pc.pendingRemoteDescription, 'same object');
});

test('a transceiver added during an SLD survives a snapshot that predates it; a missing older one is removed', async (t) => {
  const { pc, fake } = setup(t);
  const old = pc.addTransceiver('audio');
  const kept = pc.addTransceiver('video');
  const sld = pc.setLocalDescription();
  const added = pc.addTransceiver('audio');
  const [, keptFake] = fake.transceivers;
  assert.ok(keptFake);
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: {
      localDescription: offer,
      pendingLocalDescription: offer,
      transceivers: [transceiverState(keptFake, { mid: '1' })],
    },
  });
  await sld;
  assert.deepEqual(pc.getTransceivers(), [kept, added]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(old.receiver.track.readyState, 'ended');
});

test('a transceiver a rollback removes reads stopped and dissociated, as in Chrome and wrtc', async (t) => {
  const { pc, fake } = setup(t);
  const { remote } = await receiveAudio(pc, fake);
  const [transceiver] = pc.getTransceivers();
  assert.ok(transceiver);
  const srd = pc.setRemoteDescription({ type: 'rollback', sdp: '' });
  fake.transceivers = [];
  fake.completeSetRemoteDescription({ signalingState: 'stable', snapshot: { transceivers: [] } });
  await srd;
  assert.deepEqual(pc.getTransceivers(), []);
  assert.deepEqual(
    {
      mid: transceiver.mid,
      direction: transceiver.direction,
      currentDirection: transceiver.currentDirection,
      stopped: transceiver.stopped,
    },
    { mid: null, direction: 'stopped', currentDirection: 'stopped', stopped: true },
  );
  assert.equal(remote.mid, '0', 'from JS state, not a live read');
  assert.throws(
    () => {
      transceiver.direction = 'sendrecv';
    },
    { name: 'InvalidStateError' },
  );
});

test("getTransceivers() keeps JS's order when libwebrtc created one of them first", async (t) => {
  const { pc, fake } = setup(t);
  const srd = pc.setRemoteDescription(offer);
  // libwebrtc applies the offer (creating `remote`) before this runs; the
  // spec creates the offer's transceiver when the SRD completes.
  const remote = new FakeTransceiver(fake.stream, { kind: 'audio', direction: 'recvonly' });
  fake.transceivers.push(remote);
  const added = pc.addTransceiver('video');
  const [, addedFake] = fake.transceivers;
  assert.ok(addedFake);
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    tracks: [{ transceiver: remote }],
    snapshot: {
      transceivers: [transceiverState(remote, { mid: '0' }), transceiverState(addedFake)],
    },
  });
  await srd;
  assert.deepEqual(
    pc.getTransceivers().map((tr) => [tr === added, tr.mid]),
    [
      [true, null],
      [false, '0'],
    ],
  );
});

test('a direction set or a stop() while a description is in flight survives its older snapshot', async (t) => {
  const { pc, fake } = setup(t);
  const redirected = pc.addTransceiver('audio');
  const stopped = pc.addTransceiver('video');
  const [redirectedFake, stoppedFake] = fake.transceivers;
  assert.ok(redirectedFake && stoppedFake);
  const before = [transceiverState(redirectedFake), transceiverState(stoppedFake)];
  const sld = pc.setLocalDescription();
  redirected.direction = 'inactive';
  stopped.stop();
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: { localDescription: offer, pendingLocalDescription: offer, transceivers: before },
  });
  await sld;
  assert.equal(redirected.direction, 'inactive');
  assert.equal(stopped.direction, 'stopped');
  assert.throws(
    () => {
      stopped.direction = 'sendrecv';
    },
    { name: 'InvalidStateError' },
  );
});

test('icecandidate snapshots refresh the cached local description', async (t) => {
  const { pc, fake } = setup(t);
  const sld = pc.setLocalDescription();
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: { localDescription: offer, pendingLocalDescription: offer },
  });
  await sld;
  const withCandidate = {
    type: 'offer' as const,
    sdp: `${SDP}a=candidate:1 1 udp 1 192.0.2.1 1 typ host\r\n`,
  };
  const seen: (string | undefined)[] = [];
  pc.onicecandidate = () => seen.push(pc.localDescription?.sdp);
  fake.emit({
    kind: 'icecandidate',
    candidate: { candidate: CANDIDATE, sdpMid: '0', sdpMLineIndex: 0 },
    snapshot: descriptionSnapshot({
      localDescription: withCandidate,
      pendingLocalDescription: withCandidate,
    }),
  });
  await fake.flush();
  assert.deepEqual(seen, [withCandidate.sdp]);
});

// ---------------------------------------------------------------------------
// Remote streams and identity

test('track events: one wrapper per handle, and one MediaStream per stream id', async (t) => {
  const { pc, fake } = setup(t);
  const a = new FakeTransceiver(fake.stream, { kind: 'audio' });
  const v = new FakeTransceiver(fake.stream, { kind: 'video' });
  const events: RTCTrackEvent[] = [];
  pc.ontrack = (e) => events.push(e);
  const srd = pc.setRemoteDescription(offer);
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    tracks: [
      { transceiver: a, streamIds: ['s'] },
      { transceiver: v, streamIds: ['s'] },
    ],
    snapshot: {
      transceivers: [
        transceiverState(a, { mid: '0', receiverStreamIds: ['s'] }),
        transceiverState(v, { mid: '1', receiverStreamIds: ['s'] }),
      ],
    },
  });
  await srd;
  const [first, second] = events;
  assert.ok(first && second);
  assert.deepEqual(pc.getTransceivers(), [first.transceiver, second.transceiver]);
  assert.equal(first.receiver, first.transceiver.receiver);
  assert.equal(first.track, first.receiver.track);
  assert.equal(first.streams[0], second.streams[0], 'same stream object for the same id');
  assert.equal(first.streams[0]?.id, 's');
  assert.deepEqual(first.streams[0]?.getTracks(), [first.track, second.track]);
  assert.ok(Object.isFrozen(first.streams));
});

/** Applies a remote offer in which `remote` keeps receiving, on `streamIds`. */
async function reoffer(
  pc: RTCPeerConnection,
  fake: FakePeerConnection,
  remote: FakeTransceiver,
  streamIds: string[],
  type: 'offer' | 'rollback' = 'offer',
) {
  const srd = pc.setRemoteDescription(type === 'offer' ? offer : { type });
  fake.completeSetRemoteDescription({
    signalingState: type === 'offer' ? 'have-remote-offer' : 'stable',
    snapshot: {
      transceivers: [
        transceiverState(remote, {
          mid: '0',
          firedDirection: 'sendrecv',
          receiverStreamIds: streamIds,
        }),
      ],
    },
  });
  await srd;
}

test('a receiver moving to another stream fires removetrack, addtrack, then track (as Chrome)', async (t) => {
  const { pc, fake } = setup(t);
  const { remote, event } = await receiveAudio(pc, fake);
  const [s] = event.streams;
  assert.ok(s);
  const log: string[] = [];
  s.onremovetrack = (e: MediaStreamTrackEvent) => log.push(`removetrack ${s.id} ${e.track.kind}`);
  pc.ontrack = (e) => {
    const [u] = e.streams;
    log.push(`track ${e.streams.map((stream) => stream.id)} ${u?.getTracks().length}`);
    assert.equal(e.track, event.track, 'the same receiver track');
  };

  // A later offer moves the receiver to stream 'u' (setStreams on the remote
  // side). libwebrtc reports no OnTrack: the receiver was receiving already.
  await reoffer(pc, fake, remote, ['u']);
  assert.deepEqual(log, ['removetrack s audio', 'track u 1']);
  assert.deepEqual(s.getTracks(), []);
});

test('a receiver gaining a stream fires track; one keeping its streams or losing one does not', async (t) => {
  const { pc, fake } = setup(t);
  const { remote } = await receiveAudio(pc, fake);
  const log: string[] = [];
  pc.ontrack = (e) => log.push(e.streams.map((stream) => stream.id).join(','));
  await reoffer(pc, fake, remote, ['s']);
  await reoffer(pc, fake, remote, ['s', 'u']);
  await reoffer(pc, fake, remote, ['u']);
  assert.deepEqual(log, ['s,u']);
});

test("a rollback restoring a receiver's streams fires track with them (as Chrome)", async (t) => {
  const { pc, fake } = setup(t);
  const { remote } = await receiveAudio(pc, fake);
  await answerReceiving(pc, fake, remote);
  const log: string[] = [];
  pc.ontrack = (e) => log.push(e.streams.map((stream) => stream.id).join(','));
  await reoffer(pc, fake, remote, ['u']);
  await reoffer(pc, fake, remote, ['s'], 'rollback');
  assert.deepEqual(log, ['u', 's']);
});

test('a local description changing the streams fires no track event (as Chrome)', async (t) => {
  const { pc, fake } = setup(t);
  const { remote } = await receiveAudio(pc, fake);
  let tracks = 0;
  pc.ontrack = () => tracks++;
  const sld = pc.setLocalDescription(answer);
  fake.completeSetLocalDescription({
    signalingState: 'stable',
    snapshot: {
      transceivers: [
        transceiverState(remote, {
          mid: '0',
          firedDirection: 'sendrecv',
          receiverStreamIds: ['s', 'u'],
        }),
      ],
    },
  });
  await sld;
  assert.equal(tracks, 0);
});

test('addstream and removestream compare the streams of receiving transceivers, between addtrack and track', async (t) => {
  const { pc, fake } = setup(t);
  const log: string[] = [];
  const onStream = (e: MediaStreamEvent) =>
    log.push(`${e.type} ${e.stream.id} ${e.stream.getTracks().length}`);
  pc.addEventListener('addstream', onStream);
  pc.addEventListener('removestream', onStream);
  pc.addEventListener('track', () => log.push('track'));
  // Listeners only: the legacy handler attributes don't exist (historical.html).
  assert.equal('onaddstream' in pc, false);
  assert.equal('onremovestream' in pc, false);
  const { remote } = await receiveAudio(pc, fake);
  assert.deepEqual(log, ['addstream s 1', 'track']);

  log.length = 0;
  await reoffer(pc, fake, remote, ['s']);
  assert.deepEqual(log, [], 'nothing for an unchanged stream');
  await reoffer(pc, fake, remote, ['u']);
  assert.deepEqual(log, ['addstream u 1', 'removestream s 0', 'track']);
});

test('a remote stream nothing holds any more is collected; its id can be used again', async (t) => {
  const gc = runInNewContext('gc') as () => void;
  const { pc, fake } = setup(t);
  // Only a WeakRef leaves this function: the event and its streams stay in it.
  const receive = async () => {
    const { remote, event } = await receiveAudio(pc, fake);
    return { remote, s: new WeakRef(event.streams[0] as MediaStream) };
  };
  const { remote, s } = await receive();
  const moveTo = async (id: string) => {
    const srd = pc.setRemoteDescription(offer);
    fake.completeSetRemoteDescription({
      signalingState: 'have-remote-offer',
      snapshot: {
        transceivers: [transceiverState(remote, { mid: '0', receiverStreamIds: [id] })],
      },
    });
    await srd;
  };

  await moveTo('u');
  // Not deref() before collecting: it keeps the target alive for the job.
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(s.deref(), undefined);

  await moveTo('s');
  const [transceiver] = pc.getTransceivers();
  assert.ok(transceiver);
  const [again] = transceiverStateOf(transceiver).remoteStreams;
  assert.equal(again?.id, 's');
  assert.deepEqual(again?.getTracks(), [transceiver.receiver.track]);
});

// ---------------------------------------------------------------------------
// Remote track muting

/** Answers the offer receiveAudio() applied, still receiving on mid 0. */
async function answerReceiving(
  pc: RTCPeerConnection,
  fake: FakePeerConnection,
  remote: FakeTransceiver,
) {
  const sld = pc.setLocalDescription(answer);
  fake.completeSetLocalDescription({
    signalingState: 'stable',
    snapshot: {
      transceivers: [
        transceiverState(remote, {
          mid: '0',
          currentDirection: 'recvonly',
          firedDirection: 'recvonly',
          receiverStreamIds: ['s'],
        }),
      ],
    },
  });
  await sld;
}

test('a remote track is muted in its track event, and receiver:unmute unmutes it', async (t) => {
  const { pc, fake } = setup(t);
  const mutedInEvent: boolean[] = [];
  pc.addEventListener('track', (e) => mutedInEvent.push((e as RTCTrackEvent).track.muted));
  const { remote, event } = await receiveAudio(pc, fake);
  const log: string[] = [];
  record(event.track, ['mute', 'unmute'], log, () => ` ${event.track.muted}`);

  fake.emit({ kind: 'receiver:unmute', receiver: remote.receiver });
  await fake.flush();

  assert.deepEqual(mutedInEvent, [true]);
  assert.deepEqual(log, ['unmute false']);
});

test('a description that stops receiving mutes after signalingstatechange, before stream and track events', async (t) => {
  const { pc, fake } = setup(t);
  const { remote, event } = await receiveAudio(pc, fake);
  await answerReceiving(pc, fake, remote);
  fake.emit({ kind: 'receiver:unmute', receiver: remote.receiver });
  await fake.flush();
  const [stream] = event.streams;
  assert.ok(stream);
  const log: string[] = [];
  record(pc, ['signalingstatechange', 'track'], log, (e) =>
    e.type === 'track' ? ` ${(e as RTCTrackEvent).track.kind}` : '',
  );
  record(event.track, ['mute'], log, () => ` ${event.track.muted}`);
  stream.onremovetrack = () => log.push('removetrack');

  // The remote side stops sending on mid 0 and adds video on mid 1.
  const video = new FakeTransceiver(fake.stream, { kind: 'video', direction: 'recvonly' });
  const srd = pc.setRemoteDescription(offer).then(() => log.push('resolved'));
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    tracks: [{ transceiver: video }],
    removedReceivers: [remote.receiver],
    snapshot: {
      transceivers: [
        transceiverState(remote, {
          mid: '0',
          currentDirection: 'recvonly',
          firedDirection: 'inactive',
        }),
        transceiverState(video, { mid: '1', firedDirection: 'recvonly' }),
      ],
    },
  });
  await srd;

  assert.deepEqual(log, [
    'signalingstatechange',
    'mute true',
    'removetrack',
    'track video',
    'resolved',
  ]);
});

test('no mute for a track that is still muted; receiver:unmute is ignored after close', async (t) => {
  const { pc, fake } = setup(t);
  const { remote, event } = await receiveAudio(pc, fake);
  await answerReceiving(pc, fake, remote);
  const log: string[] = [];
  record(event.track, ['mute', 'unmute'], log);
  const stopReceiving = async () => {
    const srd = pc.setRemoteDescription(offer);
    fake.completeSetRemoteDescription({
      signalingState: 'have-remote-offer',
      snapshot: {
        transceivers: [transceiverState(remote, { mid: '0', firedDirection: 'inactive' })],
      },
    });
    await srd;
  };

  await stopReceiving();
  assert.deepEqual(log, [], 'never unmuted, so nothing to mute');

  pc.close();
  fake.emit({ kind: 'receiver:unmute', receiver: remote.receiver });
  await fake.flush();
  assert.deepEqual(log, []);
  assert.equal(event.track.muted, true);
});

test('an SRD that stops a transceiver mutes in its task; the track ends with ended in a later one', async (t) => {
  const { pc, fake } = setup(t);
  const { remote, event } = await receiveAudio(pc, fake);
  await answerReceiving(pc, fake, remote);
  fake.emit({ kind: 'receiver:unmute', receiver: remote.receiver });
  await fake.flush();
  const log: string[] = [];
  record(pc, ['signalingstatechange'], log);
  record(event.track, ['mute', 'ended'], log, () => ` ${event.track.readyState}`);

  // The remote offer rejects mid 0 (its side stopped the transceiver).
  const srd = pc.setRemoteDescription(offer).then(() => {
    log.push(`resolved ${event.track.readyState}`);
  });
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    removedReceivers: [remote.receiver],
    snapshot: {
      transceivers: [
        transceiverState(remote, {
          mid: '0',
          direction: 'stopped',
          firedDirection: 'inactive',
          stopping: true,
          stopped: true,
        }),
      ],
    },
  });
  await srd;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(log, ['signalingstatechange', 'mute live', 'resolved live', 'ended ended']);
});

test("a remote offer's rejected m-section fires no track event, though libwebrtc reports one (as Chrome)", async (t) => {
  const { pc, fake } = setup(t);
  const fired: string[] = [];
  pc.ontrack = (e) => fired.push(e.track.kind);
  const rejected = new FakeTransceiver(fake.stream, { kind: 'audio', direction: 'recvonly' });
  const live = new FakeTransceiver(fake.stream, { kind: 'video', direction: 'recvonly' });
  const srd = pc.setRemoteDescription(offer);
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    tracks: [{ transceiver: rejected }, { transceiver: live }],
    snapshot: {
      transceivers: [
        transceiverState(rejected, {
          mid: '0',
          direction: 'stopped',
          currentDirection: 'stopped',
          stopping: true,
          stopped: true,
        }),
        transceiverState(live, { mid: '1', firedDirection: 'recvonly' }),
      ],
    },
  });
  await srd;
  assert.deepEqual(fired, ['video']);
  assert.equal(pc.getTransceivers().length, 2, 'removed only by the answer');
});

test('receiver:unmute is not held back by an SLD/SRD in flight, so it precedes the mute that completes it', async (t) => {
  const { pc, fake } = setup(t);
  const { remote, event } = await receiveAudio(pc, fake);
  await answerReceiving(pc, fake, remote);
  const log: string[] = [];
  record(event.track, ['mute', 'unmute'], log);

  const srd = pc.setRemoteDescription(offer).then(() => log.push('resolved'));
  fake.emit({ kind: 'receiver:unmute', receiver: remote.receiver });
  await fake.flush();
  assert.deepEqual(log, ['unmute']);
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    snapshot: {
      transceivers: [transceiverState(remote, { mid: '0', firedDirection: 'sendonly' })],
    },
  });
  await srd;

  assert.deepEqual(log, ['unmute', 'mute', 'resolved']);
});

// ---------------------------------------------------------------------------
// negotiationneeded

test('negotiationneeded fires when libwebrtc says it should', async (t) => {
  const { pc, fake } = setup(t);
  let fired = 0;
  pc.onnegotiationneeded = () => fired++;
  fake.emit({ kind: 'negotiationneeded', eventId: 7 });
  await fake.flush();
  assert.equal(fired, 1);
  assert.deepEqual(fake.callsTo('shouldFireNegotiationNeededEvent'), [[7]]);
});

test('negotiationneeded waits for the operations chain to empty, then re-checks the latest id', async (t) => {
  const { pc, fake } = setup(t);
  let fired = 0;
  const firedOnce = Promise.withResolvers<void>();
  pc.onnegotiationneeded = () => {
    fired++;
    firedOnce.resolve();
  };
  const created = pc.createOffer();
  fake.emit({ kind: 'negotiationneeded', eventId: 1 });
  fake.emit({ kind: 'negotiationneeded', eventId: 2 });
  await fake.flush();
  assert.equal(fired, 0);
  assert.deepEqual(fake.callsTo('shouldFireNegotiationNeededEvent'), []);

  fake.pending('createOffer').resolve(offer);
  await created;
  // Fired from a task queued when the chain empties.
  await firedOnce.promise;
  await fake.flush();
  assert.equal(fired, 1);
  assert.deepEqual(fake.callsTo('shouldFireNegotiationNeededEvent'), [[2]]);
});

test('negotiationneeded is dropped when libwebrtc says not to', async (t) => {
  const { pc, fake } = setup(t);
  fake.stub('shouldFireNegotiationNeededEvent', () => false);
  let fired = 0;
  pc.onnegotiationneeded = () => fired++;
  fake.emit({ kind: 'negotiationneeded', eventId: 1 });
  await fake.flush();
  assert.equal(fired, 0);
});

// ---------------------------------------------------------------------------
// ICE

/** Applies `desc` as the local offer (have-local-offer). */
async function setLocalOffer(
  pc: RTCPeerConnection,
  fake: FakePeerConnection,
  desc: NativeSessionDescription = bundledOffer,
): Promise<void> {
  const sld = pc.setLocalDescription();
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: { localDescription: desc, pendingLocalDescription: desc },
  });
  await sld;
}

/** Queues the native events of one gathering round with a candidate per mid. */
function gather(fake: FakePeerConnection, mids: string[]): void {
  fake.emit({ kind: 'icegatheringstatechange', state: 'gathering' });
  for (const mid of mids) {
    fake.emit({
      kind: 'icecandidate',
      candidate: { candidate: CANDIDATE, sdpMid: mid, sdpMLineIndex: Number(mid) },
    });
  }
  fake.emit({ kind: 'icegatheringstatechange', state: 'complete' });
}

/** Resolves on the null candidate that ends gathering. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  const done = Promise.withResolvers<void>();
  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate === null) done.resolve();
  });
  return done.promise;
}

/** Logs icecandidate and icegatheringstatechange, and where each task ends. */
function recordGathering(pc: RTCPeerConnection): string[] {
  const log: string[] = [];
  let taskEndQueued = false;
  const note = (entry: string) => {
    log.push(entry);
    // Runs once the current task's listeners are done.
    if (!taskEndQueued) {
      taskEndQueued = true;
      queueMicrotask(() => {
        taskEndQueued = false;
        log.push('--');
      });
    }
  };
  pc.addEventListener('icecandidate', (e) => {
    const c = e.candidate;
    note(c === null ? 'null' : `"${c.candidate.slice(0, 11)}" ${c.sdpMid} ${c.usernameFragment}`);
  });
  pc.addEventListener('icegatheringstatechange', () => note(`state ${pc.iceGatheringState}`));
  return log;
}

test('gathering complete: end-of-candidates per transport in one task; state change and null in the next', async (t) => {
  const { pc, fake } = setup(t);
  await setLocalOffer(pc, fake);
  const log = recordGathering(pc);
  const done = gathered(pc);
  gather(fake, ['0', '1']);
  await done;
  await fake.flush();
  // An unanswered offer under 'balanced' gathers on every m-section, not
  // just the BUNDLE tag: both get an end-of-candidates.
  assert.deepEqual(log, [
    'state gathering',
    '--',
    '"candidate:1" 0 uf',
    '--',
    '"candidate:1" 1 uf',
    '--',
    '"" 0 uf',
    '"" 1 uf',
    '--',
    'state complete',
    'null',
    '--',
  ]);
});

test("gathering complete's second task runs before a later native event of another connection", async (t) => {
  const fakes = useFakeNative(t, { PeerConnection: FakePeerConnection });
  const a = new RTCPeerConnection();
  t.after(() => a.close());
  const b = new RTCPeerConnection();
  t.after(() => b.close());
  const [fakeA, fakeB] = fakes.instances('PeerConnection');
  assert.ok(fakeA && fakeB);
  await setLocalOffer(a, fakeA);
  const log: string[] = [];
  a.addEventListener('icegatheringstatechange', () => log.push(`a ${a.iceGatheringState}`));
  a.addEventListener('icecandidate', (e) => log.push(`a ${e.candidate?.candidate ?? null}`));
  b.addEventListener('connectionstatechange', () => log.push(`b ${b.connectionState}`));
  // libwebrtc reported a's completion, then b's change: in one order.
  gather(fakeA, []);
  fakeB.emit({ kind: 'connectionstatechange', state: 'connecting' });
  await fakeB.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ['a gathering', 'a ', 'a complete', 'a null', 'b connecting']);
});

test("gathering complete's second task runs before a later op completion of another connection", async (t) => {
  const fakes = useFakeNative(t, { PeerConnection: FakePeerConnection });
  const a = new RTCPeerConnection();
  t.after(() => a.close());
  const b = new RTCPeerConnection();
  t.after(() => b.close());
  const [fakeA, fakeB] = fakes.instances('PeerConnection');
  assert.ok(fakeA && fakeB);
  await setLocalOffer(a, fakeA);
  const log: string[] = [];
  a.addEventListener('icegatheringstatechange', () => log.push(`a ${a.iceGatheringState}`));
  a.addEventListener('icecandidate', (e) => log.push(`a ${e.candidate?.candidate ?? null}`));
  const created = b.createOffer().then(() => log.push('b offer resolved'));
  // libwebrtc reported a's completion, then b's createOffer() result.
  gather(fakeA, []);
  fakeB.pending('createOffer').resolve(offer);
  await created;
  assert.deepEqual(log, ['a gathering', 'a ', 'a complete', 'a null', 'b offer resolved']);
});

test("an `onicecandidate = resolve` loop sees gathering's null candidate (WPT's pattern)", async (t) => {
  const { pc, fake } = setup(t);
  await setLocalOffer(pc, fake);
  gather(fake, ['0']);
  // A new handler per event, set once the previous event's await resumes.
  const next = () =>
    new Promise<RTCPeerConnectionIceEvent>((resolve) => {
      pc.onicecandidate = resolve;
    });
  const seen: string[] = [];
  for (let c = (await next()).candidate; c; c = (await next()).candidate) {
    seen.push(c.candidate.slice(0, 11));
  }
  assert.deepEqual(seen, ['candidate:1', '']);
});

test('without candidates, gathering complete names one transport per BUNDLE group', async (t) => {
  const { pc, fake } = setup(t);
  await setLocalOffer(pc, fake);
  const log = recordGathering(pc);
  const done = gathered(pc);
  gather(fake, []);
  await done;
  assert.deepEqual(
    log.filter((e) => e.startsWith('"')),
    ['"" 0 uf'],
  );
});

test('gathering complete adds a=end-of-candidates to the local description, and keeps it in later snapshots', async (t) => {
  const { pc, fake } = setup(t);
  await setLocalOffer(pc, fake);
  const before = pc.localDescription;
  const done = gathered(pc);
  gather(fake, ['0', '1']);
  await done;
  assert.notEqual(pc.localDescription, before, 'a new RTCSessionDescription');
  assert.equal(pc.localDescription, pc.pendingLocalDescription);
  assert.equal(endOfCandidates(pc.localDescription?.sdp), 2);

  // The answer's snapshot carries libwebrtc's copy of the offer, without the lines.
  const srd = pc.setRemoteDescription(answer);
  fake.completeSetRemoteDescription({
    signalingState: 'stable',
    snapshot: {
      localDescription: bundledOffer,
      currentLocalDescription: bundledOffer,
      remoteDescription: answer,
      currentRemoteDescription: answer,
    },
  });
  await srd;
  assert.equal(endOfCandidates(pc.currentLocalDescription?.sdp), 2);
});

test('an ICE event arriving before the second gathering task runs that task first', async (t) => {
  const { pc, fake } = setup(t);
  await setLocalOffer(pc, fake);
  const log = recordGathering(pc);
  gather(fake, ['0']);
  // ICE restart: a new round starts before the completion's second task.
  fake.emit({ kind: 'icegatheringstatechange', state: 'gathering' });
  await fake.flush();
  assert.deepEqual(
    log.filter((e) => e !== '--'),
    [
      'state gathering',
      '"candidate:1" 0 uf',
      '"" 0 uf',
      'state complete',
      'null',
      'state gathering',
    ],
  );
});

test('icecandidate events carry an RTCIceCandidate with parsed fields', async (t) => {
  const { pc, fake } = setup(t);
  const got = Promise.withResolvers<RTCPeerConnectionIceEvent>();
  pc.onicecandidate = got.resolve;
  fake.emit({
    kind: 'icecandidate',
    candidate: { candidate: CANDIDATE, sdpMid: '0', sdpMLineIndex: 0 },
  });
  const { candidate } = await got.promise;
  assert.deepEqual(
    [candidate?.type, candidate?.address, candidate?.port, candidate?.usernameFragment],
    ['host', '192.0.2.1', 50000, 'uf'],
  );
});

test('icecandidateerror passes libwebrtc errorCode through unchanged', async (t) => {
  const { pc, fake } = setup(t);
  const got = Promise.withResolvers<RTCPeerConnectionIceErrorEvent>();
  pc.onicecandidateerror = got.resolve;
  fake.emit({
    kind: 'icecandidateerror',
    address: '192.0.2.x',
    port: 50000,
    url: 'stun:127.0.0.1:3478',
    errorCode: 20,
    errorText: 'Unknown Attribute',
  });
  const e = await got.promise;
  assert.deepEqual(
    {
      address: e.address,
      port: e.port,
      url: e.url,
      errorCode: e.errorCode,
      errorText: e.errorText,
    },
    {
      address: '192.0.2.x',
      port: 50000,
      url: 'stun:127.0.0.1:3478',
      errorCode: 20,
      errorText: 'Unknown Attribute',
    },
  );
});

test('icecandidateerror without a local port reads address and port null, as Chrome', async (t) => {
  const { pc, fake } = setup(t);
  const got = Promise.withResolvers<RTCPeerConnectionIceErrorEvent>();
  pc.onicecandidateerror = got.resolve;
  // libwebrtc's report of a TURN-over-TCP connection that failed.
  fake.emit({
    kind: 'icecandidateerror',
    address: '',
    port: 0,
    url: 'turn:turn.example.org:3478?transport=tcp',
    errorCode: 701,
    errorText: 'Failed to establish connection',
  });
  const e = await got.promise;
  assert.deepEqual(
    [e.address, e.port, e.url],
    [null, null, 'turn:turn.example.org:3478?transport=tcp'],
  );
});

test('addIceCandidate validates against the remote description; end-of-candidates stays in JS', async (t) => {
  const { pc, fake } = setup(t);
  await assert.rejects(pc.addIceCandidate(), { name: 'InvalidStateError' });
  await receiveAudio(pc, fake);

  await pc.addIceCandidate();
  await pc.addIceCandidate(null);
  await pc.addIceCandidate({ candidate: '', sdpMid: '1' });
  assert.deepEqual(fake.callsTo('addIceCandidate'), [], 'no native call for end-of-candidates');

  await assert.rejects(pc.addIceCandidate({ candidate: CANDIDATE, sdpMid: '9' }), {
    name: 'OperationError',
    message: /mid '9'/,
  });
  await assert.rejects(
    pc.addIceCandidate({ candidate: CANDIDATE, sdpMid: '0', usernameFragment: 'other' }),
    { name: 'OperationError', message: /ufrag 'other'/ },
  );

  const added = pc.addIceCandidate({ candidate: CANDIDATE, sdpMLineIndex: 1 });
  await fake.flush();
  fake.pending('addIceCandidate').resolve();
  await added;
  assert.deepEqual(fake.callsTo('addIceCandidate'), [
    [{ candidate: CANDIDATE, sdpMid: '1', sdpMLineIndex: 1 }],
  ]);

  fake.stub('addIceCandidate', () =>
    Promise.reject(nativeError('SYNTAX_ERROR', 'failed to parse candidate', CANDIDATE)),
  );
  await assert.rejects(pc.addIceCandidate({ candidate: CANDIDATE, sdpMid: '0' }), {
    name: 'OperationError',
    message: /failed to parse candidate/,
  });
});

/** Applies `desc` as the remote offer (have-remote-offer). */
async function setRemoteOffer(
  pc: RTCPeerConnection,
  fake: FakePeerConnection,
  desc: NativeSessionDescription,
): Promise<void> {
  const srd = pc.setRemoteDescription(desc);
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    snapshot: { remoteDescription: desc, pendingRemoteDescription: desc },
  });
  await srd;
}

test('an added candidate joins its m-section of the remote description, in a new object', async (t) => {
  const { pc, fake } = setup(t);
  await setRemoteOffer(pc, fake, offer);
  const before = pc.remoteDescription;
  const added = pc.addIceCandidate({ candidate: CANDIDATE, sdpMid: '1' });
  await fake.flush();
  fake.pending('addIceCandidate').resolve();
  await added;
  assert.notEqual(pc.remoteDescription, before);
  assert.equal(pc.remoteDescription, pc.pendingRemoteDescription);
  assert.ok(mediaSection(pc.remoteDescription?.sdp, 1).endsWith(`a=${CANDIDATE}\r\n`));
  assert.ok(!mediaSection(pc.remoteDescription?.sdp, 0).includes('a=candidate'));
});

test('a candidate libwebrtc rejects leaves the remote description alone', async (t) => {
  const { pc, fake } = setup(t);
  await setRemoteOffer(pc, fake, offer);
  const before = pc.remoteDescription;
  fake.stub('addIceCandidate', () =>
    Promise.reject(nativeError('INVALID_PARAMETER', 'no transport for it')),
  );
  await assert.rejects(pc.addIceCandidate({ candidate: CANDIDATE, sdpMid: '0' }), {
    name: 'OperationError',
  });
  assert.equal(pc.remoteDescription, before);
});

const BAD_PORT_TCP = 'candidate:2 1 tcp 1518214911 192.0.2.1 2049 typ host tcptype passive';

test('a TCP candidate to a Fetch bad port is ignored: never reaches libwebrtc, the add resolves', async (t) => {
  const { pc, fake } = setup(t);
  await setRemoteOffer(pc, fake, offer);
  const before = pc.remoteDescription;
  await pc.addIceCandidate({ candidate: BAD_PORT_TCP, sdpMid: '0' });
  assert.deepEqual(fake.callsTo('addIceCandidate'), []);
  assert.equal(pc.remoteDescription, before);
  // Still validated against the remote description first.
  await assert.rejects(pc.addIceCandidate({ candidate: BAD_PORT_TCP, sdpMid: '9' }), {
    name: 'OperationError',
  });
});

test('a malformed TCP candidate on a bad port goes to libwebrtc, which rejects it as usual', async (t) => {
  const { pc, fake } = setup(t);
  await setRemoteOffer(pc, fake, offer);
  const malformed = BAD_PORT_TCP.replace(' 1518214911 ', ' prio ');
  fake.stub('addIceCandidate', () =>
    Promise.reject(nativeError('SYNTAX_ERROR', 'failed to parse candidate', malformed)),
  );
  await assert.rejects(pc.addIceCandidate({ candidate: malformed, sdpMid: '0' }), {
    name: 'OperationError',
    message: /failed to parse candidate/,
  });
  assert.equal(fake.callsTo('addIceCandidate').length, 1);
});

test('setRemoteDescription drops TCP candidates to Fetch bad ports before libwebrtc', async (t) => {
  const { pc, fake } = setup(t);
  const sdp = SDP.replace('a=mid:0\r\n', `a=mid:0\r\na=${BAD_PORT_TCP}\r\na=${CANDIDATE}\r\n`);
  await setRemoteOffer(pc, fake, { type: 'offer', sdp });
  assert.deepEqual(fake.callsTo('setRemoteDescription'), [
    [{ type: 'offer', sdp: SDP.replace('a=mid:0\r\n', `a=mid:0\r\na=${CANDIDATE}\r\n`) }],
  ]);
});

test('end-of-candidates adds a=end-of-candidates to every m-section, one mid, or one ufrag', async (t) => {
  const { pc, fake } = setup(t);
  await setRemoteOffer(pc, fake, twoUfrags);
  const lines = () =>
    [0, 1].map((i) => endOfCandidates(mediaSection(pc.remoteDescription?.sdp, i)));

  await pc.addIceCandidate({ candidate: '', sdpMid: '1' });
  assert.deepEqual(lines(), [0, 1]);
  await pc.addIceCandidate({ usernameFragment: 'u0' });
  assert.deepEqual(lines(), [1, 1]);
  await pc.addIceCandidate({});
  assert.deepEqual(lines(), [1, 1], 'added once per section');
  assert.deepEqual(fake.callsTo('addIceCandidate'), [], 'no native call');

  // libwebrtc's copy has no end-of-candidates; later snapshots keep ours.
  const sld = pc.setLocalDescription(answer);
  await fake.flush();
  fake.completeSetLocalDescription({
    signalingState: 'stable',
    snapshot: { remoteDescription: twoUfrags, currentRemoteDescription: twoUfrags },
  });
  await sld;
  assert.deepEqual(lines(), [1, 1]);
});

// ---------------------------------------------------------------------------
// Errors

test('an SRD parse failure rejects with an RTCError carrying the line number', async (t) => {
  const { pc, fake } = setup(t);
  fake.stub('setRemoteDescription', () =>
    Promise.reject(nativeError('SYNTAX_ERROR', 'failed to parse SDP: bad', 'a=mid:1')),
  );
  const error = await pc.setRemoteDescription(offer).catch((e: unknown) => e);
  assert.ok(error instanceof RTCError);
  assert.equal(error.errorDetail, 'sdp-syntax-error');
  assert.equal(error.sdpLineNumber, 10);
  assert.equal(pc.signalingState, 'stable');
});

test("an SRD parse failure's line number counts the caller's SDP, blocked candidates included", async (t) => {
  const { pc, fake } = setup(t);
  fake.stub('setRemoteDescription', () =>
    Promise.reject(nativeError('SYNTAX_ERROR', 'failed to parse SDP: bad', 'a=mid:1')),
  );
  // Two blocked candidates before a=mid:1 (line 10 of SDP), which
  // libwebrtc never sees.
  const sdp = SDP.replace('a=mid:0\r\n', `a=mid:0\r\na=${BAD_PORT_TCP}\r\na=${BAD_PORT_TCP}\r\n`);
  const error = await pc.setRemoteDescription({ type: 'offer', sdp }).catch((e: unknown) => e);
  assert.ok(error instanceof RTCError);
  assert.equal(error.sdpLineNumber, 12);
});

test('createOffer failures are OperationError; INVALID_STATE stays InvalidStateError', async (t) => {
  const { pc, fake } = setup(t);
  const failed = pc.createOffer();
  fake.pending('createOffer').reject(nativeError('INTERNAL_ERROR', 'boom'));
  await assert.rejects(failed, { name: 'OperationError', message: 'boom' });
  const closed = pc.createOffer();
  fake.pending('createOffer').reject(nativeError('INVALID_STATE', 'peer connection is closed'));
  await assert.rejects(closed, { name: 'InvalidStateError' });
});

// ---------------------------------------------------------------------------
// Media

test('addTrack reuses a free transceiver of the kind and returns its sender', (t) => {
  const { pc } = setup(t);
  const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
  const track = audioTrack();
  const sender = pc.addTrack(track);
  assert.equal(sender, transceiver.sender);
  assert.equal(sender.track, track);
  assert.equal(transceiver.direction, 'sendrecv');
  assert.deepEqual(pc.getTransceivers(), [transceiver]);
  assert.deepEqual(pc.getSenders(), [sender]);
});

test('addTrack during an SRD reuses the transceiver the in-flight offer created, as libwebrtc does', async (t) => {
  const { pc, fake } = setup(t);
  const srd = pc.setRemoteDescription(offer);
  // libwebrtc has applied the offer already; JS hasn't seen its transceiver.
  const remote = new FakeTransceiver(fake.stream, { kind: 'audio', direction: 'recvonly' });
  remote.mid = '0';
  fake.transceivers.push(remote);
  const sender = pc.addTrack(audioTrack());
  assert.equal(fake.callsTo('addTrack').length, 1);
  assert.equal(fake.callsTo('addTransceiver').length, 0);
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    tracks: [{ transceiver: remote }],
    // The snapshot predates addTrack.
    snapshot: { transceivers: [transceiverState(remote, { direction: 'recvonly' })] },
  });
  await srd;
  const [transceiver, ...rest] = pc.getTransceivers();
  assert.deepEqual(rest, []);
  assert.equal(transceiver?.sender, sender);
  assert.equal(transceiver?.mid, '0');
  assert.equal(transceiver?.direction, 'sendrecv');
});

test('addTrack skips a stopping transceiver instead of failing as libwebrtc does', (t) => {
  const { pc, fake } = setup(t);
  pc.addTransceiver('audio', { direction: 'recvonly' }).stop();
  const sender = pc.addTrack(audioTrack());
  assert.equal(pc.getTransceivers().length, 2);
  assert.equal(fake.callsTo('addTrack').length, 0);
  const [, args] = fake.callsTo('addTransceiver');
  assert.equal(args?.[1]?.direction, 'sendrecv');
  assert.equal(pc.getTransceivers()[1]?.sender, sender);
});

test('addTrack reuses the first non-stopping free transceiver when libwebrtc would pick a stopping one', (t) => {
  const { pc } = setup(t);
  pc.addTransceiver('audio', { direction: 'recvonly' }).stop();
  const free = pc.addTransceiver('audio', { direction: 'inactive' });
  const track = audioTrack();
  const sender = pc.addTrack(track);
  assert.equal(sender, free.sender);
  assert.equal(free.direction, 'sendonly');
  assert.equal(sender.track, track);
});

test("addTrack after replaceTrack(null) in the same task follows the spec's pick, and libwebrtc agrees", async (t) => {
  const { pc, fake } = setup(t);
  const first = audioTrack();
  const sender = pc.addTrack(first);
  const replaced = sender.replaceTrack(null);
  // [[SenderTrack]] is still `first` until replaceTrack's queued task, so
  // the spec creates a transceiver; libwebrtc, whose sender has no track
  // now, would reuse this one.
  const second = audioTrack();
  const other = pc.addTrack(second);
  await replaced;
  assert.notEqual(other, sender);
  assert.deepEqual(
    pc.getSenders().map((s) => s.track),
    [null, second],
  );
  assert.deepEqual(
    fake.transceivers.map((tr) => tr.sender.track),
    [null, nativeTrackOf(second)],
  );
  assert.equal(fake.callsTo('addTrack').length, 1, 'the second one avoided AddTrack');
});

test("replaceTrack's queued step sets [[SenderTrack]] even after removeTrack, and libwebrtc's track with it", async (t) => {
  const { pc, fake } = setup(t);
  const sender = pc.addTrack(audioTrack());
  const next = audioTrack();
  const replaced = sender.replaceTrack(next);
  pc.removeTrack(sender);
  assert.equal(sender.track, null);
  await replaced;
  // The spec (and Chrome) set it in replaceTrack's task; the native sender
  // must agree, though removeTrack cleared it after replaceTrack set it.
  assert.equal(sender.track, next);
  assert.equal(fake.transceivers[0]?.sender.track, nativeTrackOf(next));
});

test("replaceTrack's queued step resets libwebrtc's track when removeTrack and addTrack put the old one back", async (t) => {
  const { pc, fake } = setup(t);
  const a = audioTrack();
  const b = audioTrack();
  const sender = pc.addTrack(a);
  const replaced = sender.replaceTrack(b);
  pc.removeTrack(sender);
  // Reuses the sender (never negotiated): [[SenderTrack]] ends where it began.
  assert.equal(pc.addTrack(a), sender);
  await replaced;
  assert.equal(sender.track, b);
  assert.equal(fake.transceivers[0]?.sender.track, nativeTrackOf(b), 'libwebrtc sends b too');
});

test('removeTrack on a stopping transceiver does nothing, as libwebrtc', (t) => {
  const { pc, fake } = setup(t);
  const track = audioTrack();
  const sender = pc.addTrack(track);
  pc.getTransceivers()[0]?.stop();
  pc.removeTrack(sender);
  assert.equal(sender.track, track);
  assert.deepEqual(fake.callsTo('removeTrack'), []);
});

test('addTrack of a track that already has a sender is InvalidAccessError', (t) => {
  const { pc } = setup(t);
  const track = audioTrack();
  pc.addTrack(track);
  assert.throws(() => pc.addTrack(track), { name: 'InvalidAccessError' });
});

test("removeTrack rejects another connection's sender, and clears the track and send direction", (t) => {
  const { pc } = setup(t);
  const other = new RTCPeerConnection();
  t.after(() => other.close());
  const foreign = other.addTransceiver('audio').sender;
  assert.throws(() => pc.removeTrack(foreign), { name: 'InvalidAccessError' });
  assert.throws(() => pc.removeTrack({} as never), { name: 'TypeError' });

  const sender = pc.addTrack(audioTrack());
  pc.removeTrack(sender);
  assert.equal(sender.track, null);
  assert.equal(pc.getTransceivers()[0]?.direction, 'recvonly');
});

test('replaceTrack checks the kind before chaining and sets the track when it resolves', async (t) => {
  const { pc, fake } = setup(t);
  const { sender } = pc.addTransceiver('audio');
  await assert.rejects(sender.replaceTrack(trackFromNative(new FakeTrack('video'))), {
    name: 'TypeError',
  });
  const created = pc.createOffer();
  const track = audioTrack();
  const replaced = sender.replaceTrack(track);
  await fake.flush();
  const nativeSender = fake.transceivers[0]?.sender;
  assert.deepEqual(nativeSender?.callsTo('replaceTrack'), [], 'chained behind createOffer');
  fake.pending('createOffer').resolve(offer);
  await created;
  await replaced;
  assert.equal(sender.track, track);
  assert.equal(nativeSender?.track, nativeTrackOf(track));
});

test('replaceTrack on a stopping transceiver rejects with InvalidStateError', async (t) => {
  const { pc } = setup(t);
  const transceiver = pc.addTransceiver('audio');
  transceiver.stop();
  await assert.rejects(transceiver.sender.replaceTrack(null), { name: 'InvalidStateError' });
});

test('setParameters needs getParameters in the same task and rejects read-only changes', async (t) => {
  const { pc, fake } = setup(t);
  const { sender } = pc.addTransceiver('audio');
  const nativeSender = fake.transceivers[0]?.sender;
  assert.ok(nativeSender);
  nativeSender.parameters = {
    transactionId: 't1',
    encodings: [{ active: true, maxBitrate: 64000 }],
    codecs: [],
    headerExtensions: [],
    rtcp: { cname: 'c', reducedSize: false },
  };
  const stale = sender.getParameters();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(sender.setParameters(stale), { name: 'InvalidStateError' });

  const fresh = sender.getParameters();
  await assert.rejects(sender.setParameters({ ...fresh, transactionId: 'x' }), {
    name: 'InvalidModificationError',
  });
  const p = sender.getParameters();
  await assert.rejects(sender.setParameters({ ...p, rtcp: { cname: 'other' } }), {
    name: 'InvalidModificationError',
  });

  const ok = sender.getParameters();
  ok.encodings[0] = { ...ok.encodings[0], maxBitrate: 32000 };
  const applied = sender.setParameters(ok);
  nativeSender.pending('setParameters').resolve();
  await applied;
  const [[passed] = []] = nativeSender.callsTo('setParameters');
  assert.deepEqual((passed as { encodings?: unknown[] } | undefined)?.encodings, [
    // With the dictionary defaults filled in by the WebIDL conversion.
    { active: true, maxBitrate: 32000, priority: 'low', adaptivePtime: false },
  ]);
});

test("the direction setter rejects 'stopped' and a stopping transceiver, and caches the value", (t) => {
  const { pc, fake } = setup(t);
  const transceiver = pc.addTransceiver('audio');
  assert.throws(
    () => {
      transceiver.direction = 'stopped';
    },
    { name: 'TypeError' },
  );
  assert.throws(
    () => {
      transceiver.direction = 'bogus' as never;
    },
    { name: 'TypeError' },
  );
  transceiver.direction = 'sendonly';
  assert.equal(fake.transceivers[0]?.direction, 'sendonly');
  assert.equal(transceiver.direction, 'sendonly');
  transceiver.stop();
  assert.throws(
    () => {
      transceiver.direction = 'sendrecv';
    },
    { name: 'InvalidStateError' },
  );
});

test('getStats(track) selects the one sender or receiver of the track', async (t) => {
  const { pc, fake } = setup(t);
  const track = audioTrack();
  pc.addTrack(track);
  const stats = pc.getStats(track);
  fake.pending('getStats').resolve('{}');
  await stats;
  assert.equal(fake.callsTo('getStats')[0]?.[0], fake.transceivers[0]?.sender);
  await assert.rejects(pc.getStats(audioTrack()), { name: 'InvalidAccessError' });
});

test("getStats(track) finds a stopped transceiver's sender and receiver, also after close", async (t) => {
  const { pc, fake } = setup(t);
  const track = audioTrack();
  pc.addTrack(track);
  const [transceiver] = pc.getTransceivers();
  assert.ok(transceiver);
  transceiver.stop();
  pc.close();
  for (const selector of [track, transceiver.receiver.track]) {
    const stats = pc.getStats(selector);
    fake.pending('getStats').resolve('{}');
    await stats;
  }
  const [native] = fake.transceivers;
  assert.deepEqual(
    fake.callsTo('getStats').map(([s]) => s),
    [native?.sender, native?.receiver],
  );
});

// ---------------------------------------------------------------------------
// Configuration

test('getConfiguration returns the defaults filled in, as a copy', (t) => {
  const { pc, fake } = setup(t, { iceServers: [{ urls: 'stun:stun.example.org:3478' }] });
  const config = pc.getConfiguration();
  assert.deepEqual(config, {
    // As Chrome: urls always a list, username and credential always there.
    iceServers: [{ urls: ['stun:stun.example.org:3478'], username: '', credential: '' }],
    iceTransportPolicy: 'all',
    bundlePolicy: 'balanced',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 0,
    certificates: [],
    portRange: {},
    sdpSemantics: 'unified-plan',
  });
  config.iceServers.length = 0;
  assert.equal(pc.getConfiguration().iceServers.length, 1);
  assert.deepEqual(fake.config.iceServers, [{ urls: 'stun:stun.example.org:3478' }]);
});

const turnServer = {
  urls: ['turn:turn.example.org:443?transport=tcp', 'turns:turn.example.org'],
  username: 'u',
  credential: 'c',
};

test("getConfiguration's ICE servers are a copy each call", (t) => {
  const { pc } = setup(t, { iceServers: [turnServer] });
  const config = pc.getConfiguration();
  (config.iceServers[0]?.urls as string[]).length = 0;
  config.iceServers.length = 0;
  assert.deepEqual(pc.getConfiguration().iceServers, [turnServer]);
});

test("getConfiguration's ICE servers go back through setConfiguration unchanged", (t) => {
  const { pc, fake } = setup(t, { iceServers: [turnServer, { urls: 'stun:stun.example.org' }] });
  pc.setConfiguration(pc.getConfiguration());
  assert.deepEqual(fake.callsTo('setConfiguration')[0]?.[0].iceServers, [
    turnServer,
    { urls: ['stun:stun.example.org'], username: '', credential: '' },
  ]);
});

test("mediasoup-client's updateIceServers(): getConfiguration() with new servers replaces them", (t) => {
  const { pc, fake } = setup(t, { iceServers: [turnServer] });
  const config = pc.getConfiguration();
  config.iceServers = [{ urls: 'turn:other.example.org', username: 'v', credential: 'd' }];
  pc.setConfiguration(config);
  assert.deepEqual(fake.callsTo('setConfiguration')[0]?.[0].iceServers, [
    { urls: 'turn:other.example.org', username: 'v', credential: 'd' },
  ]);
  assert.deepEqual(pc.getConfiguration().iceServers, [
    { urls: ['turn:other.example.org'], username: 'v', credential: 'd' },
  ]);
});

test('portRange min > max is a TypeError (as in wrtc); min == max is allowed', (t) => {
  useFakeNative(t, { PeerConnection: FakePeerConnection });
  assert.throws(() => new RTCPeerConnection({ portRange: { min: 10, max: 5 } }), {
    name: 'TypeError',
    message:
      "Failed to construct 'RTCPeerConnection': configuration.portRange.min (10) must not be " +
      'greater than portRange.max (5)',
  });
  // max defaults to 65535.
  const pc1 = new RTCPeerConnection({ portRange: { min: 65535 } });
  pc1.close();
  assert.throws(() => pc1.setConfiguration({ portRange: { min: 2, max: 1 } }), {
    name: 'TypeError',
    message:
      /^Failed to execute 'setConfiguration' on 'RTCPeerConnection': configuration\.portRange/,
  });
  const pc = new RTCPeerConnection({ portRange: { min: 5000, max: 5000 } });
  pc.close();
});

test('ICE server URLs are validated as the spec says', (t) => {
  useFakeNative(t, { PeerConnection: FakePeerConnection });
  const make = (server: object) => () => new RTCPeerConnection({ iceServers: [server as never] });
  assert.throws(make({ urls: 'http://example.org' }), { name: 'SyntaxError' });
  assert.throws(make({ urls: 'stun://example.org' }), { name: 'SyntaxError' });
  assert.throws(make({ urls: [] }), { name: 'SyntaxError' });
  assert.throws(make({ urls: 'turn:example.org' }), { name: 'InvalidAccessError' });
  assert.throws(make({ urls: 'turn:example.org?transport=sctp', username: 'u', credential: 'c' }), {
    name: 'SyntaxError',
  });
  assert.throws(make({}), { name: 'TypeError', message: /required member 'urls'/ });
  const ok = new RTCPeerConnection({
    iceServers: [
      { urls: ['stun:a.example', 'turns:b.example?transport=tcp'], username: 'u', credential: 'c' },
    ],
  });
  ok.close();
});

test('an ICE server URL must be scheme:host[:port], checked before the TURN credentials', (t) => {
  useFakeNative(t, { PeerConnection: FakePeerConnection });
  const make = (urls: string) => () => new RTCPeerConnection({ iceServers: [{ urls }] });
  for (const urls of [
    'turn:',
    'turn::8191',
    'turn:example.org:131071',
    'turn:2001:4860:4860::8888',
    'turn:user@example.org',
    'turn:example.org/',
    'turn:example.org\\path',
  ]) {
    assert.throws(make(urls), { name: 'SyntaxError', message: /scheme:host\[:port\]/ }, urls);
  }
  // Valid hosts still get to the credentials check (TURN) or succeed (STUN).
  assert.throws(make('turn:[2001:db8::1]:3478'), { name: 'InvalidAccessError' });
  for (const urls of ['stun:192.0.2.1:3478', 'stun:[2001:db8::1]', 'stun:stun.example.net']) {
    make(urls)().close();
  }
});

test('ICE server hosts that wrtc and libwebrtc accept are not rejected', (t) => {
  useFakeNative(t, { PeerConnection: FakePeerConnection });
  // Only the URL's shape is checked (what WPT requires), not whether the
  // host is a valid DNS name or IPv4 address, nor IPv6 zone ids.
  for (const urls of [
    'turn:host.123',
    'turn:256.1.1.1:3478',
    'turn:[fe80::1%25en0]',
    'turn:[fe80::1%en0]:3478',
  ]) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls, username: 'u', credential: 'c' }],
    });
    pc.close();
  }
});

test('setConfiguration checks in spec order: conversion, closed, unchangeable members, then ICE servers', (t) => {
  const { pc } = setup(t);
  assert.throws(
    () => pc.setConfiguration({ bundlePolicy: 'max-bundle', iceServers: [{ urls: 'bogus:x' }] }),
    { name: 'InvalidModificationError' },
  );
  pc.close();
  assert.throws(() => pc.setConfiguration({ iceServers: [{ urls: 'bogus:x' }] }), {
    name: 'InvalidStateError',
  });
  assert.throws(() => pc.setConfiguration({ bundlePolicy: 'nope' as never }), {
    name: 'TypeError',
  });
});

test('setConfiguration rejects changing bundlePolicy and passes the rest to libwebrtc', (t) => {
  const { pc, fake } = setup(t);
  assert.throws(() => pc.setConfiguration({ bundlePolicy: 'max-bundle' }), {
    name: 'InvalidModificationError',
  });
  pc.setConfiguration({ iceTransportPolicy: 'relay' });
  assert.equal(fake.callsTo('setConfiguration')[0]?.[0].iceTransportPolicy, 'relay');
  assert.equal(pc.getConfiguration().iceTransportPolicy, 'relay');
});

// ---------------------------------------------------------------------------
// Certificates

/** Fake PCs, and `n` certificates from a fake generator. */
async function withCertificates(t: TestContext, n: number) {
  const generateCertificate = fakeCertificateGenerator();
  const fakes = useFakeNative(t, { PeerConnection: FakePeerConnection, generateCertificate });
  const certificates = await Promise.all(
    Array.from({ length: n }, () =>
      RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' }),
    ),
  );
  const make = (config: RTCConfiguration = {}) => {
    const pc = new RTCPeerConnection(config);
    t.after(() => pc.close());
    return { pc, fake: fakes.last('PeerConnection') };
  };
  return { certificates, make };
}

test('certificates go to libwebrtc as PEM at construction; getConfiguration has the same objects', async (t) => {
  const { certificates, make } = await withCertificates(t, 2);
  const [a, b] = certificates as [RTCCertificate, RTCCertificate];
  const { pc, fake } = make({ certificates: [a, b] });
  assert.deepEqual(fake.config.certificates, [
    { privateKey: 'fake private key 1', certificate: 'fake certificate 1' },
    { privateKey: 'fake private key 2', certificate: 'fake certificate 2' },
  ]);
  const config = pc.getConfiguration();
  assert.equal(config.certificates[0], a);
  assert.equal(config.certificates[1], b);
  config.certificates.length = 0;
  assert.equal(pc.getConfiguration().certificates.length, 2, 'a copy of the list');
});

test('without certificates libwebrtc gets none, so it makes its default one as before', async (t) => {
  const { make } = await withCertificates(t, 0);
  assert.equal('certificates' in make().fake.config, false);
  assert.equal('certificates' in make({ certificates: [] }).fake.config, false);
});

test('an expired certificate is InvalidAccessError at construction, wherever it is', async (t) => {
  const { certificates: valid, make } = await withCertificates(t, 1);
  const expired = await RTCPeerConnection.generateCertificate({
    name: 'ECDSA',
    namedCurve: 'P-256',
    expires: 0,
  });
  for (const certificates of [[expired], [valid[0] as RTCCertificate, expired]]) {
    assert.throws(() => make({ certificates }), {
      name: 'InvalidAccessError',
      message: "Failed to construct 'RTCPeerConnection': Expired certificate(s).",
    });
  }
});

test('setConfiguration keeps the certificates: only the same objects in the same order pass', async (t) => {
  const { certificates, make } = await withCertificates(t, 2);
  const [a, b] = certificates as [RTCCertificate, RTCCertificate];
  const { pc, fake } = make({ certificates: [a, b] });
  pc.setConfiguration({ certificates: [a, b] });
  // mediasoup-client's updateIceServers() round trip.
  pc.setConfiguration({ ...pc.getConfiguration(), iceServers: [] });
  for (const changed of [
    { certificates: [b, a] },
    { certificates: [a] },
    { certificates: [] },
    {},
  ]) {
    assert.throws(() => pc.setConfiguration(changed), {
      name: 'InvalidModificationError',
      message:
        "Failed to execute 'setConfiguration' on 'RTCPeerConnection': certificates can't be changed.",
    });
  }
  assert.equal(fake.callsTo('setConfiguration').length, 2);
  for (const [config] of fake.callsTo('setConfiguration')) {
    assert.equal('certificates' in config, false, 'libwebrtc keeps its own');
  }

  const plain = make().pc;
  plain.setConfiguration({ certificates: [] });
  assert.throws(() => plain.setConfiguration({ certificates: [a] }), {
    name: 'InvalidModificationError',
  });
});

test('certificates must be RTCCertificates (wrtc ignored any object)', async (t) => {
  const { make } = await withCertificates(t, 0);
  const lookalike = { expires: Date.now() + 1e6, getFingerprints: () => [] };
  for (const certificates of [[{}], [lookalike], [null]]) {
    assert.throws(() => make({ certificates: certificates as never }), { name: 'TypeError' });
  }
});

// ---------------------------------------------------------------------------
// Transports

test('sender and receiver transports: set by local descriptions and remote answers, not remote offers', async (t) => {
  const { pc, fake } = setup(t);
  const audio = pc.addTransceiver('audio');
  const video = pc.addTransceiver('video');
  const [fakeAudio, fakeVideo] = fake.transceivers as [FakeTransceiver, FakeTransceiver];
  const keys = (sender: number, receiver = sender) => ({
    senderTransport: sender,
    receiverTransport: receiver,
  });
  assert.equal(audio.sender.transport, null, 'null before negotiation');

  const sld = pc.setLocalDescription(offer);
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: {
      localDescription: offer,
      pendingLocalDescription: offer,
      transceivers: [
        transceiverState(fakeAudio, { mid: '0', ...keys(1) }),
        transceiverState(fakeVideo, { mid: '1', ...keys(2) }),
      ],
    },
  });
  await sld;
  const first = audio.sender.transport;
  assert.ok(first);
  assert.equal(audio.receiver.transport, first, "the receiver's is the same object");
  assert.notEqual(video.sender.transport, first, 'another key, another transport');

  // A rollback restores the last stable state's (none yet), whatever
  // libwebrtc's senders still point at; a remote offer then leaves them.
  const rollback = pc.setLocalDescription({ type: 'rollback' });
  await fake.flush();
  fake.completeSetLocalDescription({
    signalingState: 'stable',
    snapshot: {
      transceivers: [transceiverState(fakeAudio, keys(1)), transceiverState(fakeVideo, keys(2))],
    },
  });
  await rollback;
  assert.equal(audio.sender.transport, null, 'rolled back');
  const srd = pc.setRemoteDescription(offer);
  await fake.flush();
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    snapshot: {
      remoteDescription: offer,
      pendingRemoteDescription: offer,
      transceivers: [transceiverState(fakeAudio, keys(3)), transceiverState(fakeVideo, keys(3))],
    },
  });
  await srd;
  assert.equal(audio.sender.transport, null, 'a remote offer sets none');

  // The local answer BUNDLEs both on one transport.
  const answering = pc.setLocalDescription(answer);
  await fake.flush();
  fake.completeSetLocalDescription({
    signalingState: 'stable',
    snapshot: {
      transceivers: [transceiverState(fakeAudio, keys(3)), transceiverState(fakeVideo, keys(3))],
    },
  });
  await answering;
  const bundled = audio.sender.transport;
  assert.ok(bundled);
  assert.notEqual(bundled, first);
  assert.equal(video.receiver.transport, bundled, 'shared under BUNDLE');

  // Glare: our new offer moves them, the remote offer's implicit rollback
  // restores the stable ones.
  const reoffer = pc.setLocalDescription(offer);
  await fake.flush();
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: {
      transceivers: [transceiverState(fakeAudio, keys(4)), transceiverState(fakeVideo, keys(4))],
    },
  });
  await reoffer;
  assert.notEqual(audio.sender.transport, bundled);
  const glare = pc.setRemoteDescription(offer);
  await fake.flush();
  fake.completeSetLocalDescription({
    signalingState: 'stable',
    snapshot: {
      transceivers: [transceiverState(fakeAudio, keys(4)), transceiverState(fakeVideo, keys(4))],
    },
  });
  await fake.flush();
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    snapshot: {
      transceivers: [transceiverState(fakeAudio, keys(4)), transceiverState(fakeVideo, keys(4))],
    },
  });
  await glare;
  assert.equal(audio.sender.transport, bundled);
  assert.equal(video.receiver.transport, bundled);
});

test('pc.close() keeps the transports and closes them, without events', async (t) => {
  const { pc, fake } = setup(t);
  const audio = pc.addTransceiver('audio');
  const sld = pc.setLocalDescription(offer);
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: {
      transceivers: [
        transceiverState(fake.transceivers[0] as FakeTransceiver, {
          senderTransport: 1,
          receiverTransport: 1,
        }),
      ],
    },
  });
  await sld;
  const transport = audio.sender.transport;
  assert.ok(transport);
  const log: string[] = [];
  transport.onstatechange = () => log.push('dtls');
  transport.iceTransport.onstatechange = () => log.push('ice');
  pc.close();
  assert.equal(audio.sender.transport, transport);
  assert.deepEqual([transport.state, transport.iceTransport.state], ['closed', 'closed']);
  assert.deepEqual(log, []);
});

test("an ICE transport's role is 'unknown' until an answer is applied", async (t) => {
  const { pc, fake } = setup(t);
  const audio = pc.addTransceiver('audio');
  const fakeAudio = fake.transceivers[0] as FakeTransceiver;
  const entry = transceiverState(fakeAudio, { senderTransport: 1, receiverTransport: 1 });
  const sld = pc.setLocalDescription(offer);
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: { transceivers: [entry], iceRoles: { 1: 'controlling' } },
  });
  await sld;
  const ice = audio.sender.transport?.iceTransport;
  assert.equal(ice?.role, 'unknown', 'libwebrtc picked one at the offer already');
  const srd = pc.setRemoteDescription(answer);
  await fake.flush();
  fake.completeSetRemoteDescription({
    signalingState: 'stable',
    snapshot: { transceivers: [entry], iceRoles: { 1: 'controlling' } },
  });
  await srd;
  assert.equal(ice?.role, 'controlling');
});

test("iceConnectionState is Chrome's: libwebrtc's 'completed' reads 'connected', 'failed' 'disconnected'", async (t) => {
  const { pc, fake } = setup(t);
  const log: string[] = [];
  pc.oniceconnectionstatechange = () => log.push(pc.iceConnectionState);
  for (const state of [
    'checking',
    'connected',
    'completed',
    'disconnected',
    'failed',
    'checking',
    'failed',
  ] as const) {
    fake.emit({ kind: 'iceconnectionstatechange', state });
  }
  await fake.flush();
  // An ICE restart after 'failed' still fires 'checking'; the change to
  // 'failed' (and to 'completed') fires nothing.
  assert.deepEqual(log, ['checking', 'connected', 'disconnected', 'checking', 'disconnected']);
  assert.equal(pc.iceConnectionState, 'disconnected');
});

test("with one ICE transport, it reads the connection's ICE state in both events, the connection's first", async (t) => {
  const { pc, fake } = setup(t);
  const audio = pc.addTransceiver('audio');
  const sld = pc.setLocalDescription(offer);
  fake.emit({
    kind: 'ice:state',
    transport: 1,
    state: 'new',
    role: 'controlling',
    mid: '0',
    gathering: 'new',
    selectedPair: null,
  });
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: {
      transceivers: [
        transceiverState(fake.transceivers[0] as FakeTransceiver, {
          senderTransport: 1,
          receiverTransport: 1,
        }),
      ],
    },
  });
  await sld;
  const ice = audio.sender.transport?.iceTransport;
  assert.ok(ice);
  const log: string[] = [];
  pc.oniceconnectionstatechange = () => log.push(`pc ${pc.iceConnectionState} ice ${ice.state}`);
  ice.onstatechange = () => log.push(`ice ${ice.state} pc ${pc.iceConnectionState}`);
  fake.emit({
    kind: 'iceconnectionstatechange',
    state: 'checking',
    transportStates: { 1: 'checking' },
  });
  // The transport's own report follows (libwebrtc posts it later).
  fake.emit({
    kind: 'ice:state',
    transport: 1,
    state: 'checking',
    role: 'controlling',
    mid: '0',
    gathering: 'new',
    selectedPair: null,
  });
  await fake.flush();
  assert.deepEqual(log, ['pc checking ice checking', 'ice checking pc checking']);
});
