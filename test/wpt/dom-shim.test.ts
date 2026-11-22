// Tests of the WPT DOM shim (test/wpt/dom-shim.ts): colour conversion, the
// 2D canvas, and media elements and canvas capture over the real addon
// (local tracks, and one peer connection round trip).
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import * as lib from '../../lib/index.ts';
import { connect, next, pair, WAIT_MS } from '../integration/harness.ts';
import * as dom from './dom-shim.ts';
import {
  type I420Frame,
  type Implementation,
  i420ToRgba,
  parseColor,
  rgbaToI420,
} from './dom-shim.ts';

dom.useImplementation(lib as unknown as Implementation);
const { nonstandard } = lib;

/** A w x h I420 frame of one grey `level` (0-255 as RGB, BT.601 limited luma). */
function greyI420(width: number, height: number, level: number): I420Frame {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([level, level, level, 255], i);
  return rgbaToI420(rgba, width, height);
}

/** A canvas of the given size and its 2D context. */
function canvas(width: number, height: number) {
  const element = new dom.HTMLCanvasElement();
  element.width = width;
  element.height = height;
  const context = element.getContext('2d');
  assert.ok(context);
  return { element, context };
}

/** The RGB of one pixel of a canvas. */
function pixel(context: InstanceType<typeof dom.CanvasRenderingContext2D>, x: number, y: number) {
  return [...context.getImageData(x, y, 1, 1).data.subarray(0, 3)];
}

/**
 * A local video track whose source pushes `frame()` every 30 ms until the
 * test ends; the track is stopped then.
 */
function pushedVideo(t: TestContext, frame: () => I420Frame) {
  const source = new nonstandard.RTCVideoSource();
  const track = source.createTrack();
  const pump = setInterval(() => source.onFrame(frame()), 30);
  t.after(() => {
    clearInterval(pump);
    track.stop();
  });
  return track;
}

/** A video element playing `tracks`, emptied after the test. */
function videoOf(t: TestContext, tracks: lib.MediaStreamTrack[]) {
  const video = new dom.HTMLVideoElement();
  video.srcObject = new lib.MediaStream(tracks) as never;
  t.after(() => {
    video.srcObject = null;
  });
  return video;
}

/** Resolves on `promise`, or rejects after WAIT_MS. */
function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

test('RGBA to I420 matches libyuv (BT.601 limited range) for the primaries', () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  const yuv = (r: number, g: number, b: number) => {
    const { data } = rgbaToI420(new Uint8ClampedArray([r, g, b, 255]), 1, 1);
    return [...data];
  };
  assert.deepEqual(yuv(255, 0, 0), [82, 90, 240]);
  assert.deepEqual(yuv(0, 255, 0), [144, 54, 34]);
  assert.deepEqual(yuv(0, 0, 255), [41, 240, 110]);
  assert.deepEqual(yuv(0, 0, 0), [16, 128, 128]);
  assert.deepEqual(yuv(255, 255, 255), [235, 128, 128]);
  // Three pixels in a row: one chroma sample per 2x2 block, so 2 for width 3.
  assert.equal(rgbaToI420(rgba, 3, 1).data.length, 3 + 2 * 2);
});

test('a grey level survives RGBA -> I420 -> RGBA within 1', () => {
  for (let level = 0; level <= 255; level++) {
    const back = i420ToRgba(greyI420(2, 2, level));
    for (let i = 0; i < back.length; i += 4) {
      assert.ok(Math.abs((back[i] as number) - level) <= 1, `level ${level}: got ${back[i]}`);
      assert.equal(back[i], back[i + 1]);
      assert.equal(back[i], back[i + 2]);
      assert.equal(back[i + 3], 255);
    }
  }
});

test('I420 to RGBA recovers saturated colours and handles odd sizes', () => {
  const rgba = new Uint8ClampedArray(3 * 3 * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([255, 0, 0, 255], i);
  const back = i420ToRgba(rgbaToI420(rgba, 3, 3));
  assert.equal(back.length, 3 * 3 * 4);
  for (let i = 0; i < back.length; i += 4) {
    const [r, g, b] = back.subarray(i, i + 3);
    assert.ok((r as number) >= 252 && (g as number) <= 3 && (b as number) <= 3, `${r},${g},${b}`);
  }
});

test('parseColor reads rgb(), rgba(), hex and names, and rejects the rest', () => {
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3, 255]);
  assert.deepEqual(parseColor('rgba(10,20,30,0.5)'), [10, 20, 30, 128]);
  assert.deepEqual(parseColor('#0a0b0c'), [10, 11, 12, 255]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 255]);
  assert.deepEqual(parseColor('#00000080'), [0, 0, 0, 128]);
  assert.deepEqual(parseColor('Blue'), [0, 0, 255, 255]);
  assert.equal(parseColor('#12345'), null);
  assert.equal(parseColor('hsl(0, 0%, 0%)'), null);
  assert.equal(parseColor('rgb(1, 2)'), null);
});

test('the 2D context fills, reads, writes and scales pixels, and resizing clears', () => {
  const { element, context } = canvas(4, 4);
  assert.deepEqual([...context.getImageData(0, 0, 1, 1).data], [0, 0, 0, 0]);
  context.fillStyle = 'rgb(10, 20, 30)';
  assert.equal(context.fillStyle, '#0a141e');
  context.fillStyle = 'not a colour';
  assert.equal(context.fillStyle, '#0a141e', 'an invalid colour is ignored');
  context.fillRect(1, 1, 2, 2);
  assert.deepEqual(pixel(context, 0, 0), [0, 0, 0]);
  assert.deepEqual(pixel(context, 1, 1), [10, 20, 30]);
  assert.deepEqual(pixel(context, 3, 3), [0, 0, 0]);

  const image = new dom.ImageData(1, 1);
  image.data.set([200, 100, 50, 255]);
  context.putImageData(image, 3, 0);
  assert.deepEqual(pixel(context, 3, 0), [200, 100, 50]);

  const big = canvas(8, 8);
  big.context.drawImage(element, 0, 0, 8, 8);
  assert.deepEqual(pixel(big.context, 2, 2), [10, 20, 30], 'scaled 2x');
  assert.deepEqual(pixel(big.context, 6, 0), [200, 100, 50]);

  context.fillRect(0, 0, 4, 4);
  element.width = 2;
  assert.deepEqual([...context.getImageData(0, 0, 1, 1).data], [0, 0, 0, 0]);
  assert.equal(element.getContext('webgl'), null);
});

test('a video element gets metadata, size and pixels from its track, and plays', async (t) => {
  const track = pushedVideo(t, () => greyI420(64, 48, 100));
  const video = videoOf(t, [track]);
  assert.equal(video.readyState, video.HAVE_NOTHING);
  assert.equal(video.videoWidth, 0);
  assert.equal(video.currentTime, 0);

  await next(video, 'loadedmetadata');
  assert.equal(video.videoWidth, 64);
  assert.equal(video.videoHeight, 48);
  assert.equal(video.readyState, video.HAVE_ENOUGH_DATA);
  assert.equal(video.paused, true, 'no autoplay, no play()');

  const { context } = canvas(60, 60);
  context.drawImage(video, 0, 0);
  const [r, g, b] = pixel(context, 40, 40) as [number, number, number];
  assert.ok(Math.abs(r - 100) <= 1 && r === g && g === b, `${r},${g},${b}`);
  assert.deepEqual(pixel(context, 59, 59), [0, 0, 0], 'outside the 64x48 frame: untouched');

  const playing = next(video, 'playing');
  await within(video.play(), 'play()');
  await playing;
  assert.equal(video.paused, false);
  await next(video, 'timeupdate');
  assert.ok(video.currentTime > 0 && video.currentTime < 1, `currentTime ${video.currentTime}`);
});

test('autoplay starts playing at the first frame; frames then update size, callbacks and quality', async (t) => {
  let size = [32, 16];
  const track = pushedVideo(t, () => greyI420(size[0] as number, size[1] as number, 50));
  const video = videoOf(t, [track]);
  video.autoplay = true;
  assert.equal(video.getAttribute('autoplay'), '');
  await next(video, 'playing');

  const [now, metadata] = await within(
    new Promise<[number, Record<string, number>]>((resolve) =>
      video.requestVideoFrameCallback((time, data) => resolve([time, data])),
    ),
    'a video frame callback',
  );
  assert.equal(typeof now, 'number');
  assert.equal(metadata.width, 32);
  assert.ok((metadata.presentedFrames as number) >= 1);
  assert.ok(video.getVideoPlaybackQuality().totalVideoFrames >= 1);

  size = [40, 20];
  await next(video, 'resize');
  assert.deepEqual([video.videoWidth, video.videoHeight], [40, 20]);

  // Paused, the element keeps its last frame: no more resizes.
  video.pause();
  assert.equal(video.paused, true);
  size = [48, 24];
  const frames = video.getVideoPlaybackQuality().totalVideoFrames;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(video.getVideoPlaybackQuality().totalVideoFrames, frames);
  assert.deepEqual([video.videoWidth, video.videoHeight], [40, 20]);
});

test('with audio and video, a video element waits for the first frame for its metadata', async (t) => {
  const audioSource = new nonstandard.RTCAudioSource();
  const audio = audioSource.createTrack();
  const pump = setInterval(
    () => audioSource.onData({ samples: new Int16Array(480), sampleRate: 48_000 }),
    10,
  );
  t.after(() => {
    clearInterval(pump);
    audio.stop();
  });
  const videoSource = new nonstandard.RTCVideoSource();
  const video = videoSource.createTrack();
  t.after(() => video.stop());
  const element = videoOf(t, [audio, video]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(element.readyState, element.HAVE_NOTHING, 'audio alone: no metadata');
  const metadata = next(element, 'loadedmetadata');
  videoSource.onFrame(greyI420(16, 8, 0));
  await metadata;
  assert.deepEqual([element.videoWidth, element.videoHeight], [16, 8]);
});

test('setting srcObject again rejects a pending play() and drops frame callbacks', async (t) => {
  const video = new dom.HTMLVideoElement();
  t.after(() => {
    video.srcObject = null;
  });
  const source = new nonstandard.RTCVideoSource();
  const track = source.createTrack();
  t.after(() => track.stop());
  video.srcObject = new lib.MediaStream([track]) as never;
  const played = video.play();
  let staleCallback = false;
  video.requestVideoFrameCallback(() => {
    staleCallback = true;
  });
  video.srcObject = null;
  await assert.rejects(played, { name: 'AbortError' });
  assert.equal(video.readyState, video.HAVE_NOTHING);

  // Frames of the next source run only the callbacks asked for after it.
  video.srcObject = new lib.MediaStream([pushedVideo(t, () => greyI420(16, 8, 0))]) as never;
  video.autoplay = true;
  await next(video, 'playing');
  await within(
    new Promise((resolve) => video.requestVideoFrameCallback(resolve)),
    'a video frame callback',
  );
  assert.equal(staleCallback, false);
});

test('an audio element plays an audio track once samples arrive', async (t) => {
  const source = new nonstandard.RTCAudioSource();
  const track = source.createTrack();
  const pump = setInterval(
    () => source.onData({ samples: new Int16Array(480), sampleRate: 48_000 }),
    10,
  );
  t.after(() => {
    clearInterval(pump);
    track.stop();
  });
  const audio = new dom.HTMLAudioElement();
  audio.srcObject = new lib.MediaStream() as never;
  t.after(() => {
    audio.srcObject = null;
  });
  const play = audio.play();
  // A track the page adds to the stream later is picked up too.
  (audio.srcObject as unknown as lib.MediaStream).addTrack(track);
  await within(play, 'play()');
  assert.equal(audio.readyState, audio.HAVE_ENOUGH_DATA);
});

test('canvas.captureStream() sends a frame of the canvas after each painting task', async (t) => {
  const { element, context } = canvas(64, 32);
  const [track] = element.captureStream().getTracks() as unknown as lib.MediaStreamTrack[];
  assert.ok(track);
  t.after(() => track.stop());
  const sink = new nonstandard.RTCVideoSink(track);
  t.after(() => sink.stop());

  const frame = next<Event & { frame: I420Frame }>(sink, 'frame');
  context.fillStyle = 'rgb(200, 200, 200)';
  context.fillRect(0, 0, 64, 32);
  context.fillStyle = 'black';
  context.fillRect(0, 0, 8, 8);
  const { frame: received } = await frame;
  assert.deepEqual([received.width, received.height], [64, 32]);
  // One frame for both fillRects: its luma shows both.
  assert.equal(received.data[0], 16);
  assert.equal(received.data[64 * 31 + 63], ((220 * 200 + 128) >> 8) + 16);
});

test('a canvas sent over a peer connection is decoded into a video element', async (t) => {
  const { element, context } = canvas(160, 120);
  const level = (n: number) => {
    context.fillStyle = `rgb(${n}, ${n}, ${n})`;
    context.fillRect(0, 0, 160, 120);
  };
  level(30);
  const paint = setInterval(() => level(30), 33);
  t.after(() => clearInterval(paint));
  const [track] = element.captureStream().getTracks() as unknown as lib.MediaStreamTrack[];
  assert.ok(track);
  t.after(() => track.stop());

  const pcs = pair(t);
  pcs.a.addTrack(track);
  const remote = next<lib.RTCTrackEvent>(pcs.b, 'track');
  await connect(pcs);
  const video = videoOf(t, [(await remote).track]);
  video.autoplay = true;
  await next(video, 'playing');
  assert.deepEqual([video.videoWidth, video.videoHeight], [160, 120]);

  const probe = canvas(160, 120);
  const sample = () => {
    probe.context.drawImage(video, 0, 0);
    return pixel(probe.context, 80, 60)[0] as number;
  };
  assert.ok(Math.abs(sample() - 30) <= 3, `decoded ${sample()}`);
  // A change on the sending canvas shows up after decoding.
  clearInterval(paint);
  const brighter = setInterval(() => level(220), 33);
  t.after(() => clearInterval(brighter));
  await within(
    new Promise<void>((resolve) => {
      const check = () => {
        if (Math.abs(sample() - 220) <= 3) resolve();
        else video.requestVideoFrameCallback(check);
      };
      check();
    }),
    'the new level',
  );
});
