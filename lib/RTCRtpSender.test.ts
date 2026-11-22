// RTCRtpSender (and RTCRtpReceiver) parameters against the fake native
// addon: [[LastReturnedParameters]] timing, the encodings shown and passed
// back, and codecs from the negotiated descriptions. End-to-end behaviour
// against libwebrtc is in test/integration/parameters.test.ts.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { NativeRtpCapabilities, NativeSessionDescription } from './internal/native-types.ts';
import {
  FakePeerConnection,
  type FakeSender,
  transceiverState,
  useFakeNative,
} from './internal/testing/fake-native.ts';
import { RTCPeerConnection } from './RTCPeerConnection.ts';
import type { RTCRtpSender } from './RTCRtpSender.ts';

const capabilities: Record<string, NativeRtpCapabilities> = {
  audio: {
    codecs: [
      { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { mimeType: 'audio/PCMU', clockRate: 8000, channels: 1 },
    ],
    headerExtensions: [],
  },
  video: { codecs: [{ mimeType: 'video/VP8', clockRate: 90000 }], headerExtensions: [] },
};

function setup(t: TestContext) {
  const fakes = useFakeNative(t, {
    PeerConnection: FakePeerConnection,
    getRtpCapabilities: (_side: string, kind: string) => capabilities[kind] ?? null,
  });
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  return { pc, fake: fakes.last('PeerConnection') };
}

/** RTCRtpSendParameters as libwebrtc reports them, with these encodings. */
function nativeParameters(transactionId: string, encodings: Record<string, unknown>[]) {
  return {
    transactionId,
    encodings,
    codecs: [],
    headerExtensions: [],
    rtcp: { cname: 'c', reducedSize: true },
  };
}

function nativeSenderOf(fake: FakePeerConnection, index = 0): FakeSender {
  const sender = fake.transceivers[index]?.sender;
  assert.ok(sender, `the fake has transceiver ${index}`);
  return sender;
}

/** The encodings the `call`th setParameters() passed to the native sender. */
function passedEncodings(sender: FakeSender, call = 0): Record<string, unknown>[] {
  const [parameters] = sender.callsTo('setParameters')[call] ?? [];
  assert.ok(parameters, `setParameters call ${call}`);
  return (parameters as { encodings: Record<string, unknown>[] }).encodings;
}

const nextTask = () => new Promise((resolve) => setImmediate(resolve));

test('getParameters returns the same parameters until a task has run', async (t) => {
  const { pc, fake } = setup(t);
  const { sender } = pc.addTransceiver('audio');
  const nativeSender = nativeSenderOf(fake);
  nativeSender.parameters = nativeParameters('t1', [{ active: true }]);
  const first = sender.getParameters();
  nativeSender.parameters = nativeParameters('t2', [{ active: true }]);
  const second = sender.getParameters();
  await undefined;
  assert.equal(second.transactionId, 't1');
  assert.equal(sender.getParameters().transactionId, 't1', 'after microtasks');
  assert.notEqual(first, second, 'a new object each time');
  assert.equal(nativeSender.callsTo('getParameters').length, 1);

  await nextTask();
  assert.equal(sender.getParameters().transactionId, 't2');
});

test('after close(), getParameters still returns fresh parameters once a task has run', async (t) => {
  const { pc, fake } = setup(t);
  const { sender } = pc.addTransceiver('audio');
  const nativeSender = nativeSenderOf(fake);
  nativeSender.parameters = nativeParameters('t1', [{ active: true }]);
  sender.getParameters();
  // Its clearing task, queued while open, is dropped with the rest.
  pc.close();
  nativeSender.parameters = nativeParameters('t2', [{ active: true }]);
  await nextTask();
  assert.equal(sender.getParameters().transactionId, 't2');
  nativeSender.parameters = nativeParameters('t3', [{ active: true }]);
  await nextTask();
  assert.equal(sender.getParameters().transactionId, 't3', 'cleared again once closed');
});

test('a setParameters() in the same task leaves getParameters() unchanged and its parameters usable', async (t) => {
  const { pc, fake } = setup(t);
  const { sender } = pc.addTransceiver('audio');
  const nativeSender = nativeSenderOf(fake);
  nativeSender.parameters = nativeParameters('t1', [{ active: true }]);
  const parameters = sender.getParameters();
  const first = sender.setParameters(parameters);
  assert.equal(sender.getParameters().transactionId, 't1');
  const second = sender.setParameters(parameters);
  nativeSender.pending('setParameters').resolve();
  nativeSender.pending('setParameters').resolve();
  await Promise.all([first, second]);
});

/**
 * Runs `between` between a getParameters() and a setParameters() of its
 * result, and resolves with whether the setParameters() was accepted.
 */
async function acceptedAcross(
  sender: RTCRtpSender,
  nativeSender: FakeSender,
  between: () => Promise<unknown>,
): Promise<boolean> {
  nativeSender.parameters = nativeParameters('t1', [{ active: true }]);
  const parameters = sender.getParameters();
  await between();
  const before = nativeSender.callsTo('setParameters').length;
  const applied = sender.setParameters(parameters);
  if (nativeSender.callsTo('setParameters').length > before) {
    nativeSender.pending('setParameters').resolve();
  }
  return applied.then(
    () => true,
    () => false,
  );
}

test('operations the JS layer settles in the same task leave the parameters usable', async (t) => {
  const { pc, fake } = setup(t);
  const other = new RTCPeerConnection();
  t.after(() => other.close());
  const { sender } = pc.addTransceiver('audio');
  const transceiver = fake.transceivers[0];
  assert.ok(transceiver);
  const nativeSender = nativeSenderOf(fake);
  const remote: NativeSessionDescription = { type: 'offer', sdp: remoteSdp };
  const srd = pc.setRemoteDescription(remote);
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    snapshot: {
      remoteDescription: remote,
      pendingRemoteDescription: remote,
      transceivers: [transceiver].map((tr) => transceiverState(tr, { mid: '0' })),
    },
  });
  await srd;
  await nextTask();

  assert.equal(
    await acceptedAcross(sender, nativeSender, () => Promise.resolve()),
    true,
    'microtasks only',
  );
  await nextTask();
  assert.equal(
    await acceptedAcross(sender, nativeSender, () =>
      pc.addIceCandidate({ candidate: '', sdpMid: '0' }),
    ),
    true,
    'an end-of-candidates addIceCandidate (no native call)',
  );
  await nextTask();
  assert.equal(
    await acceptedAcross(sender, nativeSender, () => other.createAnswer().catch(() => {})),
    true,
    "another connection's createAnswer rejected before its native call",
  );
  await nextTask();
  assert.equal(
    await acceptedAcross(sender, nativeSender, async () => {
      other.createAnswer().catch(() => {});
      for (let i = 0; i < 3; i++) await Promise.resolve();
    }),
    true,
    'the same rejection, not awaited',
  );
});

test('a native result delivered before the queued task makes the last parameters stale', async (t) => {
  const { pc, fake } = setup(t);
  const { sender } = pc.addTransceiver('audio');
  const nativeSender = nativeSenderOf(fake);
  const created = pc.createOffer();
  // Delivered before the task getParameters() queues below, as libwebrtc's
  // completions can be.
  fake.pending('createOffer').resolve({ type: 'offer', sdp: 'v=0\r\n' });
  nativeSender.parameters = nativeParameters('t1', [{ active: true }]);
  const stale = sender.getParameters();
  nativeSender.parameters = nativeParameters('t2', [{ active: true }]);
  await created;
  assert.equal(sender.getParameters().transactionId, 't2');
  await nextTask();
  await assert.rejects(sender.setParameters(stale), { name: 'InvalidStateError' });
});

test('audio encodings drop scaleResolutionDownBy and maxFramerate, even invalid ones', async (t) => {
  const { pc, fake } = setup(t);
  const { sender } = pc.addTransceiver('audio');
  const nativeSender = nativeSenderOf(fake);
  nativeSender.parameters = nativeParameters('t1', [{ active: true, scaleResolutionDownBy: 2 }]);
  const parameters = sender.getParameters();
  // (Not deepEqual: as an assertion function it would narrow the type.)
  assert.equal(JSON.stringify(parameters.encodings), JSON.stringify([{ active: true }]));
  parameters.encodings[0] = { active: true, scaleResolutionDownBy: -1, maxFramerate: -1 };
  const applied = sender.setParameters(parameters);
  nativeSender.pending('setParameters').resolve();
  await applied;
  assert.deepEqual(passedEncodings(nativeSender), [
    { active: true, priority: 'low', adaptivePtime: false },
  ]);
});

test("a video sender defaults to 'maintain-resolution', unshown until the app sets one", async (t) => {
  const { pc, fake } = setup(t);
  const { sender } = pc.addTransceiver('video');
  const { sender: audio } = pc.addTransceiver('audio');
  const nativeSender = nativeSenderOf(fake);
  assert.deepEqual(nativeSender.callsTo('setDefaultDegradationPreference'), [
    ['maintain-resolution'],
  ]);
  assert.deepEqual(nativeSenderOf(fake, 1).callsTo('setDefaultDegradationPreference'), []);

  // libwebrtc reports the default; getParameters() doesn't, as Chrome shows none.
  const withDefault = { ...nativeParameters('t1', [{ active: true }]) };
  nativeSender.parameters = { ...withDefault, degradationPreference: 'maintain-resolution' };
  const parameters = sender.getParameters();
  assert.equal(parameters.degradationPreference, undefined);
  // A round trip keeps the default.
  let applied = sender.setParameters(parameters);
  nativeSender.pending('setParameters').resolve();
  await applied;
  const passed = () => nativeSender.callsTo('setParameters').at(-1)?.[0] as Record<string, unknown>;
  assert.equal(passed().degradationPreference, 'maintain-resolution');

  // An app's choice is passed on and shown.
  await nextTask();
  const balanced = sender.getParameters();
  balanced.degradationPreference = 'balanced';
  applied = sender.setParameters(balanced);
  nativeSender.pending('setParameters').resolve();
  await applied;
  assert.equal(passed().degradationPreference, 'balanced');
  nativeSender.parameters = { ...withDefault, degradationPreference: 'balanced' };
  await nextTask();
  assert.equal(sender.getParameters().degradationPreference, 'balanced');

  // Leaving it out again goes back to the default, unshown.
  const reset = sender.getParameters();
  delete reset.degradationPreference;
  applied = sender.setParameters(reset);
  nativeSender.pending('setParameters').resolve();
  await applied;
  assert.equal(passed().degradationPreference, 'maintain-resolution');
  nativeSender.parameters = { ...withDefault, degradationPreference: 'maintain-resolution' };
  await nextTask();
  assert.equal(sender.getParameters().degradationPreference, undefined);

  // Audio senders get no default.
  const audioNative = nativeSenderOf(fake, 1);
  audioNative.parameters = nativeParameters('a1', [{ active: true }]);
  applied = audio.setParameters(audio.getParameters());
  audioNative.pending('setParameters').resolve();
  await applied;
  const audioPassed = audioNative.callsTo('setParameters')[0]?.[0] as Record<string, unknown>;
  assert.equal(audioPassed.degradationPreference, undefined);
});

test("video encodings show libwebrtc's default scales and pass them back unset", async (t) => {
  const { pc, fake } = setup(t);
  const { sender } = pc.addTransceiver('video', { sendEncodings: [{ rid: 'lo' }, { rid: 'hi' }] });
  const nativeSender = nativeSenderOf(fake);
  nativeSender.parameters = nativeParameters('t1', [
    { rid: 'lo', active: true },
    { rid: 'hi', active: true },
  ]);
  const parameters = sender.getParameters();
  assert.deepEqual(
    parameters.encodings.map((e) => e.scaleResolutionDownBy),
    [2, 1],
  );
  (parameters.encodings[1] as { active: boolean }).active = false;
  const unchanged = sender.setParameters(parameters);
  nativeSender.pending('setParameters').resolve();
  await unchanged;
  assert.deepEqual(
    passedEncodings(nativeSender).map((e) => e.scaleResolutionDownBy),
    [undefined, undefined],
  );

  await nextTask();
  const next = sender.getParameters();
  (next.encodings[1] as { scaleResolutionDownBy: number }).scaleResolutionDownBy = 1.5;
  const changed = sender.setParameters(next);
  nativeSender.pending('setParameters').resolve();
  await changed;
  assert.deepEqual(
    passedEncodings(nativeSender, 1).map((e) => e.scaleResolutionDownBy),
    [2, 1.5],
  );

  // A remote description removed 'lo': 'hi' keeps the scale it had.
  await nextTask();
  nativeSender.parameters = nativeParameters('t2', [{ rid: 'hi', active: true }]);
  assert.deepEqual(
    sender.getParameters().encodings.map((e) => [e.rid, e.scaleResolutionDownBy]),
    [['hi', 1]],
  );
});

const remoteSdp = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 121 111 0',
  'a=mid:0',
  'a=rtpmap:121 flarglblurp/8000/2',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 maxaveragebitrate=20001;unknownparam=foo',
  '',
].join('\r\n');
const localSdp = remoteSdp
  .replace(' 121 111 0', ' 0 111')
  .replace(/a=fmtp:111 .*/, 'a=fmtp:111 x=1');

test('codecs come from the current descriptions: remote for the sender, local for the receiver', async (t) => {
  const { pc, fake } = setup(t);
  const { sender, receiver } = pc.addTransceiver('audio');
  const transceiver = fake.transceivers[0];
  assert.ok(transceiver);
  // libwebrtc reports codecs only for a stream it sends or receives.
  nativeSenderOf(fake).parameters = nativeParameters('t1', [{ active: true }]);
  transceiver.receiver.parameters = {
    codecs: [],
    headerExtensions: [],
    rtcp: { reducedSize: true },
  };
  assert.deepEqual(sender.getParameters().codecs, []);
  assert.deepEqual(receiver.getParameters().codecs, []);

  const remote: NativeSessionDescription = { type: 'offer', sdp: remoteSdp };
  const local: NativeSessionDescription = { type: 'answer', sdp: localSdp };
  const srd = pc.setRemoteDescription(remote);
  fake.completeSetRemoteDescription({
    signalingState: 'stable',
    snapshot: {
      localDescription: local,
      currentLocalDescription: local,
      remoteDescription: remote,
      currentRemoteDescription: remote,
      transceivers: [transceiverState(transceiver, { mid: '0', currentDirection: 'recvonly' })],
    },
  });
  await srd;
  await nextTask();
  assert.deepEqual(sender.getParameters().codecs, [
    {
      payloadType: 111,
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
      sdpFmtpLine: 'maxaveragebitrate=20001;unknownparam=foo',
    },
    { payloadType: 0, mimeType: 'audio/PCMU', clockRate: 8000, channels: 1 },
  ]);
  assert.deepEqual(receiver.getParameters().codecs, [
    { payloadType: 0, mimeType: 'audio/PCMU', clockRate: 8000, channels: 1 },
    { payloadType: 111, mimeType: 'audio/opus', clockRate: 48000, channels: 2, sdpFmtpLine: 'x=1' },
  ]);
});
