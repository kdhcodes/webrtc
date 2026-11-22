// The data channel scenario (datachannel-scenario.mjs) run against
// @roamhq/wrtc and against ours, each in its own process. Everything
// observable must match, except the intentional divergences, which are split
// out first and asserted on their own. wrtc 0.10.0 has data channels, but
// several of its behaviours are bugs or gaps; ours follow the spec (and
// Chrome) there.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runScenario, type ScenarioRun } from './run-scenario.ts';

const scenario = fileURLToPath(new URL('./datachannel-scenario.mjs', import.meta.url));
type Results = Record<string, Record<string, unknown>>;

interface Run extends ScenarioRun {
  results: Results;
}

async function run(impl: 'wrtc' | 'ours'): Promise<Run> {
  const result = await runScenario(scenario, impl);
  if (result.stdout === '') {
    throw new Error(`the ${impl} scenario was killed before printing its results`);
  }
  return { ...result, results: JSON.parse(result.stdout) };
}

/** Each divergence: [section, key]. */
const divergent: [string, string][] = [
  ['create', 'chat'],
  ['create', 'lossy'],
  ['create', 'timed'],
  ['create', 'negotiated'],
  ['open', 'remote'],
  ['open', 'announced'],
  ['open', 'datachannelEventKeys'],
  ['errors', 'noArguments'],
  ['errors', 'negotiatedWithoutId'],
  ['errors', 'id65535'],
  ['errors', 'idInUse'],
  ['errors', 'longLabel'],
  ['messages', 'sendBlob'],
  ['messages', 'blobOrder'],
  ['messages', 'setBinaryTypeBlob'],
  ['messages', 'setBinaryTypeNonsense'],
  ['messages', 'binaryType'],
  ['messages', 'withBinaryType'],
  ['flow', 'bufferedAmountRightAfterSends'],
  ['flow', 'bufferedamountlow'],
  ['size', 'oneByteMore'],
  ['size', 'readyStateAfter'],
  ['close', 'readyStateAfterClose'],
  ['close', 'local'],
  ['close', 'remote'],
  ['pcClose', 'a'],
  ['pcClose', 'b'],
];

function split(results: Results): { diverged: Record<string, unknown>; rest: Results } {
  const rest: Results = structuredClone(results);
  const diverged: Record<string, unknown> = {};
  for (const [section, key] of divergent) {
    const holder = rest[section] ?? {};
    diverged[`${section}.${key}`] = holder[key];
    delete holder[key];
  }
  return { diverged, rest };
}

const [wrtcRun, oursRun] = await Promise.all([run('wrtc'), run('ours')]);
const wrtc = split(wrtcRun.results);
const ours = split(oursRun.results);

function divergence(path: string): { wrtc: unknown; ours: unknown } {
  return { wrtc: wrtc.diverged[path], ours: ours.diverged[path] };
}

type Settings = Record<string, unknown>;

/** `settings` without `keys`. */
function without(settings: Settings, keys: string[]): Settings {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !keys.includes(key)));
}

// --- The mediasoup path, asserted outright (and also compared below) ---------

test('a mediasoup-style negotiated channel carries text and binary both ways', () => {
  assert.deepEqual(ours.rest.negotiated, {
    messages: [
      { type: 'string', value: 'to b' },
      { type: 'ArrayBuffer', value: [5] },
    ],
  });
});

// --- Intentional divergences ------------------------------------------------

test('divergence: unset limits read null and an unassigned id null (spec); wrtc reads 65535 and -1', () => {
  // Also: wrtc has no bufferedAmountLowThreshold.
  const differing = ['maxPacketLifeTime', 'maxRetransmits', 'id', 'bufferedAmountLowThreshold'];
  for (const name of ['chat', 'lossy', 'timed', 'negotiated']) {
    const { wrtc: w, ours: o } = divergence(`create.${name}`) as { wrtc: Settings; ours: Settings };
    assert.deepEqual(without(o, differing), without(w, differing), name);
  }
  const chat = divergence('create.chat') as { wrtc: Settings; ours: Settings };
  assert.deepEqual(
    [
      chat.ours.maxPacketLifeTime,
      chat.ours.maxRetransmits,
      chat.ours.id,
      chat.ours.bufferedAmountLowThreshold,
    ],
    [null, null, null, 0],
  );
  assert.deepEqual(
    [
      chat.wrtc.maxPacketLifeTime,
      chat.wrtc.maxRetransmits,
      chat.wrtc.id,
      chat.wrtc.bufferedAmountLowThreshold,
    ],
    [65535, 65535, -1, undefined],
  );
  const remote = divergence('open.remote') as {
    wrtc: Record<string, Settings>;
    ours: Record<string, Settings>;
  };
  for (const label of ['chat', 'lossy', 'timed']) {
    assert.deepEqual(
      without(remote.ours[label] ?? {}, differing),
      without(remote.wrtc[label] ?? {}, differing),
      label,
    );
    assert.equal(remote.ours[label]?.id, true, `${label}: both ends have the same id`);
  }
  assert.deepEqual(
    [remote.ours.timed?.maxPacketLifeTime, remote.ours.timed?.maxRetransmits],
    [150, null],
  );
});

test('divergence: createDataChannel throws the spec exceptions; wrtc accepts several invalid calls', () => {
  assert.deepEqual(
    Object.fromEntries(
      ['noArguments', 'negotiatedWithoutId', 'id65535', 'idInUse', 'longLabel'].map((key) => [
        key,
        divergence(`errors.${key}`),
      ]),
    ),
    {
      noArguments: { wrtc: 'no error', ours: 'TypeError' },
      negotiatedWithoutId: { wrtc: 'no error', ours: 'TypeError' },
      id65535: { wrtc: 'InvalidStateError', ours: 'TypeError' },
      idInUse: { wrtc: 'InvalidStateError', ours: 'OperationError' },
      longLabel: { wrtc: 'no error', ours: 'TypeError' },
    },
  );
});

test('divergence: wrtc also fires datachannel for the negotiated channel (labels undefined and "")', () => {
  // Compared as sets: channels are announced as their open messages arrive.
  const { wrtc: w, ours: o } = divergence('open.announced') as { wrtc: string[]; ours: string[] };
  const expected = ['chat open', 'lossy open', 'timed open'];
  assert.deepEqual([...o].sort(), expected);
  assert.deepEqual([...w].sort(), [...expected, 'undefined open', ' open'].sort());
});

test("divergence: the datachannel event's channel is a prototype getter (WebIDL); wrtc's is an own property", () => {
  // Reads and destructuring see it in both (open.datachannelEventChannel,
  // compared below); Object.keys, a spread or JSON.stringify only in wrtc.
  assert.deepEqual(divergence('open.datachannelEventKeys'), { wrtc: ['channel'], ours: [] });
});

test("divergence: close() leaves readyState 'closing' (spec); wrtc reads libwebrtc's live state", () => {
  const { wrtc: w, ours: o } = divergence('close.readyStateAfterClose');
  assert.equal(o, 'closing');
  // 'closing' on macOS; on Linux libwebrtc may already be closed.
  assert.ok(w === 'closing' || w === 'closed', `wrtc: ${w}`);
});

test('divergence: Blobs can be sent (in call order) and received; wrtc throws for both', () => {
  assert.deepEqual(divergence('messages.sendBlob'), { wrtc: 'TypeError', ours: 'no error' });
  assert.deepEqual(divergence('messages.blobOrder'), {
    wrtc: undefined,
    ours: [
      { type: 'ArrayBuffer', value: [...Buffer.from('blob')] },
      { type: 'string', value: 'after blob' },
    ],
  });
  assert.deepEqual(divergence('messages.setBinaryTypeBlob'), {
    wrtc: 'TypeError',
    ours: 'no error',
  });
  assert.deepEqual(divergence('messages.binaryType'), { wrtc: 'arraybuffer', ours: 'blob' });
  assert.deepEqual(divergence('messages.withBinaryType'), {
    wrtc: [{ type: 'ArrayBuffer', value: [7, 8] }],
    ours: [{ type: 'Blob', value: [7, 8] }],
  });
});

test('divergence: an invalid binaryType is ignored (WebIDL enum); wrtc throws', () => {
  assert.deepEqual(divergence('messages.setBinaryTypeNonsense'), {
    wrtc: 'TypeError',
    ours: 'no error',
  });
});

test('divergence: bufferedAmount grows on send() and bufferedamountlow fires; wrtc reads 0 and never fires it', () => {
  assert.deepEqual(divergence('flow.bufferedAmountRightAfterSends'), { wrtc: 0, ours: 8 * 65536 });
  assert.deepEqual(divergence('flow.bufferedamountlow'), { wrtc: [], ours: [true] });
});

test('divergence: a message over maxMessageSize is a TypeError; wrtc sends it and its channel closes', () => {
  assert.deepEqual(divergence('size.oneByteMore'), { wrtc: 'no error', ours: 'TypeError' });
  assert.deepEqual(divergence('size.readyStateAfter'), { wrtc: 'closed', ours: 'open' });
});

test('divergence: the end that did not call close() fires closing first (spec); wrtc has no closing', () => {
  assert.deepEqual(divergence('close.local'), {
    wrtc: { closer: ['timed close'], other: ['timed close'] },
    ours: { closer: ['timed close'], other: ['timed closing', 'timed close'] },
  });
  assert.deepEqual(divergence('close.remote'), {
    wrtc: { closer: ['lossy close'], other: ['lossy close'] },
    ours: { closer: ['lossy close'], other: ['lossy closing', 'lossy close'] },
  });
});

test('divergence: pc.close() fires nothing locally (spec); the remote gets closing, error, close', () => {
  // wrtc fires close on the closed connection's own channels, and no error
  // remotely. The remote `closing` is Chrome's behaviour (the spec has none
  // for an abrupt close).
  const local = divergence('pcClose.a') as { wrtc: string[]; ours: string[] };
  assert.deepEqual(local.ours, []);
  // wrtc's comes from its own threads, normally within the scenario's wait.
  assert.ok(
    local.wrtc.every((e) => e === 'ms close'),
    `wrtc: ${local.wrtc}`,
  );
  assert.deepEqual(divergence('pcClose.b'), {
    wrtc: ['chat close'],
    ours: ['chat closing', 'chat error', 'chat close'],
  });
});

test('ours exits on its own once both peer connections are closed', (t) => {
  assert.ok(oursRun.exitedOnItsOwn, 'ours had to be killed after printing its results');
  if (wrtcRun.crashed) t.diagnostic(`@roamhq/wrtc crashed (${wrtcRun.crashed}) after its results`);
});

// --- Everything else matches wrtc -------------------------------------------

for (const section of Object.keys(wrtc.rest)) {
  test(`matches wrtc: ${section}`, () => {
    assert.deepEqual(ours.rest[section], wrtc.rest[section]);
  });
}
