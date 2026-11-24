// The README's WPT badge and the results page it links to, from a WPT run's
// results (the file scripts/wpt-run.mjs writes, test/wpt/out/ours.json).
//
//   node scripts/wpt-report.mjs --out <dir> [--results <ours.json>]
//     [--commit <sha>] [--date <YYYY-MM-DD>] [--platform <triple>] [--repo <owner/name>]
//
// writes <dir>/wpt.json, a shields.io endpoint badge
// (https://shields.io/badges/endpoint-badge) of subtests passed out of all,
// and <dir>/WPT.md: the same total, a table of passes per section (grouped
// by API, SECTIONS below), and per section every test with its passes and
// status, and each subtest that didn't pass (or passed unexpectedly) with
// its reason from test/wpt/expectations.json. CI runs it after WPT on pushes
// to main and pushes both files to the `badges` branch. The output depends
// only on the results, the expectations and the options: no timestamps but
// the --date given, and everything sorted.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, countStatuses } from './wpt-lib.mjs';

/**
 * Which section a test is in: the first whose pattern matches its path
 * (without `webrtc/` and the variant). Order matters: a codec test in
 * protocol/ is a codec test, and the peer connection catch-all comes late.
 */
export const SECTIONS = [
  ['Simulcast', /simulcast/i],
  ['Codecs', /vp8|vp9|av1|h264|h265|codec/i],
  ['Stats', /stats/i],
  // Handover tests move a connection between transports, data channels or
  // not; the ICE events are ICE's, though named after the peer connection.
  ['ICE and DTLS', /handover|^RTCPeerConnectionIce(Error)?Event/],
  ['Data channels', /datachannel|sctp/i],
  ['Peer connection', /^(RTCPeerConnection|RTCConfiguration)/],
  [
    'ICE and DTLS',
    /(^|[/-])ice|Ice|candidate|Candidate|dtls|Dtls|certificate|Certificate|handover|crypto-suite|fingerprint/,
  ],
  ['Protocol and IDL', /^protocol\/|idlharness|historical/],
  ['RTP', /rtp|sender|receiver|transceiver/i],
  [
    'Peer connection',
    /^(RTCError|RTCTrackEvent|RollbackEvents|simplecall|promises-call|no-media-call|toJSON|legacy\/)/,
  ],
];
export const OTHER = 'Other';
const ORDER = [
  'Peer connection',
  'RTP',
  'Stats',
  'Data channels',
  'ICE and DTLS',
  'Codecs',
  'Simulcast',
  'Protocol and IDL',
  OTHER,
];

/** The section of a test id such as `webrtc/protocol/bundle.https.html?rest`. */
export function sectionOf(id) {
  const path = id.replace(/^webrtc\//, '').replace(/\?.*$/, '');
  return SECTIONS.find(([, pattern]) => pattern.test(path))?.[0] ?? OTHER;
}

/** shields.io colours by pass rate, highest first. */
const COLOURS = [
  [0.95, 'brightgreen'],
  [0.9, 'green'],
  [0.8, 'yellowgreen'],
  [0.7, 'yellow'],
  [0, 'orange'],
];

/** The endpoint JSON for one run's results (test id to result, as in ours.json). */
export function badge(results) {
  const counts = countStatuses(results);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) throw new Error('no subtest results: is this a full WPT run?');
  const passed = counts.PASS ?? 0;
  const [, color] = COLOURS.find(([min]) => passed / total >= min) ?? ['', 'orange'];
  return { schemaVersion: 1, label: 'WPT', message: `${passed} / ${total}`, color };
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Plain text (a reason) for Markdown, where GitHub would read <tags>. */
const escapeText = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A test or subtest name as a code span, which shows its text as is (no
 * entities: `&lt;` would show literally), so the only escaping is the
 * span's own: a fence longer than any run of backticks in the name, a space
 * inside it where the name starts or ends with a backtick or a space, and
 * in a table cell, `\|` for `|` (GitHub's tables need it even in code).
 */
export function code(text, { table = false } = {}) {
  let body = String(text).replace(/\r?\n/g, ' ');
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^[` ]|[` ]$/.test(body) ? ' ' : '';
  if (table) body = body.replace(/\|/g, '\\|');
  return `${fence}${pad}${body}${pad}${fence}`;
}

/** The explicit reason for a test's or subtest's expectation, if any. */
function reasonOf(expectation) {
  return expectation && typeof expectation === 'object' ? expectation.reason : undefined;
}

/**
 * WPT.md. options: commit (sha), date (YYYY-MM-DD), platform (e.g.
 * linux-x64), repo (owner/name). Expectations are expectations.json's
 * `tests`; the run's platform picks its platform-keyed expectations.
 */
export function page(results, expectations, { commit, date, platform, repo }) {
  const os = platform.split('-')[0];
  const { unexpected, newPasses } = compare(results, expectations, { platform: os });
  const flagged = new Set(
    [...unexpected, ...newPasses].map((d) => `${d.id}\u0000${d.subtest ?? ''}`),
  );
  const isUnexpected = (id, subtest) => flagged.has(`${id}\u0000${subtest ?? ''}`);

  const sections = new Map(ORDER.map((name) => [name, []]));
  for (const id of Object.keys(results).sort(byName)) sections.get(sectionOf(id)).push(id);
  const tally = (ids) => {
    let pass = 0;
    let total = 0;
    for (const id of ids) {
      for (const sub of Object.values(results[id].subtests)) {
        total++;
        if (sub.status === 'PASS') pass++;
      }
    }
    return { pass, fail: total - pass, total };
  };
  const all = tally(Object.keys(results));
  const commitLink = `[\`${commit.slice(0, 7)}\`](https://github.com/${repo}/commit/${commit})`;

  const lines = [
    '# WPT results',
    '',
    `Web Platform Tests \`webrtc/\` (\`test/wpt/\`) on ${platform}, ${date}, at ${commitLink}:`,
    `**${all.pass} / ${all.total} subtests pass.**`,
    '',
    '"Fail" is every subtest that didn\'t pass: FAIL, TIMEOUT, NOTRUN, SKIP or',
    'PRECONDITION_FAILED. A failure listed without a reason has none recorded',
    'in `test/wpt/expectations.json`; one marked **unexpected** differs from it.',
    '',
    '| Section | Pass | Fail | Total |',
    '|---|---:|---:|---:|',
  ];
  for (const [name, ids] of sections) {
    if (ids.length === 0) continue;
    const t = tally(ids);
    lines.push(
      `| [${name}](#${name.toLowerCase().replace(/ /g, '-')}) | ${t.pass} | ${t.fail} | ${t.total} |`,
    );
  }
  lines.push(`| **Total** | **${all.pass}** | **${all.fail}** | **${all.total}** |`);

  for (const [name, ids] of sections) {
    if (ids.length === 0) continue;
    const t = tally(ids);
    lines.push(
      '',
      `## ${name}`,
      '',
      '<details>',
      `<summary>${t.pass} / ${t.total} subtests pass, in ${ids.length} tests</summary>`,
      '',
      '| Test | Passed | Status |',
      '|---|---:|---|',
    );
    const notes = [];
    for (const id of ids) {
      const result = results[id];
      const subs = Object.entries(result.subtests).sort(([a], [b]) => byName(a, b));
      const passed = subs.filter(([, s]) => s.status === 'PASS').length;
      const file = id.replace(/^webrtc\//, '');
      const status = isUnexpected(id, null) ? `${result.status} (unexpected)` : result.status;
      lines.push(`| ${code(file, { table: true })} | ${passed} / ${subs.length} | ${status} |`);
      const expected = expectations[id];
      if (result.status !== 'OK' || isUnexpected(id, null)) {
        const reason = reasonOf(expected);
        notes.push(
          `- ${code(file)}: ${isUnexpected(id, null) ? '**unexpected** ' : ''}` +
            `test status ${result.status}${reason ? `: ${escapeText(reason)}` : ''}`,
        );
      }
      for (const [subtest, sub] of subs) {
        const surprise = isUnexpected(id, subtest);
        if (sub.status === 'PASS' && !surprise) continue;
        const reason = reasonOf(expected?.subtests?.[subtest]);
        notes.push(
          `- ${code(file)} ${code(subtest)}: ${surprise ? '**unexpected** ' : ''}${sub.status}` +
            `${reason ? `: ${escapeText(reason)}` : ''}`,
        );
      }
    }
    if (notes.length) lines.push('', 'Not passing (or not as expected):', '', ...notes);
    lines.push('', '</details>');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = opt('--out');
  if (!out) {
    console.error(
      'usage: node scripts/wpt-report.mjs --out <dir> [--results <ours.json>] [--commit <sha>]\n' +
        '         [--date <YYYY-MM-DD>] [--platform <triple>] [--repo <owner/name>]',
    );
    process.exit(2);
  }
  const results = JSON.parse(
    readFileSync(opt('--results', join(root, 'test/wpt/out/ours.json')), 'utf8'),
  );
  const expectations = JSON.parse(
    readFileSync(join(root, 'test/wpt/expectations.json'), 'utf8'),
  ).tests;
  const options = {
    commit: opt('--commit', process.env.GITHUB_SHA ?? 'unknown'),
    date: opt('--date', new Date().toISOString().slice(0, 10)),
    platform: opt('--platform', `${process.platform}-${process.arch}`),
    repo: opt('--repo', process.env.GITHUB_REPOSITORY ?? 'kdhcodes/webrtc'),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'wpt.json'), `${JSON.stringify(badge(results))}\n`);
  writeFileSync(join(out, 'WPT.md'), page(results, expectations, options));
  console.log(
    `wpt-report: ${badge(results).message} subtests pass; wrote ${out}/wpt.json and WPT.md`,
  );
}

if (import.meta.main) main();
