// Differential test of the nonstandard media API against @roamhq/wrtc. The
// same scenario script (nonstandard-scenario.mjs) runs once per
// implementation, each in its own process. The observable results must
// match (for errors: whether a call throws and the error's type, not its
// message; see errors.mjs), except for the intentional divergences, which
// are split out first and asserted on their own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runScenario, type ScenarioRun } from './run-scenario.ts';

const scenario = fileURLToPath(new URL('./nonstandard-scenario.mjs', import.meta.url));
type Results = Record<string, Record<string, Record<string, unknown> | unknown>>;

interface Run extends ScenarioRun {
  results: Results;
}

async function run(impl: 'wrtc' | 'ours'): Promise<Run> {
  const result = await runScenario(scenario, impl);
  if (result.stdout === '') {
    throw new Error(
      `the ${impl} scenario exited before printing its results: ` +
        'an unstopped sink must keep the process alive',
    );
  }
  return { ...result, results: JSON.parse(result.stdout) };
}

/** Each divergence: [section, key, field?]. Field-level ones apply per entry. */
const divergent: [string, string, string?][] = [
  ['onData', 'samples offset view'],
  ['onFrame', 'data offset view'],
  ['videoEvents', '321x241 r90', 'rotation'],
  ['clone', 'enabled'],
  ['audioTrack', 'label'],
  ['videoTrack', 'label'],
  ['sinkShape', 'ondata'],
  ['listeners', 'order'],
  ['remote', 'mutedInOntrack'],
  ['remote', 'readyStateAfterClose'],
  ['remote', 'endedEventsOnClose'],
  ['mediaAfterTrackStop', 'received'],
  ['mediaAfterTrackStop', 'sinkStopped'],
  ...['8000/1', '16000/2', '44100/1', '48000/2'].map(
    (key) => ['audioEvents', key, 'ownType'] as [string, string, string],
  ),
  ...['4x4 r0', '321x241 r0', '321x241 r90'].map(
    (key) => ['videoEvents', key, 'ownType'] as [string, string, string],
  ),
];

/** Splits a result into (divergent values by path, everything else). */
function split(results: Results): { diverged: Record<string, unknown>; rest: Results } {
  const rest: Results = structuredClone(results);
  const diverged: Record<string, unknown> = {};
  for (const [section, key, field] of divergent) {
    const holder = rest[section] as Record<string, Record<string, unknown>>;
    if (field) {
      diverged[`${section}.${key}.${field}`] = holder[key]?.[field];
      delete holder[key]?.[field];
    } else {
      diverged[`${section}.${key}`] = holder[key];
      delete holder[key];
    }
  }
  return { diverged, rest };
}

const [wrtcRun, oursRun] = await Promise.all([run('wrtc'), run('ours')]);
const wrtc = split(wrtcRun.results);
const ours = split(oursRun.results);

function divergence(path: string): { wrtc: unknown; ours: unknown } {
  return { wrtc: wrtc.diverged[path], ours: ours.diverged[path] };
}

test('divergence: onData honours the samples view byteOffset', () => {
  assert.deepEqual(divergence('onData.samples offset view'), {
    wrtc: { name: 'TypeError' },
    ours: { ok: null },
  });
});

test('divergence: onFrame honours the data view byteOffset', () => {
  assert.deepEqual(divergence('onFrame.data offset view'), {
    wrtc: { name: 'TypeError' },
    ours: { ok: null },
  });
});

test('divergence: frame rotation is honoured', () => {
  assert.deepEqual(divergence('videoEvents.321x241 r90.rotation'), { wrtc: 0, ours: 90 });
});

test('divergence: clone() copies enabled (the spec); wrtc re-enables the clone', () => {
  assert.deepEqual(divergence('clone.enabled'), { wrtc: true, ours: false });
});

test('divergence: label is "" and ondata starts null (spec types; wrtc has undefined)', () => {
  assert.deepEqual(divergence('audioTrack.label'), { wrtc: undefined, ours: '' });
  assert.deepEqual(divergence('videoTrack.label'), { wrtc: undefined, ours: '' });
  assert.deepEqual(divergence('sinkShape.ondata'), { wrtc: undefined, ours: null });
});

test('divergence: events are Events, so `type` is inherited rather than own', () => {
  for (const path of Object.keys(wrtc.diverged).filter((p) => p.endsWith('.ownType'))) {
    assert.deepEqual(divergence(path), { wrtc: true, ours: false }, path);
  }
});

test('divergence: ondata runs in registration order (HTML); wrtc runs it after the listeners', () => {
  assert.deepEqual(divergence('listeners.order'), {
    wrtc: ['listener', 'ondata'],
    ours: ['ondata', 'listener'],
  });
});

test('an unstopped sink keeps the process alive, and ours exits once every sink is stopped', (t) => {
  if (wrtcRun.crashed) t.diagnostic(`@roamhq/wrtc crashed (${wrtcRun.crashed}) after its results`);
  const kept = { unstoppedSinkKeptProcessAlive: true };
  // Only meaningful for ours: wrtc's tracks hold live uv_async handles and
  // its own threads keep its process up whether or not a sink does, so
  // wrtc always reports true here. It's recorded for completeness.
  assert.deepEqual(wrtc.rest.lifetime, kept);
  assert.deepEqual(ours.rest.lifetime, kept);
  assert.ok(oursRun.exitedOnItsOwn, 'ours had to be killed after every sink was stopped');
});

test('divergence: remote tracks start muted and unmute when media arrives (the spec, Chrome)', () => {
  // Deliberate since 2026-11-20 (SPEC-LAYER-PLAN.md, "MediaStreamTrack"):
  // wrtc's tracks are never muted. Once ours unmute, both read false, which
  // `matches wrtc: remote` compares (mutedAfterUnmute, track.muted).
  assert.deepEqual(divergence('remote.mutedInOntrack'), {
    wrtc: [false, false],
    ours: [true, true],
  });
});

test('divergence: close() ends remote tracks and their clones with ended, in a queued task (the spec, Chrome)', () => {
  // Decided 2026-11-20 (SPEC-LAYER-PLAN.md, "MediaStreamTrack"): wrtc ends
  // them synchronously and fires nothing. Both read "ended" a task later
  // (`matches wrtc: remote`, readyStateAfterTask).
  assert.deepEqual(divergence('remote.readyStateAfterClose'), { wrtc: 'ended', ours: 'live' });
  assert.deepEqual(divergence('remote.endedEventsOnClose'), { wrtc: 0, ours: 3 });
});

test('divergence: stopping a track stops its sinks (Chrome: an ended track delivers nothing); wrtc keeps feeding them', () => {
  // Decided 2026-11-21 (SPEC-LAYER-PLAN.md, "RTCAudioSink"): a sink left on
  // an ended track kept the process alive with nothing more to deliver.
  assert.deepEqual(divergence('mediaAfterTrackStop.sinkStopped'), { wrtc: false, ours: true });
  assert.deepEqual(divergence('mediaAfterTrackStop.received'), { wrtc: true, ours: false });
});

test("a disabled local video track delivers black frames identical to wrtc's", () => {
  assert.deepEqual(ours.rest.disabledVideoTrack, wrtc.rest.disabledVideoTrack);
  type Frame = { width: number; height: number; data: number[] };
  const frames = Object.entries(ours.rest.disabledVideoTrack as Record<string, Frame>);
  assert.equal(frames.length, 2);
  for (const [size, { width, height, data }] of frames) {
    const luma = width * height;
    assert.ok(
      data.slice(0, luma).every((v) => v === 0) && data.slice(luma).every((v) => v === 128),
      `${size} is black (Y 0, U/V 128)`,
    );
  }
});

const checkedAbove = new Set(['lifetime', 'disabledVideoTrack', 'mediaAfterTrackStop']);
for (const section of Object.keys(wrtc.rest).filter((s) => !checkedAbove.has(s))) {
  test(`matches wrtc: ${section}`, () => {
    assert.deepEqual(ours.rest[section], wrtc.rest[section]);
  });
}
