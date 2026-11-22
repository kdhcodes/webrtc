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
      env: { ...process.env, ...env },
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
  return { root, run, configId, upstream, build, assets, asset };
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

test('pack makes an xz archive and SHA-256 named by config id, and fetch unpacks it to a build that passes check', (t) => {
  const f = fixture(t);
  const built = f.build(f.upstream);
  const pack = f.run(['pack', 'linux-x64'], { WRTC_LIBWEBRTC_ASSETS: f.assets });
  assert.equal(pack.status, 0, pack.stderr);
  assert.deepEqual(readdirSync(f.assets).sort(), [f.asset, `${f.asset}.sha256`]);
  assert.match(readFileSync(join(f.assets, `${f.asset}.sha256`), 'utf8'), /^[0-9a-f]{64} {2}/);
  assert.match(pack.stdout, new RegExp(`gh release create libwebrtc-${f.configId} `));

  const elsewhere = join(f.root, 'fetched');
  const fetch = f.run(['fetch', 'linux-x64'], {
    WRTC_LIBWEBRTC_DIR: elsewhere,
    WRTC_LIBWEBRTC_BASE_URL: pathToFileURL(f.assets).href,
  });
  assert.equal(fetch.status, 0, fetch.stderr);
  assert.deepEqual(snapshot(join(elsewhere, 'linux-x64-release')), snapshot(built));
  assert.deepEqual(readdirSync(elsewhere), ['linux-x64-release'], 'no staging dirs left behind');
});

test("pack refuses a build that isn't this checkout's config, and writes nothing", (t) => {
  const f = fixture(t);
  f.build(f.upstream, 'linux-x64-release', { stale: true });
  const pack = f.run(['pack', 'linux-x64'], { WRTC_LIBWEBRTC_ASSETS: f.assets });
  assert.notEqual(pack.status, 0);
  assert.match(pack.stderr, /gn args/);
  assert.match(
    pack.stderr,
    new RegExp(`refusing to pack a linux-x64 build that isn't config ${f.configId}`),
  );
  assert.equal(existsSync(f.assets), false);
});

test('fetch refuses an archive whose SHA-256 is wrong and keeps the build that was there', (t) => {
  const f = fixture(t);
  f.build(f.upstream);
  assert.equal(f.run(['pack', 'linux-x64'], { WRTC_LIBWEBRTC_ASSETS: f.assets }).status, 0);
  writeFileSync(join(f.assets, f.asset), 'not the archive');
  const elsewhere = join(f.root, 'fetched');
  const old = f.build(elsewhere, 'linux-x64-release', { stale: true });
  const before = snapshot(old);
  const fetch = f.run(['fetch', 'linux-x64'], {
    WRTC_LIBWEBRTC_DIR: elsewhere,
    WRTC_LIBWEBRTC_BASE_URL: pathToFileURL(f.assets).href,
  });
  assert.notEqual(fetch.status, 0);
  assert.match(
    fetch.stderr,
    /SHA-256 is [0-9a-f]{64}, but .*\.sha256 says [0-9a-f]{64}; nothing was unpacked/,
  );
  assert.deepEqual(snapshot(old), before);
});

test('fetch keeps a build that already matches, without downloading', (t) => {
  const f = fixture(t);
  f.build(f.upstream);
  const fetch = f.run(['fetch', 'linux-x64'], {
    WRTC_LIBWEBRTC_BASE_URL: pathToFileURL(join(f.root, 'nowhere')).href,
  });
  assert.equal(fetch.status, 0, fetch.stderr);
  assert.match(fetch.stderr, /already config \w+; keeping it/);
});

test('fetch names the release it looked for when there is no asset', (t) => {
  const f = fixture(t);
  const fetch = f.run(['fetch', 'linux-arm64'], {
    WRTC_LIBWEBRTC_BASE_URL: pathToFileURL(join(f.root, 'nowhere')).href,
  });
  assert.notEqual(fetch.status, 0);
  assert.match(
    fetch.stderr,
    new RegExp(`is there a libwebrtc-${f.configId} release with linux-arm64 assets\\?`),
  );
});

test('fetch reuses an archive in WRTC_LIBWEBRTC_CACHE instead of downloading it again', (t) => {
  const f = fixture(t);
  f.build(f.upstream);
  assert.equal(f.run(['pack', 'linux-x64'], { WRTC_LIBWEBRTC_ASSETS: f.assets }).status, 0);
  const cache = join(f.root, 'cache');
  const elsewhere = join(f.root, 'fetched');
  const env = { WRTC_LIBWEBRTC_DIR: elsewhere, WRTC_LIBWEBRTC_CACHE: cache };
  const first = f.run(['fetch', 'linux-x64'], {
    ...env,
    WRTC_LIBWEBRTC_BASE_URL: pathToFileURL(f.assets).href,
  });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(cache, f.asset)));
  const again = f.run(['fetch', '--force', 'linux-x64'], {
    ...env,
    WRTC_LIBWEBRTC_BASE_URL: pathToFileURL(join(f.root, 'nowhere')).href,
  });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /using .*cache/);
});

test("fetch won't replace another configuration's build in a shared (linked) directory", (t) => {
  const f = fixture(t);
  const shared = join(f.root, 'shared');
  f.build(shared, 'linux-x64-release', { stale: true });
  symlinkSync(shared, f.upstream);
  const fetch = f.run(['fetch', 'linux-x64'], {
    WRTC_LIBWEBRTC_BASE_URL: pathToFileURL(join(f.root, 'nowhere')).href,
  });
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
