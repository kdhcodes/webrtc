// Differential test of nonstandard.i420ToRgba / rgbaToI420 against
// @roamhq/wrtc: the same scenario (i420-scenario.mjs) runs once per
// implementation, each in its own process. Output bytes must be identical
// (wrtc's own rgbaToI420 chroma differs between arm64 and x64, and ours
// follows it on each), as must whether each call throws and the error's
// type (not its message: see errors.mjs), except for the intentional
// divergences, asserted on their own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runScenario, type ScenarioRun } from './run-scenario.ts';

const scenario = fileURLToPath(new URL('./i420-scenario.mjs', import.meta.url));
type Results = Record<string, unknown>;

interface Run extends ScenarioRun {
  results: Results;
}

async function run(impl: 'wrtc' | 'ours'): Promise<Run> {
  const result = await runScenario(scenario, impl);
  if (result.stdout === '') throw new Error(`the ${impl} scenario printed no results`);
  return { ...result, results: JSON.parse(result.stdout) };
}

const [wrtcRun, oursRun] = await Promise.all([run('wrtc'), run('ours')]);
const wrtc = wrtcRun.results;
const ours = oursRun.results;

test('both scenarios exit on their own, and ours does not crash', (t) => {
  // wrtc is known to crash on exit; runScenario only accepts that after
  // complete results, and a crash of ours rejects.
  if (wrtcRun.crashed) t.diagnostic(`@roamhq/wrtc crashed (${wrtcRun.crashed}) after its results`);
  assert.ok(wrtcRun.exitedOnItsOwn, 'wrtc had to be killed');
  assert.ok(oursRun.exitedOnItsOwn, 'ours had to be killed after printing its results');
  assert.equal(oursRun.crashed, null);
});

test('divergence: a view with a byteOffset converts the view (wrtc checks the whole buffer)', () => {
  assert.deepEqual(wrtc.offsetView, {
    result: { name: 'TypeError' },
    written: [0, 0, 0, 0],
  });
  assert.deepEqual(ours.offsetView, { result: { ok: null }, written: [130, 130, 130, 255] });
});

test('divergence: a negative size is a TypeError, even where wrtc wrapped its length to match', () => {
  // wrtc's C int arithmetic gives -1 x -1 1 byte of I420 and 4 of RGBA,
  // which it accepts and does nothing with.
  assert.deepEqual(wrtc.negativeWrapped, { result: { ok: null }, untouched: [7, 7, 7, 7] });
  assert.deepEqual(ours.negativeWrapped, {
    result: { name: 'TypeError' },
    untouched: [7, 7, 7, 7],
  });
});

test('the scenario covered what it should', () => {
  assert.deepEqual(Object.keys(ours).sort(), Object.keys(wrtc).sort());
  assert.equal(Object.keys(wrtc.noise as object).length, 9);
});

const divergent = new Set(['offsetView', 'negativeWrapped']);
for (const section of Object.keys(wrtc).filter((s) => !divergent.has(s))) {
  if (section === 'noise') {
    // One test per size, so a mismatch names it.
    for (const size of Object.keys(wrtc.noise as object)) {
      test(`matches wrtc byte for byte: noise ${size}`, () => {
        const pick = (r: Results) => (r.noise as Record<string, unknown>)[size];
        assert.deepEqual(pick(ours), pick(wrtc));
      });
    }
    continue;
  }
  test(`matches wrtc: ${section}`, () => {
    assert.deepEqual(ours[section], wrtc[section]);
  });
}
