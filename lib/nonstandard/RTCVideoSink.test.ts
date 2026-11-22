import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { NativeVideoFrame } from '../internal/native-types.ts';
import { FakeTrack, FakeVideoSink, useFakeNative } from '../internal/testing/fake-native.ts';
import { interfaceType } from '../internal/webidl.ts';
import { markTrackEnded, trackFromNative } from '../MediaStreamTrack.ts';
import { RTCVideoSink } from './RTCVideoSink.ts';

/** A sink on a fake video track, with the fake native sink behind it. */
function newSink(t: TestContext) {
  const fakes = useFakeNative(t, { VideoSink: FakeVideoSink });
  const track = new FakeTrack('video');
  const sink = new RTCVideoSink(trackFromNative(track));
  return { sink, track, nativeSink: fakes.last('VideoSink') };
}

const frame: NativeVideoFrame = { width: 2, height: 2, rotation: 90, data: new Uint8Array(6) };

test("the constructor checks its track's kind (a TypeError, as in wrtc)", () => {
  const audioTrack = trackFromNative(new FakeTrack('audio'));
  assert.throws(() => new RTCVideoSink(audioTrack), {
    name: 'TypeError',
    message:
      'RTCVideoSink: track is an audio track, but RTCVideoSink needs a video track ' +
      '(use RTCAudioSink for audio)',
  });
});

test('the native sink is created on the track handle', (t) => {
  const { track, nativeSink } = newSink(t);
  assert.equal(nativeSink.track, track);
});

test('a frame event carries the frame as an own enumerable property', (t) => {
  const { sink, nativeSink } = newSink(t);
  const events: Event[] = [];
  sink.onframe = (event) => events.push(event);

  nativeSink.deliver(frame);

  assert.equal(events.length, 1);
  const event = events[0] as Event & Record<string, unknown>;
  assert.equal(event.type, 'frame');
  assert.deepEqual(Object.keys(event), ['frame']);
  assert.equal(event.frame, frame);
});

test('events that arrive after stop() are not dispatched', (t) => {
  const { sink, nativeSink } = newSink(t);
  let dispatched = 0;
  sink.onframe = () => dispatched++;

  sink.stop();
  nativeSink.deliver(frame);

  assert.equal(dispatched, 0);
  assert.equal(sink.stopped, true);
});

test('stop() stops the native sink once, however often it is called', (t) => {
  const { sink, nativeSink } = newSink(t);
  sink.stop();
  sink.stop();
  assert.equal(nativeSink.stopCount, 1);
});

test("a sink stops itself when its track's source ends", async (t) => {
  const { sink, track, nativeSink } = newSink(t);
  markTrackEnded(trackFromNative(track));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sink.stopped, true);
  assert.equal(nativeSink.stopCount, 1);
});

test('a sink stops itself when its track is stopped', (t) => {
  const { sink, track, nativeSink } = newSink(t);
  trackFromNative(track).stop();
  assert.equal(sink.stopped, true);
  assert.equal(nativeSink.stopCount, 1);
});

test('framesDropped reads the native count, also after stop()', (t) => {
  const { sink, nativeSink } = newSink(t);
  assert.equal(sink.framesDropped, 0);
  nativeSink.framesDropped = 7;
  assert.equal(sink.framesDropped, 7);
  sink.stop();
  assert.equal(sink.framesDropped, 7);
});

test('RTCVideoSink is a registered WebIDL interface with a real brand check', (t) => {
  const { sink } = newSink(t);
  const convert = interfaceType('RTCVideoSink');
  assert.equal(convert(sink, 'sink'), sink);
  assert.throws(() => convert(Object.create(RTCVideoSink.prototype), 'sink'), {
    name: 'TypeError',
    message: 'sink: is not a RTCVideoSink',
  });
});
