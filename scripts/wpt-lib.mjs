// The WPT harness's pure parts, shared by scripts/wpt-run.mjs (the driver)
// and test/wpt/child.mjs (one test file in one process): finding tests,
// reading their scripts and META, and comparing results with
// test/wpt/expectations.json. No I/O beyond reading the vendored tree.
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Subtest statuses, as testharness.js formats them. */
export const PASS = 'PASS';

/**
 * File-level statuses: testharness.js's harness statuses (OK, ERROR,
 * TIMEOUT, PRECONDITION_FAILED) plus the runner's own:
 * - CRASH: the process died before reporting completion
 * - KILLED: the runner's hard timeout or RSS cap
 * - EXIT_HANG: it reported completion but didn't exit, and was killed
 * - PROTOCOL_ERROR: it printed a result line the runner couldn't parse
 *   (always unexpected, whatever the expectations say)
 * - MISSING (a delta, not a result): a full run had no result for a test
 *   the expectations say runs
 * SKIP marks a file the expectations say not to run.
 */
export const OK = 'OK';

/** A runner bug, never a test outcome, so never expected. */
export const PROTOCOL_ERROR = 'PROTOCOL_ERROR';

/**
 * Where the scripts a test page loads come from, keyed by their URL path.
 * null means "load nothing": testdriver is replaced by a stub in the child.
 */
const aliases = {
  '/resources/testharnessreport.js': 'harness:testharnessreport.js',
  '/resources/WebIDLParser.js': '/resources/webidl2/lib/webidl2.js',
  '/resources/testdriver.js': null,
  '/resources/testdriver-vendor.js': null,
  '/resources/testdriver-actions.js': null,
};

/** Is `path` (relative to the vendor root, POSIX separators) a test file? */
export function isTestFile(path) {
  if (!path.startsWith('webrtc/') || path.startsWith('webrtc/resources/')) return false;
  return /\.(window|any)\.js$/.test(path) || path.endsWith('.html');
}

/**
 * Every test in the vendored tree, as ids: the path relative to the vendor
 * root plus the variant's query string, if the test has variants.
 */
export function discoverTests(vendorDir) {
  const files = readdirSync(join(vendorDir, 'webrtc'), { recursive: true })
    .map((f) => posix.join('webrtc', String(f).split('\\').join('/')))
    .filter(isTestFile)
    .sort();
  const ids = [];
  for (const file of files) {
    const source = readFileSync(join(vendorDir, file), 'utf8');
    const { variants } = file.endsWith('.html') ? parseHtml(source) : parseMeta(source);
    if (file.endsWith('.html') && !source.includes('/resources/testharness.js')) continue;
    if (variants.length === 0) ids.push(file);
    else for (const variant of variants) ids.push(`${file}${variant}`);
  }
  return ids;
}

/** Splits a test id into its file and its variant ('' or '?...'). */
export function splitId(id) {
  const at = id.indexOf('?');
  return at === -1 ? { file: id, variant: '' } : { file: id.slice(0, at), variant: id.slice(at) };
}

/**
 * The `// META:` header of a .window.js / .any.js test: its scripts (in
 * order), whether it has a long timeout, its title and variants.
 */
export function parseMeta(source) {
  const meta = { scripts: [], long: false, title: null, variants: [] };
  for (const line of source.split('\n')) {
    const m = /^\/\/\s*META:\s*(\w+)=(.*)$/.exec(line.trim());
    if (!m) {
      if (line.trim() === '' || line.trim().startsWith('//')) continue;
      break;
    }
    const [, key, value] = m;
    if (key === 'script') meta.scripts.push(value.trim());
    else if (key === 'timeout') meta.long = value.trim() === 'long';
    else if (key === 'title') meta.title = value.trim();
    else if (key === 'variant') meta.variants.push(value.trim());
  }
  return meta;
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** An attribute's value from a tag's source, or null. */
function attribute(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3]) : null;
}

/** Tags that aren't page content (the child's DOM shim makes its own). */
const structuralTags = new Set([
  'html',
  'head',
  'body',
  'meta',
  'title',
  'script',
  'link',
  'style',
]);

/**
 * The scripts of an .html test, in document order: `{ src }` for external
 * ones and `{ code, line }` for inline ones (line: where the code starts in
 * the file, for stack traces). Plus its title, long timeout and variants,
 * and the page's elements that tests can reach (`{ tag, attributes }`, in
 * document order, nesting dropped): media and canvas elements, and any
 * element with an id. A regex scan, which is enough for WPT's simple pages
 * (inline scripts don't contain "</script>").
 */
export function parseHtml(source) {
  const page = { scripts: [], long: false, title: null, variants: [], elements: [] };
  const title = /<title>([\s\S]*?)<\/title>/i.exec(source);
  if (title) page.title = decodeEntities(title[1].trim());
  for (const m of source.matchAll(/<meta\b[^>]*>/gi)) {
    const name = attribute(m[0], 'name');
    const content = attribute(m[0], 'content');
    if (name === 'timeout' && content === 'long') page.long = true;
    if (name === 'variant' && content !== null) page.variants.push(content);
  }
  // Skip comments, so a commented-out <script> isn't run.
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  for (const m of withoutComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const [, attrs, body] = m;
    const type = attribute(` ${attrs}`, 'type');
    if (type !== null && !/^(text|application)\/(java|ecma)script$/i.test(type)) continue;
    const src = attribute(` ${attrs}`, 'src');
    if (src !== null) {
      page.scripts.push({ src });
    } else {
      const offset = m.index + m[0].indexOf('>') + 1;
      const line = withoutComments.slice(0, offset).split('\n').length;
      page.scripts.push({ code: body, line });
    }
  }
  const markup = withoutComments.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  for (const m of markup.matchAll(/<([a-z][a-z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const tag = m[1].toLowerCase();
    if (structuralTags.has(tag)) continue;
    const attributes = {};
    for (const a of m[2].matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attributes[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    }
    if ('id' in attributes || ['video', 'audio', 'canvas'].includes(tag)) {
      page.elements.push({ tag, attributes });
    }
  }
  return page;
}

/**
 * Resolves a script URL, as a page at `file` would, to a path relative to
 * the vendor root, 'harness:<name>' for the runner's own files, or null
 * for scripts that are stubbed out.
 */
export function resolveScript(src, file) {
  const url = new URL(src, `https://wpt.test/${file}`);
  if (url.origin !== 'https://wpt.test') throw new Error(`cross-origin script ${src} in ${file}`);
  const path = url.pathname;
  if (path in aliases) {
    const alias = aliases[path];
    return alias === null || alias.startsWith('harness:') ? alias : alias.slice(1);
  }
  return path.slice(1);
}

/**
 * The scripts to run for test `id`, in order, as `{ path }` (vendor- or
 * harness-relative, see resolveScript) or `{ code, line }` entries, plus
 * the test's title and whether its timeout is long. .window.js/.any.js
 * tests get what wptserve's generated page loads: testharness.js, the
 * report hook, the META scripts, then the test.
 */
export function testPlan(vendorDir, id) {
  const { file } = splitId(id);
  const source = readFileSync(join(vendorDir, file), 'utf8');
  if (file.endsWith('.html')) {
    const page = parseHtml(source);
    const scripts = [];
    for (const s of page.scripts) {
      if ('code' in s) scripts.push(s);
      else {
        const path = resolveScript(s.src, file);
        if (path !== null) scripts.push({ path });
      }
    }
    return { scripts, long: page.long, title: page.title, elements: page.elements };
  }
  const meta = parseMeta(source);
  const scripts = [{ path: 'resources/testharness.js' }, { path: 'harness:testharnessreport.js' }];
  for (const src of meta.scripts) {
    const path = resolveScript(src, file);
    if (path !== null) scripts.push({ path });
  }
  scripts.push({ path: file });
  return { scripts, long: meta.long, title: meta.title, elements: [] };
}

/**
 * The statuses an expectation allows on `platform` (process.platform).
 * `status` is a status, a list of them (flaky), or an object keyed by
 * platform whose values are either (a platform difference, e.g. `{"darwin":
 * "FAIL", "linux": "PASS"}`). A platform with no key allows nothing, so
 * every result there is a delta until it gets one.
 */
export function allowed(expectation, platform = process.platform) {
  let status = typeof expectation === 'string' ? expectation : expectation.status;
  if (isKeyed(status)) status = status[platform] ?? [];
  return Array.isArray(status) ? status : [status];
}

/** Whether a status is keyed by platform. */
function isKeyed(status) {
  return status !== null && typeof status === 'object' && !Array.isArray(status);
}

/**
 * Compares a run's results with the expectations. `results` maps test id
 * to `{ status, message?, subtests: { name: { status, message? } } }`;
 * `expectations` is expectations.json's `tests` object. Returns the
 * deltas:
 * - unexpected: results outside what's expected that aren't passes (a
 *   new or changed failure, or an expected subtest gone missing). These
 *   fail `pnpm run wpt`.
 * - newPasses: subtests (or files) that pass but were expected not to.
 * Options:
 * - full: the run covered every test (no --filter). Then a test with a
 *   (non-SKIP) expectation but no result is unexpected: it was skipped by
 *   an over-broad pattern, not discovered, or dropped by a vendor bump.
 * - platform: whose platform-keyed expectations apply.
 */
export function compare(results, expectations, { full = false, platform = process.platform } = {}) {
  const unexpected = [];
  const newPasses = [];
  for (const [id, result] of Object.entries(results)) {
    const expected = expectations[id];
    if (expected === undefined) {
      unexpected.push({ id, subtest: null, expected: 'none', actual: result.status });
      continue;
    }
    const fileAllowed = allowed(expected, platform);
    if (result.status === PROTOCOL_ERROR || !fileAllowed.includes(result.status)) {
      const entry = {
        id,
        subtest: null,
        expected: fileAllowed.join('|'),
        actual: result.status,
        message: result.message,
      };
      (result.status === OK ? newPasses : unexpected).push(entry);
    }
    const subtests = expected.subtests ?? {};
    // After an expected (flaky) harness timeout, the subtests it left
    // NOTRUN follow from it rather than being failures of their own.
    const timedOutAsExpected = result.status === 'TIMEOUT' && fileAllowed.includes('TIMEOUT');
    for (const [name, sub] of Object.entries(result.subtests)) {
      const want = name in subtests ? allowed(subtests[name], platform) : ['none'];
      if (want.includes(sub.status)) continue;
      if (timedOutAsExpected && sub.status === 'NOTRUN') continue;
      const entry = {
        id,
        subtest: name,
        expected: want.join('|'),
        actual: sub.status,
        message: sub.message,
      };
      (sub.status === PASS ? newPasses : unexpected).push(entry);
    }
    for (const [name, sub] of Object.entries(subtests)) {
      if (name in result.subtests) continue;
      const want = allowed(sub, platform);
      // A subtest that was expected to fail and is now gone isn't a regression.
      if (!want.includes(PASS)) continue;
      unexpected.push({ id, subtest: name, expected: want.join('|'), actual: 'MISSING' });
    }
  }
  if (full) {
    for (const [id, expected] of Object.entries(expectations)) {
      if (id in results || allowed(expected, platform).includes('SKIP')) continue;
      unexpected.push({
        id,
        subtest: null,
        expected: allowed(expected, platform).join('|'),
        actual: 'MISSING',
        message: 'expected to run, but the run had no result for it (skipped or not found)',
      });
    }
  }
  return { unexpected, newPasses };
}

/** The first line of a failure message, capped, for use as a reason. */
export function shortMessage(message) {
  if (!message) return '';
  const line = String(message).split('\n')[0].trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/**
 * New expectations from a run's results. Keeps SKIP entries, flaky
 * markers (lists), platform keys and reasons whose status didn't change;
 * a new non-pass gets its failure message as the reason. Expectations are
 * recorded on macOS, so a plain status is darwin's: an update elsewhere
 * that changes it records the difference as `{darwin: <old>, <platform>:
 * <new>}`, and a keyed status only ever changes the running platform's
 * key. A keyed status that ends up equal on every platform present
 * collapses back to a plain one. Tests not in `results` are kept, unless
 * `full` (the run covered every test): then only their SKIP entries are,
 * since the rest no longer run.
 */
export function updateExpectations(
  results,
  old,
  { full = false, platform = process.platform } = {},
) {
  const next = {};
  const ids = [...new Set([...Object.keys(old), ...Object.keys(results)])].sort();
  for (const id of ids) {
    const before = old[id];
    const result = results[id];
    if (result === undefined) {
      if (!full || allowed(before, platform).includes('SKIP')) next[id] = before;
      continue;
    }
    const entry = merge(before, result.status, result.message, platform);
    const subtests = {};
    for (const [name, sub] of Object.entries(result.subtests)) {
      const old = before?.subtests?.[name];
      // A subtest a harness timeout left NOTRUN says nothing new about it.
      if (result.status === 'TIMEOUT' && sub.status === 'NOTRUN' && old !== undefined) {
        subtests[name] = old;
        continue;
      }
      subtests[name] = merge(old, sub.status, sub.message, platform);
    }
    if (Object.keys(subtests).length > 0) entry.subtests = subtests;
    next[id] = entry;
  }
  return next;
}

/** The platform a plain (unkeyed) expectation was recorded on. */
const BASE_PLATFORM = 'darwin';

/** One expectation from a result, keeping the old one if it still holds. */
function merge(before, status, message, platform) {
  const fields = typeof before === 'object' && before !== null ? before : {};
  const { subtests: _ignored, ...rest } = fields;
  if (before !== undefined && allowed(before, platform).includes(status)) {
    return typeof before === 'string' ? before : rest;
  }
  const old = typeof before === 'string' ? before : rest.status;
  let next = status;
  if (isKeyed(old)) {
    next = { ...old, [platform]: status };
  } else if (old !== undefined && platform !== BASE_PLATFORM) {
    next = { [BASE_PLATFORM]: old, [platform]: status };
  }
  if (isKeyed(next)) {
    const values = Object.values(next).map((s) => JSON.stringify(s));
    if (values.every((v) => v === values[0])) next = Object.values(next)[0];
  }
  if (next === PASS) return PASS;
  if (next === OK) return { status: OK };
  // The old reason described the old status: a new failure gets its own
  // message, and a platform's new pass keeps the reason only while
  // another platform still differs (it describes that difference).
  let reason = status === PASS || status === OK ? '' : shortMessage(message);
  if (reason === '' && isKeyed(next)) reason = rest.reason ?? '';
  return reason ? { status: next, reason } : { status: next };
}

/** Counts of each subtest status over `results`. */
export function countStatuses(results) {
  const counts = {};
  for (const result of Object.values(results)) {
    for (const sub of Object.values(result.subtests)) {
      counts[sub.status] = (counts[sub.status] ?? 0) + 1;
    }
  }
  return counts;
}
