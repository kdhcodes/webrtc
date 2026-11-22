// Tests of the WPT harness's pure parts: reading a test's scripts the way
// a browser page (or wptserve's generated page) would, and the expectation
// deltas that decide whether `pnpm run wpt` fails.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  compare,
  discoverTests,
  type Expectation,
  parseHtml,
  parseMeta,
  resolveScript,
  type TestResult,
  testPlan,
  updateExpectations,
} from './wpt-lib.mjs';

/** A temp vendor tree with `files` (path to content), removed after the test. */
function vendorTree(t: TestContext, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wpt-lib-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

test('parseMeta reads scripts in order, timeout, title and variants, up to the code', () => {
  const meta = parseMeta(
    [
      '// META: script=/common/utils.js',
      '// META: timeout=long',
      '// META: title=A title',
      '// META: script=helper.js',
      '// META: variant=?a',
      '',
      "'use strict';",
      '// META: script=late.js',
    ].join('\n'),
  );
  assert.deepEqual(meta, {
    scripts: ['/common/utils.js', 'helper.js'],
    long: true,
    title: 'A title',
    variants: ['?a'],
  });
});

test('parseHtml returns external and inline scripts in document order', () => {
  const page = parseHtml(
    [
      '<!doctype html>',
      '<meta name="timeout" content="long">',
      '<meta name=variant content="?rest">',
      '<title>RTC &amp; things</title>',
      '<script src="/resources/testharness.js"></script>',
      "<script src='helper.js'></script>",
      '<!-- <script src="commented-out.js"></script> -->',
      '<script type="text/plain">not code</script>',
      '<script type="text/javascript">',
      'test(() => {});',
      '</script>',
    ].join('\n'),
  );
  assert.equal(page.title, 'RTC & things');
  assert.equal(page.long, true);
  assert.deepEqual(page.variants, ['?rest']);
  assert.deepEqual(page.scripts, [
    { src: '/resources/testharness.js' },
    { src: 'helper.js' },
    { code: '\ntest(() => {});\n', line: 9 },
  ]);
});

test('parseHtml lists the elements tests can reach, outside scripts and comments', () => {
  const page = parseHtml(
    [
      '<!doctype html><html><head><title>t</title></head>',
      '<body>',
      '<div id="log"></div>',
      '<div>',
      '  <video id=v muted autoplay="autoplay" data-x=\'a>b\'></video>',
      '</div>',
      '<canvas></canvas>',
      '<!-- <video id="commented-out"></video> -->',
      '<script>const html = "<video id=in-script>";</script>',
      '<span>no id</span>',
      '</body></html>',
    ].join('\n'),
  );
  assert.deepEqual(page.elements, [
    { tag: 'div', attributes: { id: 'log' } },
    { tag: 'video', attributes: { id: 'v', muted: '', autoplay: 'autoplay', 'data-x': 'a>b' } },
    { tag: 'canvas', attributes: {} },
  ]);
});

test('resolveScript resolves against the test file and maps aliases and stubs', () => {
  const file = 'webrtc/protocol/split.https.html';
  assert.equal(
    resolveScript('../RTCPeerConnection-helper.js', file),
    'webrtc/RTCPeerConnection-helper.js',
  );
  assert.equal(resolveScript('/common/gc.js', file), 'common/gc.js');
  assert.equal(
    resolveScript('/resources/testharnessreport.js', file),
    'harness:testharnessreport.js',
  );
  assert.equal(
    resolveScript('/resources/WebIDLParser.js', file),
    'resources/webidl2/lib/webidl2.js',
  );
  assert.equal(resolveScript('/resources/testdriver.js', file), null);
  assert.throws(() => resolveScript('https://example.com/x.js', file), /cross-origin/);
});

test('testPlan loads a .window.js test as wptserve does: harness, report, META scripts, test', (t) => {
  const vendor = vendorTree(t, {
    'webrtc/a.window.js': '// META: script=helper.js\n// META: timeout=long\ntest(() => {});\n',
  });
  assert.deepEqual(testPlan(vendor, 'webrtc/a.window.js'), {
    scripts: [
      { path: 'resources/testharness.js' },
      { path: 'harness:testharnessreport.js' },
      { path: 'webrtc/helper.js' },
      { path: 'webrtc/a.window.js' },
    ],
    long: true,
    title: null,
    elements: [],
  });
});

test('discoverTests lists variants separately and leaves out helpers and non-test pages', (t) => {
  const harness = '<script src="/resources/testharness.js"></script>';
  const vendor = vendorTree(t, {
    'webrtc/a.html': harness,
    'webrtc/b.html': `<meta name="variant" content="?x"><meta name="variant" content="?y">${harness}`,
    'webrtc/c.window.js': 'test(() => {});',
    'webrtc/RTCPeerConnection-helper.js': '',
    'webrtc/iframe.html': '<p>no harness</p>',
    'webrtc/resources/frame.html': harness,
  });
  assert.deepEqual(discoverTests(vendor), [
    'webrtc/a.html',
    'webrtc/b.html?x',
    'webrtc/b.html?y',
    'webrtc/c.window.js',
  ]);
});

function result(subtests: Record<string, string>, status = 'OK'): TestResult {
  return {
    status,
    subtests: Object.fromEntries(
      Object.entries(subtests).map(([name, s]) => [name, { status: s, message: `${s} message` }]),
    ),
  };
}

test('compare: a regression is unexpected, a new pass is not', () => {
  const expectations: Record<string, Expectation> = {
    t: { status: 'OK', subtests: { a: 'PASS', b: { status: 'FAIL', reason: 'r' } } },
  };
  const { unexpected, newPasses } = compare({ t: result({ a: 'FAIL', b: 'PASS' }) }, expectations);
  assert.deepEqual(unexpected, [
    { id: 't', subtest: 'a', expected: 'PASS', actual: 'FAIL', message: 'FAIL message' },
  ]);
  assert.deepEqual(newPasses, [
    { id: 't', subtest: 'b', expected: 'FAIL', actual: 'PASS', message: 'PASS message' },
  ]);
});

test('compare: a failure changing kind (FAIL to TIMEOUT) is unexpected', () => {
  const expectations: Record<string, Expectation> = {
    t: { status: 'OK', subtests: { a: { status: 'FAIL' } } },
  };
  const { unexpected } = compare({ t: result({ a: 'TIMEOUT' }) }, expectations);
  assert.equal(unexpected.length, 1);
  assert.equal(unexpected[0]?.actual, 'TIMEOUT');
});

test('compare: a flaky expectation accepts each of its statuses', () => {
  const expectations: Record<string, Expectation> = {
    t: { status: 'OK', subtests: { a: { status: ['PASS', 'FAIL'], reason: 'flaky' } } },
  };
  for (const status of ['PASS', 'FAIL']) {
    assert.deepEqual(compare({ t: result({ a: status }) }, expectations), {
      unexpected: [],
      newPasses: [],
    });
  }
});

test('compare: a missing passing subtest and a new failing one are unexpected', () => {
  const expectations: Record<string, Expectation> = {
    t: { status: 'OK', subtests: { gone: 'PASS', goneFailing: { status: 'FAIL' } } },
  };
  const { unexpected } = compare({ t: result({ fresh: 'FAIL' }) }, expectations);
  assert.deepEqual(
    unexpected.map((d) => [d.subtest, d.expected, d.actual]),
    [
      ['fresh', 'none', 'FAIL'],
      ['gone', 'PASS', 'MISSING'],
    ],
  );
});

test('compare: after an expected harness TIMEOUT, NOTRUN subtests are not regressions', () => {
  const expectations: Record<string, Expectation> = {
    t: {
      status: ['OK', 'TIMEOUT'],
      subtests: { hangs: { status: ['PASS', 'TIMEOUT'] }, later: 'PASS' },
    },
  };
  const timedOut = compare(
    { t: result({ hangs: 'TIMEOUT', later: 'NOTRUN' }, 'TIMEOUT') },
    expectations,
  );
  assert.deepEqual(timedOut.unexpected, []);
  // Without the harness timeout, a NOTRUN is still a regression.
  const notTimedOut = compare({ t: result({ hangs: 'PASS', later: 'NOTRUN' }) }, expectations);
  assert.deepEqual(
    notTimedOut.unexpected.map((d) => [d.subtest, d.actual]),
    [['later', 'NOTRUN']],
  );
});

test('compare: a harness ERROR where OK was expected is unexpected', () => {
  const expectations: Record<string, Expectation> = { t: { status: 'OK', subtests: {} } };
  const { unexpected } = compare({ t: result({}, 'ERROR') }, expectations);
  assert.deepEqual(
    unexpected.map((d) => [d.subtest, d.expected, d.actual]),
    [[null, 'OK', 'ERROR']],
  );
});

test('compare: on a full run, an expected test with no result is unexpected; a SKIP one is not', () => {
  const expectations: Record<string, Expectation> = {
    ran: { status: 'OK', subtests: { a: 'PASS' } },
    vanished: { status: 'OK', subtests: { a: 'PASS' } },
    skipped: { status: 'SKIP', reason: 'needs a DOM' },
  };
  const results = { ran: result({ a: 'PASS' }) };
  const full = compare(results, expectations, { full: true });
  assert.deepEqual(
    full.unexpected.map((d) => [d.id, d.subtest, d.expected, d.actual]),
    [['vanished', null, 'OK', 'MISSING']],
  );
  // A filtered run only ran some tests, so the rest aren't missing.
  assert.deepEqual(compare(results, expectations).unexpected, []);
});

test('compare: a platform-keyed expectation applies the entry for the given platform', () => {
  const expectations: Record<string, Expectation> = {
    t: {
      status: 'OK',
      subtests: { h264: { status: { darwin: 'FAIL', linux: 'PASS' }, reason: 'platform' } },
    },
  };
  const failing = { t: result({ h264: 'FAIL' }) };
  assert.deepEqual(compare(failing, expectations, { platform: 'darwin' }).unexpected, []);
  // On Linux the same failure is a regression, which a flaky list would hide.
  assert.deepEqual(
    compare(failing, expectations, { platform: 'linux' }).unexpected.map((d) => [
      d.expected,
      d.actual,
    ]),
    [['PASS', 'FAIL']],
  );
  // A platform with no key expects nothing, so any result is a delta.
  assert.deepEqual(
    compare(failing, expectations, { platform: 'win32' }).unexpected.map((d) => d.expected),
    [''],
  );
});

test('updateExpectations on a platform-keyed expectation changes only that platform', () => {
  const old: Record<string, Expectation> = {
    t: {
      status: 'OK',
      subtests: {
        h264: { status: { darwin: 'FAIL', linux: 'PASS' }, reason: 'r' },
        other: { status: { darwin: 'FAIL', linux: 'PASS' }, reason: 'r' },
      },
    },
  };
  const results = { t: result({ h264: 'TIMEOUT', other: 'FAIL' }) };
  const updated = updateExpectations(results, old, { platform: 'linux' });
  assert.deepEqual(updated.t, {
    status: 'OK',
    subtests: {
      h264: { status: { darwin: 'FAIL', linux: 'TIMEOUT' }, reason: 'TIMEOUT message' },
      // Equal on every platform again: back to a plain status, with the
      // new failure's reason instead of the stale one.
      other: { status: 'FAIL', reason: 'FAIL message' },
    },
  });
});

test('updateExpectations off macOS keys a changed plain status instead of overwriting it', () => {
  // A plain status is darwin's (expectations are recorded on macOS).
  const old: Record<string, Expectation> = {
    t: { status: 'OK', subtests: { fixed: { status: 'FAIL', reason: 'r' }, broke: 'PASS' } },
  };
  const results = { t: result({ fixed: 'PASS', broke: 'FAIL' }) };
  assert.deepEqual(updateExpectations(results, old, { platform: 'linux' }).t, {
    status: 'OK',
    subtests: {
      // The darwin failure's reason still describes the difference.
      fixed: { status: { darwin: 'FAIL', linux: 'PASS' }, reason: 'r' },
      broke: { status: { darwin: 'PASS', linux: 'FAIL' }, reason: 'FAIL message' },
    },
  });
  // On macOS itself the plain status is simply updated.
  assert.deepEqual(updateExpectations(results, old, { platform: 'darwin' }).t, {
    status: 'OK',
    subtests: { fixed: 'PASS', broke: { status: 'FAIL', reason: 'FAIL message' } },
  });
});

test('updateExpectations collapses a keyed status that is equal everywhere, dropping its reason', () => {
  const old: Record<string, Expectation> = {
    t: {
      status: 'OK',
      subtests: { h264: { status: { darwin: 'FAIL', linux: 'PASS' }, reason: 'platform' } },
    },
  };
  const updated = updateExpectations({ t: result({ h264: 'PASS' }) }, old, { platform: 'darwin' });
  assert.deepEqual(updated.t, { status: 'OK', subtests: { h264: 'PASS' } });
});

test('compare: a PROTOCOL_ERROR is unexpected even where the expectations allow it', () => {
  const expectations: Record<string, Expectation> = {
    t: { status: ['OK', 'ERROR', 'PROTOCOL_ERROR'], subtests: {} },
  };
  const { unexpected } = compare({ t: result({}, 'PROTOCOL_ERROR') }, expectations);
  assert.deepEqual(
    unexpected.map((d) => d.actual),
    ['PROTOCOL_ERROR'],
  );
});

test('updateExpectations on a full run drops tests that no longer run, but keeps SKIP entries', () => {
  const old: Record<string, Expectation> = {
    gone: { status: 'OK', subtests: { a: 'PASS' } },
    skipped: { status: 'SKIP', reason: 'needs a DOM' },
  };
  assert.deepEqual(updateExpectations({}, old, { full: true }), {
    skipped: { status: 'SKIP', reason: 'needs a DOM' },
  });
  // A filtered run keeps what it didn't run.
  assert.deepEqual(updateExpectations({}, old), old);
});

test('updateExpectations keeps what a subtest was expected to do when a harness timeout left it NOTRUN', () => {
  const old: Record<string, Expectation> = { t: { status: 'OK', subtests: { later: 'PASS' } } };
  const updated = updateExpectations({ t: result({ later: 'NOTRUN' }, 'TIMEOUT') }, old, {
    platform: 'darwin',
  });
  assert.deepEqual(updated.t, { status: 'TIMEOUT', subtests: { later: 'PASS' } });
});

test('updateExpectations keeps reasons and flaky markers that still hold, and unrun tests', () => {
  const old: Record<string, Expectation> = {
    t: {
      status: 'OK',
      subtests: {
        kept: { status: 'FAIL', reason: 'hand-written reason' },
        flaky: { status: ['PASS', 'TIMEOUT'], reason: 'flaky' },
        fixed: { status: 'FAIL', reason: 'old' },
      },
    },
    skipped: { status: 'SKIP', reason: 'needs a DOM' },
  };
  const results = { t: result({ kept: 'FAIL', flaky: 'PASS', fixed: 'PASS', broke: 'FAIL' }) };
  assert.deepEqual(updateExpectations(results, old, { platform: 'darwin' }), {
    skipped: { status: 'SKIP', reason: 'needs a DOM' },
    t: {
      status: 'OK',
      subtests: {
        kept: { status: 'FAIL', reason: 'hand-written reason' },
        flaky: { status: ['PASS', 'TIMEOUT'], reason: 'flaky' },
        fixed: 'PASS',
        broke: { status: 'FAIL', reason: 'FAIL message' },
      },
    },
  });
});
