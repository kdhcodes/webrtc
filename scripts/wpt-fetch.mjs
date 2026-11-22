#!/usr/bin/env node
// Vendors the pinned web-platform-tests subset into test/wpt/vendor/:
// webrtc/ plus the few resources, helpers and IDL files its tests load.
// A shallow, blobless, sparse git fetch of one commit, so only these files
// are downloaded (a few MB), then copied over the old vendor tree.
//
//   node scripts/wpt-fetch.mjs [--commit <sha>]
//
// Without --commit it re-fetches the commit recorded in
// test/wpt/vendor/WPT_COMMIT. After a bump, run `pnpm run wpt:update` and
// review the expectation changes.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'test/wpt/vendor');
const repo = 'https://github.com/web-platform-tests/wpt.git';

/** Paths copied from the WPT checkout, relative to its root. */
const paths = [
  'LICENSE.md',
  'webrtc',
  'resources/testharness.js',
  'resources/idlharness.js',
  // Served as /resources/WebIDLParser.js by wptserve (an alias).
  'resources/webidl2/lib/webidl2.js',
  'common/gc.js',
  'common/subset-tests-by-key.js',
  'mediacapture-streams/permission-helper.js',
  // idlharness.https.window.js fetches these.
  ...['webrtc', 'webidl', 'mediacapture-streams', 'hr-time', 'dom', 'html', 'websockets'].map(
    (name) => `interfaces/${name}.idl`,
  ),
];

/** Not needed to run anything: WPT's own maintenance scripts. */
const excluded = ['webrtc/tools'];

function parseArgs(argv) {
  const at = argv.indexOf('--commit');
  if (at !== -1) return argv[at + 1];
  const recorded = join(vendor, 'WPT_COMMIT');
  if (!existsSync(recorded)) throw new Error('no --commit given and no WPT_COMMIT recorded');
  return readFileSync(recorded, 'utf8').trim();
}

const commit = parseArgs(process.argv.slice(2));
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a full commit hash: ${commit}`);

const work = mkdtempSync(join(tmpdir(), 'wpt-fetch-'));
const git = (...args) => execFileSync('git', ['-C', work, ...args], { stdio: 'inherit' });
try {
  git('init', '--quiet');
  git('remote', 'add', 'origin', repo);
  git('sparse-checkout', 'set', '--no-cone', ...paths.map((p) => `/${p}`));
  git('fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', commit);
  git('checkout', '--quiet', 'FETCH_HEAD');

  rmSync(vendor, { recursive: true, force: true });
  for (const path of paths) {
    const from = join(work, path);
    if (!existsSync(from)) throw new Error(`${path} is not in WPT ${commit}`);
    cpSync(from, join(vendor, path), {
      recursive: true,
      filter: (src) => !excluded.some((ex) => src.startsWith(join(work, ex))),
    });
  }
  writeFileSync(join(vendor, 'WPT_COMMIT'), `${commit}\n`);
  console.log(`vendored WPT ${commit} into ${vendor}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
