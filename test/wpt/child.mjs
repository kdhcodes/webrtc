// Runs one WPT test (a file, or one variant of it) against one
// implementation, in this process. scripts/wpt-run.mjs spawns one of these
// per test, so open peer connections can't outlive it and @roamhq/wrtc and
// our addon are never loaded together.
//
//   node --expose-gc test/wpt/child.mjs ours|wrtc <test id> [timeout multiplier]
//
// The implementation's exports and the browser shims go on globalThis, and
// every script runs through vm.runInThisContext, so tests see the same
// realm's TypeError, ArrayBuffer and DOMException as the implementation
// (assert_throws_js compares constructors). `document` (test/wpt/dom-shim.ts)
// only appears once testharness.js has loaded, so it picks its
// ShellTestEnvironment.
//
// Output: one line per event on stdout, prefixed with MARKER and JSON:
// {type: 'result', name, status, message} per subtest as it finishes, then
// {type: 'complete', status, message}. Streaming means a test the runner has
// to kill still reports the subtests that finished.
import { readFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { splitId, testPlan } from '../../scripts/wpt-lib.mjs';
import * as dom from './dom-shim.ts';
import { atLeastDelayTimers } from './timers.ts';

export const MARKER = '@@WPT ';

const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, 'vendor');
const [impl, id, multiplierArg] = process.argv.slice(2);
if ((impl !== 'ours' && impl !== 'wrtc') || !id) {
  console.error('usage: child.mjs ours|wrtc <test id> [timeout multiplier]');
  process.exit(2);
}
const multiplier = Number(multiplierArg ?? 1);
const { file, variant } = splitId(id);

/** Synchronous stdout that survives a non-blocking pipe (EAGAIN). */
function emit(event) {
  const bytes = Buffer.from(`${MARKER}${JSON.stringify(event)}\n`);
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(1, bytes, written);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
    }
  }
}

// --- The implementation -----------------------------------------------------

const exports =
  impl === 'wrtc'
    ? createRequire(import.meta.url)('@roamhq/wrtc')
    : await import('../../lib/index.ts');

/** Defines a global as browsers do: writable, configurable, not enumerable. */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

for (const [name, value] of Object.entries(exports)) {
  if (name === 'default') continue;
  defineGlobal(name, value);
}

// --- Browser shims ----------------------------------------------------------

defineGlobal('self', globalThis);
defineGlobal('window', globalThis);

// HTML's setTimeout waits at least the delay; Node's can fire up to about
// 1 ms early (test/wpt/timers.ts).
const timers = atLeastDelayTimers(globalThis.setTimeout, globalThis.clearTimeout, () =>
  performance.now(),
);
defineGlobal('setTimeout', timers.setTimeout);
defineGlobal('clearTimeout', timers.clearTimeout);
// idlharness checks `'Window' in self` to decide what's exposed here.
defineGlobal('Window', function Window() {});
defineGlobal('isSecureContext', true);
defineGlobal('location', {
  href: `https://web-platform.test:8443/${id}`,
  origin: 'https://web-platform.test:8443',
  protocol: 'https:',
  host: 'web-platform.test:8443',
  hostname: 'web-platform.test',
  port: '8443',
  pathname: `/${file}`,
  search: variant,
  hash: '',
});
// The DOM (test/wpt/dom-shim.ts): media elements that play a srcObject
// through the implementation's sinks, and a 2D canvas whose captureStream()
// feeds its source. RTCPeerConnection-helper.js sees
// HTMLCanvasElement.prototype.captureStream and makes video noise with it.
// `document` itself is installed after testharness.js has loaded (see
// installDocument below).
dom.useImplementation(exports);
for (const [name, value] of Object.entries({
  Node: dom.Node,
  Document: dom.Document,
  HTMLElement: dom.HTMLElement,
  HTMLBodyElement: dom.HTMLBodyElement,
  HTMLMediaElement: dom.HTMLMediaElement,
  HTMLVideoElement: dom.HTMLVideoElement,
  HTMLAudioElement: dom.HTMLAudioElement,
  HTMLCanvasElement: dom.HTMLCanvasElement,
  CanvasRenderingContext2D: dom.CanvasRenderingContext2D,
  ImageData: dom.ImageData,
})) {
  defineGlobal(name, value);
}
defineGlobal('requestAnimationFrame', dom.requestAnimationFrame);
defineGlobal('cancelAnimationFrame', dom.cancelAnimationFrame);
// Some tests call trackFactories.audio() directly, which needs a
// synchronous audio track: new AudioContext(), an oscillator connected to
// createMediaStreamDestination(). This minimal stand-in hands out a silent
// track from the implementation's nonstandard RTCAudioSource. There's no
// MediaStreamAudioDestinationNode, so getNoiseStream() still uses
// getUserMedia.
defineGlobal(
  'AudioContext',
  class AudioContext {
    createOscillator() {
      return { connect: (destination) => destination, start() {}, stop() {} };
    }
    createMediaStreamDestination() {
      const track = new exports.nonstandard.RTCAudioSource().createTrack();
      return { stream: new exports.MediaStream([track]) };
    }
    close() {
      return Promise.resolve();
    }
  },
);
// Window event handler attributes that tests assign as bare globals in
// strict code (`onmessage = ...`).
defineGlobal('onmessage', null);
Object.defineProperty(navigator, 'mediaDevices', {
  value: exports.mediaDevices,
  configurable: true,
});
// testdriver.js needs a WebDriver; the permission prompts it would answer
// don't exist here. click() clicks the shim's element.
defineGlobal('test_driver', {
  set_permission: () => Promise.resolve(),
  bless: (_intent, action) => Promise.resolve(action?.()),
  click: (element) => Promise.resolve(element.click()),
});
// idlharness fetches /interfaces/*.idl.
const nodeFetch = globalThis.fetch;
defineGlobal('fetch', (input, init) => {
  const url = String(input);
  if (url.startsWith('/interfaces/')) {
    try {
      return Promise.resolve(new Response(readFileSync(join(vendor, url))));
    } catch {
      return Promise.resolve(new Response('', { status: 404 }));
    }
  }
  return nodeFetch(input, init);
});
// Uint8Array's hex and base64 methods (browsers have them; Node 24's V8
// doesn't). The certificate tests hash DER with them.
if (!Uint8Array.prototype.toHex) {
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    value() {
      return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('hex');
    },
    writable: true,
    configurable: true,
  });
}
if (!Uint8Array.fromBase64) {
  Object.defineProperty(Uint8Array, 'fromBase64', {
    value: (string) => new Uint8Array(Buffer.from(string, 'base64')),
    writable: true,
    configurable: true,
  });
}
// RTCPeerConnection-helper.js reads Blobs with FileReader.
defineGlobal(
  'FileReader',
  class FileReader extends EventTarget {
    result = null;
    onload = null;
    onerror = null;
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(
        (buffer) => {
          this.result = buffer;
          const event = new Event('load');
          this.onload?.(event);
          this.dispatchEvent(event);
        },
        (error) => {
          const event = Object.assign(new Event('error'), { error });
          this.onerror?.(event);
          this.dispatchEvent(event);
        },
      );
    }
  },
);

// The global as an EventTarget, so testharness.js hears uncaught errors and
// unhandled rejections the way a window reports them.
const globalTarget = new EventTarget();
for (const method of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
  defineGlobal(method, globalTarget[method].bind(globalTarget));
}
process.on('uncaughtException', (error) => {
  globalTarget.dispatchEvent(
    Object.assign(new Event('error'), { error, message: String(error?.message ?? error) }),
  );
});
process.on('unhandledRejection', (reason) => {
  globalTarget.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }));
});

// --- Reporting (called by test/wpt/testharnessreport.js) --------------------

// testharness.js's numeric statuses, as WPT's runners name them.
const subtestStatuses = ['PASS', 'FAIL', 'TIMEOUT', 'NOTRUN', 'PRECONDITION_FAILED'];
const harnessStatuses = ['OK', 'ERROR', 'TIMEOUT', 'PRECONDITION_FAILED'];

/** Tests seen (via add_test_state_callback), and those already reported. */
const seen = new Set();
const reported = new Set();
/** Tests still running when the harness timed out. */
const timedOut = new Set();

function reportResult(test, status) {
  reported.add(test);
  emit({ type: 'result', name: test.name, status, message: test.message });
}

defineGlobal('__wptReport', {
  state(test) {
    seen.add(test);
  },
  result(test) {
    const status = skipSubtests.has(test.name)
      ? 'SKIP'
      : (subtestStatuses[test.status] ?? String(test.status));
    reportResult(test, status);
  },
  complete(tests, harness) {
    // A harness timeout completes the file without results for the
    // subtests still pending: the ones that were running timed out, the
    // rest never ran (testharness.js leaves them NOTRUN).
    for (const test of tests) {
      if (reported.has(test)) continue;
      if (timedOut.has(test)) {
        test.message ??= 'still running at the harness timeout';
        reportResult(test, 'TIMEOUT');
      } else {
        reportResult(test, subtestStatuses[test.status] ?? String(test.status));
      }
    }
    const status = harnessStatuses[harness.status] ?? String(harness.status);
    emit({ type: 'complete', status, message: harness.message });
    // Whatever the test left open (peer connections, gUM timers) would keep
    // the process alive.
    process.exit(0);
  },
});

// --- Run --------------------------------------------------------------------

// Subtests the expectations mark SKIP: registered with an empty body, so
// they don't run, and reported as SKIP. Their names must match exactly.
const skipSubtests = new Set(JSON.parse(process.env.WPT_SKIP_SUBTESTS ?? '[]'));

/** Wraps testharness.js's test functions to honour skipSubtests. */
function wrapForSkips() {
  if (skipSubtests.size === 0) return;
  const wrap = (name, empty) => {
    const original = globalThis[name];
    defineGlobal(name, (...args) => {
      // async_test(name) has no function; async_test(func, name) has one.
      const subtestName = typeof args[0] === 'function' ? args[1] : args[0];
      if (!skipSubtests.has(subtestName)) return original(...args);
      return original(empty, subtestName);
    });
  };
  wrap('test', () => {});
  wrap('promise_test', async () => {});
  wrap('async_test', (t) => t.done());
}

const plan = testPlan(vendor, id);
if (plan.title) defineGlobal('META_TITLE', plan.title);

/**
 * Installs `document` with the page's own elements (in its body, and as
 * globals by id: the window's named access). It waits for testharness.js,
 * which picks its ShellTestEnvironment only while there's no `document`:
 * the window environment would want a real page (load events, output).
 */
function installDocument() {
  const document = new dom.Document();
  for (const { tag, attributes } of plan.elements) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (tag === 'canvas' && (name === 'width' || name === 'height'))
        element[name] = Number(value);
      else element.setAttribute(name, value);
    }
    document.body.appendChild(element);
    if (element.id && !(element.id in globalThis)) defineGlobal(element.id, element);
  }
  defineGlobal('document', document);
}

/** A script's source and file name, or null if it doesn't exist (a 404). */
function load(script) {
  if ('code' in script) {
    return { code: script.code, filename: join(vendor, file), lineOffset: script.line - 1 };
  }
  const filename = script.path.startsWith('harness:')
    ? join(here, script.path.slice('harness:'.length))
    : join(vendor, script.path);
  try {
    return { code: readFileSync(filename, 'utf8'), filename, lineOffset: 0 };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

for (const script of plan.scripts) {
  const source = load(script);
  // A browser skips a script that fails to load (only the element gets an
  // error event); some WPT pages do reference files that don't exist.
  if (source === null) {
    console.error(`wpt: ${script.path} not found; skipped, as a browser would`);
    continue;
  }
  try {
    vm.runInThisContext(source.code, {
      filename: source.filename,
      lineOffset: source.lineOffset,
    });
    if (script.path === 'resources/testharness.js') {
      wrapForSkips();
      installDocument();
    }
  } catch (error) {
    // A browser reports a script's uncaught exception to window.onerror and
    // goes on with the next script.
    globalTarget.dispatchEvent(
      Object.assign(new Event('error'), { error, message: String(error?.message ?? error) }),
    );
  }
}

// The browser runner's harness timeout (10 s, or 60 s for timeout=long).
// ShellTestEnvironment has none of its own. testharness.js's timeout()
// completes the file with the harness status TIMEOUT.
const timeoutMs = (plan.long ? 60_000 : 10_000) * multiplier;
setTimeout(() => {
  for (const test of seen) {
    if (test.phase === test.phases.STARTED) timedOut.add(test);
  }
  globalThis.timeout();
}, timeoutMs);
