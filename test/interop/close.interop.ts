// Ending a call with Chromium from either side, and the Node process exiting
// afterwards.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright';
import { CONSENT_WAIT_MS, ENDED, launch, liveCall, nodeReaches } from './chrome.ts';

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(() => browser?.close());

test('our close() mid-call ends the call for Chrome', async (t) => {
  const { c, remote } = await liveCall(t, browser);
  const started = performance.now();
  c.pc.close();
  assert.equal(c.pc.connectionState, 'closed');
  // The receivers' tracks end in a queued task, with `ended` (since wave 1D;
  // SPEC-LAYER-PLAN.md, "ended on receiver tracks").
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    remote.map((track) => track.readyState),
    ['ended', 'ended'],
  );
  const state = await c.chrome.reaches((s) => ENDED.includes(s), CONSENT_WAIT_MS);
  t.diagnostic(`Chrome went ${state} after ${Math.round(performance.now() - started)} ms`);
  await c.checkCandidates();
});

test("Chrome's close() mid-call ends the call for us", async (t) => {
  const { c } = await liveCall(t, browser);
  const started = performance.now();
  await c.chrome.call('close');
  const state = await nodeReaches(c.pc, (s) => ENDED.includes(s), CONSENT_WAIT_MS);
  t.diagnostic(`we went ${state} after ${Math.round(performance.now() - started)} ms`);
  await c.checkCandidates();
});

for (const first of ['node', 'chrome']) {
  test(`the Node process exits on its own after a call ${first === 'node' ? 'we' : 'Chrome'} ended`, async () => {
    // A full call in a child process (exit-after-call.ts), ended by `first`;
    // once the other side notices and the browser is closed, the child must
    // exit by itself: nothing of ours may keep the event loop alive.
    const child = fileURLToPath(new URL('./exit-after-call.ts', import.meta.url));
    // Without the runner's context the child reports in plain TAP.
    const env: NodeJS.ProcessEnv = { ...process.env, INTEROP_CLOSES_FIRST: first };
    delete env.NODE_TEST_CONTEXT;
    const { code, stdout } = await new Promise<{ code: number | string | null; stdout: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          ['--test-reporter=tap', child],
          // The call and the consent wait, with margin; past this the child
          // is assumed stuck.
          { env, timeout: CONSENT_WAIT_MS + 45_000 },
          (error, stdout) => {
            resolve({ code: error ? (error.signal ?? error.code ?? 'error') : 0, stdout });
          },
        );
      },
    );
    assert.equal(
      code,
      0,
      `child ended with ${code} (SIGTERM: still running, leaked handle?):\n${stdout}`,
    );
    assert.match(stdout, /^# pass 1$/m);
  });
}
