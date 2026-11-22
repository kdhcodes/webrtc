// The playout-only audio device (src/playout_adm.cc), seen through what it
// drives: a remote audio sink gets one event per playout pull, so the
// sink's event rate is the pull rate.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AudioCounter, audioCall, eventRate } from './playout-harness.ts';

/** True if `rate` (events per second) is one pull per 10 ms, within 10%. */
const oneEventPer10ms = (rate: number) => Math.abs(rate - 100) <= 10;

test('a remote audio sink gets one event per 10 ms of real time', async (t) => {
  const counter = new AudioCounter(t, await audioCall(t));
  // 3 s: drift shows up, as does a second loop (200/s) or a stalled one.
  const rate = await eventRate(counter, 300);
  assert.ok(oneEventPer10ms(rate), `${rate.toFixed(1)} events/s, expected 100`);
});

/** Stops this whole process, every thread, for `seconds`; resolves once it runs again. */
function stallProcess(seconds: number): Promise<void> {
  const pid = process.pid;
  return new Promise((resolve, reject) => {
    execFile('sh', ['-c', `kill -STOP ${pid}; sleep ${seconds}; kill -CONT ${pid}`], (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

test('after a short stall, playout makes up the missed pulls (sinks keep real time)', async (t) => {
  const counter = new AudioCounter(t, await audioCall(t));
  await counter.until((c) => c.audible >= 10, '10 audible events');
  const from = counter.count;
  const start = performance.now();
  await stallProcess(1);
  const end = await counter.until((c) => c.count >= from + 150, '150 events from the stall on');
  // 150 pulls cover 1.5 s of real time. The ~100 missed during the 1 s stall
  // are made up back to back, so the 150th event arrives about 1.5 s after
  // `start`; had they been dropped, about 2.5 s.
  const elapsed = end - start;
  assert.ok(elapsed < 2100, `150 events took ${elapsed.toFixed(0)} ms with a 1 s stall: dropped`);
});

test('after a stall longer than the 2 s cap, playout drops the missed pulls', async (t) => {
  const counter = new AudioCounter(t, await audioCall(t));
  await counter.until((c) => c.audible >= 10, '10 audible events');
  const from = counter.count;
  const start = performance.now();
  await stallProcess(3);
  const end = await counter.until((c) => c.count >= from + 150, '150 events from the stall on');
  // Made up, the ~300 missed pulls would put the 150th event at about 3 s
  // after `start`; dropped, at about 4.5 s.
  const elapsed = end - start;
  assert.ok(elapsed > 3900, `150 events took ${elapsed.toFixed(0)} ms with a 3 s stall: a burst`);
});

test('once every peer connection is gone, the device terminates and plays again on the next', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wrtc-playout-cycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('./playout-cycle-child.ts', import.meta.url));
  const log = join(dir, 'libwebrtc.log');
  const env = {
    ...process.env,
    WRTC_LOG: 'WebRtcVoiceEngine::Init|WebRtcVoiceEngine::Terminate',
    WRTC_LOG_FILE: log,
  };
  const { code, stdout, stderr } = await new Promise<{
    code: number | string;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const args = ['--expose-gc', script];
    execFile(process.execPath, args, { env, timeout: 30_000 }, (error, out, err) => {
      const code = error ? (error.signal ?? error.code ?? 'error') : 0;
      resolve({ code, stdout: out, stderr: err });
    });
  });
  const tail = stderr.trimEnd().split('\n').slice(-5).join('\n');
  assert.equal(code, 0, `the child ended with ${code} (SIGTERM: it hung):\n${tail}`);
  // The device was terminated between the calls and initialized again, and
  // the second call is heard at the normal rate only if Init() brought it
  // back with a single playout loop.
  const engine = readFileSync(log, 'utf8')
    .split('\n')
    .flatMap((line) => line.match(/WebRtcVoiceEngine::(Init|Terminate)$/)?.[1] ?? []);
  assert.deepEqual(engine, ['Init', 'Terminate', 'Init', 'Terminate']);
  const rates = JSON.parse(stdout) as number[];
  assert.equal(rates.length, 2);
  for (const [i, rate] of rates.entries()) {
    assert.ok(oneEventPer10ms(rate), `call ${i + 1}: ${rate.toFixed(1)} events/s, expected 100`);
  }
});
