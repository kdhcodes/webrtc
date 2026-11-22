// Local source -> track -> sink loopback through real libwebrtc, with no
// peer connection: exact payloads, stop() semantics and env teardown.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { native } from '../../lib/internal/native.ts';
import type { NativeAudioData, NativeVideoFrame } from '../../lib/internal/native-types.ts';

const addonPath = createRequire(import.meta.url).resolve('../../build/Release/wrtc.node');

/** Collects callback payloads; `next(n)` resolves once n have arrived. */
function collector<T>() {
  const items: T[] = [];
  let waiting: { count: number; resolve: () => void } | undefined;
  return {
    items,
    callback: (item: T) => {
      items.push(item);
      if (waiting && items.length >= waiting.count) waiting.resolve();
    },
    next(count: number): Promise<void> {
      if (items.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        // Failure guard only.
        const timer = setTimeout(
          () => reject(new Error(`expected ${count} events, got ${items.length}`)),
          5000,
        );
        waiting = {
          count,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        };
      });
    },
  };
}

// Node's TSFN dispatch drains every queued item in one uv callback, and uv
// runs all signalled async handles in one pass, so after a witness sink has
// seen an event and the check phase has run, every other sink's queue that
// was signalled at the same time has been drained too.
const afterDrain = () => new Promise((resolve) => setImmediate(resolve));

function pcm(length: number): Int16Array {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i++) samples[i] = ((i * 7919) % 65536) - 32768;
  return samples;
}

function i420(width: number, height: number): Uint8Array {
  const size = width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
  return data;
}

function audioData(sampleRate: number, channelCount: number): NativeAudioData {
  const numberOfFrames = sampleRate / 100;
  return {
    samples: pcm(numberOfFrames * channelCount),
    sampleRate,
    bitsPerSample: 16,
    channelCount,
    numberOfFrames,
  };
}

for (const sampleRate of [8000, 16000, 48000]) {
  for (const channelCount of [1, 2]) {
    test(`audio ${sampleRate} Hz, ${channelCount} channel(s) arrives exactly as pushed`, async (t) => {
      const source = new native.AudioSource();
      const events = collector<NativeAudioData>();
      const sink = new native.AudioSink(source.createTrack(), events.callback);
      t.after(() => sink.stop());

      const data = audioData(sampleRate, channelCount);
      source.pushData(data);
      await events.next(1);

      assert.deepEqual(events.items, [data]);
      assert.notEqual(events.items[0]?.samples.buffer, data.samples.buffer, 'a fresh buffer');
    });
  }
}

for (const rotation of [0, 90, 180, 270] as const) {
  test(`a 321x241 frame with rotation ${rotation} arrives unrotated with its rotation`, async (t) => {
    const source = new native.VideoSource({ isScreencast: false, needsDenoising: null });
    const frames = collector<NativeVideoFrame>();
    const sink = new native.VideoSink(source.createTrack(), frames.callback);
    t.after(() => sink.stop());

    const frame = { width: 321, height: 241, data: i420(321, 241), rotation };
    source.pushFrame(frame);
    await frames.next(1);

    assert.equal(frames.items.length, 1);
    const [received] = frames.items;
    const { data: receivedData, ...receivedMeta } = received ?? assert.fail('no frame');
    const { data: pushedData, ...pushedMeta } = frame;
    assert.deepEqual(receivedMeta, pushedMeta);
    assert.equal(firstMismatch(receivedData, pushedData), -1, 'frame data matches what was pushed');
  });
}

/** A plain typed array that owns its whole, exactly sized, ArrayBuffer. */
function assertOwnBuffer(array: Uint8Array | Int16Array, proto: object, what: string) {
  assert.equal(Object.getPrototypeOf(array), proto, `${what} is a plain typed array`);
  assert.equal(array.byteOffset, 0, `${what} byteOffset`);
  assert.equal(array.buffer.byteLength, array.byteLength, `${what} owns its whole buffer`);
}

/**
 * The first index where `actual` differs from `expected` (or from the
 * single byte `expected`), or -1. Frames are compared this way rather than
 * with assert.deepEqual, whose diff of a mismatching frame takes gigabytes.
 */
function firstMismatch(actual: Uint8Array, expected: Uint8Array | number): number {
  if (typeof expected !== 'number') {
    if (actual.length !== expected.length) return Math.min(actual.length, expected.length);
    if (Buffer.compare(actual, expected) === 0) return -1;
  }
  for (let i = 0; i < actual.length; i++) {
    const want = typeof expected === 'number' ? expected : expected[i];
    if (actual[i] !== want) return i;
  }
  return -1;
}

// Sinks hold libwebrtc's frame buffer and copy it on the JS thread, into an
// uninitialised ArrayBuffer. Every frame must be its own copy of what was
// pushed, independent of the source's data, other frames and other sinks.
// Three frames (all a sink queues, media_sink.cc kMaxQueuedFrames) are
// pushed in one go, so all three are held while the source's data changes.
test('every video frame is an independent copy of what was pushed', async (t) => {
  const source = new native.VideoSource({ isScreencast: false, needsDenoising: null });
  const track = source.createTrack();
  const first = collector<NativeVideoFrame>();
  const second = collector<NativeVideoFrame>();
  const sinks = [
    new native.VideoSink(track, first.callback),
    new native.VideoSink(track, second.callback),
  ];
  t.after(() => {
    for (const sink of sinks) sink.stop();
  });

  const data = i420(320, 240);
  const expected = data.slice();
  source.pushFrame({ width: 320, height: 240, data, rotation: 0 });
  // Overwritten before any sink's frame reaches JS.
  const fills = [0x11, 0x22];
  for (const fill of fills) {
    data.fill(fill);
    source.pushFrame({ width: 320, height: 240, data, rotation: 0 });
  }
  data.fill(0);
  await Promise.all([first.next(3), second.next(3)]);

  for (const [sink, frames] of [
    ['first', first.items],
    ['second', second.items],
  ] as const) {
    frames.forEach((frame, i) => {
      const what = `${sink} sink, frame ${i}`;
      assertOwnBuffer(frame.data, Uint8Array.prototype, what);
      const at = firstMismatch(frame.data, i === 0 ? expected : (fills[i - 1] ?? -1));
      assert.equal(at, -1, `${what} differs from what was pushed at byte ${at}`);
    });
  }
  const [a0, a1] = first.items;
  const [b0] = second.items;
  assert.ok(a0 && a1 && b0);
  assert.notEqual(a0.data.buffer, a1.data.buffer);
  assert.notEqual(a0.data.buffer, b0.data.buffer);
  a0.data.fill(1);
  assert.equal(firstMismatch(b0.data, expected), -1, "one sink's writes reach another's frame");
});

/** Keeps the JS thread busy for `ms`, as GC, CPU load or a slow handler would. */
function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
}

// The event loop stalls while frames keep coming: here pushed from the JS
// thread itself between busy waits, so the order of events is exact. (A
// remote track's frames come from a decoder thread instead; see
// test/integration/video-sink-stall.test.ts.)
test('a stalled video sink keeps the newest 3 frames, in order, and counts the rest', async (t) => {
  const source = new native.VideoSource({ isScreencast: false, needsDenoising: null });
  const frames = collector<NativeVideoFrame>();
  const sink = new native.VideoSink(source.createTrack(), frames.callback);
  t.after(() => sink.stop());
  const width = 1920;
  const height = 1080;
  const data = new Uint8Array((width * height * 3) / 2);
  const rotations = [0, 90, 180, 270] as const;
  const pushes = 30;

  const rssBefore = process.memoryUsage.rss();
  for (let i = 0; i < pushes; i++) {
    data.fill(i);
    source.pushFrame({ width, height, data, rotation: rotations[i % 4] ?? 0 });
    busy(10);
  }
  const growthMb = (process.memoryUsage.rss() - rssBefore) / 2 ** 20;
  assert.equal(sink.framesDropped, pushes - 3);
  await frames.next(3);
  await afterDrain();

  assert.deepEqual(
    frames.items.map(({ width, height, rotation, data }) => [width, height, rotation, data[0]]),
    [
      [width, height, 270, 27],
      [width, height, 0, 28],
      [width, height, 90, 29],
    ],
  );
  frames.items.forEach((frame, i) => {
    const at = firstMismatch(frame.data, 27 + i);
    assert.equal(at, -1, `frame ${i} differs from what was pushed at byte ${at}`);
  });
  // Every one of the 30 frames held until JS caught up would be 93 MB.
  assert.ok(growthMb < 40, `RSS grew ${growthMb.toFixed(1)} MB during the stall`);

  // Caught up: the next frame arrives as usual, and nothing more is dropped.
  data.fill(99);
  source.pushFrame({ width, height, data, rotation: 0 });
  await frames.next(4);
  assert.equal(frames.items[3]?.data[0], 99);
  assert.equal(sink.framesDropped, pushes - 3);
});

test('an audio sink never drops: everything pushed in one task arrives, in order', async (t) => {
  const source = new native.AudioSource();
  const events = collector<NativeAudioData>();
  const sink = new native.AudioSink(source.createTrack(), events.callback);
  t.after(() => sink.stop());

  const count = 50;
  for (let i = 0; i < count; i++) {
    const data = audioData(8000, 1);
    data.samples.fill(i);
    source.pushData(data);
  }
  await events.next(count);

  assert.deepEqual(
    events.items.map((event) => event.samples[0]),
    Array.from({ length: count }, (_, i) => i),
  );
});

test('every audio event is an independent copy of what was pushed', async (t) => {
  const source = new native.AudioSource();
  const track = source.createTrack();
  const first = collector<NativeAudioData>();
  const second = collector<NativeAudioData>();
  const sinks = [
    new native.AudioSink(track, first.callback),
    new native.AudioSink(track, second.callback),
  ];
  t.after(() => {
    for (const sink of sinks) sink.stop();
  });

  const data = audioData(48000, 2);
  const expected = data.samples.slice();
  source.pushData(data);
  data.samples.fill(7);
  source.pushData(data);
  await Promise.all([first.next(2), second.next(2)]);

  const [a0, a1] = first.items;
  const [b0] = second.items;
  assert.ok(a0 && a1 && b0);
  assertOwnBuffer(a0.samples, Int16Array.prototype, 'samples');
  assert.deepEqual(a0.samples, expected);
  assert.ok(a1.samples.every((v) => v === 7));
  assert.notEqual(a0.samples.buffer, b0.samples.buffer);
  a0.samples.fill(1);
  assert.deepEqual(b0.samples, expected);
});

test('audio events queued before stop() are dropped', async (t) => {
  const source = new native.AudioSource();
  const track = source.createTrack();
  const witness = collector<NativeAudioData>();
  const witnessSink = new native.AudioSink(track, witness.callback);
  t.after(() => witnessSink.stop());
  const stopped = collector<NativeAudioData>();
  const sink = new native.AudioSink(track, stopped.callback);

  // Local sinks run inside pushData, so these are queued by the time it
  // returns.
  for (let i = 0; i < 3; i++) source.pushData(audioData(8000, 1));
  sink.stop();
  await witness.next(3);
  await afterDrain();

  assert.equal(stopped.items.length, 0);
});

test('audio pushed after stop() never reaches the sink', async (t) => {
  const source = new native.AudioSource();
  const track = source.createTrack();
  const witness = collector<NativeAudioData>();
  const witnessSink = new native.AudioSink(track, witness.callback);
  t.after(() => witnessSink.stop());
  const stopped = collector<NativeAudioData>();
  const sink = new native.AudioSink(track, stopped.callback);

  sink.stop();
  sink.stop(); // idempotent
  source.pushData(audioData(8000, 1));
  await witness.next(1);
  await afterDrain();

  assert.equal(stopped.items.length, 0);
});

test('video pushed after stop() never reaches the sink', async (t) => {
  const source = new native.VideoSource({ isScreencast: false, needsDenoising: null });
  const track = source.createTrack();
  const witness = collector<NativeVideoFrame>();
  const witnessSink = new native.VideoSink(track, witness.callback);
  t.after(() => witnessSink.stop());
  const stopped = collector<NativeVideoFrame>();
  const sink = new native.VideoSink(track, stopped.callback);

  sink.stop();
  sink.stop(); // idempotent
  source.pushFrame({ width: 2, height: 2, data: i420(2, 2), rotation: 0 });
  await witness.next(1);
  await afterDrain();

  assert.equal(stopped.items.length, 0);
});

test('sinks reject non-track handles and tracks of the other kind', () => {
  const audioTrack = new native.AudioSource().createTrack();
  const videoTrack = new native.VideoSource({
    isScreencast: false,
    needsDenoising: null,
  }).createTrack();
  const fake = Object.create(Object.getPrototypeOf(audioTrack));

  assert.throws(() => new native.AudioSink(fake, () => {}), TypeError);
  assert.throws(() => new native.AudioSink(videoTrack, () => {}), {
    name: 'TypeError',
    message: 'expected a native audio Track handle',
  });
  assert.throws(() => new native.VideoSink(audioTrack, () => {}), {
    name: 'TypeError',
    message: 'expected a native video Track handle',
  });
});

test('each createTrack() makes a new track on the same source', async (t) => {
  const source = new native.AudioSource();
  const first = source.createTrack();
  const second = source.createTrack();
  const a = collector<NativeAudioData>();
  const b = collector<NativeAudioData>();
  const sinkA = new native.AudioSink(first, a.callback);
  t.after(() => sinkA.stop());
  const sinkB = new native.AudioSink(second, b.callback);
  t.after(() => sinkB.stop());

  source.pushData(audioData(8000, 1));
  await Promise.all([a.next(1), b.next(1)]);

  assert.notEqual(first, second);
  assert.notEqual(first.id, second.id);
  assert.equal(first.kind, 'audio');
});

test('a clone is a new track on the same source and gets its media', async (t) => {
  const audio = new native.AudioSource();
  const video = new native.VideoSource({ isScreencast: false, needsDenoising: null });
  const audioTrack = audio.createTrack();
  const videoTrack = video.createTrack();
  audioTrack.enabled = false;
  const audioClone = audioTrack.clone();
  const videoClone = videoTrack.clone();
  const sounds = collector<NativeAudioData>();
  const frames = collector<NativeVideoFrame>();
  const audioSink = new native.AudioSink(audioClone, sounds.callback);
  t.after(() => audioSink.stop());
  const videoSink = new native.VideoSink(videoClone, frames.callback);
  t.after(() => videoSink.stop());

  const data = audioData(8000, 1);
  const frame = { width: 3, height: 3, data: i420(3, 3), rotation: 0 as const };
  audio.pushData(data);
  video.pushFrame(frame);
  await Promise.all([sounds.next(1), frames.next(1)]);

  assert.deepEqual(sounds.items, [data]);
  assert.deepEqual(frames.items, [frame]);
  assert.notEqual(audioClone.id, audioTrack.id);
  assert.equal(audioClone.kind, 'audio');
  assert.equal(videoClone.kind, 'video');
  assert.equal(audioClone.enabled, true, 'enabled is not copied natively (wrtc parity)');
  assert.equal(audioClone.clone().kind, 'audio', 'a clone can be cloned');
});

test('an unreferenced sink is not collected and keeps delivering until stop()', async () => {
  // Needs --expose-gc, so it runs in a child process.
  const script = `
    const native = require(process.argv[1]);
    const audio = new native.AudioSource();
    const video = new native.VideoSource({ isScreencast: false, needsDenoising: null });
    const counts = { audio: 0, video: 0 };
    let delivered;
    const both = new Promise((resolve) => { delivered = resolve; });
    const onEvent = (kind) => () => {
      counts[kind]++;
      if (counts.audio > 0 && counts.video > 0) delivered();
    };
    // Only weak references survive this function.
    const refs = (() => [
      new WeakRef(new native.AudioSink(audio.createTrack(), onEvent('audio'))),
      new WeakRef(new native.VideoSink(video.createTrack(), onEvent('video'))),
    ])();
    const guard = setTimeout(() => {
      console.log(JSON.stringify({ error: 'no delivery after gc', counts }));
      process.exit(1);
    }, 5000);
    (async () => {
      // Two rounds, so finalizers scheduled by the first have run.
      for (let i = 0; i < 2; i++) {
        globalThis.gc();
        await new Promise((resolve) => setImmediate(resolve));
      }
      const alive = refs.map((ref) => ref.deref() !== undefined);
      audio.pushData({ samples: new Int16Array(80), sampleRate: 8000, bitsPerSample: 16,
        channelCount: 1, numberOfFrames: 80 });
      video.pushFrame({ width: 2, height: 2, data: new Uint8Array(6), rotation: 0 });
      await both;
      clearTimeout(guard);
      for (const ref of refs) ref.deref()?.stop();
      console.log(JSON.stringify({ alive, counts }));
    })();
  `;
  // The timeout is a failure guard; the child also has to exit on its own
  // once its sinks are stopped.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--expose-gc', '-e', script, addonPath],
    { timeout: 20_000 },
  );
  assert.deepEqual(JSON.parse(stdout), { alive: [true, true], counts: { audio: 1, video: 1 } });
});

test('terminating workers while sink events are queued is clean', async () => {
  // Each worker queues thousands of sink events and then never yields, so
  // they are all still queued when worker.terminate() tears the env down.
  // Node then dispatches some of them while it closes the worker's handles,
  // before the sinks' env cleanup hooks run, on an env that can no longer
  // create JS values. That used to crash the process. The sinks are never
  // stopped, so only the cleanup hook detaches them (they are kept in an
  // array so that doesn't depend on GC).
  const body = `
    const { parentPort, workerData } = require('node:worker_threads');
    const native = require(workerData.addonPath);
    const audio = new native.AudioSource();
    const video = new native.VideoSource({ isScreencast: false, needsDenoising: null });
    globalThis.sinks = [];
    for (let i = 0; i < 4; i++) {
      sinks.push(new native.AudioSink(audio.createTrack(), () => {}));
      sinks.push(new native.VideoSink(video.createTrack(), () => {}));
    }
    // Local sinks run inside pushData/pushFrame, so this queues 200 events
    // per audio sink and the newest 3 per video sink.
    for (let i = 0; i < 200; i++) {
      audio.pushData({ samples: new Int16Array(480), sampleRate: 48000, bitsPerSample: 16,
        channelCount: 1, numberOfFrames: 480 });
      video.pushFrame({ width: 4, height: 4, data: new Uint8Array(24), rotation: 0 });
    }
    parentPort.postMessage('queued');
    for (;;) {}
  `;
  for (let i = 0; i < 5; i++) {
    const worker = new Worker(body, { eval: true, workerData: { addonPath } });
    await new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve());
      worker.once('error', reject);
    });
    assert.equal(await worker.terminate(), 1);
  }

  // The main thread's media pipeline still works afterwards.
  const source = new native.AudioSource();
  const events = collector<NativeAudioData>();
  const sink = new native.AudioSink(source.createTrack(), events.callback);
  try {
    source.pushData(audioData(8000, 1));
    await events.next(1);
  } finally {
    sink.stop();
  }
});
