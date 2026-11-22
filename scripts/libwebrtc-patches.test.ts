// Tests of scripts/libwebrtc-patches.sh, the patch record build-libwebrtc.sh
// keeps in the libwebrtc checkout: run against a fake checkout (a src/ of
// two text files) and a fake gclient, with the real `patch`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const lib = join(dirname(fileURLToPath(import.meta.url)), 'libwebrtc-patches.sh');
const noPatch = spawnSync('patch', ['--version']).error
  ? 'needs the patch CLI, and there is none on PATH'
  : false;

const upper = (file: string, from: string) =>
  `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${from.toUpperCase()}\n`;

/**
 * A repo with patches/, a checkout whose src/ they apply to, and a fake
 * gclient that exits with $FAKE_GCLIENT_STATUS.
 */
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'wrtc-patches-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write('checkout/src/a.txt', 'one\n');
  write('checkout/src/b.txt', 'two\n');
  write('checkout/src/c.txt', 'three\n');
  // Unset, $FAKE_GCLIENT_STATUS counts as 0 in the arithmetic.
  write('bin/gclient', '#!/bin/sh\nexit $((FAKE_GCLIENT_STATUS + 0))\n');
  spawnSync('chmod', ['+x', join(dir, 'bin', 'gclient')]);
  write('repo/patches/0001-a.patch', upper('a.txt', 'one'));
  const applied = join(dir, 'checkout', '.libwebrtc-rs-js-applied-patches');
  /** Runs one of the library's functions the way build-libwebrtc.sh does. */
  const runWith = (vars: Record<string, string>, fn: string, ...args: string[]) => {
    const script =
      'set -euo pipefail\n' +
      'die() { echo "die: $*" >&2; exit 1; }\nlog() { :; }\n' +
      `source "${lib}"\n"$@"`;
    const r = spawnSync('bash', ['-c', script, 'harness', fn, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        repo: join(dir, 'repo'),
        root: join(dir, 'checkout'),
        applied,
        ...vars,
      },
    });
    return { status: r.status, stderr: r.stderr.trim() };
  };
  const run = (fn: string, ...args: string[]) => runWith({}, fn, ...args);
  const read = (path: string) => readFileSync(join(dir, path), 'utf8');
  const record = () => (existsSync(applied) ? readFileSync(applied, 'utf8') : null);
  return { dir, write, run, runWith, read, record };
}

test('a full run: sync clears the record, gen applies and records every patch, package passes', {
  skip: noPatch,
}, (t) => {
  const { write, run, read, record } = fixture(t);
  write('repo/patches/0002-b.patch', upper('b.txt', 'two'));
  write('checkout/.libwebrtc-rs-js-applied-patches', 'stale 0009-old.patch\n');

  assert.deepEqual(run('sync_checkout', '--reset'), { status: 0, stderr: '' });
  assert.equal(record(), null, 'a sync resets every patch');
  assert.equal(run('require_applied_patches').status, 1, 'nothing applied yet');

  assert.deepEqual(run('apply_patches'), { status: 0, stderr: '' });
  assert.equal(read('checkout/src/a.txt'), 'ONE\n');
  assert.equal(read('checkout/src/b.txt'), 'TWO\n');
  assert.deepEqual(
    record()
      ?.trim()
      .split('\n')
      .map((line) => line.split(' ')[1]),
    ['0001-a.patch', '0002-b.patch'],
  );
  assert.deepEqual(run('require_applied_patches'), { status: 0, stderr: '' });

  // Again, as gen runs before every build: already applied, nothing changes.
  const before = record();
  assert.deepEqual(run('apply_patches'), { status: 0, stderr: '' });
  assert.equal(record(), before);
  assert.equal(read('checkout/src/a.txt'), 'ONE\n');
});

test('a patch that half-applied and was then dropped from patches/ still needs a sync', {
  skip: noPatch,
}, (t) => {
  const { write, run, read, dir } = fixture(t);
  // b.txt applies, c.txt's hunk doesn't match: patch changes b.txt and fails.
  write('repo/patches/0002-half.patch', upper('b.txt', 'two') + upper('c.txt', 'nope'));
  const failed = run('apply_patches');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^die: patches\/0002-half.patch doesn't apply/m);
  assert.equal(read('checkout/src/b.txt'), 'TWO\n', 'half of it is in the checkout');

  rmSync(join(dir, 'repo', 'patches', '0002-half.patch'));
  const gen = run('apply_patches');
  assert.equal(gen.status, 1);
  assert.match(
    gen.stderr,
    /^die: the checkout has patches applied that patches\/ no longer has \(or has changed\): 0002-half.patch - run the sync step first/,
  );
  const pkg = run('require_applied_patches');
  assert.equal(pkg.status, 1);
  assert.match(pkg.stderr, /^die: the checkout's applied patches aren't patches\/ as it is now/);
});

test('a sync that fails partway leaves no record, so package refuses the checkout', {
  skip: noPatch,
}, (t) => {
  const { run, runWith, record } = fixture(t);
  assert.equal(run('apply_patches').status, 0);
  assert.deepEqual(run('require_applied_patches'), { status: 0, stderr: '' });

  assert.equal(runWith({ FAKE_GCLIENT_STATUS: '1' }, 'sync_checkout', '--reset').status, 1);
  assert.equal(record(), null);
  assert.equal(run('require_applied_patches').status, 1);
});
