// A remote video sink and its event loop: frames come from the decoder
// thread whether or not JS keeps up, so a sink queues at most the newest 3
// for JS and counts what it drops (src/media_sink.cc, kMaxQueuedFrames).
// The sender runs in a worker, with its own event loop, so it keeps sending
// while this thread is busy. Each frame carries its number in 16x16 blocks.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  type MediaStreamTrack,
  nonstandard,
  type RTCIceCandidateInit,
  RTCPeerConnection,
  type RTCPeerConnectionIceEvent,
  type RTCSessionDescriptionInit,
  type RTCTrackEvent,
} from '../../lib/index.ts';
import { builtPackage } from './built-package.ts';
import { next, WAIT_MS } from './harness.ts';

// The frame number: 24 cells of 16x16 luma at the top left, 8 columns by 3
// rows, white or black. Bits 0-15 are the number, 16-23 a check byte.
const CELL = 16;
const COLS = 8;
const CELLS = 24;
const check = (n: number) => ((n & 0xff) ^ (n >> 8) ^ 0xa5) & 0xff;

// The worker's code: JavaScript loading the compiled package (a worker must
// not run TypeScript; CONTRIBUTING-AGENTS.md). It sends one video track,
// pushing a numbered frame every 1/30 s.
const sender = `
const { parentPort, workerData } = require('node:worker_threads');
const { entry, width, height } = workerData;
const CELL = ${CELL}, COLS = ${COLS}, CELLS = ${CELLS};
const check = ${check.toString()};
(async () => {
  const { RTCPeerConnection, nonstandard } = await import(entry);
  const pc = new RTCPeerConnection();
  const source = new nonstandard.RTCVideoSource();
  const track = source.createTrack();
  pc.addTrack(track);
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) parentPort.postMessage({ candidate: candidate.toJSON() });
  };
  const data = new Uint8Array(width * height * 1.5).fill(128);
  let pump;
  parentPort.on('message', (message) => {
    if (message.answer) pc.setRemoteDescription(message.answer);
    if (message.candidate) pc.addIceCandidate(message.candidate);
    if (message.close) {
      clearInterval(pump);
      track.stop();
      pc.close();
      parentPort.close();
    }
  });
  await pc.setLocalDescription();
  parentPort.postMessage({ offer: { type: 'offer', sdp: pc.localDescription.sdp } });
  const start = performance.now();
  let n = 0;
  pump = setInterval(() => {
    if (performance.now() - start < (n * 1000) / 30) return;
    n++;
    const bits = n | (check(n) << 16);
    for (let cell = 0; cell < CELLS; cell++) {
      const x = (cell % COLS) * CELL;
      const y0 = Math.floor(cell / COLS) * CELL;
      for (let y = y0; y < y0 + CELL; y++) {
        data.fill((bits >> cell) & 1 ? 235 : 16, y * width + x, y * width + x + CELL);
      }
    }
    source.onFrame({ width, height, data });
  }, 5);
})();
`;

/** The frame's number, or null if the blocks don't read back. */
function frameNumber({ data, width }: nonstandard.RTCVideoSinkFrame): number | null {
  let bits = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    const x = (cell % COLS) * CELL + CELL / 2;
    const y = Math.floor(cell / COLS) * CELL + CELL / 2;
    if ((data[y * width + x] ?? 0) > 128) bits |= 1 << cell;
  }
  const n = bits & 0xffff;
  return bits >>> 16 === check(n) ? n : null;
}

/** A remote video track whose sender runs in a worker; closed after the test. */
async function remoteVideo(
  t: TestContext,
  entry: string,
  width: number,
  height: number,
): Promise<MediaStreamTrack> {
  const worker = new Worker(sender, { eval: true, workerData: { entry, width, height } });
  const pc = new RTCPeerConnection();
  t.after(async () => {
    pc.close();
    worker.postMessage({ close: true });
    await worker.terminate();
  });
  const failed = new Promise<never>((_, reject) => worker.once('error', reject));
  pc.onicecandidate = ({ candidate }: RTCPeerConnectionIceEvent) => {
    if (candidate) worker.postMessage({ candidate: candidate.toJSON() });
  };
  type Message = { offer?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
  worker.on('message', async ({ offer, candidate }: Message) => {
    if (candidate) await pc.addIceCandidate(candidate);
    if (offer) {
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription();
      worker.postMessage({ answer: { type: 'answer', sdp: pc.localDescription?.sdp } });
    }
  });
  const { track } = await Promise.race([next<RTCTrackEvent>(pc, 'track'), failed]);
  return track;
}

/** The frame numbers a sink receives (null: unreadable), and a way to wait for more. */
function frameNumbers(sink: nonstandard.RTCVideoSink) {
  const numbers: (number | null)[] = [];
  const sizes = new Set<string>();
  let waiting: { count: number; resolve: () => void } | undefined;
  sink.onframe = ({ frame }) => {
    numbers.push(frameNumber(frame));
    sizes.add(`${frame.width}x${frame.height}`);
    if (waiting && numbers.length >= waiting.count) waiting.resolve();
  };
  return {
    numbers,
    sizes,
    /** Resolves once `count` frames have arrived in all. */
    until(count: number): Promise<void> {
      if (numbers.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        // Failure guard only.
        const timer = setTimeout(
          () => reject(new Error(`expected ${count} frames, got ${numbers.length}`)),
          WAIT_MS,
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

/** Keeps the JS thread busy for `ms`, as GC, CPU load or a slow handler would. */
function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
}

function assertIncreasing(numbers: (number | null)[]): void {
  assert.ok(!numbers.includes(null), `unreadable frame numbers: ${numbers.join(',')}`);
  for (let i = 1; i < numbers.length; i++) {
    assert.ok(
      (numbers[i] ?? 0) > (numbers[i - 1] ?? 0),
      `frames out of order at ${i}: ${numbers.join(',')}`,
    );
  }
}

test('a remote video sink and a busy event loop', async (t) => {
  // Built once for both cases (it runs tsc).
  const { entry } = builtPackage(t);

  await t.test(
    'a stall drops the oldest frames, counts them, then resumes in order with the newest',
    async (t) => {
      const track = await remoteVideo(t, entry, 320, 240);
      const sink = new nonstandard.RTCVideoSink(track);
      t.after(() => sink.stop());
      const frames = frameNumbers(sink);
      await frames.until(10);

      // Stalled in a check-phase callback, then measured in the next one:
      // the frames that waited are delivered in the poll phase between.
      const stall = await new Promise<{ before: number; dropped: number; delivered: number }>(
        (resolve) =>
          setImmediate(() => {
            const before = frames.numbers.length;
            const droppedBefore = sink.framesDropped;
            busy(500);
            setImmediate(() =>
              resolve({
                before,
                dropped: sink.framesDropped - droppedBefore,
                delivered: frames.numbers.length - before,
              }),
            );
          }),
      );
      const droppedAfterStall = sink.framesDropped;
      await frames.until(frames.numbers.length + 10);

      // About 15 frames were decoded during the stall.
      assert.ok(stall.dropped > 0, 'the stall dropped frames');
      // The 3 that waited, and at most one decoded while they were delivered.
      assert.ok(
        stall.delivered >= 1 && stall.delivered <= 4,
        `${stall.delivered} frames delivered right after the stall`,
      );
      assertIncreasing(frames.numbers);
      // The dropped frames are the oldest: all of them came between the
      // last frame before the stall and the first after it.
      const lastBefore = frames.numbers[stall.before - 1] ?? 0;
      const firstAfter = frames.numbers[stall.before] ?? 0;
      assert.ok(
        firstAfter - lastBefore - 1 >= stall.dropped,
        `frame ${lastBefore} then ${firstAfter}, but ${stall.dropped} dropped`,
      );
      assert.equal(sink.framesDropped, droppedAfterStall, 'no drops once caught up');
    },
  );

  await t.test('a sink whose event loop keeps up drops nothing at 720p30', async (t) => {
    const track = await remoteVideo(t, entry, 1280, 720);
    const sink = new nonstandard.RTCVideoSink(track);
    t.after(() => sink.stop());
    const frames = frameNumbers(sink);
    await frames.until(60);

    assert.equal(sink.framesDropped, 0);
    assert.deepEqual([...frames.sizes], ['1280x720']);
    assertIncreasing(frames.numbers);
  });
});
