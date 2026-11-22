#!/usr/bin/env node
// Runs the vendored WPT webrtc/ tests (test/wpt/vendor) against our
// implementation or @roamhq/wrtc, one child process per test
// (test/wpt/child.mjs), and compares the results with
// test/wpt/expectations.json.
//
//   pnpm run wpt               ours; prints the deltas, exits 1 on an unexpected failure
//   pnpm run wpt:update        ours; rewrites expectations.json and the comparison
//   pnpm run wpt:wrtc          wrtc; rewrites wrtc-baseline.json and the comparison
//
// Options (after `--` with pnpm):
//   --impl ours|wrtc   implementation (default ours)
//   --update           rewrite expectations.json (ours) instead of gating on it
//   --filter a,b       only tests whose id contains one of these
//   --jobs N           tests run in parallel (default 4)
//   --timeout-multiplier X   scales the 10 s / 60 s harness timeouts (default 1)
//   --max-rss-mb N     kill a test process above this RSS (default 3072)
//   --verbose          print each test's stderr tail when it didn't complete
//   --compare          only rewrite the comparison from the recorded files
//
// A wrtc run is a signal, not a gate: it never fails, and only rewrites
// test/wpt/wrtc-baseline.json (and the comparison) when it ran everything.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allowed,
  compare,
  countStatuses,
  discoverTests,
  OK,
  PROTOCOL_ERROR,
  testPlan,
  updateExpectations,
} from './wpt-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wptDir = join(root, 'test/wpt');
const vendor = join(wptDir, 'vendor');
const child = join(wptDir, 'child.mjs');
const expectationsFile = join(wptDir, 'expectations.json');
const baselineFile = join(wptDir, 'wrtc-baseline.json');
const comparisonFile = join(wptDir, 'wrtc-comparison.md');
const MARKER = '@@WPT ';

function parseArgs(argv) {
  const options = {
    impl: 'ours',
    update: false,
    filter: [],
    jobs: 4,
    multiplier: 1,
    maxRssMb: 3072,
    verbose: false,
    compare: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--impl') options.impl = value();
    else if (arg === '--update') options.update = true;
    else if (arg === '--filter') options.filter.push(...value().split(',').filter(Boolean));
    else if (arg === '--jobs') options.jobs = Number(value());
    else if (arg === '--timeout-multiplier') options.multiplier = Number(value());
    else if (arg === '--max-rss-mb') options.maxRssMb = Number(value());
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--compare') options.compare = true;
    else if (arg === '--') continue;
    else throw new Error(`unknown option ${arg}`);
  }
  if (options.impl !== 'ours' && options.impl !== 'wrtc') throw new Error('--impl ours|wrtc');
  if (!Number.isInteger(options.jobs) || options.jobs < 1) {
    throw new Error('--jobs must be a positive integer');
  }
  for (const [name, value] of [
    ['--timeout-multiplier', options.multiplier],
    ['--max-rss-mb', options.maxRssMb],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  }
  return options;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/**
 * Writes JSON as Biome formats it (so `pnpm run lint` passes): two-space
 * indents, with short arrays of strings (flaky statuses) on one line.
 */
function writeJson(path, value) {
  const text = JSON.stringify(value, null, 2).replace(
    /\[\n\s*((?:"(?:[^"\\\n]|\\.)*",?\n\s*)+)\]/g,
    (whole, items) => {
      const inline = `[${items
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
        .join(' ')}]`;
      return inline.length <= 60 ? inline : whole;
    },
  );
  writeFileSync(path, `${text}\n`);
}

/**
 * Why a test is skipped (a pattern or a SKIP entry, resolved for this
 * platform as compare() does), or null.
 */
function skipReason(id, expectations) {
  const entry = expectations.tests[id];
  if (entry !== undefined && allowed(entry).includes('SKIP')) return entry.reason ?? 'skipped';
  for (const { pattern, reason } of expectations.skip) {
    if (new RegExp(pattern).test(id)) return reason;
  }
  return null;
}

/** Subtest names marked SKIP (on this platform) inside a test that otherwise runs. */
function skippedSubtests(id, expectations) {
  const subtests = expectations.tests[id]?.subtests ?? {};
  return Object.entries(subtests)
    .filter(([, e]) => allowed(e).includes('SKIP'))
    .map(([name]) => name);
}

/** The RSS of a process in KiB, or 0 if it's gone. */
function rssKb(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], (error, stdout) => {
      resolve(error ? 0 : Number(stdout.trim()) || 0);
    });
  });
}

/** Every child process still running, so none outlives the driver. */
const children = new Set();

function killChildren() {
  for (const proc of children) proc.kill('SIGKILL');
}

// A child can be blocked in native code (RTCConfiguration-iceCandidatePoolSize
// is), so it would outlive a driver killed or crashed mid-run.
process.on('exit', killChildren);
for (const [signal, number] of [
  ['SIGINT', 2],
  ['SIGHUP', 1],
  ['SIGTERM', 15],
]) {
  process.on(signal, () => {
    killChildren();
    process.exit(128 + number);
  });
}

/**
 * Runs one test in a child process. Resolves with its result:
 * `{ status, message?, subtests, ms, stderr }`. Until the child has
 * exited, it's killed at the hard timeout (the harness timeout plus a
 * grace period for cleanup) or above the RSS cap; one that has reported
 * completion gets a shorter grace period to exit. A child killed after
 * completing keeps its results, with the status EXIT_HANG.
 */
function runTest(id, options, long, skipped) {
  const harnessMs = (long ? 60_000 : 10_000) * options.multiplier;
  const hardMs = harnessMs + 20_000 * options.multiplier;
  const exitGraceMs = 10_000 * options.multiplier;
  const started = Date.now();
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      ['--expose-gc', child, options.impl, id, String(options.multiplier)],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WPT_SKIP_SUBTESTS: JSON.stringify(skipped) },
      },
    );
    children.add(proc);
    const subtests = {};
    let complete = null;
    let killed = null;
    let exitTimer = null;
    let protocolError = null;
    let buffered = '';
    let stderr = '';
    const kill = (why) => {
      if (killed !== null || !children.has(proc)) return;
      killed = why;
      proc.kill('SIGKILL');
    };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (!line.startsWith(MARKER)) continue;
        let event;
        try {
          event = JSON.parse(line.slice(MARKER.length));
        } catch {
          // Recorded for this test (PROTOCOL_ERROR, never expected), not a
          // driver crash.
          protocolError ??= `unparseable result line from the child: ${line.slice(0, 200)}`;
          continue;
        }
        if (event.type === 'result') {
          let name = event.name;
          // testharness.js allows duplicate names; keep both.
          for (let n = 2; name in subtests; n++) name = `${event.name} (${n})`;
          subtests[name] = { status: event.status, message: event.message ?? undefined };
        } else if (event.type === 'complete' && complete === null) {
          complete = event;
          // The child exits right after reporting; give it a bounded time.
          exitTimer = setTimeout(
            () => kill(`did not exit within ${exitGraceMs} ms of completing`),
            exitGraceMs,
          );
        }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    const timer = setTimeout(() => kill(`killed after ${hardMs} ms`), hardMs);
    const rssTimer = setInterval(async () => {
      const kb = await rssKb(proc.pid);
      if (kb > options.maxRssMb * 1024) kill(`killed at ${Math.round(kb / 1024)} MB RSS`);
    }, 1000);
    proc.on('exit', (code, signal) => {
      children.delete(proc);
      clearTimeout(timer);
      clearTimeout(exitTimer);
      clearInterval(rssTimer);
      const ms = Date.now() - started;
      if (protocolError !== null) {
        resolve({ status: PROTOCOL_ERROR, message: protocolError, subtests, ms, stderr });
      } else if (complete !== null && killed !== null) {
        const message = `harness ${complete.status}, then ${killed}`;
        resolve({ status: 'EXIT_HANG', message, subtests, ms, stderr });
      } else if (complete !== null) {
        // wrtc can crash in its exit path after reporting; the results stand.
        const message = complete.message ?? undefined;
        resolve({ status: complete.status, message, subtests, ms, stderr });
      } else if (killed !== null) {
        resolve({ status: 'KILLED', message: killed, subtests, ms, stderr });
      } else {
        const message = `exited (code ${code}, signal ${signal}) before completing`;
        resolve({ status: 'CRASH', message, subtests, ms, stderr });
      }
    });
  });
}

/** Runs `tasks` (async functions) with at most `jobs` in flight. */
async function pool(tasks, jobs) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
}

/** Pass counts per file, and what wrtc passes that we don't. */
function renderComparison(ours, wrtc, commit) {
  const ids = [...new Set([...Object.keys(ours), ...Object.keys(wrtc)])].sort();
  // Both files are recorded on macOS, so platform keys resolve to darwin. A
  // flaky expectation (several statuses) counts as FLAKY, not a pass.
  const status = (entry) => {
    if (entry === undefined) return undefined;
    const statuses = allowed(entry, 'darwin');
    return statuses.length > 1 ? 'FLAKY' : statuses[0];
  };
  const rows = [];
  const onlyWrtc = [];
  const totals = { subtests: 0, ours: {}, wrtc: {} };
  const count = (bucket, s) => {
    bucket[s] = (bucket[s] ?? 0) + 1;
  };
  for (const id of ids) {
    const o = ours[id];
    const w = wrtc[id];
    if (status(o) === 'SKIP' || status(w) === 'SKIP' || !o || !w) continue;
    const names = [
      ...new Set([...Object.keys(o.subtests ?? {}), ...Object.keys(w.subtests ?? {})]),
    ];
    let oPass = 0;
    let wPass = 0;
    for (const name of names) {
      const os = status(o.subtests?.[name]) ?? 'MISSING';
      const ws = status(w.subtests?.[name]) ?? 'MISSING';
      totals.subtests++;
      count(totals.ours, os);
      count(totals.wrtc, ws);
      if (os === 'PASS') oPass++;
      if (ws === 'PASS') wPass++;
      if (ws === 'PASS' && os !== 'PASS')
        onlyWrtc.push(`| ${id} | ${name.replace(/\|/g, '\\|')} | ${os} |`);
    }
    const mark = (s) => (s === OK ? '' : ` (${s})`);
    rows.push(
      `| ${id} | ${names.length} | ${oPass}${mark(status(o))} | ${wPass}${mark(status(w))} |`,
    );
  }
  const fmt = (bucket) =>
    Object.entries(bucket)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([s, n]) => `${s} ${n}`)
      .join(', ');
  return [
    '# WPT webrtc/: ours vs @roamhq/wrtc',
    '',
    `Generated by \`scripts/wpt-run.mjs\` from \`expectations.json\` (ours) and`,
    `\`wrtc-baseline.json\` (wrtc, from one run). WPT ${commit}.`,
    'Files skipped for either implementation are left out. A file status other',
    'than OK is in brackets. FLAKY is a subtest whose expectation lists several',
    'statuses; MISSING, one that implementation never reported (its file was',
    'killed or errored first). Both files are recorded on macOS, so a status',
    'keyed by platform is shown as its darwin entry.',
    'wrtc is a signal, not a target: its EventTarget ignores listener options',
    'and dispatches plain objects, so some of its failures are noise.',
    '',
    `Subtests: ${totals.subtests}.`,
    `- ours: ${fmt(totals.ours)}`,
    `- wrtc: ${fmt(totals.wrtc)}`,
    '',
    '| Test | Subtests | Ours PASS | wrtc PASS |',
    '|---|---|---|---|',
    ...rows,
    '',
    `## Subtests wrtc passes and we don't (${onlyWrtc.length})`,
    '',
    '| Test | Subtest | Ours |',
    '|---|---|---|',
    ...onlyWrtc,
    '',
  ].join('\n');
}

function writeComparison() {
  const ours = readJson(expectationsFile, { tests: {} }).tests;
  const wrtc = readJson(baselineFile, { tests: {} }).tests;
  const commit = readFileSync(join(vendor, 'WPT_COMMIT'), 'utf8').trim();
  writeFileSync(comparisonFile, renderComparison(ours, wrtc, commit));
  console.log(`wrote ${comparisonFile}`);
}

function describe(entry) {
  const where = entry.subtest === null ? entry.id : `${entry.id} :: ${entry.subtest}`;
  const message = entry.message ? `: ${String(entry.message).split('\n')[0].slice(0, 160)}` : '';
  return `  ${where}\n    expected ${entry.expected}, got ${entry.actual}${message}`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    // A usage error, not a crash: no stack trace.
    console.error(`wpt-run: ${error.message}`);
    process.exit(2);
  }
  if (options.compare) return writeComparison();

  const expectations = readJson(expectationsFile, { skip: [], tests: {} });
  const isWrtc = options.impl === 'wrtc';
  const all = discoverTests(vendor).filter(
    (id) => options.filter.length === 0 || options.filter.some((f) => id.includes(f)),
  );
  const toRun = [];
  const skipped = [];
  for (const id of all) {
    if (skipReason(id, expectations) === null) toRun.push(id);
    else skipped.push(id);
  }
  // Long tests first, so they don't end up as a tail running alone.
  const long = new Map(toRun.map((id) => [id, testPlan(vendor, id).long]));
  toRun.sort((a, b) => Number(long.get(b)) - Number(long.get(a)));

  console.log(
    `WPT ${options.impl}: ${toRun.length} tests to run, ${skipped.length} skipped, ` +
      `${options.jobs} at a time`,
  );
  const results = {};
  let done = 0;
  const started = Date.now();
  await pool(
    toRun.map((id) => async () => {
      const result = await runTest(id, options, long.get(id), skippedSubtests(id, expectations));
      results[id] = result;
      done++;
      const subs = Object.values(result.subtests);
      const passed = subs.filter((s) => s.status === 'PASS').length;
      const status = result.status === OK ? '' : ` ${result.status}`;
      console.log(
        `[${done}/${toRun.length}] ${passed}/${subs.length}${status} ${id} (${result.ms} ms)`,
      );
      if (options.verbose && result.status !== OK && result.stderr) {
        console.log(
          result.stderr
            .trimEnd()
            .split('\n')
            .slice(-20)
            .map((l) => `     | ${l}`)
            .join('\n'),
        );
      }
    }),
    options.jobs,
  );

  // Raw results (with messages and timings), for digging into failures.
  const outDir = join(wptDir, 'out');
  mkdirSync(outDir, { recursive: true });
  const ordered = Object.fromEntries(
    Object.keys(results)
      .sort()
      .map((id) => {
        const { stderr: _stderr, ...rest } = results[id];
        return [id, rest];
      }),
  );
  writeJson(join(outDir, `${options.impl}.json`), ordered);

  const counts = countStatuses(results);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const fileStatuses = {};
  for (const r of Object.values(results))
    fileStatuses[r.status] = (fileStatuses[r.status] ?? 0) + 1;
  console.log(
    `\n${options.impl}: ${total} subtests in ${toRun.length} tests ` +
      `(${Math.round((Date.now() - started) / 1000)} s)`,
  );
  console.log(`  subtests: ${JSON.stringify(counts)}`);
  console.log(`  tests:    ${JSON.stringify(fileStatuses)}; skipped ${skipped.length}`);

  const fullRun = options.filter.length === 0;
  if (isWrtc) {
    if (!fullRun) return;
    const old = readJson(baselineFile, { tests: {} }).tests;
    writeJson(baselineFile, {
      note: 'wrtc results on the same runner: a signal, not a gate. pnpm run wpt:wrtc rewrites it.',
      tests: updateExpectations(results, old, { full: true }),
    });
    console.log(`wrote ${baselineFile}`);
    writeComparison();
    return;
  }
  if (options.update) {
    expectations.tests = updateExpectations(results, expectations.tests, { full: fullRun });
    writeJson(expectationsFile, expectations);
    console.log(`wrote ${expectationsFile}`);
    if (fullRun) writeComparison();
    return;
  }
  const { unexpected, newPasses } = compare(results, expectations.tests, { full: fullRun });
  if (newPasses.length > 0) {
    console.log(`\nNew passes (${newPasses.length}); run pnpm run wpt:update to record them:`);
    for (const entry of newPasses) console.log(describe(entry));
  }
  if (unexpected.length > 0) {
    console.log(`\nUnexpected results (${unexpected.length}):`);
    for (const entry of unexpected) console.log(describe(entry));
    process.exitCode = 1;
  } else {
    console.log('\nNo unexpected results.');
  }
}

await main();
