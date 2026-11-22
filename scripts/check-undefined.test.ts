// Tests of scripts/check-undefined.sh, which `pnpm run build` runs: it
// fails on undefined symbols that aren't Node's, and on an nm that fails.
// A fake nm prints this platform's format (macOS `nm -m`, Linux `nm -D`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-undefined.sh');
const darwin = process.platform === 'darwin';
const skip = ['darwin', 'linux'].includes(process.platform) ? false : 'checks macOS and Linux only';

/** nm's lines for undefined symbols, in this platform's format. */
const undefinedLines = (names: string[]) =>
  names
    .map((name) =>
      darwin
        ? `                 (undefined) external _${name} (dynamically looked up)`
        : `                 U ${name}`,
    )
    .join('\n');

function check(t: TestContext, nm: { stdout?: string; status?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'wrtc-check-undefined-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'out'), nm.stdout ?? '');
  writeFileSync(
    join(dir, 'nm'),
    `#!/bin/sh\ncat "${join(dir, 'out')}"\necho "nm: some error" >&2\nexit ${nm.status ?? 0}\n`,
  );
  chmodSync(join(dir, 'nm'), 0o755);
  return spawnSync('bash', [script, join(dir, 'wrtc.node')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

test("passes when only Node's symbols are undefined", { skip }, (t) => {
  const run = check(t, { stdout: undefinedLines(['napi_create_object', 'uv_default_loop']) });
  assert.equal(run.status, 0, run.stderr);
});

test("fails on an undefined symbol that isn't Node's, naming it", { skip }, (t) => {
  const run = check(t, { stdout: undefinedLines(['napi_create_object', 'webrtc_missing']) });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /unresolved symbols in .*wrtc\.node/);
  assert.match(run.stderr, /webrtc_missing/);
});

test('fails when nm fails, instead of finding nothing missing', { skip }, (t) => {
  const run = check(t, { status: 1 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /check-undefined: nm couldn't read .*wrtc\.node/);
});

test('versioned and weak symbols are not missing', {
  skip: skip || (darwin && 'Linux nm format'),
}, (t) => {
  const run = check(t, {
    stdout: '                 U memcpy@GLIBC_2.17\n                 w __gmon_start__',
  });
  assert.equal(run.status, 0, run.stderr);
});
