// Tests of scripts/gyp-webrtc.py's check that a libwebrtc build matches the
// checkout linking it (its .source against the pins, the recipe version, the
// gn args and the patches), run on a fixture checkout so they don't depend
// on the real build. Hashes are git's blob hashes (`git hash-object`), pinned
// here as git printed them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'gyp-webrtc.py');
const commit = 'abcdef0123456789abcdef0123456789abcdef01';
const depotTools = 'depot_tools 0123456789abcdef0123456789abcdef01234567';
const recipe = 'recipe 1';
// `git hash-object` of "a = 1\n", the args with comments and blank lines dropped.
const linuxArgs =
  'args third_party/args/linux-x64-release.gn 1337a530cbc1bd7d20aee2d80f1f174a9182417d';
const patches = 'patches 9f8cf4f04d8cadec6ef4f1bfe6b37757fd0a6d73';
const webrtcLine = `webrtc https://webrtc.googlesource.com/src.git ${commit} (branch-heads/7871, M150)`;
const matching = [webrtcLine, depotTools, recipe, linuxArgs, patches];

/** A build script with pins, args, two patches, and an empty libwebrtc dir. */
function fixture(t: TestContext, { recipeVersion = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wrtc-gyp-webrtc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const buildScript = (version: number) =>
    write(
      'scripts/build-libwebrtc.sh',
      `# pins\nwebrtc_branch=7871\nwebrtc_commit=${commit}\n` +
        `depot_tools_commit=${depotTools.split(' ')[1]}\nlibwebrtc_recipe=${version}\n`,
    );
  mkdirSync(join(root, 'scripts'));
  copyFileSync(script, join(root, 'scripts', 'gyp-webrtc.py'));
  buildScript(recipeVersion);
  for (const name of ['mac-arm64', 'linux-x64', 'linux-arm64']) {
    write(`third_party/args/${name}-release.gn`, 'a = 1\n');
  }
  write('patches/0002-b.patch', 'b = 2\n');
  write('patches/0001-a.patch', 'diff --git a/x b/x\n');
  const lib = join(root, 'lib');
  /** Runs gyp-webrtc.py with these variables set (or, when undefined, unset). */
  const runWith = (vars: Record<string, string | undefined>, ...args: string[]) => {
    const env = { ...process.env, ...vars };
    for (const [name, value] of Object.entries(vars)) if (value === undefined) delete env[name];
    const r = spawnSync('python3', [join(root, 'scripts', 'gyp-webrtc.py'), ...args], {
      encoding: 'utf8',
      env,
    });
    return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  };
  // The builds in lib/, set up as gpubox-test.sh does: build-libwebrtc.sh
  // writes where the addon links from.
  const run = (...args: string[]) =>
    runWith({ WRTC_LIBWEBRTC_DIR: lib, WEBRTC_DEST: lib }, ...args);
  /** Writes the linux-x64 build's .source. */
  const source = (lines: string[]) =>
    write('lib/linux-x64-release/.source', `${lines.join('\n')}\n`);
  return { root, lib, run, runWith, write, source, buildScript };
}

const local = (triple: string) => `scripts/build-libwebrtc.sh ${triple}`;
const gpubox = (triple: string) =>
  `scripts/gpubox-test.sh -- scripts/build-libwebrtc.sh ${triple} (on gpubox), ` +
  'then copy it here (CONTRIBUTING-AGENTS.md, Setup)';
const onMac = 'scripts/build-libwebrtc.sh darwin-arm64 on an arm64 Mac';
/**
 * What the hints say to run to build each triple, by build host. libwebrtc
 * builds only on an arm64 Mac (darwin-arm64) and on x64 Linux (both Linux
 * triples; scripts/build-libwebrtc.sh refuses anything else).
 */
const buildCommands: Record<string, Record<string, string>> = {
  'darwin-arm64': {
    'darwin-arm64': local('darwin-arm64'),
    'linux-x64': gpubox('linux-x64'),
    'linux-arm64': gpubox('linux-arm64'),
  },
  'linux-x64': {
    'darwin-arm64': onMac,
    'linux-x64': local('linux-x64'),
    'linux-arm64': local('linux-arm64'),
  },
  'linux-arm64': {
    'darwin-arm64': onMac,
    'linux-x64': gpubox('linux-x64'),
    'linux-arm64': gpubox('linux-arm64'),
  },
};
/** What the hints say to run to build `triple` from this machine. */
function buildCommand(triple: string) {
  const host = `${process.platform}-${process.arch}`;
  const command = buildCommands[host]?.[triple];
  if (!command) throw new Error(`no build command for ${triple} from ${host}`);
  return command;
}

test('build_command sends each triple to the host that can build it', () => {
  // host_triple() replaced, so every host is checked on any machine.
  const probe = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("gyp_webrtc", ${JSON.stringify(script)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'out = {}',
    'for host in ("darwin-arm64", "linux-x64", "linux-arm64"):',
    '    m.host_triple = lambda host=host: host',
    '    out[host] = {t: m.build_command(t) for t in ("darwin-arm64", "linux-x64", "linux-arm64")}',
    'print(json.dumps(out))',
  ].join('\n');
  const result = spawnSync('python3', ['-B', '-c', probe], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), buildCommands);
});

test('stamp prints the pins, recipe, args and patches lines, patches in name order', (t) => {
  const { run } = fixture(t);
  assert.deepEqual(run('stamp', 'linux-x64'), {
    status: 0,
    stdout: [depotTools, recipe, linuxArgs, patches].join('\n'),
    stderr: '',
  });
});

test('check passes a build whose .source matches the checkout', (t) => {
  const { run, source } = fixture(t);
  source([...matching, 'built 2026-11-22 on Linux x86_64']);
  assert.deepEqual(run('check', 'linux-x64'), { status: 0, stdout: '', stderr: '' });
});

test('check fails a build made from other pins, recipe, args or patches, naming each', (t) => {
  const { run, source, lib } = fixture(t);
  const otherCommit = webrtcLine.replace(commit, '1'.repeat(40));
  source([
    otherCommit,
    'depot_tools 22',
    'args third_party/args/linux-x64-release.gn 00ff',
    'patches 11ee',
  ]);
  const r = run('check', 'linux-x64');
  assert.equal(r.status, 1);
  assert.equal(
    r.stderr,
    [
      `the linux-x64 libwebrtc build (${lib}/linux-x64-release/.source) doesn't match this checkout:`,
      `  upstream commit: built from '${otherCommit}', the pin is now ${commit}`,
      `  depot_tools pin: built with 'depot_tools 22', this checkout has '${depotTools}'`,
      `  build recipe (libwebrtc_recipe): built with nothing recorded, this checkout has '${recipe}'`,
      `  gn args (third_party/args/linux-x64-release.gn, without comments): built with 'args third_party/args/linux-x64-release.gn 00ff', this checkout has '${linuxArgs}'`,
      `  patches: built with 'patches 11ee', this checkout has '${patches}'`,
      `rebuild it: ${buildCommand('linux-x64')}`,
    ].join('\n'),
  );
});

test('a recipe bump makes existing builds stale and changes the config id', (t) => {
  const { run, source, buildScript } = fixture(t);
  source(matching);
  const before = run('config-id').stdout;
  buildScript(2);
  const r = run('check', 'linux-x64');
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /^ {2}build recipe \(libwebrtc_recipe\): built with 'recipe 1', this checkout has 'recipe 2'$/m,
  );
  assert.notEqual(run('config-id').stdout, before);
});

test('comment and blank-line edits to the args or the build script change nothing', (t) => {
  const { run, source, write, root } = fixture(t);
  source(matching);
  const before = run('config-id').stdout;
  write(
    'third_party/args/linux-x64-release.gn',
    '# gn args\n\na = 1  # one\nb = "x # not a comment"\n',
  );
  // Only the new setting differs; the comments don't count.
  const withSetting = run('stamp', 'linux-x64').stdout;
  write('third_party/args/linux-x64-release.gn', 'a = 1\nb = "x # not a comment"\n');
  assert.equal(run('stamp', 'linux-x64').stdout, withSetting);
  assert.notEqual(run('config-id').stdout, before, 'a real setting changes it');

  write('third_party/args/linux-x64-release.gn', '# reworded\na = 1 # still one\n\n');
  writeFileSync(
    join(root, 'scripts', 'build-libwebrtc.sh'),
    `# reworded comment\nwebrtc_branch=7871\nwebrtc_commit=${commit}\n` +
      `depot_tools_commit=${depotTools.split(' ')[1]}\nlibwebrtc_recipe=1\n`,
  );
  assert.deepEqual(run('check', 'linux-x64'), { status: 0, stdout: '', stderr: '' });
  assert.equal(run('config-id').stdout, before);
});

test('check fails when a patch changes after the build, and when .source is missing', (t) => {
  const { run, source, write, root } = fixture(t);
  source(matching);
  write('patches/0003-new.patch', 'c\n');
  const changed = run('check', 'linux-x64');
  assert.equal(changed.status, 1);
  assert.match(
    changed.stderr,
    /^ {2}patches: built with 'patches 9f8cf4f0[0-9a-f]+', this checkout has /m,
  );
  assert.doesNotMatch(changed.stderr, /gn args|upstream commit|recipe|depot_tools/);

  const copy = join(root, 'artifacts-libwebrtc-source');
  const missing = run('check', 'linux-x64', '--source', copy);
  assert.equal(missing.status, 1);
  assert.match(
    missing.stderr,
    new RegExp(`${copy} is missing, so what it was built from is unknown`),
  );
});

test('check --source reads a copy of .source, as package.sh passes one', (t) => {
  const { run, write, root } = fixture(t);
  write('copy', `${matching.join('\n')}\n`);
  assert.equal(run('check', 'linux-x64', '--source', join(root, 'copy')).status, 0);
});

test('check with --source but no file, or a stray argument, is a usage error', (t) => {
  const { run } = fixture(t);
  const usage = {
    status: 1,
    stdout: '',
    stderr: 'usage: gyp-webrtc.py check [<triple>] [--source <file>]',
  };
  assert.deepEqual(run('check', 'linux-x64', '--source'), usage);
  assert.deepEqual(run('check', 'linux-x64', 'linux-arm64'), usage);
});

test('dir warns about a mismatched build but still prints it, so a local experiment links', (t) => {
  const { run, write, lib } = fixture(t);
  const host = `${process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch}-release`;
  const triple = host.replace(/^mac/, 'darwin').replace(/-release$/, '');
  const args = linuxArgs.replace('linux-x64-release', host);
  write(
    `lib/${host}/.source`,
    `${[webrtcLine, depotTools, recipe, args, 'patches 11ee'].join('\n')}\n`,
  );
  const mismatched = run('dir');
  assert.equal(mismatched.status, 0);
  assert.equal(mismatched.stdout, join(lib, host));
  assert.match(
    mismatched.stderr,
    /^gyp-webrtc.py: warning: .* doesn't match this checkout:\n {2}patches: /,
  );
  assert.ok(
    mismatched.stderr.endsWith(
      `scripts/prebuild.sh refuses it as it is. To fix: rebuild it: ${buildCommand(triple)}`,
    ),
    mismatched.stderr,
  );

  write(`lib/${host}/.source`, `${[webrtcLine, depotTools, recipe, args, patches].join('\n')}\n`);
  assert.deepEqual(run('dir'), { status: 0, stdout: join(lib, host), stderr: '' });
});

test("a mismatched build behind the checkout's own link says to replace that link", (t) => {
  const { runWith, write, root } = fixture(t);
  write('shared/linux-x64-release/.source', `${[webrtcLine, 'patches 11ee'].join('\n')}\n`);
  const link = join(root, 'third_party', 'libwebrtc-upstream');
  symlinkSync(join(root, 'shared'), link);
  const r = runWith(
    { WRTC_LIBWEBRTC_DIR: undefined, WEBRTC_DEST: undefined },
    'check',
    'linux-x64',
  );
  assert.equal(r.status, 1);
  assert.ok(
    r.stderr.endsWith(
      `\n${link} links to ${join(root, 'shared')}, which other checkouts share, so ` +
        "scripts/build-libwebrtc.sh won't replace it: replace the link with a directory " +
        `(rm ${link} && mkdir ${link}), then ${buildCommand('linux-x64')}`,
    ),
    r.stderr,
  );
});

test('a mismatched build from WRTC_LIBWEBRTC_DIR says to unset or repoint it', (t) => {
  const { runWith, source, lib } = fixture(t);
  source([webrtcLine, 'patches 11ee']);
  const r = runWith({ WRTC_LIBWEBRTC_DIR: lib, WEBRTC_DEST: undefined }, 'check', 'linux-x64');
  assert.equal(r.status, 1);
  assert.ok(
    r.stderr.endsWith(
      `\nthe builds come from WRTC_LIBWEBRTC_DIR=${lib}: unset it, or point it at a ` +
        `directory with a matching build; to make one, ${buildCommand('linux-x64')}`,
    ),
    r.stderr,
  );
});

test('config-id changes with the patches and stays put otherwise', (t) => {
  const { run, write } = fixture(t);
  const before = run('config-id').stdout;
  assert.match(before, /^[0-9a-f]{12}$/);
  assert.equal(run('config-id').stdout, before);
  write('patches/0001-a.patch', 'diff --git a/y b/y\n');
  assert.notEqual(run('config-id').stdout, before);
});
