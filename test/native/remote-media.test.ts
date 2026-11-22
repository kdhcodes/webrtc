// The milestone 1 media path through real libwebrtc, at the native layer:
// pushed audio/video -> sender -> loopback ICE/DTLS/SRTP -> receiver ->
// sinks on the remote tracks. This exercises WP-M (sources, sinks, playout
// ADM) and WP-R (addTrack, track events, receivers) together.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { native } from '../../lib/internal/native.ts';
import type {
  NativeAudioData,
  NativeSink,
  NativeTrack,
  NativeVideoFrame,
} from '../../lib/internal/native-types.ts';
import { connect, Peer } from './pc-harness.ts';

const WIDTH = 320;
const HEIGHT = 240;
// The size of frames pushed once the sinks under test are stopped. The
// source never adapts resolution, so a receiver only sees this size after
// the sender switched to it.
const LATE_WIDTH = 352;
const LATE_HEIGHT = 288;

// Node's TSFN dispatch drains every queued item in one uv callback, and uv
// runs all signalled async handles in one pass, so after a witness sink has
// seen an event and the check phase has run, every other sink's queue that
// was signalled before it has been drained too.
const afterDrain = () => new Promise((resolve) => setImmediate(resolve));

/** Resolves once `count` items match `pred`; a timeout is only a failure guard. */
function waitForItems<T>(
  items: T[],
  count: number,
  pred: (item: T) => boolean,
  what: string,
): { push: (item: T) => void; done: Promise<void> } {
  let resolve!: () => void;
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((res, rej) => {
    resolve = res;
    timer = setTimeout(() => {
      const matching = items.filter(pred).length;
      rej(new Error(`expected ${count} ${what}, got ${matching} (of ${items.length})`));
    }, 15_000);
  });
  return {
    push: (item: T) => {
      items.push(item);
      if (items.filter(pred).length >= count) {
        clearTimeout(timer);
        resolve();
      }
    },
    done,
  };
}

/** 10 ms of a 440 Hz tone at 48 kHz mono: what the sender pushes. */
function tone(tick: number): Int16Array {
  const samples = new Int16Array(480);
  for (let i = 0; i < samples.length; i++) {
    const t = (tick * 480 + i) / 48_000;
    samples[i] = Math.round(8000 * Math.sin(2 * Math.PI * 440 * t));
  }
  return samples;
}

/** A mid-grey I420 frame. */
function greyFrame(width: number, height: number): Uint8Array {
  const chroma = ((width + 1) >> 1) * ((height + 1) >> 1);
  return new Uint8Array(width * height + 2 * chroma).fill(128);
}

/** Decoded tone, not silence. */
const audible = (d: NativeAudioData) => d.samples.some((s) => Math.abs(s) > 1000);

interface Call {
  b: Peer;
  audioTrack: NativeTrack;
  videoTrack: NativeTrack;
  audioSenderTrack: NativeTrack | null;
  videoSenderTrack: NativeTrack | null;
  remoteAudio: NativeTrack;
  remoteVideo: NativeTrack;
  /** From now on, push LATE_WIDTH x LATE_HEIGHT frames. */
  pushLateFrames(): void;
}

/**
 * Two connected peers, A sending B a pushed tone and grey frames (rotation
 * 90) on the media clock a real application would use: 10 ms of audio every
 * 10 ms and a frame every ~33 ms. Closed and stopped after the test.
 */
async function call(t: TestContext): Promise<Call> {
  const a = new Peer(t);
  const b = new Peer(t);

  const audioSource = new native.AudioSource();
  const videoSource = new native.VideoSource({ isScreencast: false, needsDenoising: null });
  const audioTrack = audioSource.createTrack();
  const videoTrack = videoSource.createTrack();
  const audio = a.pc.addTrack(audioTrack, ['stream']);
  const video = a.pc.addTrack(videoTrack, ['stream']);

  await connect(a, b);

  const remote = new Map<string, NativeTrack>();
  for (const ev of b.of('track')) remote.set(ev.receiver.track.kind, ev.receiver.track);
  const remoteAudio = remote.get('audio');
  const remoteVideo = remote.get('video');
  assert.ok(remoteAudio && remoteVideo, 'B got an audio and a video track');

  let tick = 0;
  let frame = { width: WIDTH, height: HEIGHT, data: greyFrame(WIDTH, HEIGHT) };
  const pump = setInterval(() => {
    audioSource.pushData({
      samples: tone(tick),
      sampleRate: 48_000,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: 480,
    });
    if (tick % 3 === 0) videoSource.pushFrame({ ...frame, rotation: 90 });
    tick++;
  }, 10);
  t.after(() => clearInterval(pump));

  return {
    b,
    audioTrack,
    videoTrack,
    audioSenderTrack: audio.sender.track,
    videoSenderTrack: video.sender.track,
    remoteAudio,
    remoteVideo,
    pushLateFrames: () => {
      frame = { width: LATE_WIDTH, height: LATE_HEIGHT, data: greyFrame(LATE_WIDTH, LATE_HEIGHT) };
    },
  };
}

test('audio and video from pushed sources reach sinks on the remote tracks', async (t) => {
  const c = await call(t);
  assert.equal(c.audioSenderTrack, c.audioTrack, 'sender.track keeps the source track identity');
  assert.equal(c.videoSenderTrack, c.videoTrack);
  const trackEvents = c.b.of('track');
  assert.equal(trackEvents.length, 2);
  for (const ev of trackEvents) {
    assert.deepEqual(ev.streamIds, ['stream']);
    assert.equal(ev.receiver.track, ev.receiver.track, 'receiver.track is stable');
  }

  const audioEvents: NativeAudioData[] = [];
  const videoFrames: NativeVideoFrame[] = [];
  const audioWait = waitForItems(audioEvents, 10, audible, 'audible remote audio events');
  const videoWait = waitForItems(
    videoFrames,
    3,
    (f) => f.width === WIDTH && f.height === HEIGHT,
    `${WIDTH}x${HEIGHT} remote frames`,
  );
  const sinks: NativeSink[] = [
    new native.AudioSink(c.remoteAudio, audioWait.push),
    new native.VideoSink(c.remoteVideo, videoWait.push),
  ];
  t.after(() => {
    for (const sink of sinks) sink.stop();
  });

  await Promise.all([audioWait.done, videoWait.done]);

  const heard = audioEvents.find(audible);
  assert.ok(heard);
  // Remote audio comes out of the mixer at the playout device's format, not
  // the format the sender pushed (SPEC-LAYER-PLAN.md compatibility spec).
  assert.equal(heard.sampleRate, 48_000);
  assert.equal(heard.numberOfFrames, 480);
  assert.equal(heard.bitsPerSample, 16);
  assert.equal(heard.samples.length, heard.numberOfFrames * heard.channelCount);

  const received = videoFrames.find((f) => f.width === WIDTH);
  assert.ok(received);
  assert.equal(received.rotation, 90, 'rotation arrives as metadata (CVO)');
  assert.equal(received.data.length, greyFrame(WIDTH, HEIGHT).length);

  // Stopping sinks while media is still flowing must not deadlock, and
  // nothing is delivered afterwards. A witness sink that stays attached
  // waits for a frame that is only pushed after stop(); once it has it and
  // the check phase has run, anything the stopped sinks had queued has been
  // dispatched (and dropped).
  const witnessFrames: NativeVideoFrame[] = [];
  const witnessWait = waitForItems(
    witnessFrames,
    1,
    (f) => f.width === LATE_WIDTH,
    `${LATE_WIDTH}x${LATE_HEIGHT} witness frames pushed after stop()`,
  );
  const witness = new native.VideoSink(c.remoteVideo, witnessWait.push);
  t.after(() => witness.stop());
  for (const sink of sinks) sink.stop();
  const audioCount = audioEvents.length;
  const videoCount = videoFrames.length;
  c.pushLateFrames();
  await witnessWait.done;
  await afterDrain();
  assert.equal(audioEvents.length, audioCount, 'no audio after stop()');
  assert.equal(videoFrames.length, videoCount, 'no video after stop()');
});

test("receivers' getSources() report the sender's SSRC, its RTP clock and audio level", async (t) => {
  const c = await call(t);
  const receivers = new Map(c.b.of('track').map((ev) => [ev.receiver.track.kind, ev.receiver]));
  const audio = receivers.get('audio');
  const video = receivers.get('video');
  assert.ok(audio && video);

  const frames: NativeVideoFrame[] = [];
  let waiter = waitForItems(frames, 3, () => true, 'remote frames');
  const sink = new native.VideoSink(c.remoteVideo, (frame) => waiter.push(frame));
  t.after(() => sink.stop());
  await waiter.done;
  const read = () => ({ at: performance.now(), sources: video.getSources() });
  const before = read();
  // About half a second of frames at ~30 fps.
  waiter = waitForItems(frames, frames.length + 15, () => true, 'more remote frames');
  await waiter.done;
  const after = read();

  const [s1] = before.sources;
  const [s2] = after.sources;
  assert.ok(s1 && s2 && before.sources.length === 1 && after.sources.length === 1);
  assert.equal(s1.type, 'ssrc');
  assert.equal(s2.source, s1.source);
  assert.equal(s1.audioLevel, undefined, 'no audio level on video');
  const elapsed = after.at - s2.age - (before.at - s1.age);
  const rate = (((s2.rtpTimestamp - s1.rtpTimestamp) >>> 0) / elapsed) * 1000;
  assert.ok(Math.abs(rate - 90_000) < 15_000, `video RTP clock ${rate} Hz over ${elapsed} ms`);

  const [heard] = audio.getSources();
  assert.ok(heard);
  assert.equal(heard.type, 'ssrc');
  assert.notEqual(heard.source, s1.source);
  // The tone peaks at 8000 of 32767: about -15 dBov on average.
  assert.ok(heard.audioLevel !== undefined && heard.audioLevel > 5 && heard.audioLevel < 30);
});

test('a clone of a remote track gets the remote media', async (t) => {
  const c = await call(t);
  const audioClone = c.remoteAudio.clone();
  const videoClone = c.remoteVideo.clone();
  assert.notEqual(audioClone.id, c.remoteAudio.id);
  assert.notEqual(videoClone.id, c.remoteVideo.id);

  const audioEvents: NativeAudioData[] = [];
  const videoFrames: NativeVideoFrame[] = [];
  const audioWait = waitForItems(audioEvents, 10, audible, 'audible audio events on the clone');
  const videoWait = waitForItems(
    videoFrames,
    3,
    (f) => f.width === WIDTH && f.height === HEIGHT && f.rotation === 90,
    `${WIDTH}x${HEIGHT} frames on the clone`,
  );
  const audioSink = new native.AudioSink(audioClone, audioWait.push);
  t.after(() => audioSink.stop());
  const videoSink = new native.VideoSink(videoClone, videoWait.push);
  t.after(() => videoSink.stop());

  await Promise.all([audioWait.done, videoWait.done]);
});

// Remote frames are copied once, on the JS thread, from the decoder's own
// (pooled) buffer: each sink's frame must still be its own copy.
test('two sinks on a remote video track get independent frames', async (t) => {
  const c = await call(t);
  const first: NativeVideoFrame[] = [];
  const second: NativeVideoFrame[] = [];
  const full = (f: NativeVideoFrame) => f.width === WIDTH && f.height === HEIGHT;
  const firstWait = waitForItems(first, 2, full, 'frames on the first sink');
  const secondWait = waitForItems(second, 2, full, 'frames on the second sink');
  const sinks = [
    new native.VideoSink(c.remoteVideo, firstWait.push),
    new native.VideoSink(c.remoteVideo, secondWait.push),
  ];
  t.after(() => {
    for (const sink of sinks) sink.stop();
  });
  await Promise.all([firstWait.done, secondWait.done]);

  const [a0, a1] = first.filter(full);
  const b = second.filter(full);
  assert.ok(a0 && a1);
  assert.equal(Object.getPrototypeOf(a0.data), Uint8Array.prototype);
  assert.equal(a0.data.byteOffset, 0);
  assert.equal(a0.data.buffer.byteLength, a0.data.byteLength);
  assert.notEqual(a0.data.buffer, a1.data.buffer);
  for (const f of b) assert.notEqual(f.data.buffer, a0.data.buffer);
  const before = b.map((f) => f.data.slice());
  a0.data.fill(1);
  // Buffer.compare, not deepEqual: a deepEqual diff of mismatching frames
  // takes gigabytes.
  const changed = b.findIndex(
    (f, i) => Buffer.compare(f.data, before[i] ?? new Uint8Array()) !== 0,
  );
  assert.equal(changed, -1, `one sink's writes reached the other sink's frame ${changed}`);
});
