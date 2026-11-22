import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clockState,
  colourBars,
  Pacer,
  startAudioFeed,
  startPacer,
  startVideoFeed,
  stopPacer,
} from './synthetic-media.ts';

/** Emissions of a pacer ticked at each of `times` (ms from its start). */
function emissions(perSecond: number, maxBurst: number, times: number[]): number[] {
  const counts: number[] = [];
  let count = 0;
  const pacer = new Pacer(perSecond, 1000, maxBurst, () => count++);
  for (const t of times) {
    pacer.tick(1000 + t);
    counts.push(count);
  }
  return counts;
}

test('Pacer emits at its rate however late and irregular the ticks are', () => {
  // A 10 ms timer that drifts: ticks at 0, 13, 31, 32, 58, ... up to 1000 ms.
  const times = [0, 13, 31, 32, 58, 77, 104, 150, 199, 251, 333, 480, 500, 720, 999, 1000];
  const audio = emissions(100, 1000, times);
  assert.equal(audio[0], 1, 'the first chunk is due at the start');
  assert.equal(audio.at(-1), 101, '100 chunks a second, plus the one at 0');
  const video = emissions(30, 1000, times);
  assert.equal(video.at(-1), 31, '30 frames a second, plus the one at 0');
});

test('Pacer drops what fell due during a stall beyond maxBurst, then keeps its rate', () => {
  // 10 ms ticks, then a 1 s stall, then 10 ms ticks again.
  const counts = emissions(100, 5, [0, 10, 20, 1020, 1030, 1040]);
  assert.deepEqual(counts, [1, 2, 3, 8, 9, 10]);
});

test('colourBars is a 640x480 I420 frame of eight vertical 75% bars', () => {
  const frame = colourBars(640, 480);
  assert.equal(frame.byteLength, 640 * 480 * 1.5);
  const expected = [
    [180, 128, 128],
    [162, 44, 142],
    [131, 156, 44],
    [112, 72, 58],
    [84, 184, 198],
    [65, 100, 212],
    [35, 212, 114],
    [16, 128, 128],
  ];
  const u = 640 * 480;
  const v = u + 320 * 240;
  for (const row of [0, 479]) {
    const chromaRow = row >> 1;
    const seen = expected.map((_, bar) => {
      // First and last column of each 80-pixel bar.
      const cols = [bar * 80, bar * 80 + 79];
      return cols.map((x) => [
        frame[row * 640 + x],
        frame[u + chromaRow * 320 + (x >> 1)],
        frame[v + chromaRow * 320 + (x >> 1)],
      ]);
    });
    assert.deepEqual(
      seen,
      expected.map((yuv) => [yuv, yuv]),
      `row ${row}`,
    );
  }
});

test('the clock runs while any feed runs and stops with the last one', (t) => {
  const audio = startAudioFeed();
  const video = startVideoFeed();
  t.after(() => {
    audio.stop();
    video.stop();
  });
  assert.deepEqual(clockState(), { feeds: 2, ticking: true });
  audio.stop();
  audio.stop();
  assert.deepEqual(clockState(), { feeds: 1, ticking: true }, 'stop() is idempotent');
  video.stop();
  assert.deepEqual(clockState(), { feeds: 0, ticking: false });
});

test("the clock's timer doesn't keep the process alive", (t) => {
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  const feed = startAudioFeed();
  t.after(() => feed.stop());
  assert.equal(clockState().ticking, true);
  assert.equal(timers(), before, "no ref'd timer was added");
});

test('a feed that throws neither escapes the clock nor starves the feeds after it', async (t) => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.message);
  process.on('warning', onWarning);
  let failures = 0;
  const failing = new Pacer(100, performance.now(), 5, () => {
    failures++;
    throw new Error('push failed');
  });
  let pushes = 0;
  const pushed = new Promise<void>((resolve) => {
    const healthy = new Pacer(100, performance.now(), 5, () => {
      if (++pushes === 5) resolve();
    });
    startPacer(failing);
    startPacer(healthy);
    t.after(() => {
      stopPacer(failing);
      stopPacer(healthy);
      process.off('warning', onWarning);
    });
  });
  await pushed;
  assert.ok(failures >= 2, `the failing feed is retried on later ticks (${failures} failures)`);
  assert.deepEqual(warnings, ["getUserMedia's synthetic media failed to push: Error: push failed"]);
});
