import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { NativeAudioData } from '../internal/native-types.ts';
import { FakeAudioSink, FakeTrack, useFakeNative } from '../internal/testing/fake-native.ts';
import { interfaceType } from '../internal/webidl.ts';
import { markTrackEnded, trackFromNative } from '../MediaStreamTrack.ts';
import { RTCAudioSink } from './RTCAudioSink.ts';

/** A sink on a fake audio track, with the fake native sink behind it. */
function newSink(t: TestContext) {
  const fakes = useFakeNative(t, { AudioSink: FakeAudioSink });
  const track = new FakeTrack('audio');
  const sink = new RTCAudioSink(trackFromNative(track));
  return { sink, track, nativeSink: fakes.last('AudioSink') };
}

const payload: NativeAudioData = {
  samples: new Int16Array([1, -2, 3]),
  sampleRate: 300,
  bitsPerSample: 16,
  channelCount: 1,
  numberOfFrames: 3,
};

test('the constructor checks its track: TypeErrors (as in wrtc) that say what to pass', () => {
  const videoTrack = trackFromNative(new FakeTrack('video'));
  const track =
    "a MediaStreamTrack from this library (getUserMedia(), a source's createTrack(), or a peer connection's track event)";
  assert.throws(() => new RTCAudioSink(undefined as never), {
    name: 'TypeError',
    message: `RTCAudioSink: track is missing: it must be ${track}`,
  });
  assert.throws(() => new RTCAudioSink({ id: 'x', kind: 'audio' }), {
    name: 'TypeError',
    message: `RTCAudioSink: track must be ${track}, not an object`,
  });
  // Another library's track (wrtc's, say).
  class MediaStreamTrack {}
  assert.throws(() => new RTCAudioSink(new MediaStreamTrack() as never), {
    name: 'TypeError',
    message:
      'RTCAudioSink: track is a MediaStreamTrack from another library; it must come from this ' +
      "library (getUserMedia(), a source's createTrack(), or a peer connection's track event)",
  });
  assert.throws(() => new RTCAudioSink(videoTrack), {
    name: 'TypeError',
    message:
      'RTCAudioSink: track is a video track, but RTCAudioSink needs an audio track ' +
      '(use RTCVideoSink for video)',
  });
});

test('the native sink is created on the track handle', (t) => {
  const { track, nativeSink } = newSink(t);
  assert.equal(nativeSink.track, track);
});

test('a data event carries the payload as own enumerable properties, in wrtc order', (t) => {
  const { sink, nativeSink } = newSink(t);
  const events: Event[] = [];
  sink.addEventListener('data', (event) => events.push(event));

  nativeSink.deliver(payload);

  assert.equal(events.length, 1);
  const [event] = events as [Event];
  assert.equal(event.type, 'data');
  assert.equal(event.target, sink);
  const keys = Object.keys(event);
  assert.deepEqual(keys, [
    'samples',
    'bitsPerSample',
    'sampleRate',
    'channelCount',
    'numberOfFrames',
  ]);
  const fields = Object.fromEntries(keys.map((key) => [key, (event as never)[key]]));
  assert.deepEqual(fields, payload);
});

test('ondata runs with the sink as this, in registration order with listeners', (t) => {
  const { sink, nativeSink } = newSink(t);
  const seen: [string, unknown][] = [];
  sink.addEventListener('data', function (this: unknown) {
    seen.push(['listener', this]);
  });
  sink.ondata = function (this: unknown) {
    seen.push(['ondata', this]);
  };

  nativeSink.deliver(payload);

  assert.deepEqual(seen, [
    ['listener', sink],
    ['ondata', sink],
  ]);
});

test('events that arrive after stop() are not dispatched', (t) => {
  const { sink, nativeSink } = newSink(t);
  let dispatched = 0;
  sink.ondata = () => dispatched++;

  sink.stop();
  nativeSink.deliver(payload);

  assert.equal(dispatched, 0);
  assert.equal(sink.stopped, true);
});

test('stop() stops the native sink once, however often it is called', (t) => {
  const { sink, nativeSink } = newSink(t);
  sink.stop();
  sink.stop();
  assert.equal(nativeSink.stopCount, 1);
});

/** Resolves after the tasks queued so far (setImmediate's queue) have run. */
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a sink stops itself when its track's source ends, after the track's ended event", async (t) => {
  const { sink, track, nativeSink } = newSink(t);
  const remote = trackFromNative(track);
  const seen: boolean[] = [];
  remote.onended = () => seen.push(sink.stopped);
  markTrackEnded(remote);
  assert.equal(sink.stopped, false, 'not before the queued task');
  await nextTask();
  assert.deepEqual(seen, [false]);
  assert.equal(sink.stopped, true);
  assert.equal(nativeSink.stopCount, 1);
});

test('a sink stops when its track is stopped, not when another clone is', (t) => {
  const fakes = useFakeNative(t, { AudioSink: FakeAudioSink });
  const track = trackFromNative(new FakeTrack('audio'));
  const clone = track.clone();
  const sink = new RTCAudioSink(clone);
  track.stop();
  assert.equal(sink.stopped, false);
  clone.stop();
  assert.equal(sink.stopped, true);
  assert.equal(fakes.last('AudioSink').stopCount, 1);
});

test('a sink on a clone stops when the source ends', async (t) => {
  useFakeNative(t, { AudioSink: FakeAudioSink });
  const remote = trackFromNative(new FakeTrack('audio'));
  const sink = new RTCAudioSink(remote.clone());
  markTrackEnded(remote);
  await nextTask();
  assert.equal(sink.stopped, true);
});

test('a sink created on a track whose source has ended starts stopped', async (t) => {
  const fakes = useFakeNative(t, { AudioSink: FakeAudioSink });
  const remote = trackFromNative(new FakeTrack('audio'));
  markTrackEnded(remote);
  await nextTask();
  const sink = new RTCAudioSink(remote);
  assert.equal(sink.stopped, true);
  assert.equal(fakes.last('AudioSink').stopCount, 1);
  const late = new RTCAudioSink(remote.clone());
  assert.equal(late.stopped, true, 'nor does a clone made after the end');
});

test('a sink on a stopped track, a clone of one, or one cloned in an ended listener starts stopped', async (t) => {
  useFakeNative(t, { AudioSink: FakeAudioSink });
  const remote = trackFromNative(new FakeTrack('audio'));
  const live = remote.clone();
  remote.stop();
  assert.equal(new RTCAudioSink(remote).stopped, true);
  assert.equal(new RTCAudioSink(remote.clone()).stopped, true);
  let inListener: RTCAudioSink | undefined;
  live.onended = () => {
    inListener = new RTCAudioSink(live.clone());
  };
  markTrackEnded(remote);
  await nextTask();
  assert.equal(inListener?.stopped, true);
});

test('a subclass overriding stop() can be made on an ended track; the sink still stops', async (t) => {
  const fakes = useFakeNative(t, { AudioSink: FakeAudioSink });
  class Logged extends RTCAudioSink {
    log: string[] = [];
    override stop(): void {
      this.log.push('stop');
      super.stop();
    }
  }
  const remote = trackFromNative(new FakeTrack('audio'));
  markTrackEnded(remote);
  await nextTask();
  const sink = new Logged(remote);
  assert.equal(sink.stopped, true);
  assert.deepEqual(sink.log, [], 'the override is not what the source end calls');
  assert.equal(fakes.last('AudioSink').stopCount, 1);
});

test('a sink stopped before its source ends is not stopped again', async (t) => {
  const { sink, track, nativeSink } = newSink(t);
  sink.stop();
  markTrackEnded(trackFromNative(track));
  await nextTask();
  assert.equal(nativeSink.stopCount, 1);
});

test('RTCAudioSink is a registered WebIDL interface with a real brand check', (t) => {
  const { sink } = newSink(t);
  const convert = interfaceType('RTCAudioSink');
  assert.equal(convert(sink, 'sink'), sink);
  assert.throws(() => convert(Object.create(RTCAudioSink.prototype), 'sink'), {
    name: 'TypeError',
    message: 'sink: is not a RTCAudioSink',
  });
});
