// Tests of scripts/ci-status.mjs, the release workflow's check that CI
// passed on the tagged commit: what a commit's CI runs add up to, and the
// polling, with a fake clock and fake API.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Run, verdict, waitForCi } from './ci-status.mjs';

const passed: Run = { status: 'completed', conclusion: 'success' };
const failed: Run = { status: 'completed', conclusion: 'failure' };
const cancelled: Run = { status: 'completed', conclusion: 'cancelled' };
const running: Run = { status: 'in_progress', conclusion: null };

test('one successful run is enough, e.g. a rerun after a failure', () => {
  assert.equal(verdict([failed, passed]), 'success');
});

test('no runs, or one still going, is pending', () => {
  assert.equal(verdict([]), 'pending');
  assert.equal(verdict([failed, running]), 'pending');
});

test('runs that all finished without success are a failure', () => {
  assert.equal(verdict([failed, cancelled]), 'failure');
});

/** waitForCi over a fixed sequence of API answers, on a clock that sleeping advances. */
function poll(answers: Run[][], timeoutMs = 60_000) {
  let clock = 0;
  const calls: number[] = [];
  const logs: string[] = [];
  const result = waitForCi({
    fetchRuns: async () => {
      calls.push(clock);
      return answers[Math.min(calls.length - 1, answers.length - 1)] ?? [];
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    timeoutMs,
    intervalMs: 30_000,
    log: (line) => logs.push(line),
  });
  return { result, calls, logs };
}

test('waits while CI runs, then succeeds', async () => {
  const p = poll([[], [{ ...running, html_url: 'https://ci/1' }], [passed]]);
  assert.equal(await p.result, 'success');
  assert.deepEqual(p.calls, [0, 30_000, 60_000]);
  assert.deepEqual(p.logs, [
    'no CI run for this commit yet; waiting',
    'CI is still running (https://ci/1); waiting',
  ]);
});

test('fails as soon as every run has failed', async () => {
  const p = poll([[running], [failed]]);
  assert.equal(await p.result, 'failure');
  assert.equal(p.calls.length, 2);
});

test('gives up at the timeout when CI never ran', async () => {
  const p = poll([[]], 60_000);
  assert.equal(await p.result, 'timeout');
  assert.deepEqual(p.calls, [0, 30_000, 60_000]);
});
