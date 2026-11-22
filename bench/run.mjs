#!/usr/bin/env node
// Benchmarks this library against @roamhq/wrtc. Each run is one
// implementation in its own child process (bench/scenario.mjs): never load
// both addons in one process. Runs alternate the implementation order
// (ours first, then wrtc first, ...) so slow drift on the machine hits both.
//
//   pnpm run bench [--configs audio,vga,...] [--runs 5] [--duration 20]
//                  [--warmup 5] [--impls ours,wrtc] [--out bench/out] [--src]
//   node bench/run.mjs --report a.json[,b.json]   (re-render saved results)
//
// Prints a Markdown table per configuration (median [min-max] per metric,
// and ours/wrtc) and writes it plus the raw JSON to --out.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const root = new URL('..', import.meta.url).pathname;
const scenario = join(root, 'bench/scenario.mjs');

/** Every configuration. `pairs` is the number of loopback peer connection pairs. */
const CONFIGS = {
  audio: { kind: 'media', pairs: 1, audio: true, width: 0, height: 0, fps: 0 },
  vga: { kind: 'media', pairs: 1, audio: true, width: 640, height: 480, fps: 30 },
  hd: { kind: 'media', pairs: 1, audio: true, width: 1280, height: 720, fps: 30 },
  'vga-x4': { kind: 'media', pairs: 4, audio: true, width: 640, height: 480, fps: 30 },
  'vga-x8': { kind: 'media', pairs: 8, audio: true, width: 640, height: 480, fps: 30 },
  // Receive-heavy: one pair whose sender has 6 VGA tracks, so 6 remote sinks.
  'recv-x6': {
    kind: 'media',
    pairs: 1,
    audio: true,
    width: 640,
    height: 480,
    fps: 30,
    videoTracks: 6,
  },
  // Simulcast send, video only: 3 layers of 1280x720, each received on its own m-line.
  simulcast: {
    kind: 'media',
    pairs: 1,
    audio: false,
    width: 1280,
    height: 720,
    fps: 30,
    simulcast: [
      { rid: 'q', scaleResolutionDownBy: 4 },
      { rid: 'h', scaleResolutionDownBy: 2 },
      { rid: 'f', scaleResolutionDownBy: 1 },
    ],
  },
  // The binding alone: 4 local 720p30 + audio sources straight into sinks.
  local: { kind: 'local', pairs: 4, audio: true, width: 1280, height: 720, fps: 30 },
  control: { kind: 'control', iterations: 10 },
};
const DESCRIPTIONS = {
  audio: '1 pair, audio only',
  vga: '1 pair, audio + 640x480@30 VP8',
  hd: '1 pair, audio + 1280x720@30 VP8',
  'vga-x4': '4 pairs, each audio + 640x480@30 VP8',
  'vga-x8': '8 pairs, each audio + 640x480@30 VP8',
  'recv-x6': 'receive-heavy: 1 pair, audio + 6 VP8 tracks of 640x480@30 into 6 remote sinks',
  simulcast:
    'simulcast send: 1 pair, video only, 1280x720@30 VP8 in 3 layers (q 1/4, h 1/2, f), one sink per layer',
  local: 'no peer connection: 4 local sources (audio + 1280x720@30) straight into sinks',
  control: 'control-plane timings, 10 iterations per run (plus 1 discarded warm-up)',
};

const { values: args } = parseArgs({
  options: {
    configs: { type: 'string', default: Object.keys(CONFIGS).join(',') },
    runs: { type: 'string', default: '5' },
    duration: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '5' },
    impls: { type: 'string', default: 'ours,wrtc' },
    out: { type: 'string', default: join(root, 'bench/out') },
    src: { type: 'boolean', default: false },
    report: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});
if (args.help) {
  console.log(`usage: pnpm run bench [options]
  --configs a,b,...  ${Object.keys(CONFIGS).join(', ')} (default: all)
  --runs N           runs per implementation and configuration (default 5)
  --duration S       measured window per media run, seconds (default 20)
  --warmup S         media flowing before the window, seconds (default 5)
  --impls ours,wrtc  implementations to run (default both)
  --out DIR          where the .md and .json go (default bench/out)
  --src              load ours from lib/*.ts instead of the compiled dist/
  --report a.json,b.json
                     run nothing: print the tables of saved results; a later
                     file's configs replace an earlier one's (for reruns)`);
  process.exit(0);
}
const names = args.configs.split(',').filter(Boolean);
for (const name of names) {
  if (!CONFIGS[name]) throw new Error(`unknown config ${name}; known: ${Object.keys(CONFIGS)}`);
}
const impls = args.impls.split(',').filter(Boolean);
const runs = Number(args.runs);
const durationS = Number(args.duration);
const warmupS = Number(args.warmup);

/** How long to wait for a child to exit on its own after printing its results. */
const EXIT_WAIT_MS = 10_000;

/**
 * Before killing a child that hangs: its native stacks, on macOS via
 * `sample` (no root needed for our own processes). Returns the file, or null.
 */
function sampleStacks(pid, label) {
  if (os.platform() !== 'darwin') return Promise.resolve(null);
  const file = join(args.out, `hang-${label}.sample.txt`);
  return new Promise((resolve) => {
    const sampler = spawn('sample', [String(pid), '2', '-file', file], { stdio: 'ignore' });
    sampler.on('error', () => resolve(null));
    sampler.on('close', (code) => resolve(code === 0 ? file : null));
  });
}

/** One child run: its parsed result plus how its process ended. */
function runOnce(impl, config, label) {
  const timeoutMs =
    120_000 + (config.warmupS + config.durationS) * 1000 + (config.pairs ?? 1) * 10_000;
  // Wall clock vs monotonic clock: the monotonic one stops while the
  // machine sleeps, so a difference flags a run that spanned a sleep.
  const wallStart = Date.now();
  const monoStart = performance.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scenario, impl, JSON.stringify(config)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let printedAt = null;
    let exitTimer = null;
    let exitedAt = null;
    let hangSample = null;
    const runTimer = setTimeout(async () => {
      hangSample = await sampleStacks(child.pid, `${label}-timeout`);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (printedAt === null && stdout.includes('\n')) {
        printedAt = performance.timeOrigin + performance.now();
        exitTimer = setTimeout(async () => {
          hangSample = await sampleStacks(child.pid, label);
          child.kill('SIGKILL');
        }, EXIT_WAIT_MS);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', () => {
      exitedAt = performance.timeOrigin + performance.now();
    });
    // 'close', not 'exit': the pipes are drained, so stdout and stderr are complete.
    child.on('close', (code, signal) => {
      clearTimeout(runTimer);
      clearTimeout(exitTimer);
      let parsed = null;
      try {
        parsed = JSON.parse(stdout.split('\n')[0]);
      } catch {}
      const hung = signal === 'SIGKILL' && printedAt !== null;
      // The scenario's own report of what kept a hung process alive.
      const diag = /^bench-hang-diag (.*)$/m.exec(stderr)?.[1];
      const wallEnd = Date.now();
      const clock = {
        start: new Date(wallStart).toISOString(),
        end: new Date(wallEnd).toISOString(),
        sleepDriftMs: Math.round(wallEnd - wallStart - (performance.now() - monoStart)),
      };
      resolve({
        impl,
        clock,
        ok: parsed !== null,
        result: parsed?.result ?? null,
        exit: {
          code,
          signal: hung ? null : signal,
          hung,
          // From the child's results line to the parent seeing it exit.
          afterMs: parsed && !hung ? exitedAt - printedAt : null,
          forced: impl === 'wrtc' && config.kind !== 'control',
          ...(hung ? { diag: diag ? JSON.parse(diag) : null } : {}),
          ...(hangSample ? { sample: hangSample } : {}),
        },
        stderr: parsed ? stderr.slice(0, 2000) : stderr.slice(-4000),
      });
    });
  });
}

// --- Aggregation ------------------------------------------------------------------
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
};

/** [label, key, digits] per configuration kind. */
const MEDIA_METRICS = [
  ['CPU, % of one core', 'cpuPct', 1],
  ['  user', 'cpuUserPct', 1],
  ['  sys', 'cpuSysPct', 1],
  ['RSS steady (median), MB', 'rssMedianMB', 0],
  ['RSS peak in window, MB', 'rssMaxMB', 0],
  ['RSS peak, process lifetime, MB', 'maxRssMB', 0],
  ['JS heap used (median), MB', 'heapUsedMedianMB', 1],
  ['external + ArrayBuffers (median), MB', 'externalMedianMB', 1],
  ['event-loop delay p50, ms', 'eldP50Ms', 2],
  ['event-loop delay p99, ms', 'eldP99Ms', 2],
  ['event-loop delay max, ms', 'eldMaxMs', 1],
  ['GC events / s', 'gcPerS', 1],
  ['  major GC / s', 'gcMajorPerS', 2],
  ['GC time, ms / s', 'gcMsPerS', 2],
  ['JS (main) thread CPU, ms / s', 'mainThreadCpuMsPerS', 1],
  [
    '  outside pushes and handlers (sink delivery, callbacks, timers, GC)',
    'mainThreadOtherCpuMsPerS',
    1,
  ],
  ['JS thread busy (event-loop utilization, wall clock), ms / s', 'jsBusyMsPerS', 1],
  ['  in onData/onFrame pushes', 'pushMsPerS', 2],
  ['  in sink handlers (this script)', 'handlerMsPerS', 2],
  ['  other: sink event delivery, callbacks, timers, GC', 'jsOtherMsPerS', 1],
  ['push timer lateness p99, ms', 'pumpLateP99Ms', 2],
  ['audio sink callbacks / s (per sink)', 'audioCallbacksPerS', 1],
  ['video streams sent (all pairs)', 'videoStreamsSent', 0],
  ['video sinks', 'videoSinks', 0],
  ['video frames / s delivered (per sink)', 'videoFpsPerSink', 1],
  ['  slowest sink', 'videoFpsMinSink', 1],
  ['video frames never delivered, %', 'videoDroppedPct', 2],
  ['frames at full (expected) resolution, %', 'videoFullResPct', 1],
  ['source-to-sink latency p50, ms', 'latencyP50Ms', 1],
  ['source-to-sink latency p99, ms', 'latencyP99Ms', 1],
  ['source-to-sink latency max, ms', 'latencyMaxMs', 1],
  ['frames later than 100 ms, %', 'lateFramesPct', 2],
  ['video packet send (pacer) delay, ms / packet', 'packetSendDelayMs', 2],
  ['audio packet send delay, ms / packet', 'audioPacketSendDelayMs', 2],
  ['jitter buffer delay, ms / frame', 'jitterBufferMsPerFrame', 1],
  ['receive processing delay (arrival to decoded), ms / frame', 'processingMsPerFrame', 1],
  ['video bitrate, kbps (per pair)', 'videoKbps', 0],
  ['audio bitrate, kbps (per pair)', 'audioKbps', 1],
  ['encode time, ms / frame', 'encodeMsPerFrame', 2],
  ['decode time, ms / frame', 'decodeMsPerFrame', 2],
  ['average QP', 'qpAvg', 1],
  ['frames encoded / s (per pair, all layers)', 'framesEncodedPerS', 1],
  ['process CPU per encoded frame, ms', 'cpuMsPerEncodedFrame', 2],
  ['teardown (stop sinks, close PCs), ms', 'teardownMs', 1],
  ['exit after teardown, ms', 'exitMs', 0],
  ['load average (1 min) after the run', 'loadAvg', 2],
];
const LOCAL_METRICS = MEDIA_METRICS.filter(([, key]) =>
  [
    'jsBusyMsPerS',
    'mainThreadCpuMsPerS',
    'mainThreadOtherCpuMsPerS',
    'handlerMsPerS',
    'jsOtherMsPerS',
    'loadAvg',
    'cpuPct',
    'cpuUserPct',
    'cpuSysPct',
    'rssMedianMB',
    'rssMaxMB',
    'heapUsedMedianMB',
    'externalMedianMB',
    'eldP50Ms',
    'eldP99Ms',
    'eldMaxMs',
    'gcPerS',
    'gcMajorPerS',
    'gcMsPerS',
    'pushMsPerS',
    'pumpLateP99Ms',
    'audioCallbacksPerS',
    'videoFpsPerSink',
    'latencyP50Ms',
    'latencyP99Ms',
    'exitMs',
  ].includes(key),
);
const CONTROL_METRICS = [
  ['addon load (import), ms', 'loadMs', 1],
  ['new RTCPeerConnection(), ms', 'constructMsP50', 2],
  ['createOffer(), ms', 'createOfferMsP50', 2],
  ['createOffer to both connected, ms', 'offerToConnectedMsP50', 1],
  ['renegotiation (addTrack to answer applied), ms', 'renegotiateMsP50', 1],
  ['renegotiation to remote track event, ms', 'renegotiateTrackMsP50', 1],
  ['  createOffer', 'reneg_createOfferMsP50', 2],
  ['  setLocalDescription(offer)', 'reneg_sldOfferMsP50', 2],
  ['  setRemoteDescription(offer)', 'reneg_srdOfferMsP50', 2],
  ['  createAnswer', 'reneg_createAnswerMsP50', 2],
  ['  setLocalDescription(answer)', 'reneg_sldAnswerMsP50', 2],
  ['  setRemoteDescription(answer)', 'reneg_srdAnswerMsP50', 2],
  ['  renegotiation offer size, bytes', 'offerSdpBytesP50', 0],
  ['  video payload types offered', 'videoPayloadTypesP50', 0],
  ['getStats() p50, ms', 'getStatsMsP50', 2],
  ['getStats() p99, ms', 'getStatsMsP99', 2],
  ['close(), ms', 'closeMsP50', 2],
  ['process exit after close, ms', 'exitMs', 0],
  ['load average (1 min) after the run', 'loadAvg', 2],
];
const metricsFor = (kind) =>
  kind === 'control' ? CONTROL_METRICS : kind === 'local' ? LOCAL_METRICS : MEDIA_METRICS;

/** A run's value for `key`, with the exit time and load folded in. */
function metricOf(run, key) {
  if (key === 'exitMs') return run.exit.forced || run.exit.hung ? null : run.exit.afterMs;
  if (key === 'loadAvg') return run.loadAvg ?? null;
  const value = run.result?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function summarize(values) {
  const numbers = values.filter((v) => v !== null);
  if (numbers.length === 0) return null;
  return {
    n: numbers.length,
    median: quantile(numbers, 0.5),
    min: Math.min(...numbers),
    max: Math.max(...numbers),
  };
}

const fmt = (x, digits) => (x === null ? 'n/a' : x.toFixed(digits));
const cell = (s, digits) =>
  s === null ? 'n/a' : `${fmt(s.median, digits)} [${fmt(s.min, digits)}–${fmt(s.max, digits)}]`;

/** Killed by the run timeout before printing results: the scenario itself hung. */
const timedOut = (run) => !run.ok && run.exit.signal === 'SIGKILL';
/** Died of a signal of its own (wrtc's crashes on exit). */
const crashed = (run) => run.exit.signal && !timedOut(run);

/** What the exit column says when there's no exit time: forced, hung, crashed. */
function exitNote(runs) {
  const notes = new Set();
  for (const run of runs) {
    if (run.exit.forced) notes.add('process.exit()');
    if (run.exit.hung) notes.add(`hung (killed after ${EXIT_WAIT_MS / 1000} s)`);
    if (crashed(run)) notes.add(`crashed: ${run.exit.signal}`);
  }
  return [...notes];
}

/**
 * Ours/wrtc per round: run i of each ran back to back (interleaved), so a
 * slow period on the machine hits both sides of a pair. Null if unpaired.
 */
function pairedRatios(byImpl, key) {
  const [x, y] = Object.values(byImpl);
  const ratios = [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const a = metricOf(x[i], key);
    const b = metricOf(y[i], key);
    if (a !== null && b !== null && b !== 0) ratios.push(a / b);
  }
  return summarize(ratios);
}

/** The exit cell's notes on runs with no exit time, and how many crashed or hung. */
function exitCell(runs, s, digits) {
  const ended = runs.filter((r) => r.ok);
  const parts = [];
  const crashedRuns = ended.filter(crashed);
  if (crashedRuns.length) {
    const signals = [...new Set(crashedRuns.map((r) => r.exit.signal))].join('/');
    parts.push(`${crashedRuns.length}/${ended.length} crashed: ${signals}`);
  }
  const hungRuns = ended.filter((r) => r.exit.hung).length;
  if (hungRuns) {
    parts.push(
      `**${hungRuns}/${ended.length} hung** after printing results (killed after ${EXIT_WAIT_MS / 1000} s)`,
    );
  }
  if (s === null) return exitNote(runs).join(', ') || 'n/a';
  return `${cell(s, digits)}${parts.length ? ` (${parts.join('; ')})` : ''}`;
}

function table(name, kind, byImpl) {
  const impls = Object.keys(byImpl);
  const two = impls.length === 2;
  const lines = [
    `### ${name}: ${DESCRIPTIONS[name] ?? ''}`,
    '',
    `| metric | ${impls.join(' | ')} |${two ? ' ours / wrtc (medians) | paired ours / wrtc per run |' : ''}`,
    `|---|${impls.map(() => '---|').join('')}${two ? '---|---|' : ''}`,
  ];
  for (const [label, key, digits] of metricsFor(kind)) {
    const stats = impls.map((impl) => summarize(byImpl[impl].map((run) => metricOf(run, key))));
    if (stats.every((s) => s === null) && key !== 'exitMs') continue;
    const cells = stats.map((s, i) =>
      key === 'exitMs' ? exitCell(byImpl[impls[i]], s, digits) : cell(s, digits),
    );
    let ratio = '';
    if (two) {
      const [x, y] = stats;
      // wrtc's exit is forced or a crash, so an exit-time ratio means nothing.
      const comparable = x && y && y.median !== 0 && key !== 'exitMs' && key !== 'loadAvg';
      const paired = comparable ? pairedRatios(byImpl, key) : null;
      ratio = comparable
        ? ` ${(x.median / y.median).toFixed(2)} | ${paired ? cell(paired, 2) : 'n/a'} |`
        : ' n/a | n/a |';
    }
    lines.push(`| ${label} | ${cells.join(' | ')} |${ratio}`);
  }
  // Facts that should be identical across runs: report each distinct value.
  for (const key of ['codec', 'encoder', 'decoder', 'qualityLimitation']) {
    const seen = impls.map((impl) => [
      ...new Set(byImpl[impl].map((run) => run.result?.[key]).filter((v) => v)),
    ]);
    if (seen.every((s) => s.length === 0)) continue;
    lines.push(
      `| ${key} | ${seen.map((s) => s.join(', ') || 'n/a').join(' | ')} |${two ? ' | |' : ''}`,
    );
  }
  const notes = impls.flatMap((impl) =>
    [
      ...new Set(
        byImpl[impl].flatMap((run) => [
          ...(run.result?.notes ?? []),
          ...(run.result?.statsErrors ?? []),
        ]),
      ),
    ].map((note) => `- ${impl}: ${note}`),
  );
  const failed = impls.flatMap((impl) =>
    byImpl[impl]
      .filter((run) => !run.ok)
      .map((run) =>
        timedOut(run)
          ? `- ${impl}: a run hung before printing results and was killed (excluded above)`
          : `- ${impl}: a run failed (exit ${run.exit.code}, ${run.exit.signal}; see JSON)`,
      ),
  );
  const hung = impls.flatMap((impl) =>
    byImpl[impl].flatMap((run, i) =>
      run.ok && run.exit.hung
        ? [
            `- ${impl}: run ${i + 1} printed its results but didn't exit; still alive after 3 s: ${
              run.exit.diag
                ? `\`${JSON.stringify(run.exit.diag)}\``
                : 'no report (JS thread blocked?)'
            }${run.exit.sample ? `; native stacks: ${run.exit.sample}` : ''}`,
          ]
        : [],
    ),
  );
  // More than a second of wall clock the monotonic clock didn't see: the
  // machine slept during the run, so its numbers (and any hang) are suspect.
  const slept = impls.flatMap((impl) =>
    byImpl[impl].flatMap((run, i) =>
      run.clock && Math.abs(run.clock.sleepDriftMs) > 1000
        ? [
            `- ${impl}: run ${i + 1} spanned a system sleep (wall clock ${(run.clock.sleepDriftMs / 1000).toFixed(0)} s ahead); treat it as invalid`,
          ]
        : [],
    ),
  );
  lines.push('', ...notes, ...failed, ...hung, ...slept);
  return lines.join('\n');
}

// --- Main ---------------------------------------------------------------------------
function readVersion(path) {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}
function git(...gitArgs) {
  return new Promise((resolve) => {
    const child = spawn('git', gitArgs, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', () => resolve(out.trim()));
    child.on('error', () => resolve('unknown'));
  });
}

/** The Markdown for one machine's results; `sources` are the runs' machine records. */
function render(sources, all) {
  const [machine] = sources;
  const passes = sources.flatMap((m) => {
    const { runs: n, warmupS: w, durationS: d } = m.settings;
    return [
      `- ${m.date.slice(0, 16).replace('T', ' ')} UTC: ${m.passConfigs.join(', ')}`,
      `  - ours ${m.ours}${m.addon ? `; wrtc.node sha256 ${m.addon.sha256}, native inputs ${m.addon.nativeInputs}` : ''}`,
      `  - ${n} runs per implementation; media: ${w} s warm-up, ${d} s window`,
      `  - load average (1/5/15 min) ${m.loadAvgAtStart.join(' / ')} at start, ${m.loadAvgAtEnd.join(' / ')} at end`,
    ];
  });
  return [
    `## ${machine.platform}, ${machine.date.slice(0, 10)}`,
    '',
    `- ${machine.os}, ${machine.cpu}, ${machine.memoryGB} GB, Node ${machine.node}`,
    `- @roamhq/wrtc ${machine.wrtc}`,
    ...passes,
    '- cells: median [min–max] over runs',
    '',
    ...Object.entries(all).map(([name, { config, byImpl }]) => table(name, config.kind, byImpl)),
  ].join('\n');
}

// --report a.json,b.json: re-render saved results. Later files replace
// earlier ones' configurations (e.g. a rerun of the configs a busy machine spoiled).
if (args.report) {
  const sources = [];
  const all = {};
  for (const file of args.report.split(',')) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    for (const source of sources) {
      source.passConfigs = source.passConfigs.filter((name) => !saved.runs[name]);
    }
    saved.machine.passConfigs = Object.keys(saved.runs);
    sources.push(saved.machine);
    Object.assign(all, saved.runs);
  }
  const ordered = Object.fromEntries(
    Object.keys(CONFIGS)
      .filter((name) => all[name])
      .map((name) => [name, all[name]]),
  );
  console.log(render(sources, ordered));
  process.exit(0);
}

// What the native addon is built from (scripts/native-inputs.sh's list),
// hashed without git so it works in a synced copy too. Not the same string
// as native_build_id, which hashes git blobs.
const NATIVE_INPUTS = [
  'src',
  'binding.gyp',
  'scripts/gyp-webrtc.py',
  'docker/linux.Dockerfile',
  'scripts/build-libwebrtc.sh',
  'scripts/libwebrtc-patches.sh',
  'third_party/args',
  'patches',
];
function nativeInputs() {
  const files = [];
  const walk = (path) => {
    const full = join(root, path);
    if (!existsSync(full)) return;
    if (statSync(full).isDirectory()) for (const f of readdirSync(full)) walk(join(path, f));
    else files.push(path);
  };
  for (const path of NATIVE_INPUTS) walk(path);
  const hash = createHash('sha256');
  let newest = 0;
  for (const file of files.sort()) {
    hash.update(`${file}\0`).update(readFileSync(join(root, file)));
    newest = Math.max(newest, statSync(join(root, file)).mtimeMs);
  }
  return { hash: hash.digest('hex').slice(0, 12), newest };
}

// Preflight: ours runs from dist/ (or lib/ with --src) and build/Release/wrtc.node.
const addonPath = join(root, 'build/Release/wrtc.node');
let addon = null;
if (impls.includes('ours')) {
  const missing = [
    !args.src && !existsSync(join(root, 'dist/index.js')) && 'dist/index.js (pnpm run build:ts)',
    !existsSync(addonPath) && 'build/Release/wrtc.node (pnpm run build)',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`bench: missing ${missing.join(' and ')}`);
    process.exit(1);
  }
  const inputs = nativeInputs();
  const built = statSync(addonPath).mtimeMs;
  addon = {
    sha256: createHash('sha256').update(readFileSync(addonPath)).digest('hex').slice(0, 12),
    nativeInputs: inputs.hash,
    builtAt: new Date(built).toISOString(),
  };
  if (built < inputs.newest) {
    console.error('bench: build/Release/wrtc.node is older than its sources; run pnpm run build');
    process.exit(1);
  }
}

// Keep a Mac awake for as long as this process lives: an idle sleep
// mid-run fakes hangs and spoils the timings (it did, on 2026-11-19).
let caffeinated = false;
if (os.platform() === 'darwin') {
  try {
    const keeper = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    keeper.on('error', () => {});
    keeper.unref();
    caffeinated = keeper.pid !== undefined;
  } catch {}
}

const cpus = os.cpus();
const machine = {
  date: new Date().toISOString(),
  platform: `${os.platform()}-${os.arch()}`,
  os: `${os.type()} ${os.release()}`,
  cpu: `${cpus[0]?.model ?? 'unknown'} x ${cpus.length}`,
  memoryGB: Math.round(os.totalmem() / 2 ** 30),
  node: process.version,
  wrtc: readVersion('node_modules/@roamhq/wrtc/package.json'),
  // BENCH_REV names the commit where there's no git (e.g. a synced copy).
  ours: `${readVersion('package.json')} at ${
    process.env.BENCH_REV ||
    `${(await git('rev-parse', '--short', 'HEAD')) || 'unknown'}${
      (await git('status', '--porcelain')) ? ' (dirty)' : ''
    }`
  }, ${args.src ? 'lib/ (type stripping)' : 'dist/'}`,
  addon,
  caffeinated,
  loadAvgAtStart: os.loadavg().map((x) => x.toFixed(2)),
  settings: { runs, durationS, warmupS },
};
console.error(`bench: ${JSON.stringify(machine)}`);

mkdirSync(args.out, { recursive: true });
const stamp = `${machine.platform}-${machine.date.replace(/[:.]/g, '-')}`;
const all = {};
for (const name of names) {
  const base = CONFIGS[name];
  const config = { ...base, warmupS, durationS, src: args.src };
  const byImpl = Object.fromEntries(impls.map((impl) => [impl, []]));
  for (let r = 0; r < runs; r++) {
    const order = r % 2 === 0 ? impls : [...impls].reverse();
    for (const impl of order) {
      const started = Date.now();
      const run = await runOnce(impl, config, `${name}-${impl}-${r + 1}`);
      run.loadAvg = os.loadavg()[0];
      byImpl[impl].push(run);
      const status = run.ok
        ? `ok${run.exit.signal ? `, then ${run.exit.signal}` : ''}${run.exit.hung ? ', then hung' : ''}`
        : `FAILED (exit ${run.exit.code}, ${run.exit.signal}): ${run.stderr.slice(-400)}`;
      console.error(
        `bench: ${name} run ${r + 1}/${runs} ${impl}: ${status} (${((Date.now() - started) / 1000).toFixed(0)} s, load ${run.loadAvg.toFixed(2)})`,
      );
    }
  }
  all[name] = { config, byImpl };
  // After every configuration, so a killed run (a dropped SSH session) keeps
  // what it finished; --report renders a partial file.
  save();
}

function save() {
  machine.loadAvgAtEnd = os.loadavg().map((x) => x.toFixed(2));
  const markdown = render([{ ...machine, passConfigs: Object.keys(all) }], all);
  writeFileSync(join(args.out, `${stamp}.md`), `${markdown}\n`);
  writeFileSync(
    join(args.out, `${stamp}.json`),
    `${JSON.stringify({ machine, runs: all }, null, 1)}\n`,
  );
  return markdown;
}

console.log(save());
console.error(`bench: wrote ${join(args.out, `${stamp}.md`)} and .json`);
