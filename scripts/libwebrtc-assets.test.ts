// Tests of scripts/libwebrtc-assets.sh, which packs our libwebrtc builds as
// release assets and fetches them back: run on a fixture checkout (the real
// gyp-webrtc.py, fake pins, args and patches, a tiny "build"), downloading
// over file:// URLs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const dirs = ['mac-arm64-release', 'linux-x64-release', 'linux-arm64-release'];
// Without the variables the script reads, which the Docker image and CI set
// (WRTC_LIBWEBRTC_DIR, WRTC_LIBWEBRTC_CACHE): each test sets its own.
const outsideEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('WRTC_LIBWEBRTC_')),
);

/** A checkout with pins, args, a patch, and a linux-x64 build of its config. */
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wrtc-assets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(
    'scripts/build-libwebrtc.sh',
    'webrtc_branch=7871\nwebrtc_commit=abcdef0123456789abcdef0123456789abcdef01\n' +
      'depot_tools_commit=0123456789abcdef0123456789abcdef01234567\nlibwebrtc_recipe=1\n',
  );
  for (const name of ['libwebrtc-assets.sh', 'gyp-webrtc.py']) {
    copyFileSync(join(scripts, name), join(root, 'scripts', name));
  }
  for (const dir of dirs) write(`third_party/args/${dir}.gn`, `target = "${dir}"\n`);
  write('patches/0001-a.patch', 'a patch\n');
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [join(root, 'scripts', 'libwebrtc-assets.sh'), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...outsideEnv, ...env },
    });
  const python = (...args: string[]) =>
    spawnSync('python3', [join(root, 'scripts', 'gyp-webrtc.py'), ...args], { encoding: 'utf8' });
  const configId = python('config-id').stdout.trim();
  const upstream = join(root, 'third_party', 'libwebrtc-upstream');
  /** A build of this checkout's config (or, with stale, of other args). */
  const build = (base: string, dir = 'linux-x64-release', { stale = false } = {}) => {
    const triple = dir === 'mac-arm64-release' ? 'darwin-arm64' : dir.replace('-release', '');
    const stamp = python('stamp', triple).stdout.replace(/(args \S+) \w+/, (line, args) =>
      stale ? `${args} 0000000000000000000000000000000000000000` : line,
    );
    const at = join(base, dir);
    mkdirSync(join(at, 'lib'), { recursive: true });
    mkdirSync(join(at, 'include', 'api'), { recursive: true });
    writeFileSync(join(at, 'lib', 'libwebrtc.a'), `!<arch>\n${dir}\n`);
    writeFileSync(join(at, 'include', 'api', 'peer_connection_interface.h'), '// header\n');
    for (const file of ['LICENSE.md', 'webrtc.ninja', 'args.gn']) {
      writeFileSync(join(at, file), `${file} of ${dir}\n`);
    }
    writeFileSync(
      join(at, '.source'),
      'webrtc https://webrtc.googlesource.com/src.git ' +
        `abcdef0123456789abcdef0123456789abcdef01 (branch-heads/7871, M150)\n${stamp}built now\n`,
    );
    return at;
  };
  const assets = join(root, 'assets');
  const asset = `libwebrtc-${configId}-linux-x64.tar.xz`;
  const hashes = join(root, 'third_party', 'libwebrtc-assets.sha256');
  /** Packs the linux-x64 build into assets/ (recording its hash), and returns the URL to fetch from. */
  const pack = () => {
    const run = runPack();
    assert.equal(run.status, 0, run.stderr);
    return pathToFileURL(assets).href;
  };
  const runPack = () => run(['pack', 'linux-x64'], { WRTC_LIBWEBRTC_ASSETS: assets });
  const nowhere = pathToFileURL(join(root, 'nowhere')).href;
  return { root, run, configId, upstream, build, assets, asset, hashes, pack, runPack, nowhere };
}

/** Every file under dir with its contents, for comparing two builds. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string, rel: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path, `${rel}${entry.name}/`);
      else files[`${rel}${entry.name}`] = readFileSync(path, 'utf8');
    }
  };
  walk(dir, '');
  return files;
}

test('pack makes an xz archive named by config id and records its SHA-256 for committing; fetch unpacks it to a build that passes check', (t) => {
  const f = fixture(t);
  const built = f.build(f.upstream);
  const pack = f.runPack();
  assert.equal(pack.status, 0, pack.stderr);
  assert.deepEqual(readdirSync(f.assets), [f.asset]);
  assert.match(readFileSync(f.hashes, 'utf8'), new RegExp(`^[0-9a-f]{64} {2}${f.asset}\\n$`));
  assert.match(pack.stdout, new RegExp(`gh release create libwebrtc-${f.configId} `));

  const elsewhere = join(f.root, 'fetched');
  mkdirSync(join(elsewhere, '.fetch.other-checkout'), { recursive: true });
  const fetch = f.run(['fetch', 'linux-x64'], {
    WRTC_LIBWEBRTC_DIR: elsewhere,
    WRTC_LIBWEBRTC_BASE_URL: pathToFileURL(f.assets).href,
  });
  assert.equal(fetch.status, 0, fetch.stderr);
  assert.deepEqual(snapshot(join(elsewhere, 'linux-x64-release')), snapshot(built));
  assert.deepEqual(
    readdirSync(elsewhere).sort(),
    ['.fetch.other-checkout', 'linux-x64-release'],
    "its own staging dir is gone, another checkout's is left alone",
  );
});

test("pack replaces its assets' recorded hashes and keeps other configs'", (t) => {
  const f = fixture(t);
  f.build(f.upstream);
  const other = `${'a'.repeat(64)}  libwebrtc-000000000000-linux-x64.tar.xz\n`;
  const stale = `${'b'.repeat(64)}  ${f.asset}\n`;
  writeFileSync(f.hashes, other + stale);
  f.pack();
  const lines = readFileSync(f.hashes, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], other.trim());
  assert.match(String(lines[1]), new RegExp(`^[0-9a-f]{64} {2}${f.asset}$`));
  assert.notEqual(lines[1], stale.trim());
});

test('sha256 prints the committed hash of a triple, for the CI cache key', (t) => {
  const f = fixture(t);
  f.build(f.upstream);
  f.pack();
  const run = f.run(['sha256', 'linux-x64']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(`${run.stdout.trim()}  ${f.asset}\n`, readFileSync(f.hashes, 'utf8'));
  const missing = f.run(['sha256', 'linux-arm64']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no SHA-256 for libwebrtc-\w+-linux-arm64\.tar\.xz/);
});

test("pack refuses a build that isn't this checkout's config, and writes nothing", (t) => {
  const f = fixture(t);
  f.build(f.upstream, 'linux-x64-release', { stale: true });
  const pack = f.runPack();
  assert.notEqual(pack.status, 0);
  assert.match(pack.stderr, /gn args/);
  assert.match(
    pack.stderr,
    new RegExp(`refusing to pack a linux-x64 build that isn't config ${f.configId}`),
  );
  assert.equal(existsSync(f.assets), false);
  assert.equal(existsSync(f.hashes), false);
});

test("fetch refuses an archive that doesn't match the committed hash, and keeps the build that was there", (t) => {
  const f = fixture(t);
  f.build(f.upstream);
  const url = f.pack();
  // Whoever can replace a release asset could replace a hash next to it too.
  writeFileSync(join(f.assets, f.asset), 'not the archive');
  writeFileSync(join(f.assets, `${f.asset}.sha256`), 'whatever they like');
  const elsewhere = join(f.root, 'fetched');
  const old = f.build(elsewhere, 'linux-x64-release', { stale: true });
  const before = snapshot(old);
  const fetch = f.run(['fetch', 'linux-x64'], {
    WRTC_LIBWEBRTC_DIR: elsewhere,
    WRTC_LIBWEBRTC_BASE_URL: url,
  });
  assert.notEqual(fetch.status, 0);
  assert.match(
    fetch.stderr,
    /SHA-256 is [0-9a-f]{64}, but third_party\/libwebrtc-assets\.sha256 says [0-9a-f]{64}; nothing was unpacked/,
  );
  assert.deepEqual(snapshot(old), before);
});

test('fetch refuses an asset with no committed hash, before downloading it', (t) => {
  const f = fixture(t);
  const fetch = f.run(['fetch', 'linux-x64'], { WRTC_LIBWEBRTC_BASE_URL: f.nowhere });
  assert.notEqual(fetch.status, 0);
  assert.match(
    fetch.stderr,
    new RegExp(
      `no SHA-256 for ${f.asset.replaceAll('.', '\\.')} in third_party/libwebrtc-assets\\.sha256`,
    ),
  );
  assert.doesNotMatch(fetch.stderr, /downloading/);
});

test('fetch keeps a build that already matches, without downloading', (t) => {
  const f = fixture(t);
  f.build(f.upstream);
  const fetch = f.run(['fetch', 'linux-x64'], { WRTC_LIBWEBRTC_BASE_URL: f.nowhere });
  assert.equal(fetch.status, 0, fetch.stderr);
  assert.match(fetch.stderr, /already config \w+; keeping it/);
});

test('fetch names the release it looked for when the asset is missing', (t) => {
  const f = fixture(t);
  f.build(f.upstream);
  f.pack();
  const fetch = f.run(['fetch', 'linux-x64'], {
    WRTC_LIBWEBRTC_DIR: join(f.root, 'fetched'),
    WRTC_LIBWEBRTC_BASE_URL: f.nowhere,
  });
  assert.notEqual(fetch.status, 0);
  assert.match(
    fetch.stderr,
    new RegExp(`is there a libwebrtc-${f.configId} release with linux-x64 assets\\?`),
  );
});

test('fetch reuses an archive in WRTC_LIBWEBRTC_CACHE instead of downloading it again', (t) => {
  const f = fixture(t);
  f.build(f.upstream);
  const url = f.pack();
  const cache = join(f.root, 'cache');
  const env = { WRTC_LIBWEBRTC_DIR: join(f.root, 'fetched'), WRTC_LIBWEBRTC_CACHE: cache };
  const first = f.run(['fetch', 'linux-x64'], { ...env, WRTC_LIBWEBRTC_BASE_URL: url });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(cache, f.asset)));
  const again = f.run(['fetch', '--force', 'linux-x64'], {
    ...env,
    WRTC_LIBWEBRTC_BASE_URL: f.nowhere,
  });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /using .*cache/);
});

test('fetch downloads again over a cached archive that no longer matches', (t) => {
  const f = fixture(t);
  const built = f.build(f.upstream);
  const url = f.pack();
  const cache = join(f.root, 'cache');
  mkdirSync(cache);
  writeFileSync(join(cache, f.asset), 'a truncated or stale archive');
  const elsewhere = join(f.root, 'fetched');
  const fetch = f.run(['fetch', 'linux-x64'], {
    WRTC_LIBWEBRTC_DIR: elsewhere,
    WRTC_LIBWEBRTC_CACHE: cache,
    WRTC_LIBWEBRTC_BASE_URL: url,
  });
  assert.equal(fetch.status, 0, fetch.stderr);
  assert.match(
    fetch.stderr,
    /doesn't match third_party\/libwebrtc-assets\.sha256; downloading it again/,
  );
  assert.deepEqual(snapshot(join(elsewhere, 'linux-x64-release')), snapshot(built));
  assert.deepEqual(readFileSync(join(cache, f.asset)), readFileSync(join(f.assets, f.asset)));
});

test("fetch won't replace another configuration's build in a shared (linked) directory", (t) => {
  const f = fixture(t);
  const shared = join(f.root, 'shared');
  f.build(shared, 'linux-x64-release', { stale: true });
  symlinkSync(shared, f.upstream);
  const fetch = f.run(['fetch', 'linux-x64'], { WRTC_LIBWEBRTC_BASE_URL: f.nowhere });
  assert.notEqual(fetch.status, 0);
  assert.match(
    fetch.stderr,
    /which other checkouts use, and its linux-x64-release build is another configuration/,
  );
});

test('an unknown triple is an error', (t) => {
  const f = fixture(t);
  const fetch = f.run(['fetch', 'linux-riscv64']);
  assert.notEqual(fetch.status, 0);
  assert.match(fetch.stderr, /unknown triple 'linux-riscv64'/);
});
