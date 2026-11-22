// Tests of scripts/prebuild.sh's Linux path: on a host of the triple's
// architecture it builds in Docker, for Docker's name of that platform.
// Runs a copy of the script in a fixture repo, with fake `uname` and
// `docker` on PATH (the fake docker writes a binary where --output says).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
// The Docker image has no git, which prebuild.sh needs for the build id.
const noGit = spawnSync('git', ['--version']).error
  ? 'needs git, and there is none on PATH'
  : false;
const commit = 'abcdef0123456789abcdef0123456789abcdef01';

const fakeUname = `#!/bin/sh
case "$1" in
  -m) echo "$FAKE_ARCH" ;;
  -s) echo Linux ;;
  -sm) echo "Linux $FAKE_ARCH" ;;
  *) echo Linux ;;
esac
`;

const fakeDocker = `#!/bin/sh
echo "$*" >>"$FAKE_DOCKER_LOG"
for arg in "$@"; do
  case "$arg" in
    type=local,dest=*) dest="\${arg#type=local,dest=}" ;;
  esac
done
mkdir -p "$dest"
printf 'ELF GLIBC_2.17 GLIBC_2.34' >"$dest/wrtc.node"
`;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wrtc-prebuild-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, text: string, mode = 0o644) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    chmodSync(join(root, path), mode);
  };
  for (const name of ['prebuild.sh', 'native-inputs.sh', 'gyp-webrtc.py']) {
    write(`scripts/${name}`, readFileSync(join(scripts, name), 'utf8'), 0o755);
  }
  write(
    'scripts/build-libwebrtc.sh',
    `webrtc_branch=7871\nwebrtc_commit=${commit}\n` +
      'depot_tools_commit=0123456789abcdef0123456789abcdef01234567\nlibwebrtc_recipe=1\n',
  );
  for (const dir of ['mac-arm64-release', 'linux-x64-release', 'linux-arm64-release']) {
    write(`third_party/args/${dir}.gn`, `target = "${dir}"\n`);
  }
  write('patches/0001-a.patch', 'a patch\n');
  write('src/addon.cc', '// addon\n');
  write('bin/uname', fakeUname, 0o755);
  write('bin/docker', fakeDocker, 0o755);
  const git = (...args: string[]) => {
    const run = spawnSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');

  // A libwebrtc build of the fixture's config, for each Linux triple.
  const libwebrtc = join(root, 'libwebrtc');
  for (const triple of ['linux-x64', 'linux-arm64']) {
    const at = join(libwebrtc, `${triple}-release`);
    mkdirSync(join(at, 'lib'), { recursive: true });
    writeFileSync(join(at, 'lib', 'libwebrtc.a'), '!<arch>\n');
    const stamp = spawnSync('python3', [join(root, 'scripts', 'gyp-webrtc.py'), 'stamp', triple], {
      encoding: 'utf8',
    }).stdout;
    writeFileSync(
      join(at, '.source'),
      `webrtc https://webrtc.googlesource.com/src.git ${commit} (branch-heads/7871, M150)\n${stamp}`,
    );
  }
  const log = join(root, 'docker.log');
  const prebuild = (triple: string, arch: string) =>
    spawnSync('bash', [join(root, 'scripts', 'prebuild.sh'), triple], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        FAKE_ARCH: arch,
        FAKE_DOCKER_LOG: log,
        WRTC_LIBWEBRTC_DIR: libwebrtc,
      },
    });
  const dockerCalls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { root, prebuild, dockerCalls };
}

test('linux-x64 on an x64 host builds in Docker for linux/amd64', { skip: noGit }, (t) => {
  const f = fixture(t);
  const run = f.prebuild('linux-x64', 'x86_64');
  assert.equal(run.status, 0, run.stderr);
  const [call, ...more] = f.dockerCalls();
  assert.deepEqual(more, []);
  assert.match(
    String(call),
    /^build --platform linux\/amd64 -f docker\/linux\.Dockerfile --target addon /,
  );
  assert.ok(existsSync(join(f.root, 'artifacts/prebuilds/linux-x64/wrtc.node')));
  assert.match(run.stdout, /linux-x64 needs glibc >= 2\.34/);
});

test('linux-arm64 on an arm64 host builds in Docker for linux/arm64', { skip: noGit }, (t) => {
  const f = fixture(t);
  const run = f.prebuild('linux-arm64', 'aarch64');
  assert.equal(run.status, 0, run.stderr);
  assert.match(String(f.dockerCalls()[0]), /^build --platform linux\/arm64 /);
  assert.equal(
    readFileSync(join(f.root, 'artifacts/prebuilds/linux-arm64/libwebrtc-source'), 'utf8').split(
      '\n',
    )[0],
    `webrtc https://webrtc.googlesource.com/src.git ${commit} (branch-heads/7871, M150)`,
  );
});

test('linux-arm64 on an x64 host is refused, not emulated', { skip: noGit }, (t) => {
  const f = fixture(t);
  const run = f.prebuild('linux-arm64', 'x86_64');
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /linux-arm64 builds in Docker on an arm64 host \(natively, not emulated\)/,
  );
  assert.deepEqual(f.dockerCalls(), []);
});
