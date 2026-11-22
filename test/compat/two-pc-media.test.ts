// Milestone 1 acceptance: the two-PC media scenario (two-pc-media-
// scenario.mjs) run against @roamhq/wrtc and against ours, each in its own
// process. Everything observable must match, except the intentional
// divergences, which are split out first and asserted on their own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runScenario, type ScenarioRun } from './run-scenario.ts';

const scenario = fileURLToPath(new URL('./two-pc-media-scenario.mjs', import.meta.url));
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
  ['signaling', 'negotiationneededBeforeFirstOffer'],
  ['ice', 'sequenceA'],
  ['remoteStream', 'removetrackEvents'],
  ['replaceTrack', 'senderTrackBeforeAwait'],
  ['reAdd', 'remoteStreamReused'],
  ['statsKeys', 'a'],
  ['statsKeys', 'b'],
  ['getStatsSelectorTypes', 'sender'],
  ['getStatsSelectorTypes', 'receiver'],
  ['getConfiguration', 'certificates'],
  ['getConfiguration', 'iceServers'],
  ['errors', 'srdGarbage'],
  ['errors', 'addIceCandidateUnknownMid'],
  ['errors', 'turnWithoutCredentials'],
  ['close', 'getTransceivers'],
  ['close', 'addTransceiver'],
  ['close', 'getStats'],
  ['close', 'getStatsPolling'],
  ['close', 'eventsAfterClose'],
  ['stop', 'endedEvents'],
  ['close', 'remoteTrackEnded'],
  ['close', 'endedEvents'],
  ['transportsAtOffer', 'role'],
  ['transports', 'candidateGetters'],
  ['remoteTrack', 'labels'],
  ['eventShapes', 'trackKeys'],
  ['eventShapes', 'icecandidateKeys'],
];

type StatsKeys = Record<string, string[]>;
type Both<T> = { wrtc: T; ours: T };

// The stats comparison. The scenario samples stats only once both peers have
// the members that wait on media or RTCP (framesPerSecond, round-trip times,
// the remote-* types), so the differences left are between the two
// libwebrtc versions (our newer M150, wrtc's older one), plus one slow
// member (timingDependentStatsMembers). Each version allowance is one-way:
// a member listed as ours-only fails the test if wrtc reports it and we
// don't. RTP streams are keyed `<type>/<kind>`; candidates and pairs are
// the selected pair's.

/** Members only our (newer) libwebrtc reports: wrtc's version predates them. */
const oursOnlyStatsMembers: Record<string, string[]> = {
  'candidate-pair': ['lastPacketReceivedTimestamp', 'lastPacketSentTimestamp'],
  'local-candidate': ['foundation', 'usernameFragment'],
  // RTCVideoSourceStats: wrtc's video source never reports its frame size
  // (libwebrtc's AdaptedVideoTrackSource records it only in AdaptFrame).
  'media-source': ['height', 'width'],
  'remote-candidate': ['foundation', 'usernameFragment'],
  'inbound-rtp/audio': [
    'delayedPacketOutageSamples',
    'interruptionCount',
    'jitterBufferFlushes',
    'packetsReceivedWithCe',
    'packetsReceivedWithEct1',
    'relativePacketArrivalDelay',
    'totalInterruptionDuration',
    'totalProcessingDelay',
  ],
  'inbound-rtp/video': [
    'freezeCount',
    // wrtc's libwebrtc reports it only for a frame that carried timing info
    // (none in this scenario); ours from the first frames.
    'googTimingFrameInfo',
    'jitterBufferMinimumDelay',
    'jitterBufferTargetDelay',
    'packetsReceivedWithCe',
    'packetsReceivedWithEct1',
    'pauseCount',
    'powerEfficientDecoder',
    // Points at remote-outbound-rtp/video, which only ours reports (below).
    'remoteId',
    'retransmittedBytesReceived',
    'retransmittedPacketsReceived',
    'rtxSsrc',
    'totalFreezesDuration',
    'totalPausesDuration',
  ],
  'outbound-rtp/audio': ['packetsSentWithEct1', 'totalPacketSendDelay'],
  'outbound-rtp/video': [
    'encodingIndex',
    'packetsSentWithEct1',
    'powerEfficientEncoder',
    'rtxSsrc',
    'scalabilityMode',
    'targetBitrate',
  ],
};

/**
 * Members only wrtc reports. trackId joins an RTP stream to its legacy
 * 'track' stats, which we decided not to synthesize.
 */
const wrtcOnlyStatsMembers: Record<string, string[]> = {
  'inbound-rtp/audio': ['trackId'],
  'inbound-rtp/video': ['trackId'],
  'outbound-rtp/audio': ['trackId'],
  'outbound-rtp/video': ['trackId'],
};

/**
 * Stats types only one side reports. wrtc's libwebrtc only turns sender
 * reports into remote-outbound-rtp for audio; ours does for video too (both
 * report remote-outbound-rtp/audio, which must match).
 */
const oursOnlyStatsTypes = new Set(['remote-outbound-rtp/video']);
/** The legacy types wrtc's libwebrtc still has; we decided not to synthesize them. */
const wrtcOnlyStatsTypes = new Set(['track', 'stream']);

/**
 * The one timing-dependent member left, allowed either way: it needs an
 * RTP-to-NTP mapping, which takes two RTCP sender reports. For audio those
 * arrive about 5 s apart, so both implementations take 6 to 10 s to report
 * it; waiting for it would more than double the scenario's run time.
 */
const timingDependentStatsMembers: Record<string, string[]> = {
  'inbound-rtp/audio': ['estimatedPlayoutTimestamp'],
  'inbound-rtp/video': ['estimatedPlayoutTimestamp'],
};

/** The stats differences outside the allowlists, one line each. */
function unexpectedStatsDifferences(ours: StatsKeys, wrtc: StatsKeys): string[] {
  const problems: string[] = [];
  for (const type of new Set([...Object.keys(ours), ...Object.keys(wrtc)])) {
    const [o, w] = [ours[type], wrtc[type]];
    if (!o || !w) {
      if (!(o ? oursOnlyStatsTypes : wrtcOnlyStatsTypes).has(type)) {
        problems.push(`${type}: only ${o ? 'ours' : 'wrtc'} reports it`);
      }
      continue;
    }
    const timing = timingDependentStatsMembers[type] ?? [];
    const oursOnly = [...(oursOnlyStatsMembers[type] ?? []), ...timing];
    const wrtcOnly = [...(wrtcOnlyStatsMembers[type] ?? []), ...timing];
    for (const key of o.filter((k) => !w.includes(k) && !oursOnly.includes(k))) {
      problems.push(`${type}.${key}: only ours`);
    }
    for (const key of w.filter((k) => !o.includes(k) && !wrtcOnly.includes(k))) {
      problems.push(`${type}.${key}: only wrtc`);
    }
  }
  return problems;
}

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

// --- The milestone 1 path, asserted outright (and also compared below) ------

test('remote audio reaches a nonstandard sink at 48 kHz mono, 480 frames, Int16Array', () => {
  assert.deepEqual(ours.rest.remoteAudio, {
    keys: ['samples', 'bitsPerSample', 'sampleRate', 'channelCount', 'numberOfFrames'],
    samples: 'Int16Array',
    sampleRate: 48_000,
    numberOfFrames: 480,
    channelCount: 1,
    bitsPerSample: 16,
  });
});

test('remote video reaches a nonstandard sink as tightly packed I420 in a Uint8Array', () => {
  assert.deepEqual(ours.rest.remoteVideo, {
    keys: ['width', 'height', 'rotation', 'data'],
    data: 'Uint8Array',
    length: 320 * 240 * 1.5,
    rotation: 0,
  });
});

test("both ways: the answerer's track, added after setRemoteDescription, reaches the offerer's sink", () => {
  assert.deepEqual(ours.rest.answererAddTrack, {
    reusedOfferedTransceiver: true,
    senderTrack: true,
    directions: [
      ['0', 'sendrecv', null],
      ['1', 'recvonly', null],
    ],
  });
  assert.deepEqual(ours.rest.reverseAudio, { sampleRate: 48_000, numberOfFrames: 480 });
});

test('clones of remote tracks end when the remote stops the transceiver, and on close()', () => {
  const stop = ours.rest.stop as Record<string, { tracks: string[]; clones: string[] }>;
  assert.deepEqual(stop.afterNegotiation?.clones, ['live', 'live', 'ended']);
  assert.deepEqual(ours.rest.close?.clones, {
    tracks: ['ended', 'ended', 'ended'],
    clones: ['ended', 'ended', 'ended'],
  });
});

test('track events carry the sent stream, as one MediaStream holding both tracks', () => {
  assert.deepEqual(ours.rest.remoteStream, {
    sameObjectForBothTracks: true,
    isMediaStream: true,
    tracks: ['audio', 'video'],
    getReceiversMatch: true,
    tracksAfterRemoval: [],
  });
});

// --- Intentional divergences ------------------------------------------------

test('divergence: remote tracks end with ended, in a queued task, when the transceiver stops or the PC closes (spec, Chrome)', () => {
  // Decided 2026-11-20 (SPEC-LAYER-PLAN.md, "MediaStreamTrack"): wrtc ends
  // them synchronously and fires nothing. A task later both read "ended"
  // (stop.afterNegotiation, close.remoteTrackEndedAfterTasks).
  assert.deepEqual(divergence('stop.endedEvents'), { wrtc: [], ours: ['track 2', 'clone 2'] });
  assert.deepEqual(divergence('close.remoteTrackEnded'), { wrtc: 'ended', ours: 'live' });
  assert.deepEqual(divergence('close.endedEvents'), {
    wrtc: [],
    // Each track, then its clones (they share its source).
    ours: ['track 0', 'clone 0', 'track 1', 'clone 1'],
  });
});

test('divergence: negotiationneeded is suppressed while an offer is already chained (spec, Chrome)', () => {
  // addTrack, then createOffer in the same task: the spec (and libwebrtc's
  // shouldFireNegotiationNeededEvent) drop the event because the operations
  // chain is busy; wrtc fires it anyway.
  assert.deepEqual(divergence('signaling.negotiationneededBeforeFirstOffer'), {
    wrtc: true,
    ours: false,
  });
});

test('divergence: gathering ends with an end-of-candidates ("") candidate before null (spec)', () => {
  assert.deepEqual(divergence('ice.sequenceA'), {
    wrtc: ['candidate', 'null'],
    ours: ['candidate', 'end-of-candidates', 'null'],
  });
});

test("divergence: a remote track's label is 'remote <kind>' (spec, Chrome)", () => {
  assert.deepEqual(divergence('remoteTrack.labels'), {
    wrtc: ['undefined', 'undefined'],
    ours: ['remote audio', 'remote video'],
  });
});

test("divergence: event payloads are prototype getters (WebIDL); wrtc's are own properties", () => {
  // Decided 2026-11-21 (SPEC-LAYER-PLAN.md, "Events"). Reads and
  // destructuring see the payload in both (eventShapes.*Destructures,
  // compared below); Object.keys, a spread or JSON.stringify only in wrtc.
  assert.deepEqual(divergence('eventShapes.trackKeys'), {
    wrtc: ['receiver', 'streams', 'track', 'transceiver'],
    ours: [],
  });
  assert.deepEqual(divergence('eventShapes.icecandidateKeys'), {
    wrtc: ['candidate'],
    ours: [],
  });
});

test('divergence: remote streams fire removetrack when a track stops being received (spec)', () => {
  // wrtc's remote stream loses the tracks too, but silently.
  assert.deepEqual(divergence('remoteStream.removetrackEvents'), { wrtc: 0, ours: 3 });
});

test('stats: both peers report the same members per type, apart from libwebrtc version differences', () => {
  for (const peer of ['a', 'b']) {
    const { wrtc: w, ours: o } = divergence(`statsKeys.${peer}`) as Both<StatsKeys>;
    assert.deepEqual(unexpectedStatsDifferences(o, w), [], `peer ${peer}`);
    // The legacy member wrtc-era code reads, on every local RTP stream.
    for (const [type, keys] of Object.entries(o)) {
      if (/^(in|out)bound-rtp\//.test(type)) {
        assert.ok(keys.includes('mediaType'), `${peer} ${type}`);
      }
    }
  }
});

test('divergence: no legacy track stats in getStats(selector)', () => {
  const { wrtc: w, ours: o } = divergence('getStatsSelectorTypes.sender') as Both<string[]>;
  assert.deepEqual(
    w.filter((type) => !o.includes(type)),
    ['track'],
  );
  const receiver = divergence('getStatsSelectorTypes.receiver') as Both<string[]>;
  assert.deepEqual(
    receiver.wrtc.filter((type) => !receiver.ours.includes(type)),
    ['track'],
  );
});

test('divergence: sender.track changes a task after replaceTrack(), when it resolves (spec)', () => {
  // wrtc's replaceTrack is synchronous; the spec sets [[SenderTrack]] in a
  // queued task. Both have the new track once the promise resolves.
  assert.deepEqual(divergence('replaceTrack.senderTrackBeforeAwait'), { wrtc: true, ours: false });
});

test('divergence: a remote stream id keeps its MediaStream object after its tracks left', () => {
  // A re-added track arrives in the same stream id: ours hands out the
  // same object (one MediaStream per id per connection); wrtc a new one.
  assert.deepEqual(divergence('reAdd.remoteStreamReused'), { wrtc: false, ours: true });
});

test("divergence: an ICE transport's role is 'unknown' until the answer (WPT); wrtc's is libwebrtc's at once", () => {
  assert.deepEqual(divergence('transportsAtOffer.role'), { wrtc: 'controlling', ours: 'unknown' });
  assert.equal(ours.rest.transports?.role, 'controlling', 'the same once answered');
});

test("divergence: an ICE transport's candidate pair, candidate and parameter getters work; wrtc's throw", () => {
  assert.deepEqual(divergence('transports.candidateGetters'), {
    wrtc: Array(5).fill('throws Error'),
    ours: ['object', 'array', 'array', 'object', 'object'],
  });
});

test('divergence: getConfiguration includes certificates (spec)', () => {
  assert.deepEqual(divergence('getConfiguration.certificates'), { wrtc: undefined, ours: [] });
});

test("divergence: getConfiguration's ICE servers read as Chrome's (urls a list; username, credential '')", () => {
  assert.deepEqual(divergence('getConfiguration.iceServers'), {
    wrtc: [{ urls: 'stun:stun.example.org:3478' }],
    ours: [{ urls: ['stun:stun.example.org:3478'], username: '', credential: '' }],
  });
});

test('divergence: errors are the DOMExceptions the spec names; wrtc throws plain Errors', () => {
  assert.deepEqual(divergence('errors.srdGarbage'), {
    wrtc: { name: 'TypeError' },
    ours: { name: 'OperationError' }, // an RTCError with errorDetail 'sdp-syntax-error'
  });
  assert.deepEqual(divergence('errors.addIceCandidateUnknownMid'), {
    wrtc: { name: 'Error' },
    ours: { name: 'OperationError' },
  });
  assert.deepEqual(divergence('errors.turnWithoutCredentials'), {
    wrtc: { name: 'Error' },
    ours: { name: 'InvalidAccessError' },
  });
  assert.deepEqual(divergence('close.addTransceiver'), {
    wrtc: { name: 'Error' },
    ours: { name: 'InvalidStateError' },
  });
});

test('divergence: after close, transceivers stay listed and getStats keeps resolving (spec)', () => {
  // stop() on a held transceiver throws InvalidStateError in both (compared below).
  assert.deepEqual(divergence('close.getTransceivers'), { wrtc: 0, ours: 2 });
  assert.deepEqual(divergence('close.getStats'), { wrtc: { name: 'Error' }, ours: { ok: true } });
  const error = { name: 'Error' };
  assert.deepEqual(divergence('close.getStatsPolling'), {
    wrtc: [error, error, error],
    ours: [{ ok: true }, { ok: true }, { ok: true }],
  });
});

test('divergence: close() fires no events (spec); wrtc fires the closed state changes', () => {
  const { wrtc: fromWrtc, ours: fromOurs } = divergence('close.eventsAfterClose');
  assert.deepEqual(fromOurs, []);
  assert.deepEqual([...(fromWrtc as string[])].sort(), [
    'connectionstatechange',
    'iceconnectionstatechange',
    'signalingstatechange',
  ]);
});

test('ours exits on its own once both peer connections are closed and the sinks stopped', (t) => {
  assert.ok(oursRun.exitedOnItsOwn, 'ours had to be killed after printing its results');
  if (wrtcRun.crashed) t.diagnostic(`@roamhq/wrtc crashed (${wrtcRun.crashed}) after its results`);
});

// --- Everything else matches wrtc -------------------------------------------

for (const section of Object.keys(wrtc.rest)) {
  test(`matches wrtc: ${section}`, () => {
    assert.deepEqual(ours.rest[section], wrtc.rest[section]);
  });
}
