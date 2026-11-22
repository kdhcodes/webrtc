// Tests of scripts/npm-publish.mjs, the release workflow's publish step:
// the order packages go out in, skipping versions already published, and
// what it refuses. npm is a fake that logs its calls and answers `npm view`
// from FAKE_PUBLISHED.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publishArgs } from './npm-publish.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'npm-publish.mjs');
const triples = ['darwin-arm64', 'linux-arm64', 'linux-x64'];

// view: prints the version when "<name>@<version>" is in FAKE_PUBLISHED,
// otherwise npm's 404 (or FAKE_VIEW_ERROR's message); publish: succeeds
// unless the tarball's name contains FAKE_PUBLISH_FAIL.
const fakeNpm = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'view') {
  if (process.env.FAKE_VIEW_ERROR) {
    console.error(process.env.FAKE_VIEW_ERROR);
    process.exit(1);
  }
  const published = (process.env.FAKE_PUBLISHED || '').split(',');
  if (published.includes(args[1])) {
    console.log(args[1].split('@').pop());
    process.exit(0);
  }
  console.error('npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/x');
  process.exit(1);
}
if (args[0] === 'publish') {
  const fail = process.env.FAKE_PUBLISH_FAIL;
  process.exit(fail && args[1].includes(fail) ? 1 : 0);
}
process.exit(2);
`;

function fixture(t: TestContext, version = '0.1.0', { platforms = triples } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wrtc-publish-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'artifacts');
  mkdirSync(out);
  const pack = (file: string, manifest: Record<string, unknown>) => {
    const stage = join(dir, 'stage', file, 'package');
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest));
    const tar = spawnSync('tar', ['-czf', join(out, file), '-C', dirname(stage), 'package']);
    assert.equal(tar.status, 0, String(tar.stderr));
  };
  pack(`kdh.codes-webrtc-${version}.tgz`, {
    name: '@kdh.codes/webrtc',
    version,
    optionalDependencies: Object.fromEntries(
      triples.map((triple) => [`@kdh.codes/webrtc-${triple}`, version]),
    ),
  });
  for (const triple of platforms) {
    pack(`kdh.codes-webrtc-${triple}-${version}.tgz`, {
      name: `@kdh.codes/webrtc-${triple}`,
      version,
      os: [triple.split('-')[0]],
    });
  }
  const npm = join(dir, 'npm');
  writeFileSync(npm, fakeNpm);
  chmodSync(npm, 0o755);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script, ...args, out], {
      encoding: 'utf8',
      env: { ...process.env, NPM: npm, FAKE_LOG: log, ...env },
    });
  /** The `npm publish` calls, as "<tarball file> <flags>". */
  const published = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args[0] === 'publish')
      .map(([, tarball = '', ...flags]) => [tarball.split('/').pop(), ...flags].join(' '));
  return { out, run, published };
}

test('publishes the platform packages first, then the main package, with provenance and public access', (t) => {
  const f = fixture(t);
  const run = f.run([]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(f.published(), [
    'kdh.codes-webrtc-darwin-arm64-0.1.0.tgz --access public --provenance',
    'kdh.codes-webrtc-linux-arm64-0.1.0.tgz --access public --provenance',
    'kdh.codes-webrtc-linux-x64-0.1.0.tgz --access public --provenance',
    'kdh.codes-webrtc-0.1.0.tgz --access public --provenance',
  ]);
});

test('skips versions already published, so a rerun after a partial failure publishes the rest', (t) => {
  const f = fixture(t);
  const run = f.run([], {
    FAKE_PUBLISHED: '@kdh.codes/webrtc-darwin-arm64@0.1.0,@kdh.codes/webrtc-linux-arm64@0.1.0',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /@kdh\.codes\/webrtc-darwin-arm64@0\.1\.0 is already published; skipping it/,
  );
  assert.deepEqual(f.published(), [
    'kdh.codes-webrtc-linux-x64-0.1.0.tgz --access public --provenance',
    'kdh.codes-webrtc-0.1.0.tgz --access public --provenance',
  ]);
});

test('stops at the first failed publish, before the main package', (t) => {
  const f = fixture(t);
  const run = f.run([], { FAKE_PUBLISH_FAIL: 'linux-arm64' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /publishing @kdh\.codes\/webrtc-linux-arm64@0\.1\.0 failed; rerun/);
  assert.deepEqual(f.published(), [
    'kdh.codes-webrtc-darwin-arm64-0.1.0.tgz --access public --provenance',
    'kdh.codes-webrtc-linux-arm64-0.1.0.tgz --access public --provenance',
  ]);
});

test('a registry error other than 404 fails without publishing anything', (t) => {
  const f = fixture(t);
  const run = f.run([], { FAKE_VIEW_ERROR: 'npm error code ETIMEDOUT' });
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /npm view @kdh\.codes\/webrtc-darwin-arm64@0\.1\.0 failed:\nnpm error code ETIMEDOUT/,
  );
  assert.deepEqual(f.published(), []);
});

test("refuses to publish a main package whose platform package isn't there", (t) => {
  const f = fixture(t, '0.1.0', { platforms: ['darwin-arm64', 'linux-x64'] });
  const run = f.run([]);
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /@kdh\.codes\/webrtc depends on @kdh\.codes\/webrtc-linux-arm64, which has no tarball/,
  );
  assert.deepEqual(f.published(), []);
});

test('a prerelease goes out under the next tag; --dry-run and --no-provenance pass through', (t) => {
  const f = fixture(t, '0.2.0-rc.1');
  const run = f.run(['--dry-run', '--no-provenance']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    f.published()[3],
    'kdh.codes-webrtc-0.2.0-rc.1.tgz --access public --tag next --dry-run',
  );
});

test('the tarball path is absolute, which npm never reads as a GitHub shorthand', () => {
  const tarball = publishArgs('artifacts/x-0.1.0.tgz', '0.1.0')[1] ?? '';
  assert.ok(tarball.startsWith('/'), tarball);
});
