import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertEventAttributes } from './internal/testing/event-attributes.ts';
import { FakeTrack } from './internal/testing/fake-native.ts';
import {
  addRemoteTrack,
  MediaStream,
  MediaStreamEvent,
  MediaStreamTrackEvent,
  removeRemoteTrack,
} from './MediaStream.ts';
import { trackFromNative } from './MediaStreamTrack.ts';

const audio = () => trackFromNative(new FakeTrack('audio'));
const video = () => trackFromNative(new FakeTrack('video'));

test('constructors: empty, from a stream, from tracks, and wrtc {id}', () => {
  const a = audio();
  const v = video();
  const empty = new MediaStream();
  assert.match(empty.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(empty.getTracks(), []);

  const fromTracks = new MediaStream([v, a, a]);
  assert.deepEqual(fromTracks.getTracks(), [a, v], 'deduplicated, audio first');
  const fromStream = new MediaStream(fromTracks);
  assert.notEqual(fromStream.id, fromTracks.id);
  assert.deepEqual(fromStream.getTracks(), [a, v]);

  assert.equal(new MediaStream({ id: 'wrtc-id' }).id, 'wrtc-id');
  assert.throws(() => new MediaStream([{}] as never), { name: 'TypeError' });
});

test('track accessors and active', () => {
  const a = audio();
  const v = video();
  const stream = new MediaStream([a, v]);
  assert.deepEqual(stream.getAudioTracks(), [a]);
  assert.deepEqual(stream.getVideoTracks(), [v]);
  assert.equal(stream.getTrackById(v.id), v);
  assert.equal(stream.getTrackById('nope'), null);
  assert.equal(stream.active, true);
  a.stop();
  v.stop();
  assert.equal(stream.active, false);
});

test('addTrack/removeTrack by the application fire no events', () => {
  const stream = new MediaStream();
  const a = audio();
  let events = 0;
  stream.onaddtrack = () => events++;
  stream.onremovetrack = () => events++;
  stream.addTrack(a);
  stream.addTrack(a);
  assert.deepEqual(stream.getTracks(), [a]);
  stream.removeTrack(a);
  assert.deepEqual(stream.getTracks(), []);
  assert.equal(events, 0);
});

test('remote membership changes fire addtrack/removetrack with the track, once', () => {
  const stream = new MediaStream();
  const a = audio();
  const log: string[] = [];
  stream.addEventListener('addtrack', (e) =>
    log.push(`add ${(e as MediaStreamTrackEvent).track === a}`),
  );
  stream.onremovetrack = (e) => log.push(`remove ${e.track === a}`);
  addRemoteTrack(stream, a);
  addRemoteTrack(stream, a);
  removeRemoteTrack(stream, a);
  removeRemoteTrack(stream, a);
  assert.deepEqual(log, ['add true', 'remove true']);
});

test('the legacy addstream event exposes its stream as an enumerable prototype getter', () => {
  const stream = new MediaStream();
  const event = new MediaStreamEvent('addstream', stream);
  assertEventAttributes(event, { stream });
  assert.equal(
    Object.getOwnPropertyDescriptor(MediaStreamEvent.prototype, 'stream')?.enumerable,
    true,
  );
});

test('MediaStreamTrackEvent needs a track and exposes it as a prototype getter', () => {
  const track = audio();
  assertEventAttributes(new MediaStreamTrackEvent('addtrack', { track }), { track });
  assert.throws(() => new MediaStreamTrackEvent('addtrack', { track: {} } as never), {
    name: 'TypeError',
    message: /is not a MediaStreamTrack/,
  });
});

test('clone() has a new id and clones of every track', () => {
  const a = audio();
  const stream = new MediaStream([a]);
  const clone = stream.clone();
  assert.notEqual(clone.id, stream.id);
  const [cloned] = clone.getTracks();
  assert.ok(cloned && cloned !== a);
  assert.equal(cloned.kind, 'audio');
});
