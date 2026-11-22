// RTCRtpReceiver against the fake native addon: its track's label and
// jitterBufferTarget reaching libwebrtc. The jitter buffer's effect on
// received media is checked by WPT's RTCRtpReceiver-video-jitterBufferTarget-stats.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import {
  FakePeerConnection,
  type FakeReceiver,
  useFakeNative,
} from './internal/testing/fake-native.ts';
import { RTCPeerConnection } from './RTCPeerConnection.ts';

function setup(t: TestContext) {
  const fakes = useFakeNative(t, { PeerConnection: FakePeerConnection });
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  return { pc, fake: fakes.last('PeerConnection') };
}

function nativeReceiverOf(fake: FakePeerConnection): FakeReceiver {
  const receiver = fake.transceivers[0]?.receiver;
  assert.ok(receiver, 'the fake has a transceiver');
  return receiver;
}

test("a receiver's track is labelled 'remote <kind>' from the start, and its clones keep it (as Chrome)", (t) => {
  const { pc } = setup(t);
  const audio = pc.addTransceiver('audio').receiver.track;
  const video = pc.addTransceiver('video').receiver.track;
  assert.equal(audio.label, 'remote audio');
  assert.equal(video.label, 'remote video');
  const clone = video.clone();
  t.after(() => clone.stop());
  assert.equal(clone.label, 'remote video');
});

test('jitterBufferTarget reaches libwebrtc in seconds, and null restores its default', (t) => {
  const { pc, fake } = setup(t);
  const { receiver } = pc.addTransceiver('video');
  const native = nativeReceiverOf(fake);
  receiver.jitterBufferTarget = 1000;
  receiver.jitterBufferTarget = 0;
  receiver.jitterBufferTarget = null;
  assert.deepEqual(native.callsTo('setJitterBufferMinimumDelay'), [[1], [0], [null]]);
  assert.equal(receiver.jitterBufferTarget, null);
});

test('an invalid jitterBufferTarget throws before libwebrtc and keeps the last valid value', (t) => {
  const { pc, fake } = setup(t);
  const { receiver } = pc.addTransceiver('audio');
  const native = nativeReceiverOf(fake);
  receiver.jitterBufferTarget = 250;
  assert.throws(
    () => {
      receiver.jitterBufferTarget = 4001;
    },
    { name: 'RangeError' },
  );
  assert.throws(
    () => {
      receiver.jitterBufferTarget = -1;
    },
    { name: 'RangeError' },
  );
  assert.equal(receiver.jitterBufferTarget, 250);
  assert.deepEqual(native.callsTo('setJitterBufferMinimumDelay'), [[0.25]]);
});

test('jitterBufferTarget can still be set after close(), as in Chrome', (t) => {
  const { pc, fake } = setup(t);
  const { receiver } = pc.addTransceiver('video');
  pc.close();
  receiver.jitterBufferTarget = 500;
  assert.equal(receiver.jitterBufferTarget, 500);
  assert.deepEqual(nativeReceiverOf(fake).callsTo('setJitterBufferMinimumDelay'), [[0.5]]);
});
