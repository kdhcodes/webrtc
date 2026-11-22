import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { native } from './internal/native.ts';
import { FakeTrack } from './internal/testing/fake-native.ts';
import { interfaceType } from './internal/webidl.ts';
import {
  initRemoteTrack,
  MediaStreamTrack,
  markTrackEnded,
  nativeTrackOf,
  setTrackMuted,
  trackFromNative,
  whenEnded,
} from './MediaStreamTrack.ts';
import { RTCAudioSink } from './nonstandard/RTCAudioSink.ts';
import { RTCAudioSource } from './nonstandard/RTCAudioSource.ts';

const tenMs = { samples: new Int16Array(80), sampleRate: 8000 };

/** Resolves with the sink's next data event (5 s failure guard). */
function nextData(sink: RTCAudioSink): Promise<unknown> {
  return once(sink, 'data', { signal: AbortSignal.timeout(5000) });
}

test('is not constructible from JS (a TypeError, as in wrtc and Chrome)', () => {
  assert.throws(() => new MediaStreamTrack(), {
    name: 'TypeError',
    message:
      "Failed to construct 'MediaStreamTrack': Illegal constructor. Tracks come from " +
      "getUserMedia(), a nonstandard RTCAudioSource or RTCVideoSource's createTrack(), or a " +
      "peer connection's track event.",
  });
});

test('one wrapper per native handle', () => {
  const handle = new native.AudioSource().createTrack();
  const track = trackFromNative(handle);
  assert.equal(trackFromNative(handle), track);
  assert.equal(nativeTrackOf(track), handle);
});

test('createTrack() returns a new live track each time', () => {
  const source = new RTCAudioSource();
  const first = source.createTrack();
  const second = source.createTrack();
  assert.notEqual(first, second);
  assert.notEqual(first.id, second.id);
  assert.equal(first.readyState, 'live');
  assert.equal(first.muted, false);
});

test('stop() ends the track without an event, and stops its sinks (wrtc kept them fed)', (t) => {
  const source = new RTCAudioSource();
  const track = source.createTrack();
  const sink = new RTCAudioSink(track);
  const other = new RTCAudioSink(source.createTrack());
  t.after(() => {
    sink.stop();
    other.stop();
  });
  let ended = 0;
  track.addEventListener('ended', () => ended++);

  track.stop();

  assert.equal(track.readyState, 'ended');
  assert.equal(ended, 0);
  assert.equal(sink.stopped, true);
  assert.equal(other.stopped, false, "another track on the source isn't affected");
});

test('after stop(), enabled no longer reaches the native track (wrtc parity)', () => {
  const track = new RTCAudioSource().createTrack();
  track.stop();
  track.enabled = false;
  assert.equal(track.enabled, false);
  assert.equal(nativeTrackOf(track)?.enabled, true);
});

test('while live, enabled reads and writes the native track, as a boolean', () => {
  const handle = new FakeTrack('video');
  const track = trackFromNative(handle);
  track.enabled = 0 as never;
  assert.equal(handle.enabled, false);
  handle.enabled = true;
  assert.equal(track.enabled, true);
});

test('clone() is a new track on the same source with the same enabled', async (t) => {
  const source = new RTCAudioSource();
  const track = source.createTrack();
  track.enabled = false;
  const clone = track.clone();
  const sink = new RTCAudioSink(clone);
  t.after(() => sink.stop());

  const data = nextData(sink);
  source.onData(tenMs);
  await data;

  assert.notEqual(clone.id, track.id);
  assert.equal(clone.kind, 'audio');
  assert.equal(clone.enabled, false);
  assert.equal(clone.readyState, 'live');
});

test('clone() of an ended track is ended and keeps its JS-side enabled', () => {
  const handle = new FakeTrack('audio');
  const track = trackFromNative(handle);
  track.stop();
  track.enabled = false;

  const clone = track.clone();

  assert.equal(nativeTrackOf(clone), handle.clones[0]);
  assert.equal(clone.readyState, 'ended');
  assert.equal(clone.enabled, false);
});

/** Resolves after the tasks queued so far (setImmediate's queue) have run. */
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));

test("when a received track's source ends, it and every live clone end in a queued task, each with ended", async () => {
  const remote = trackFromNative(new FakeTrack('video'));
  const clone = remote.clone();
  const cloneOfClone = clone.clone();
  const stopped = remote.clone();
  stopped.stop();
  assert.equal(remote.readyState, 'live', "stopping a clone doesn't end the others");
  const tracks = [remote, clone, cloneOfClone, stopped];
  const log: string[] = [];
  tracks.forEach((track, i) => {
    track.onended = () => log.push(`ended ${i} ${track.readyState}`);
  });

  markTrackEnded(remote);
  markTrackEnded(remote);
  assert.deepEqual(
    tracks.map((track) => track.readyState),
    ['live', 'live', 'live', 'ended'],
    'still live until the task runs',
  );
  await nextTask();

  assert.deepEqual(
    tracks.map((track) => track.readyState),
    ['ended', 'ended', 'ended', 'ended'],
  );
  assert.deepEqual(
    log,
    ['ended 0 ended', 'ended 1 ended', 'ended 2 ended'],
    'once each; not the stopped one',
  );
  markTrackEnded(remote);
  await nextTask();
  assert.equal(log.length, 3);
});

test('a track stopped before its source-end task runs fires no ended', async () => {
  const remote = trackFromNative(new FakeTrack('audio'));
  let ended = 0;
  remote.onended = () => ended++;
  markTrackEnded(remote);
  remote.stop();
  await nextTask();
  assert.equal(remote.readyState, 'ended');
  assert.equal(ended, 0);
});

/** Logs each mute/unmute event of `tracks` as `<type> <index>` and the track's `muted` then. */
function recordMutes(tracks: MediaStreamTrack[]): string[] {
  const log: string[] = [];
  tracks.forEach((track, i) => {
    track.onmute = () => log.push(`mute ${i} ${track.muted}`);
    track.onunmute = () => log.push(`unmute ${i} ${track.muted}`);
  });
  return log;
}

test('a remote track starts muted, once: marking it again later keeps its state', () => {
  const track = trackFromNative(new FakeTrack('audio'));
  assert.equal(track.muted, false, 'not remote yet');
  initRemoteTrack(track);
  assert.equal(track.muted, true);
  setTrackMuted(track, false);
  initRemoteTrack(track);
  assert.equal(track.muted, false);
});

test('setting the muted state fires mute or unmute only when it changes, after updating muted', () => {
  const track = trackFromNative(new FakeTrack('video'));
  initRemoteTrack(track);
  const log = recordMutes([track]);
  setTrackMuted(track, true);
  setTrackMuted(track, false);
  setTrackMuted(track, false);
  setTrackMuted(track, true);
  assert.deepEqual(log, ['unmute 0 false', 'mute 0 true']);
});

test("clones of a remote track start with its muted state and follow the source's", () => {
  const remote = trackFromNative(new FakeTrack('audio'));
  initRemoteTrack(remote);
  const early = remote.clone();
  assert.equal(early.muted, true);
  const log = recordMutes([remote, early]);
  setTrackMuted(remote, false);
  const late = early.clone();
  assert.equal(late.muted, false);
  late.onmute = () => log.push(`mute 2 ${late.muted}`);

  setTrackMuted(remote, true);

  assert.deepEqual(log, [
    'unmute 0 false',
    'unmute 1 false',
    'mute 0 true',
    'mute 1 true',
    'mute 2 true',
  ]);
});

test("an ended track's muted state no longer changes, and fires nothing", async () => {
  const remote = trackFromNative(new FakeTrack('audio'));
  initRemoteTrack(remote);
  const stopped = remote.clone();
  stopped.stop();
  const log = recordMutes([remote, stopped]);

  setTrackMuted(remote, false);
  markTrackEnded(remote);
  await nextTask();
  setTrackMuted(remote, true);

  assert.deepEqual(log, ['unmute 0 false']);
  assert.deepEqual([remote.muted, stopped.muted], [false, true]);
});

test('once its end is queued, a track still mutes but no longer unmutes', async () => {
  const remote = trackFromNative(new FakeTrack('video'));
  initRemoteTrack(remote);
  const log = recordMutes([remote]);

  markTrackEnded(remote);
  setTrackMuted(remote, false);
  assert.equal(remote.muted, true);
  setTrackMuted(remote, false);
  await nextTask();

  assert.deepEqual(log, []);
  assert.equal(remote.readyState, 'ended');
});

test('a track whose end is queued can still mute before it ends', () => {
  const remote = trackFromNative(new FakeTrack('audio'));
  initRemoteTrack(remote);
  setTrackMuted(remote, false);
  const log = recordMutes([remote]);

  markTrackEnded(remote);
  setTrackMuted(remote, true);

  assert.deepEqual(log, ['mute 0 true']);
});

test('a source-end callback that throws is reported without skipping the others or the family', async (t) => {
  const remote = trackFromNative(new FakeTrack('audio'));
  const clone = remote.clone();
  const ran: string[] = [];
  whenEnded(remote, () => {
    throw new Error('boom');
  });
  whenEnded(remote, () => ran.push('remote'));
  whenEnded(clone, () => ran.push('clone'));
  const reported = new Promise<unknown>((resolve) => {
    const listeners = process.rawListeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    process.once('uncaughtException', (error) => {
      for (const listener of listeners) process.on('uncaughtException', listener as never);
      resolve(error);
    });
  });
  t.after(() => process.removeAllListeners('uncaughtException'));
  markTrackEnded(remote);
  await nextTask();
  assert.deepEqual(ran, ['remote', 'clone']);
  assert.equal(clone.readyState, 'ended');
  assert.equal(((await reported) as Error).message, 'boom');
});

test('whenEnded runs on stop() or a source end, once, and at once for an ended track', async () => {
  const stopped = trackFromNative(new FakeTrack('video'));
  const remote = trackFromNative(new FakeTrack('video'));
  const ran: string[] = [];
  whenEnded(stopped, () => ran.push('stopped'));
  const cancel = whenEnded(remote, () => ran.push('cancelled'));
  whenEnded(remote, () => ran.push('remote'));
  cancel();
  stopped.stop();
  stopped.stop();
  assert.deepEqual(ran, ['stopped'], 'synchronously, once');
  markTrackEnded(remote);
  await nextTask();
  assert.deepEqual(ran, ['stopped', 'remote']);
  whenEnded(remote, () => ran.push('late'));
  assert.deepEqual(ran, ['stopped', 'remote', 'late']);
});

test('contentHint accepts only the hints defined for the track kind', () => {
  const audio = trackFromNative(new FakeTrack('audio'));
  const video = trackFromNative(new FakeTrack('video'));
  const set = (track: MediaStreamTrack, hint: string) => {
    track.contentHint = hint;
    return track.contentHint;
  };
  assert.deepEqual(
    ['speech', 'speech-recognition', 'music', 'motion', ''].map((hint) => set(audio, hint)),
    ['speech', 'speech-recognition', 'music', 'music', ''],
  );
  assert.deepEqual(
    ['motion', 'detail', 'text', 'speech', ''].map((hint) => set(video, hint)),
    ['motion', 'detail', 'text', 'text', ''],
  );
});

test('clone() of a received track is a new track of the same kind', (t) => {
  const pc = new native.PeerConnection({}, () => {});
  t.after(() => pc.close());
  for (const kind of ['audio', 'video'] as const) {
    const track = trackFromNative(pc.addTransceiver(kind).receiver.track);
    track.enabled = false;
    const clone = track.clone();
    assert.notEqual(clone, track);
    assert.notEqual(clone.id, track.id);
    assert.equal(clone.kind, kind);
    assert.equal(clone.enabled, false);
    assert.equal(clone.readyState, 'live');
  }
});

test('MediaStreamTrack is a registered WebIDL interface with a real brand check', () => {
  const convert = interfaceType('MediaStreamTrack');
  assert.doesNotThrow(() => convert(new RTCAudioSource().createTrack(), 'track'));
  assert.throws(() => convert(Object.create(MediaStreamTrack.prototype), 'track'), {
    name: 'TypeError',
    message: 'track: is not a MediaStreamTrack',
  });
});
