// Tests of the manifests scripts/package.sh publishes: how the main package
// depends on the platform packages, and the fields the registry needs
// (no `private`, `repository` in every package for npm's provenance check).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type Manifest,
  mainManifest,
  platformDeps,
  platformManifest,
} from './package-manifests.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts', 'package-manifests.mjs');
const triples = ['darwin-arm64', 'linux-arm64', 'linux-x64'];
const repository = { type: 'git', url: 'git+https://github.com/example/webrtc.git' };
const root: Manifest = {
  name: '@scope/webrtc',
  version: '1.2.3',
  description: 'd',
  keywords: ['webrtc'],
  license: 'MIT',
  repository,
  homepage: 'https://github.com/example/webrtc#readme',
  bugs: { url: 'https://github.com/example/webrtc/issues' },
  publishConfig: { access: 'public' },
  type: 'module',
  exports: { '.': './dist/index.js' },
  types: './dist/index.d.ts',
  dependencies: { 'node-addon-api': '^8.0.0', other: '^1.0.0' },
  devDependencies: { typescript: '^7.0.0' },
  scripts: { prepublishOnly: 'exit 1' },
};

test('the main package depends on every platform package, at exactly its version, as optional dependencies', () => {
  const main = mainManifest(root, { buildId: 'abc', triples, wiring: 'optional' });
  assert.deepEqual(main.optionalDependencies, {
    '@scope/webrtc-darwin-arm64': '1.2.3',
    '@scope/webrtc-linux-arm64': '1.2.3',
    '@scope/webrtc-linux-x64': '1.2.3',
  });
  assert.equal(main.peerDependencies, undefined);
});

test('PLATFORM_DEPS=peer makes them optional peer dependencies instead', () => {
  const main = mainManifest(root, { buildId: 'abc', triples, wiring: 'peer' });
  assert.equal(main.optionalDependencies, undefined);
  assert.deepEqual(main.peerDependencies, {
    '@scope/webrtc-darwin-arm64': '1.2.3',
    '@scope/webrtc-linux-arm64': '1.2.3',
    '@scope/webrtc-linux-x64': '1.2.3',
  });
  assert.deepEqual(main.peerDependenciesMeta, {
    '@scope/webrtc-darwin-arm64': { optional: true },
    '@scope/webrtc-linux-arm64': { optional: true },
    '@scope/webrtc-linux-x64': { optional: true },
  });
});

test('an unknown PLATFORM_DEPS is an error naming the choices', () => {
  assert.throws(() => platformDeps(root, triples, 'peers'), {
    message: 'PLATFORM_DEPS=peers: expected optional or peer',
  });
});

test('the main package ships dist, README and the legal files, and only runtime dependencies', () => {
  const main = mainManifest(root, { buildId: 'abc', triples, wiring: 'optional' });
  assert.deepEqual(main.files, ['dist', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']);
  assert.deepEqual(main.dependencies, { other: '^1.0.0' });
  assert.equal(main.devDependencies, undefined);
  assert.equal(main.scripts, undefined, "the repo's scripts (prepublishOnly) stay out");
  assert.equal(main.nativeBuild, 'abc');
});

test('every package carries the registry fields and is publishable', () => {
  const main = mainManifest(root, { buildId: 'abc', triples, wiring: 'optional' });
  const linux = platformManifest(root, { triple: 'linux-x64', buildId: 'def', commit: 'c0ffee' });
  for (const manifest of [main, linux]) {
    assert.deepEqual(manifest.repository, repository, `${manifest.name}: repository`);
    assert.deepEqual(manifest.publishConfig, { access: 'public' }, `${manifest.name}`);
    assert.equal(manifest.license, 'MIT');
    assert.equal('private' in manifest, false, `${manifest.name} must not be private`);
  }
});

test('a platform package is limited to its os, cpu and (on Linux) glibc, and carries its own build id', () => {
  const linux = platformManifest(root, { triple: 'linux-arm64', buildId: 'def', commit: 'c0ffee' });
  assert.equal(linux.name, '@scope/webrtc-linux-arm64');
  assert.equal(linux.version, '1.2.3');
  assert.deepEqual(linux.os, ['linux']);
  assert.deepEqual(linux.cpu, ['arm64']);
  assert.deepEqual(linux.libc, ['glibc']);
  assert.equal(linux.nativeBuild, 'def');
  assert.equal(linux.main, 'wrtc.node');
  assert.match(String(linux.description), /built from c0ffee/);
  const mac = platformManifest(root, { triple: 'darwin-arm64', buildId: 'def', commit: 'c0ffee' });
  assert.deepEqual(mac.os, ['darwin']);
  assert.equal(mac.libc, undefined);
});

test("the repo's package.json makes publishable packages pointing at its repository", () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const main = mainManifest(pkg, { buildId: 'abc', triples, wiring: 'optional' });
  assert.equal('private' in main, false);
  assert.match(String((pkg.repository as { url: string }).url), /github\.com\/kdhcodes\/webrtc/);
  for (const version of Object.values(main.optionalDependencies as Record<string, string>)) {
    assert.equal(version, pkg.version);
  }
});

function stage(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'wrtc-manifests-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'main'));
  mkdirSync(join(dir, 'linux-x64'));
  writeFileSync(join(dir, 'linux-x64', '.build'), 'def\tc0ffee (dirty)\n');
  return dir;
}

test('the CLI writes the staged manifests and READMEs from the build records', (t) => {
  const dir = stage(t);
  const run = spawnSync(process.execPath, [script, dir, 'abc', triples.join(' '), 'linux-x64'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PLATFORM_DEPS: '' },
  });
  assert.equal(run.status, 0, run.stderr);
  const main = JSON.parse(readFileSync(join(dir, 'main', 'package.json'), 'utf8'));
  assert.equal(main.nativeBuild, 'abc');
  assert.ok(main.optionalDependencies, 'optional dependencies are the default');
  const linux = JSON.parse(readFileSync(join(dir, 'linux-x64', 'package.json'), 'utf8'));
  assert.equal(linux.nativeBuild, 'def');
  assert.match(linux.description, /built from c0ffee \(dirty\)\.$/);
  assert.equal(existsSync(join(dir, 'linux-x64', '.build')), false, '.build is not packed');
  assert.match(
    readFileSync(join(dir, 'linux-x64', 'README.md'), 'utf8'),
    /Install `@kdh\.codes\/webrtc` instead/,
  );
});

test('the CLI refuses an unknown PLATFORM_DEPS', (t) => {
  const dir = stage(t);
  const run = spawnSync(process.execPath, [script, dir, 'abc', triples.join(' ')], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PLATFORM_DEPS: 'bundled' },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /PLATFORM_DEPS=bundled: expected optional or peer/);
});
