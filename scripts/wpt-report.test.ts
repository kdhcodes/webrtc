// Tests of scripts/wpt-report.mjs, the README's WPT badge and the WPT.md
// page it links to, against a real run's results:
// wpt-report.fixture.json.gz is test/wpt/out/ours.json from `pnpm run wpt`
// on darwin-arm64 (2026-11-22, 2206 / 2337), with only the statuses kept
// (no messages or timings), gzipped. Regenerate it the same way after a WPT
// vendor bump.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { Expectation, TestResult } from './wpt-lib.mjs';
import { badge, code, OTHER, page, sectionOf } from './wpt-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const results: Record<string, TestResult> = JSON.parse(
  gunzipSync(readFileSync(join(here, 'wpt-report.fixture.json.gz'))).toString('utf8'),
);
const expectations: Record<string, Expectation> = JSON.parse(
  readFileSync(join(here, '..', 'test', 'wpt', 'expectations.json'), 'utf8'),
).tests;
const options = {
  commit: '0123456789abcdef0123456789abcdef01234567',
  date: '2026-11-22',
  platform: 'darwin-arm64',
  repo: 'kdhcodes/webrtc',
};
const md = page(results, expectations, options);

/** The lines of WPT.md's section `name`, from its heading to the next. */
function section(name: string): string {
  const start = md.indexOf(`\n## ${name}\n`);
  assert.ok(start >= 0, `no section ${name}`);
  const end = md.indexOf('\n## ', start + 1);
  return md.slice(start, end < 0 ? undefined : end);
}

test('the badge is subtests passed out of all of them', () => {
  assert.deepEqual(badge(results), {
    schemaVersion: 1,
    label: 'WPT',
    message: '2206 / 2337',
    color: 'green',
  });
});

test('the badge colour follows the pass rate', () => {
  const run = (pass: number, fail: number): Record<string, TestResult> => ({
    'webrtc/a.html': {
      status: 'OK',
      subtests: Object.fromEntries([
        ...Array.from({ length: pass }, (_, i) => [`p${i}`, { status: 'PASS' }]),
        ...Array.from({ length: fail }, (_, i) => [`f${i}`, { status: 'FAIL' }]),
      ]),
    },
  });
  assert.equal(badge(run(95, 5)).color, 'brightgreen');
  assert.equal(badge(run(90, 10)).color, 'green');
  assert.equal(badge(run(70, 30)).color, 'yellow');
  assert.equal(badge(run(10, 90)).color, 'orange');
  assert.throws(() => badge({}), { message: 'no subtest results: is this a full WPT run?' });
});

test('every test in the suite has a section: Other is empty', () => {
  const ids = new Set([...Object.keys(results), ...Object.keys(expectations)]);
  const other = [...ids].filter((id) => sectionOf(id) === OTHER);
  assert.deepEqual(other, []);
  assert.doesNotMatch(md, /## Other/);
});

test('tests land in the section of their API', () => {
  const cases: Record<string, string> = {
    'webrtc/RTCPeerConnection-addIceCandidate.html?rest': 'Peer connection',
    'webrtc/RTCConfiguration-iceServers.html?rest': 'Peer connection',
    'webrtc/simplecall.https.html': 'Peer connection',
    'webrtc/RTCTrackEvent-fire.html': 'Peer connection',
    'webrtc/RTCPeerConnectionIceEvent-constructor.html': 'ICE and DTLS',
    'webrtc/RTCPeerConnectionIceErrorEvent.html': 'ICE and DTLS',
    'webrtc/RTCRtpSender-encode-same-track-twice.https.html': 'RTP',
    'webrtc/RTCRtpSender-setParameters.html?rest': 'RTP',
    'webrtc/RTCPeerConnection-getStats.https.html?rest': 'Stats',
    'webrtc/getstats.html': 'Stats',
    'webrtc/RTCDataChannel-send.html': 'Data channels',
    'webrtc/RTCSctpTransport-maxMessageSize.html': 'Data channels',
    'webrtc/RTCIceTransport.html?rest': 'ICE and DTLS',
    'webrtc/RTCCertificate.html': 'ICE and DTLS',
    'webrtc/protocol/handover-datachannel.html': 'ICE and DTLS',
    'webrtc/protocol/dtls-setup.https.html': 'ICE and DTLS',
    'webrtc/protocol/h264-profile-levels.https.html?rest': 'Codecs',
    'webrtc/RTCRtpTransceiver-setCodecPreferences.html?rest': 'Codecs',
    'webrtc/simulcast/h264.https.html': 'Simulcast',
    'webrtc/protocol/bundle.https.html?rest': 'Protocol and IDL',
    'webrtc/historical.html?rest': 'Protocol and IDL',
  };
  for (const [id, name] of Object.entries(cases)) assert.equal(sectionOf(id), name, id);
});

test("the summary table's sections add up to the total", () => {
  const rows = [...md.matchAll(/^\| \[[^\]]+\]\(#[\w-]+\) \| (\d+) \| (\d+) \| (\d+) \|$/gm)];
  assert.equal(rows.length, 8);
  const sum = (i: number) => rows.reduce((n, row) => n + Number(row[i]), 0);
  assert.deepEqual([sum(1), sum(2), sum(3)], [2206, 131, 2337]);
  assert.match(md, /^\| \*\*Total\*\* \| \*\*2206\*\* \| \*\*131\*\* \| \*\*2337\*\* \|$/m);
});

test('the header has the date, the linked commit, the platform and the total', () => {
  assert.match(
    md,
    /^# WPT results\n\nWeb Platform Tests `webrtc\/` \(`test\/wpt\/`\) on darwin-arm64, 2026-11-22, at \[`0123456`\]\(https:\/\/github\.com\/kdhcodes\/webrtc\/commit\/0123456789abcdef0123456789abcdef01234567\):\n\*\*2206 \/ 2337 subtests pass\.\*\*\n/,
  );
});

test('each section is a collapsible block listing every test with its passes and status', () => {
  const codecs = section('Codecs');
  assert.match(codecs, /<details>\n<summary>\d+ \/ \d+ subtests pass, in \d+ tests<\/summary>/);
  assert.match(
    codecs,
    /^\| `protocol\/h264-profile-levels\.https\.html\?rest` \| 0 \/ 11 \| OK \|$/m,
  );
  const listed = [...md.matchAll(/^\| `([^`]+)` \| \d+ \/ \d+ \| /gm)].map((m) => m[1]);
  assert.equal(listed.length, Object.keys(results).length);
});

test('H264 failures are listed as failures, with their by-decision reason', () => {
  assert.match(
    section('Codecs'),
    /^- `protocol\/h264-profile-levels\.https\.html\?rest` `Level 1 H264 video is appropriately constrained`: FAIL: H264 is not built in \(no H264, by decision\)$/m,
  );
});

test('a test that times out shows its status and reason', () => {
  assert.match(
    section('Simulcast'),
    /^- `simulcast\/vp9\.https\.html`: test status TIMEOUT: VP9 simulcast with two rids/m,
  );
});

test('a subtest that differs from the expectations is marked unexpected', () => {
  const id = 'webrtc/RTCPeerConnection-createOffer.html?rest';
  const changed = structuredClone(results);
  const subtests = changed[id]?.subtests ?? {};
  const [name] = Object.keys(subtests).filter((n) => subtests[n]?.status === 'PASS');
  assert.ok(name);
  subtests[name] = { status: 'FAIL' };
  assert.match(
    page(changed, expectations, options),
    /^- `RTCPeerConnection-createOffer\.html\?rest` .*: \*\*unexpected\*\* FAIL$/m,
  );
  assert.doesNotMatch(md, /: \*\*unexpected\*\* /, 'the real run had no unexpected results');
});

test('the page is the same whatever order the results come in', () => {
  const reversed = Object.fromEntries(Object.entries(results).reverse());
  assert.equal(page(reversed, expectations, options), md);
});

test('the CLI writes wpt.json and WPT.md', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wrtc-wpt-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'ours.json'), JSON.stringify(results));
  const run = spawnSync(
    process.execPath,
    [
      join(here, 'wpt-report.mjs'),
      '--out',
      join(dir, 'out'),
      '--results',
      join(dir, 'ours.json'),
      ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v]),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    readFileSync(join(dir, 'out', 'wpt.json'), 'utf8'),
    '{"schemaVersion":1,"label":"WPT","message":"2206 / 2337","color":"green"}\n',
  );
  assert.equal(readFileSync(join(dir, 'out', 'WPT.md'), 'utf8'), md);
});

test('names are code spans shown as they are: no entities, fences longer than their backticks', () => {
  assert.equal(code('plain'), '`plain`');
  assert.equal(code('a <b> & c'), '`a <b> & c`');
  assert.equal(code('x `y` z'), '``x `y` z``');
  assert.equal(code('`starts and ends`'), '`` `starts and ends` ``');
  assert.equal(code('a | b', { table: true }), '`a \\| b`');
});

test('a subtest name with <, & and a backtick appears in the page as written', () => {
  const shown = page(
    {
      'webrtc/RTCPeerConnection-x.html': {
        status: 'OK',
        subtests: { 'a <b> & `c` d': { status: 'FAIL' }, ok: { status: 'PASS' } },
      },
    },
    {
      'webrtc/RTCPeerConnection-x.html': {
        status: 'OK',
        subtests: { 'a <b> & `c` d': 'FAIL', ok: 'PASS' },
      },
    },
    options,
  );
  assert.ok(shown.includes('- `RTCPeerConnection-x.html` ``a <b> & `c` d``: FAIL\n'), shown);
});
