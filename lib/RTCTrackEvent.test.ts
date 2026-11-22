import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertEventAttributes } from './internal/testing/event-attributes.ts';
import { FakePeerConnection, useFakeNative } from './internal/testing/fake-native.ts';
import { MediaStream } from './MediaStream.ts';
import { RTCPeerConnection } from './RTCPeerConnection.ts';
import { RTCTrackEvent } from './RTCTrackEvent.ts';

test('constructible from spec objects, with the payload as brand-checked prototype getters', (t) => {
  useFakeNative(t, { PeerConnection: FakePeerConnection });
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  const transceiver = pc.addTransceiver('video');
  const stream = new MediaStream();
  const init = {
    receiver: transceiver.receiver,
    track: transceiver.receiver.track,
    streams: [stream],
    transceiver,
  };
  const event = new RTCTrackEvent('track', init);
  const { streams } = event;
  assertEventAttributes(event, { ...init, streams });
  assert.deepEqual(streams, [stream]);
  assert.notEqual(streams, init.streams, 'a copy of the init sequence');
  assert.ok(Object.isFrozen(streams), 'a FrozenArray');
  assert.equal(event.streams, streams, '[SameObject]');
  const { track, receiver } = event;
  assert.deepEqual([track, receiver], [init.track, init.receiver], 'destructuring still works');
  assert.deepEqual([event.type, event.bubbles, event.cancelable], ['track', false, false]);
});

test('the init members must be the right interfaces', () => {
  assert.throws(
    () => new RTCTrackEvent('track', { receiver: {}, track: {}, transceiver: {} } as never),
    { name: 'TypeError', message: /is not a RTCRtpReceiver/ },
  );
  assert.throws(() => new (RTCTrackEvent as unknown as new (t: string) => Event)('track'), {
    name: 'TypeError',
  });
});
