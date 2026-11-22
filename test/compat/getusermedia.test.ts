// Differential test of getUserMedia and mediaDevices against @roamhq/wrtc.
// getusermedia-scenario.mjs runs once per implementation, each in its own
// process. The results must match (for errors: whether a call throws or
// rejects and the error's type, not its message; see errors.mjs) except for
// the intentional divergences, which are split out and asserted on their
// own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runScenario, type ScenarioRun } from './run-scenario.ts';

const scenario = fileURLToPath(new URL('./getusermedia-scenario.mjs', import.meta.url));
type Results = Record<string, Record<string, unknown>>;

interface Run extends ScenarioRun {
  results: Results;
}

async function run(impl: 'wrtc' | 'ours'): Promise<Run> {
  const result = await runScenario(scenario, impl);
  return { ...result, results: JSON.parse(result.stdout) };
}

/** Each divergence: [section, key]. */
const divergent: [string, string][] = [
  ['audioTrack', 'label'],
  ['videoTrack', 'label'],
  ['clone', 'label'],
  ['localMedia', 'audio'],
  ['localMedia', 'video'],
  ['mediaDevices', 'sameFunction'],
  ['mediaDevices', 'enumerateDevices'],
];

function split(results: Results): { diverged: Record<string, unknown>; rest: Results } {
  const rest: Results = structuredClone(results);
  const diverged: Record<string, unknown> = {};
  for (const [section, key] of divergent) {
    diverged[`${section}.${key}`] = rest[section]?.[key];
    delete rest[section]?.[key];
  }
  return { diverged, rest };
}

const [wrtcRun, oursRun] = await Promise.all([run('wrtc'), run('ours')]);
const wrtc = split(wrtcRun.results);
const ours = split(oursRun.results);

function divergence(path: string): { wrtc: unknown; ours: unknown } {
  return { wrtc: wrtc.diverged[path], ours: ours.diverged[path] };
}

test("divergence: gUM tracks carry silence and colour bars; wrtc's carry nothing", () => {
  assert.deepEqual(divergence('localMedia.audio'), {
    wrtc: [],
    ours: ['48000/1/480', '48000/1/480', '48000/1/480'],
  });
  assert.deepEqual(divergence('localMedia.video'), {
    wrtc: [],
    ours: ['640x480', '640x480', '640x480'],
  });
});

test("divergence: gUM tracks are labelled with enumerateDevices' labels (wrtc: undefined)", () => {
  // JSON drops wrtc's undefined labels.
  assert.deepEqual(divergence('audioTrack.label'), { wrtc: undefined, ours: 'Fake audio device' });
  assert.deepEqual(divergence('videoTrack.label'), { wrtc: undefined, ours: 'Fake video device' });
  assert.deepEqual(divergence('clone.label'), { wrtc: undefined, ours: 'Fake video device' });
});

test('divergence: enumerateDevices resolves with the fake devices; wrtc throws synchronously', () => {
  assert.deepEqual(divergence('mediaDevices.enumerateDevices'), {
    wrtc: { threw: 'Error' }, // "Not yet implemented"
    ours: {
      resolved: [
        {
          deviceId: 'FakeAudioDevice',
          kind: 'audioinput',
          label: 'Fake audio device',
          groupId: 'FakeDeviceGroup',
        },
        {
          deviceId: 'FakeVideoDevice',
          kind: 'videoinput',
          label: 'Fake video device',
          groupId: 'FakeDeviceGroup',
        },
      ],
    },
  });
});

test('divergence: mediaDevices.getUserMedia is bound, so not the same function as getUserMedia', () => {
  assert.deepEqual(divergence('mediaDevices.sameFunction'), { wrtc: true, ours: false });
});

test('live gUM tracks keep neither process alive', (t) => {
  if (wrtcRun.crashed) t.diagnostic(`@roamhq/wrtc crashed (${wrtcRun.crashed}) after its results`);
  assert.ok(wrtcRun.exitedOnItsOwn, 'wrtc had to be killed');
  assert.ok(oursRun.exitedOnItsOwn, 'ours had to be killed: live gUM tracks kept it alive');
});

for (const section of Object.keys(wrtc.rest)) {
  test(`matches wrtc: ${section}`, () => {
    assert.deepEqual(ours.rest[section], wrtc.rest[section]);
  });
}
