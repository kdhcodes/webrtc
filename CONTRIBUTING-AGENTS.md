# Working on this repo (for agents)

Read `SPEC-LAYER-PLAN.md` (your work package's section, "Conventions",
"Native contract" and "wrtc compatibility spec") and the "Gotchas" in
`PLAN.md` before changing code. This file is the short version of the rules.

## Setup

In the main checkout (once): `scripts/build-libwebrtc.sh darwin-arm64`
(upstream libwebrtc M150 from source, with our gn args from
`third_party/args/` and our patches from `patches/`, into
`third_party/libwebrtc-upstream/mac-arm64-release`; the first build checks
out about 20 GB into `~/src/webrtc-m150` and takes a while, later ones
minutes), then `pnpm install`, then `pnpm run build`. The Linux builds come
from an x64 Linux host (gpubox, below) and are copied here for Docker:
`rsync -a gpubox:repos/personal/libwebrtc-rs-js-libwebrtc/$(python3 scripts/gyp-webrtc.py config-id)/linux-arm64-release third_party/libwebrtc-upstream/`.
Once a configuration's builds are uploaded ("CI and releases"),
`scripts/libwebrtc-assets.sh fetch all` gets all three instead of
building (about 230 MB to download).

In a git worktree: `scripts/setup-worktree.sh`. It links the main
checkout's `third_party/libwebrtc-upstream` (about 1 GB per platform,
gitignored), installs dependencies and builds the addon. A branch that
changes `third_party/args` or `patches/` must not rebuild into that link
(other worktrees use it; `build-libwebrtc.sh` refuses): replace the link
with a directory of its own first (`rm third_party/libwebrtc-upstream &&
mkdir third_party/libwebrtc-upstream`) and build there. See "Rebuilding
libwebrtc" below.

All commands run inside the devenv shell (direnv, or prefix them with
`devenv shell --`).

For `pnpm run test:interop` only, download Playwright's Chromium once per
machine: `npx playwright install chromium` (about 100 MB, into
`~/Library/Caches/ms-playwright` or `~/.cache/ms-playwright`; rerun it after
a Playwright upgrade).

### Chrome interop tests

`test/interop/` runs our `RTCPeerConnection` in Node against Chromium's in
a headless Playwright page (`chrome-peer.js` is the page side, `chrome.ts`
the Node side). Signaling is in-process with trickle ICE both ways. Each side
sends deterministic media (Node: a 440 Hz tone and grey I420 frames from the
nonstandard sources; Chrome: a WebAudio oscillator and a grey canvas) and
checks what it receives: our sinks for samples, frequency, frame size and
luma; in Chrome, `getStats` plus WebAudio and canvas readback. Data
channels are driven the same way (`createDataChannel`, `send`,
`closeChannel` in the page), with each page channel's events reported back
in order as `dc` events. Notes:
- The files are `*.interop.ts`, so `pnpm test` and `test:exit` don't pick
  them up. A leaked handle makes `node --test` hang rather than fail, so
  `close.interop.ts` checks process exit explicitly, in a child process.
- Chrome's inbound `totalAudioEnergy` stays 0 in headless Chromium (no
  playout device), so audio is verified with a WebAudio analyser instead.
- `INTEROP_CHANNEL=chromium` runs full Chromium (new headless) instead of
  the headless shell; `INTEROP_CHANNEL=chrome` runs an installed Google
  Chrome. A managed (policy-controlled) Chrome may drop Playwright's
  connection after about 5 s, which fails every test.
- On gpubox it runs as is (no missing system libraries). Keep the browser
  inside your checkout: run `npx playwright install chromium` and the tests
  with `PLAYWRIGHT_BROWSERS_PATH=<checkout>/.pw-browsers`, over plain `ssh`,
  since `scripts/gpubox-test.sh` re-syncs with `--delete` and would remove it.

### Data channel throughput (`bench/datachannel.mjs`)

A standalone harness (no dependencies beyond the devDependencies): one
sender and one receiver peer connection, one channel, host candidates only.
It prints MiB/s and messages/s, the receiver's 100 ms timeline, every pause
of 50 ms or more between received messages, libwebrtc's data-channel,
transport and selected candidate-pair stats deltas (transport loss, wire
overhead, the pair used), and the OS count of UDP datagrams dropped for a
full socket buffer (`netstat -s -p udp` on macOS, `RcvbufErrors` on Linux).
`--json` prints everything, `--debug` logs each peer's setup steps. It is
separate from `pnpm run bench` (`bench/run.mjs`), which compares ours with
wrtc over media and signaling scenarios and has no data channel case; this
one is a single run per invocation, for investigating data channels.
Examples:

```sh
node bench/datachannel.mjs --topology proc --size 64k --duration 5   # two processes
node bench/datachannel.mjs --size 1k --strategy one                  # same process
node bench/datachannel.mjs --sender wrtc --topology proc --poll 1    # @roamhq/wrtc
node bench/datachannel.mjs --sender chrome --receiver ours           # Chromium -> us
node bench/datachannel.mjs --sender ours --receiver firefox          # us -> Firefox (usrsctp)
node bench/datachannel.mjs --topology remote --candidates ' 192\.168\.' \
  --remote-cmd "ssh gpubox 'cd <checkout> && <node> bench/datachannel.mjs --serve'"
```

- `--sender` / `--receiver`: `ours`, `wrtc`, `chrome` or `firefox` (a
  Playwright page; `INTEROP_CHANNEL` as for the interop tests;
  `npx playwright install firefox` once for Firefox). Our addon and wrtc
  are never loaded into one process. Firefox gathered only the default
  route's interface (a VPN's, here) despite the prefs and the fake
  capture grant the harness sets, and `FIREFOX_ICE_INTERFACE=en0`
  (`force_interface`) didn't change that. Pin the other side with
  `--candidates` so Firefox's checks reach a LAN address; a pair whose
  far end shows as the VPN's address went through the VPN software.
- `--topology same|proc|remote`: receiver in this process, in a child
  process (signaling over its stdin/stdout), or wherever `--remote-cmd`
  runs `--serve` (e.g. over ssh). The child exits when its stdin closes,
  so killing the driver (even with SIGKILL) or dropping ssh ends it.
- `--strategy burst` (send up to `--high`, then wait for
  `bufferedamountlow` at `--low`) or `one` (one message per
  `bufferedamountlow` at 0). wrtc never fires `bufferedamountlow`; use
  `--poll 1` with it.
- `--timeout` (default `--duration` + 60 s) ends a run whose setup or
  transfer hangs. On macOS the run keeps the machine awake (`caffeinate`);
  a run that spanned a sleep anyway is flagged invalid, as in `pnpm run
  bench`. A pair on a VPN interface is flagged too: pin with
  `--candidates`.

**Don't measure throughput with both peers in one process.** Both share
libwebrtc's one network thread, and dcSCTP's slow start on a ~0 ms RTT
overflows the receiving UDP socket in the first ~50 ms (all of the loss
happens then). dcSCTP then recovers through retransmission timeouts at its
400 ms minimum RTO, several in a row, so a few seconds' run averages 1 to
50 MiB/s. Two processes on the same Mac reach about 125 MiB/s with no loss.
wrtc collapses the same way. Browser runs that pick a VPN interface's
candidates go through the VPN software and are slow and lossy (0.2 to
5 MiB/s); pinned to the LAN, us to Chromium ran at 70 MiB/s. On Linux,
mind the 208 KiB default receive buffer: across the LAN it overflowed at
about 12 MiB/s. See the PLAN.md gotcha "Data channel throughput".

## Commands

| Command | What it does |
|---|---|
| `pnpm run build` | node-gyp build of `build/Release/wrtc.node` plus the unresolved-symbol check |
| `pnpm test` | `node --test` over `lib/**/*.test.ts` and `test/**/*.test.ts` (runs the `.ts` directly) |
| `pnpm run test:unit` | only the colocated unit tests under `lib/` |
| `pnpm run typecheck` | `tsc` over `lib/` and `test/`, plus the DOM-lib fixture in `test/types-dom/` |
| `pnpm run test:exit` | runs every test file that can touch the addon under plain `node`; fails if one hangs (leaked handle) |
| `pnpm run test:interop` | Chrome interop (`test/interop/*.interop.ts`): our peer connection against headless Chromium through Playwright. Not part of `pnpm test`; needs the browser download below |
| `pnpm run build:ts` | compiles `lib/` to `dist/` |
| `pnpm run bench` | performance comparison with `@roamhq/wrtc` (`bench/`, see below). Not part of `pnpm test`; takes about 40 minutes with the defaults |
| `pnpm run wpt` | Web Platform Tests `webrtc/` (`test/wpt/`, see below) against ours; prints the deltas from `test/wpt/expectations.json` and fails on an unexpected failure. Not part of `pnpm test`; about 3 minutes |
| `pnpm run wpt:update` | the same, rewriting `expectations.json` and `wrtc-comparison.md` instead of gating |
| `pnpm run wpt:wrtc` | the same tests against `@roamhq/wrtc`, rewriting `wrtc-baseline.json` and `wrtc-comparison.md` (a signal, never a gate) |
| `pnpm run lint` | Biome (JS/TS lint and format check) plus `clang-format --check` |
| `pnpm run format` | applies Biome and clang-format fixes |
| `pnpm run gen:idl` | regenerates `lib/internal/generated/idl.ts` (converters) and `interfaces.ts` (interface shapes) from `@webref/idl` |
| `docker build -f docker/linux.Dockerfile -t wrtc-linux-<wp> --build-context libwebrtc="$(cd -P third_party/libwebrtc-upstream/linux-arm64-release && pwd)" .` then `docker run --rm wrtc-linux-<wp>` | Linux build, typecheck and tests. Use your own tag. |

### Web Platform Tests (`test/wpt/`)

WPT's `webrtc/` tests, run in Node against our implementation, with
`@roamhq/wrtc` as a baseline. Layout:
- `test/wpt/vendor/`: the vendored WPT subset (`webrtc/` plus the
  `resources/`, `common/`, `interfaces/` files it loads, and WPT's BSD-3
  `LICENSE.md`). The commit is in `vendor/WPT_COMMIT`. Don't edit it; bump it
  with `node scripts/wpt-fetch.mjs --commit <sha>` (a sparse, blobless git
  fetch of just those paths), then `pnpm run wpt:update` and review the
  expectation diff.
- `scripts/wpt-run.mjs`: the driver. One child process per test (or per
  `variant` of one), at most `--jobs` (default 4) at a time, long tests first.
- `test/wpt/child.mjs`: one test in one process. It puts the
  implementation's exports and the shims on `globalThis` and runs every
  script with `vm.runInThisContext`, so tests share the implementation's
  realm (`assert_throws_js` compares constructors). Our addon and wrtc are
  never loaded together.
- `scripts/wpt-lib.mjs`: test discovery, `META:` and `.html` script
  extraction, and the expectation comparison (unit-tested in
  `scripts/wpt-lib.test.ts`, which `pnpm test` runs).
- `test/wpt/expectations.json`: `skip` (file patterns with a reason) and
  `tests` (per test: the harness status, and per subtest `"PASS"` or
  `{status, reason}`; a status can be an array for a flaky subtest or an
  object keyed by `process.platform`, and `SKIP` on a subtest makes the
  child register it with an empty body).
- `test/wpt/wrtc-baseline.json` and `wrtc-comparison.md`: wrtc's results on
  the same runner and the per-test pass counts side by side.
- `test/wpt/out/` (gitignored): each run's raw results, with failure
  messages and timings, for digging in.

How a test runs:
- `document` is only installed once testharness.js has loaded, so it uses
  its `ShellTestEnvironment`. The
  runner adds the browser's harness timeout (10 s, 60 s for
  `timeout=long`; `--timeout-multiplier` scales it): subtests still running
  then are TIMEOUT and the rest NOTRUN. A process that hasn't finished 20 s
  after that is killed (KILLED), as is one over `--max-rss-mb` (3 GB); a
  process that dies before reporting is CRASH; one that reports but doesn't
  exit within 10 s is killed as EXIT_HANG; one whose output can't be parsed
  is PROTOCOL_ERROR (a runner bug, so always unexpected). Subtests reported before any of these still count. Killing the
  driver (or a driver error) kills its children.
- On a full run (no `--filter`), a test with a non-SKIP expectation but no
  result is unexpected (MISSING): an over-broad skip pattern, a discovery
  bug, or a vendor bump that dropped the file. A full `wpt:update` drops
  such entries, so after widening a skip pattern check the expectation
  diff: an over-broad pattern silently loses those tests' entries.
- Shims: `window`/`self`, `location` (with the variant as `search`),
  a small DOM (`test/wpt/dom-shim.ts`, its limits in its header comment), a
  minimal `AudioContext` whose destination stream holds a silent
  `nonstandard.RTCAudioSource` track (some tests call
  `trackFactories.audio()` directly), a no-op `test_driver`, `fetch` for
  `/interfaces/*.idl`, `FileReader`, and uncaught errors and unhandled
  rejections dispatched as the window's `error`/`unhandledrejection`
  events. A script that doesn't exist is skipped, as a browser would.
- The DOM shim carries real video. A `<video>`/`<audio>` element plays its
  `srcObject` through the implementation's `RTCVideoSink`/`RTCAudioSink`:
  `loadedmetadata`, `playing`, `videoWidth`, `currentTime`, `timeupdate`,
  `resize` and `requestVideoFrameCallback` follow decoded frames and
  samples. A 2D canvas's `captureStream()` feeds an `RTCVideoSource`, and
  `drawImage(video)` paints the element's current frame (I420 to RGBA,
  BT.601), so `getImageData` pixel checks see what went through the codec.
  The helper's `getNoiseStream({video})` therefore draws on a canvas, as in
  a browser; audio still comes from `getUserMedia`. An audio-only
  element's readiness proves only that the receive pipeline runs (a remote
  sink gets playout silence before any packet), and `currentTime` only
  that one frame or sample arrived; the shim's header lists which passes
  rest on that. The page's own elements
  (`<video id=...>`) come from `wpt-lib`'s `parseHtml` and are reachable by
  `getElementById` and by name on the window.
- Out of scope and skipped (patterns in `expectations.json`): DTMF,
  BFCache, iframes, workers, WebGL and media files (`<video src>`).

Options (after `--`): `--filter a,b` (substrings of test ids), `--jobs N`,
`--timeout-multiplier X`, `--verbose` (the stderr tail of tests that didn't
finish OK), `--impl wrtc`. A filtered `wpt:update` only rewrites the tests
it ran. Wrap full runs in `caffeinate -i` on macOS. On gpubox:
`scripts/gpubox-test.sh <name> -- bash -c 'pnpm run build && pnpm run wpt'`.
Where a subtest's status differs on Linux (e.g. the TCP port-8001
subtests), its expectation is keyed by `process.platform`, e.g. `"status":
{"darwin": "FAIL", "linux": "PASS"}`. A plain status is macOS's (expectations are
recorded there): `wpt:update` on Linux turns a changed plain status into
`{"darwin": <old>, "linux": <new>}`, only ever changes the running
platform's key, and collapses a keyed status back to a plain one when it's
equal on every platform. A list of statuses means flaky, not a platform
difference.

When `pnpm run wpt` reports new passes, record them with `wpt:update`; when
it reports an unexpected failure, fix it or (for a known, explained change)
update and say why in the commit. Give new failures a better `reason` by
hand: `wpt:update` keeps a reason as long as the status doesn't change.

### Benchmark against wrtc

`bench/run.mjs` (run as `pnpm run bench`, which first compiles `dist/`)
runs each configuration several times per implementation, each run in its
own child process (`bench/scenario.mjs ours|wrtc '<config>'`), alternating
which implementation goes first. It prints a Markdown table per
configuration: median [min–max] over runs, the ratio of medians, and the
paired ours/wrtc ratio of each round (run i of each ran back to back, so
machine drift hits both). It writes the table and the raw JSON to
`bench/out/` (gitignored) after every configuration. `bench/RESULTS.md`
holds the recorded results and the verdict, with the full tables, raw JSON
and archived profiles in `bench/results/`. `node bench/run.mjs --report
a.json[,b.json]` re-renders saved JSON; a later file's configurations
replace an earlier one's, for reruns.

- Configurations (`--configs a,b`):
  - `audio`, `vga` (audio + 640x480@30), `hd` (1280x720@30)
  - `vga-x4` and `vga-x8` (4 or 8 loopback pairs)
  - `recv-x6` (receive-heavy: one pair, 6 video tracks into 6 remote sinks)
  - `simulcast` (3 layers of 720p; the receiver gets one m-line per rid,
    munged as `test/interop/codecs.interop.ts` does)
  - `local` (sources straight into sinks, no peer connection: the
    binding's own cost)
  - `control` (signaling, getStats, close and exit timings)
- Every media run must negotiate VP8 on every pair, or it fails.
- `bench/renegotiation-probe.mjs ours|wrtc [n]` measures wall vs CPU time
  per signaling step, and is the workload for a native profile
  (`sample <pid>` on macOS).
- `bench/codec-probe.mjs ours|wrtc [families] [rounds]` measures
  back-to-back renegotiations, optionally with the codec preferences
  limited (e.g. `vp8,vp9`; there is no H264 any more, see PLAN.md
  Gotchas).
- `bench/gc-sinks.mjs ours|wrtc` reports GC by kind for local sinks with
  no other JS running.
- Bound one-off experiments: give them a wall-clock timeout and an RSS
  cap. A failing `assert.deepEqual` on a video frame once built a
  multi-gigabyte diff, so compare frames with `Buffer.compare`.
- A run that prints its results but doesn't exit within 10 s is reported
  as hung, with what the child still had alive
  (`process.getActiveResourcesInfo()`) and, on macOS, a `sample` of its
  native stacks in `--out`.
- Other options: `--runs 5`, `--duration 20` (measured seconds),
  `--warmup 5`, `--impls ours,wrtc`, `--out DIR`, `--src` (load `lib/`
  through type stripping instead of `dist/`; costs memory a real install
  doesn't pay). `node bench/run.mjs --help` lists them.
- Media is pushed from the nonstandard sources on a drift-corrected 10 ms
  clock: a moving texture, VP8 forced first in the offer, and a frame
  counter in the top-left 96x64 pixels that the sinks decode for latency
  and drop counts.
- Close other heavy work first, and on gpubox check `uptime` (load below
  1) before a run; the tables record the load after every run.
- On macOS, run it under `caffeinate -i`: an idle sleep mid-run produces
  fake "hangs" and kills SSH sessions.
- On gpubox, build with `scripts/gpubox-test.sh <name> -- pnpm run build`,
  then start the bench detached on the box (`setsid nohup ... &`, logging
  to a file outside the synced directory) rather than through the SSH
  session: a dropped session kills a 30-minute run.
- wrtc crashes (SIGSEGV/SIGABRT) on exit in some runs; the tables record
  it rather than failing. In media runs wrtc exits with `process.exit()`,
  as the compat scenarios do.

### Linux x64 on gpubox

A real Linux x64 machine is reachable as `ssh gpubox` (Pop!_OS 24.04, 8
cores). Prefer it to the Docker image for Linux x64; Docker on this Mac
remains the way to test **Linux arm64**. `scripts/gpubox-test.sh` syncs the
current checkout to `~/repos/personal/libwebrtc-rs-js-<branch>` on the box
and runs build, typecheck, test and test:exit there; `scripts/gpubox-test.sh
-- <command>` runs a single command instead. It uses the box's shared,
user-local toolchain in `~/repos/personal/libwebrtc-rs-js-tools` (Node 24,
pnpm, LLVM 21; the box's own clang 18 is too old for libwebrtc's libc++) and
the box's libwebrtc builds for the checkout's configuration, in
`~/repos/personal/libwebrtc-rs-js-libwebrtc/<id>/<triple>-release`. `<id>`
is `python3 scripts/gyp-webrtc.py config-id`, a hash of the upstream and
depot_tools pins, the recipe version (`libwebrtc_recipe` in
`build-libwebrtc.sh`), `third_party/args` (without comments) and
`patches/`, so a branch that changes any of them builds its own and never replaces the one other branches link
(they share a build when their configurations match).
`scripts/gpubox-test.sh -- scripts/build-libwebrtc.sh linux-x64` (and
`linux-arm64`) make them from the box's checkout in `~/src/webrtc-m150`,
which every configuration shares, so run one libwebrtc build at a time. A
libwebrtc build takes long enough that a dropped SSH session can kill it:
start it detached on the box (`setsid nohup ... &`) instead. Delete `<id>`
directories no branch uses any more (about 1 GB each; the pre-split
builds in `~/repos/personal/libwebrtc-rs-js/third_party/libwebrtc-upstream`
are only linked by branches older than this scheme). There is no
passwordless sudo: install nothing system-wide. Clean up your own
`~/repos/personal/libwebrtc-rs-js-<branch>` directory when you're done.

### Rebuilding libwebrtc

Whenever the libwebrtc build changes (the upstream pin, `third_party/args`,
`patches/`) or Node is upgraded:

1. Refresh the root certificates TURN over TLS (`turns:`) verifies servers
   against: `scripts/gen-ssl-roots.sh`. It regenerates
   `patches/0003-ssl-roots-from-node.patch` (libwebrtc's compiled-in
   `rtc_base/ssl_roots.h`) from the Node on `PATH`'s bundled Mozilla roots
   (`tls.rootCertificates`; run it in the devenv shell, Node 24) with
   upstream's `tools_webrtc/sslroots/generate_sslroots.py`, and records the
   Node version in the patch header. It leaves the patch alone when only the
   generator's timestamp would change. The roots are compiled in because
   M150's own list (pki.goog's 36) has no ISRG (Let's Encrypt) root, and a
   runtime `SSLCertificateVerifier` is no way round that: on Linux
   BoringSSL's symbols are renamed `BSSL_*`, so a verifier would bind to
   Node's OpenSSL.
2. Rebuild every triple: `scripts/build-libwebrtc.sh darwin-arm64` here,
   linux-x64 then linux-arm64 on gpubox (above), and copy the Linux builds
   back (Setup).
3. Each build's `.source` records the upstream and depot_tools pins, the
   recipe version, and the hashes of its gn args (without comments and
   blank lines) and patches. `python3 scripts/gyp-webrtc.py check
   [<triple>]` compares them with the checkout: `pnpm run build` links a
   build that doesn't match with a warning (for local experiments),
   `scripts/prebuild.sh` refuses it, and `scripts/package.sh` refuses a
   binary linked against one (prebuild.sh keeps the build's `.source` next
   to the binary as `libwebrtc-source`). `build-libwebrtc.sh` itself isn't
   hashed: bump its `libwebrtc_recipe` whenever a change to it changes
   what a build contains or how it's laid out (the ninja targets, what's
   archived, `prefix_boringssl`, the headers copied), so existing builds
   count as stale; comment and logging edits don't need a bump. The
   recipe, the pins, the args and the patches together make the gpubox
   config id. Patches applied since the last `sync` are recorded in the
   checkout (`scripts/libwebrtc-patches.sh`; each before it's applied, so a
   half-applied one counts, and `sync` drops the record before it starts):
   removing or changing one needs the `sync` step before `gen`, and the
   `package` step refuses a checkout whose applied patches aren't
   `patches/`.
4. Rerun the third-party notices steps (Packaging), then
   `scripts/prebuild.sh all`. Pack the builds (`scripts/libwebrtc-assets.sh
   pack`), commit the hashes it records in
   `third_party/libwebrtc-assets.sha256`, and have the user upload them
   before the change is pushed ("CI and releases"): CI can't build or test
   the new configuration until they're up.
5. Check `turns:` against a real server on each platform: `WRTC_TURNS_PROBE=1
   node --test test/integration/turns.test.ts` here, on gpubox (through
   `gpubox-test.sh`) and in the Linux arm64 image (`docker run --rm -e
   WRTC_TURNS_PROBE=1 wrtc-linux-<wp> node --test
   test/integration/turns.test.ts`). It sends bogus credentials to
   `any.turn.svc.whereby.com:443`, whose chain ends at ISRG Root X1, and
   needs TURN's 401 back, which only comes over a verified TLS session.
   Without the variable the file runs only its offline test: a loopback
   server with a throwaway CA's certificate must be refused.

### Packaging (prebuilt tarballs, the ones npm gets)

`artifacts/` (gitignored) gets a main package,
`@kdh.codes/webrtc` (the JS in `dist/`, its types and `README.md`), and one platform
package per supported platform (`@kdh.codes/webrtc-darwin-arm64`,
`-linux-arm64`, `-linux-x64`) carrying `wrtc.node`, with `os`/`cpu` (and
`libc: glibc`) fields. The main package
lists them as `optionalDependencies` at exactly its own version, as wrtc
does, so installs pick the platform's package automatically
(`PLATFORM_DEPS=peer scripts/package.sh` makes them optional
`peerDependencies` instead; `scripts/package.sh` says why that used to be
the default). The manifests come from `scripts/package-manifests.mjs`:
`name`, `version`, `license`, `repository`, `homepage`, `bugs` and
`publishConfig` are taken from `package.json` for every package (npm's
provenance check needs `repository` in each). These tarballs are what gets
published ("CI and releases" below). `lib/internal/native.ts` loads
`build/Release/wrtc.node` when it exists (a checkout), and otherwise the
installed `<name>-<platform>-<arch>` package. Renaming the package is a
one-line change: `name` in `package.json`. A scoped name packs as
`<scope>-<name>-<version>.tgz` (`kdh.codes-webrtc-0.1.0.tgz`), without
the `@` and with the `/` as `-`. The repo root's `package.json` isn't a
package to publish: its `prepublishOnly` fails `npm publish` there.

Build all three binaries and package them, from an arm64 Mac, in this order:

```sh
scripts/prebuild.sh darwin-arm64   # pnpm run build here, strip -x
scripts/prebuild.sh linux-arm64    # Docker: docker/linux.Dockerfile --target addon
scripts/prebuild.sh linux-x64      # gpubox, via gpubox-test.sh; cleans up after itself
                                   # (on an x64 host, e.g. CI, Docker as for linux-arm64)
scripts/package.sh                 # build:ts, then artifacts/*.tgz; lists missing platforms
```

(`scripts/prebuild.sh all` runs the first three.) Each binary lands in
`artifacts/prebuilds/<platform>/` (a failed build keeps the previous one)
with its build id, a hash of the native inputs listed in
`scripts/native-inputs.sh` (sources, build files, the libwebrtc pin), and the
commit it was built from. Both manifests carry that id as `nativeBuild`, and
the loader refuses a platform package from a different build than the main
package. `package.sh` warns when a binary's id differs from the current
native inputs or it was built from uncommitted native sources;
`package.sh --strict` fails instead. A JS-only change needs only
`package.sh`, not new binaries. Then install the
main tarball plus the platform's, e.g. `npm install
./kdh.codes-webrtc-0.1.0.tgz ./kdh.codes-webrtc-darwin-arm64-0.1.0.tgz` or the
same with `pnpm add`; nothing is built on install. (Offline, the other two
optional dependencies fail to resolve and are skipped.)

Smoke-test them from clean installs with `scripts/smoke-install.sh [--pm
pnpm] artifacts`: it installs only the two tarballs, offline, into a fresh
temp dir with a PATH holding only node and the package manager, and runs
`scripts/smoke.mjs` (two PCs, audio and video from the nonstandard sources to
sinks, killed if it hangs). For Linux arm64 in a stock image, with no compiler and no outside
network (an internal Docker network still gives ICE a non-loopback
interface):

```sh
docker network create --internal wrtc-offline
docker run --rm --network wrtc-offline -v "$PWD/artifacts:/artifacts:ro" \
  -v "$PWD/scripts:/scripts:ro" node:24-slim bash /scripts/smoke-install.sh /artifacts
docker network rm wrtc-offline
```

On gpubox, copy the main and linux-x64 tarballs plus `scripts/smoke.mjs` and
`scripts/smoke-install.sh` to a fresh directory outside
`~/repos/personal/libwebrtc-rs-js*`, run it with
`PATH=$HOME/repos/personal/libwebrtc-rs-js-tools/node/bin:/usr/bin:/bin`, and
delete the directory afterwards.

The Linux binaries need **glibc 2.34** or newer (`scripts/prebuild.sh`
prints each one's floor; libwebrtc is built against Chromium's old sysroot,
and the 2.34 comes from linking on Ubuntu 24.04), so Ubuntu 22.04+, Debian
12+, RHEL 9 and Amazon Linux 2023 (linux-arm64 smoke-tested on Rocky Linux
9). The macOS one needs macOS 13.5+ (Node 24's floor; the
addon also links ScreenCaptureKit, 12.3+).

Every package carries `LICENSE` (ours, MIT) and `THIRD_PARTY_NOTICES.md`.
Notices are per platform: each platform package gets `notices/<triple>.md`
(renamed), the licences of what its `wrtc.node` contains (libwebrtc, the
third-party code in that triple's `libwebrtc.a`, node-addon-api); the main
package gets the root `THIRD_PARTY_NOTICES.md`, the union, with each
component's platforms. `package.sh` refuses a platform without its file.
`scripts/third-party-notices.mjs` makes them in two steps (its header has
the details):
1. On the machine that built libwebrtc, for each triple: `node
   scripts/third-party-notices.mjs components <checkout>/src/out/<triple>
   <libwebrtc.a or its "ar t" list> > notices/<triple>.components`. It
   takes every object `build-libwebrtc.sh` archives, checks the list
   against the archive's members, and maps each object's inputs (`ninja -t
   deps`, plus the `%include`s of nasm sources) to their deepest
   `third_party/<name>` directory, so nested code (libaom's `vector`,
   x86inc) is listed too. Linux out dirs are on gpubox
   (`~/src/webrtc-m150/src/out`); give it the member list of the archive
   on this Mac, since gpubox's own copy may be older.
2. `node scripts/third-party-notices.mjs generate --libwebrtc-dir
   <...>/third_party/libwebrtc-upstream`: licence texts from each triple's
   `LICENSE.md` (libwebrtc's own generator), and for directories it leaves
   out, from the checkout (`--checkout`, default `~/src/webrtc-m150/src`).
   It fails on a directory with no licence text.

Rerun both whenever the libwebrtc build changes, and commit the
`.components` lists with the notices. Some archived code isn't linked into
`wrtc.node` (protobuf, utf8_range, perfetto, fastfeat: no symbols of theirs
in the darwin-arm64 or linux-x64 link maps); the notices keep them, marked
as such, because the check is over what's archived.

`package.json` sets `gypfile: false`: without it, `pnpm install` (and npm)
runs an implicit `node-gyp rebuild` because `binding.gyp` sits at the root,
which uses the system compiler on Linux and fails. Build explicitly with
`pnpm run build`.

Before handing work back, all of these must pass on macOS: `build`,
`typecheck`, `test`, `test:exit` and `lint`. Native changes must also pass the Docker
run. CI (below) runs the same on every platform, but only once pushed: run
them locally first.

### CI and releases

The repo is public at `github.com/kevindhanna/webrtc`, so GitHub Actions'
runners are free. Three workflows, plus a local action. Actions from GitHub
(`actions/*`) are pinned by major version, others by commit SHA with the
version in a comment.

- `.github/workflows/ci.yml`, on pushes to `main` and on pull requests. A
  pull request's newer push cancels its older run; every push to `main` runs
  to the end, since releases require CI to have passed on their commit.
  - `lint and typecheck` (ubuntu-24.04): `pnpm run lint` (with
    clang-format pinned to devenv's version, from PyPI) and `typecheck`, once,
    since neither is per platform.
  - `darwin-arm64` (macos-26, arm64): `pnpm run build` on the runner with
    node-gyp (pinned to devenv's) and the image's default Xcode, its newest
    (26.6, Apple clang 21, close to devenv's clang 21; macos-15's default is
    16.4 with clang 17), then `typecheck`, `test` and `test:exit`. Both
    compile against the system libc++, which libwebrtc's mac build uses.
  - `linux-x64` (ubuntu-24.04) and `linux-arm64` (ubuntu-24.04-arm):
    `docker/linux.Dockerfile`, exactly as locally, so the addon links (and
    gets its glibc floor) as the released binaries do. The build stage builds
    and typechecks; `docker run` runs `test` and `test:exit`; linux-x64 also
    runs `pnpm run wpt` (about 4 minutes) and uploads `test/wpt/out` (for
    digging into failures, and for the badge). Only
    the image's `toolchain` and `deps` stages (apt, clang, Node,
    node_modules) go to the Actions cache, never the libwebrtc layer.
  - Not in CI: the Chrome interop tests and `test/sfu` (a browser download
    and timing-sensitive media on shared runners; run them locally).
- `.github/workflows/release.yml`, on tags `v*`: below.
- `.github/workflows/wpt-badge.yml`, after each CI run that succeeded on a
  push to `main` (`workflow_run`), so a failed badge never fails CI, which
  releases require: `scripts/wpt-report.mjs` turns that run's linux-x64
  WPT results artifact into `wpt.json` (the README's shields.io badge:
  subtests passed out of all) and `WPT.md` (the page the badge links to:
  the total, a pass/fail table by section, and per section every test and
  each subtest that didn't pass, with its reason from
  `test/wpt/expectations.json`), and force-pushes both, from a fresh repo,
  as the single commit of the `badges` branch. It's the only job with
  `contents: write`, runs main's own workflow and script (never a pull
  request's), and one run at a time. The sections are a table at the top of
  the script; a test matching none lands in "Other", which its test keeps
  empty for the current suite, so a WPT vendor bump may need a pattern there.
- `.github/actions/libwebrtc`: fetches the libwebrtc build for the
  checkout's config id with `scripts/libwebrtc-assets.sh fetch <triple>`,
  caching the downloaded archive under its committed SHA-256
  (`WRTC_LIBWEBRTC_CACHE`).

**libwebrtc for CI.** CI never builds libwebrtc. It downloads ours from the
GitHub release tagged `libwebrtc-<config id>` (`python3
scripts/gyp-webrtc.py config-id`; "Linux x64 on gpubox" says what it
covers), whose assets are `libwebrtc-<config id>-<triple>.tar.xz`, each
build's whole directory (`include/`, `lib/libwebrtc.a`, `.source`,
`LICENSE.md`, `args.gn`, `webrtc.ninja`, ...). Their SHA-256s are committed
in `third_party/libwebrtc-assets.sha256`, one line per config id and triple,
and `fetch` checks every download (and every cached archive) against those,
never against anything from the release: whoever could replace an asset
could replace a hash next to it too. `scripts/libwebrtc-assets.sh fetch
[<triple>...|all]` downloads, verifies, unpacks into
`third_party/libwebrtc-upstream/` and runs `gyp-webrtc.py check`; it keeps a
build that already matches, and also works locally (e.g. `fetch
linux-arm64` for the Docker run instead of copying it from gpubox).
`WRTC_LIBWEBRTC_BASE_URL` downloads from elsewhere (any URL curl reads),
e.g. a local `python3 -m http.server` over the packed files.

Turn on GitHub's immutable releases (Settings, General, Releases, "Enable
release immutability"): a published release's assets and tag can then
never be replaced. A `libwebrtc-*` release is never edited anyway: to change
an asset, change the build (or bump `libwebrtc_recipe` in
`scripts/build-libwebrtc.sh`), which makes a new config id and a new
release. Without immutability, replacing an asset in place would also need
its new hash committed in a reviewed change, or every fetch fails.

So **whenever the config id changes** (a new upstream pin, recipe, gn args
or patches), and once before CI first runs, the assets must be up before
the commit that needs them reaches GitHub, or its CI fails at the fetch. In
this order:

1. Rebuild all three triples ("Rebuilding libwebrtc"). (Not for the first
   time: the main checkout's builds are config baece4cbd14b.)
2. In the main checkout, with the three builds in
   `third_party/libwebrtc-upstream/`: `scripts/libwebrtc-assets.sh pack`.
   It refuses a build that doesn't match the checkout, writes
   `artifacts/libwebrtc/`, checks each asset is under GitHub's 2 GiB limit
   (at baece4cbd14b: darwin-arm64 135 MiB, linux-arm64 46 MiB, linux-x64
   49 MiB), records their SHA-256s in `third_party/libwebrtc-assets.sha256`
   and prints the upload command, filled in. Run it in the devenv shell: it
   packs with GNU tar and xz, whose output is the same for the same build,
   so for baece4cbd14b the recorded hashes are the ones already committed.
   macOS's own tar (bsdtar) writes other bytes, so other hashes; `pack`
   falls back to it only without GNU tar and xz on `PATH` (it also finds
   Homebrew's `gtar`), with a warning.
   Commit the hashes file with the change that needs the new build.
3. The user uploads them (an agent never does; it's outward-facing). With
   `gh`:

   ```sh
   id=$(python3 scripts/gyp-webrtc.py config-id)
   gh release create "libwebrtc-$id" --repo kevindhanna/webrtc --target main --latest=false \
     --title "libwebrtc $id" --notes "libwebrtc builds for config id $id (scripts/libwebrtc-assets.sh)" \
     artifacts/libwebrtc/libwebrtc-"$id"-*.tar.xz
   ```

   (`gh` uploads the assets to a draft and then publishes it, which an
   immutable release needs.) `--latest=false` keeps the repo's "Latest
   release" for the npm versions; the tag doesn't match `v*`, so it starts
   no release run. Without `gh`, the same through the API, with a token
   that can write the repo's contents (a fine-grained token with "Contents:
   read and write"): create a draft, upload, then publish it.

   ```sh
   id=$(python3 scripts/gyp-webrtc.py config-id); token=...   # the token
   api=https://api.github.com/repos/kevindhanna/webrtc
   auth="Authorization: Bearer $token"
   release=$(curl -fsS -X POST -H "$auth" "$api/releases" \
     -d "{\"tag_name\":\"libwebrtc-$id\",\"target_commitish\":\"main\",\"name\":\"libwebrtc $id\",\"draft\":true,\"make_latest\":\"false\"}" |
     node -p 'JSON.parse(require("fs").readFileSync(0)).id')
   for f in artifacts/libwebrtc/libwebrtc-"$id"-*.tar.xz; do
     curl -fsS -X POST -H "$auth" -H "Content-Type: application/octet-stream" --data-binary @"$f" \
       "https://uploads.github.com/repos/kevindhanna/webrtc/releases/$release/assets?name=$(basename "$f")" >/dev/null
   done
   curl -fsS -X PATCH -H "$auth" "$api/releases/$release" -d '{"draft":false,"make_latest":"false"}' >/dev/null
   ```

4. Only then push the commit (or merge to `main`). Old `libwebrtc-*`
   releases stay: branches and tags of that configuration still fetch them.

**Releasing a version** (after the first, below):

1. On `main`, bump `version` in `package.json` (the platform packages and
   the main package's `optionalDependencies` follow it), commit and push.
2. `git tag v<version> && git push origin v<version>`.
3. `release.yml` then: checks the tag is `v` plus `package.json`'s
   version; waits for CI to pass on the tagged commit
   (`scripts/ci-status.mjs`: a successful `ci.yml` run of that commit,
   waiting up to 90 minutes while one is still going; it fails if they all
   failed or none ran, e.g. for a commit that was never pushed to `main`);
   builds each platform's binary on its own runner with
   `scripts/prebuild.sh <triple>` against the fetched libwebrtc (darwin-arm64
   on macos-26, as in CI; linux-x64 and linux-arm64 in Docker on the Ubuntu
   runners, which `prebuild.sh` does on any host of that architecture); runs
   `scripts/package.sh --strict`; smoke-tests clean, offline installs
   (`scripts/smoke-install.sh`) in `node:24-bookworm-slim` on x64 and
   arm64 and with npm and pnpm on macos-15 (the older macOS, for the binary
   built on 26); then, in the `npm` environment (where you approve the run,
   if the environment requires it), publishes with
   `scripts/npm-publish.mjs`: the three platform packages, then the main
   package, each by `npm publish <tarball> --access public --provenance`
   through trusted publishing (OIDC: `id-token: write`, Node 24's npm,
   checked to be 11.5.1 or later, no token). A version that's already in the
   registry is skipped, so rerunning a partly failed run publishes only the
   rest. A prerelease version (`0.2.0-rc.1`) goes out under the `next`
   dist-tag.
4. The tarballs are the `packages` artifact of the run.

**The first publish** (0.1.0) is manual, from local tarballs: npm only lets
a package configure trusted publishing once it exists. In the main checkout,
with the CI branch merged locally:

1. Upload the libwebrtc assets (steps 2 and 3 above), then push `main`, so
   CI's first run can fetch them.
2. Build and publish:

   ```sh
   scripts/prebuild.sh all                # the Dockerfile's stage split changed the native build id,
                                          # so prebuilds from before it are refused
   scripts/package.sh --strict
   scripts/smoke-install.sh artifacts     # and the Docker smoke test above, for linux-arm64
   npm login                              # an account that can publish to the @kdh.codes scope
   npm publish ./artifacts/kdh.codes-webrtc-darwin-arm64-0.1.0.tgz --access public
   npm publish ./artifacts/kdh.codes-webrtc-linux-arm64-0.1.0.tgz --access public
   npm publish ./artifacts/kdh.codes-webrtc-linux-x64-0.1.0.tgz --access public
   npm publish ./artifacts/kdh.codes-webrtc-0.1.0.tgz --access public
   ```

   (Keep the `./`: without it npm reads `artifacts/x.tgz` as a GitHub repo.
   Add `--otp <code>` if the account uses 2FA for writes. `node
   scripts/npm-publish.mjs --no-provenance artifacts` does the same four in
   the same order, skipping any already published. Provenance needs CI, so
   the first version has none.) Check it with `npm view @kdh.codes/webrtc`
   and an `npm install @kdh.codes/webrtc` in an empty directory.
3. For each of the four packages (`@kdh.codes/webrtc`,
   `@kdh.codes/webrtc-darwin-arm64`, `-linux-arm64`, `-linux-x64`), on
   npmjs.com: the package's Settings, "Trusted Publisher", GitHub Actions,
   with organization or user `kevindhanna`, repository `webrtc`, workflow
   filename `release.yml` and environment name `npm`, with "Allow npm
   publish" ticked (the workflow runs `npm publish`; without it only `npm
   stage publish` is allowed). npm marks a new trusted publisher "Pending
   validation" until a publish through it, and drops it if that doesn't
   happen within about 2 days, so release a new version from CI soon after
   (0.1.1 did this, 2026-11-22). Once all four publish
   from CI, "Require two-factor authentication and disallow tokens" in the
   same settings stops token publishes.
4. On GitHub: Settings, Environments, `npm` (a run creates it if it doesn't
   exist), with yourself as a required reviewer and deployments limited to
   tags matching `v*` (add it as ref type Tag: a branch rule `v*` blocks
   every tag); and immutable releases (above).
5. Don't use `v0.1.0` to try the release workflow: its publish skips a
   version that's out, which doesn't validate the trusted publishers.
   Release a new version instead.

npm took about 4 minutes to serve the new packages after the first publish
("Your package is being processed"); until then the registry answers 404.
npm's 2FA for writes here is a browser approval, so a manual `npm publish`
has to run in a real terminal that can wait for it.

What's only known to work once it has run on GitHub (none of it could run
locally): the runners' toolchains (Xcode 26.6 on macos-26, Docker on the
arm64 runner), the Actions caches, artifact passing between jobs, the CI
gate's API calls, the badge push, OIDC and provenance, and the `npm`
environment. The scripts the workflows call were all run locally, and the
workflows pass `actionlint`.

### Debugging libwebrtc

**Its log.** libwebrtc logs a lot at info level, but by default formats
almost nothing (only its RTCError messages reach stderr). `WRTC_LOG` turns
on a filtered sink (`src/log_hook.cc`) for the whole process; it's read
once, when the addon first loads, and costs nothing when unset:

```sh
WRTC_LOG='SetSink|default receive stream' node my-repro.ts  # lines containing either
WRTC_LOG='*' WRTC_LOG_FILE=/tmp/rtc.log node my-repro.ts     # every line, into a file
```

Lines are info severity and up, as `RTCLOG <seconds> [<thread>] (<file>:<line>):
<message>`; the seconds are on the monotonic clock `process.hrtime()` reads,
so JS-side timestamps line up with them. While it's on, libwebrtc's own
stderr output is off and error-level lines are printed to stderr by the
hook instead, so a few more of them show up than usual. Grep libwebrtc's
source (upstream M150, `branch-heads/7871` at `05e02da9d17f`, plus
`patches/`; checked out in `~/src/webrtc-m150/src`) for the message to find
what logged it.

**The removeTrack race stress repro.** `scripts/stress-removetrack-race.mjs`
reproduces the libwebrtc race that `src/sink_reassert.cc` works around
(PLAN.md "Gotchas"): runs of two PCs sending each other video, a
`removeTrack` and renegotiation, then a sink that must get a frame. It
loads the CPU itself (`--load N` busy loops, default one per CPU) and counts
races from the libwebrtc log. It isn't part of `pnpm test` (minutes, and
it saturates the machine); run it after touching `sink_reassert.cc`, the
SLD/SRD completion path, or the libwebrtc pin. Not on gpubox, which is
shared.

```sh
node scripts/stress-removetrack-race.mjs --runs 600 [--load 12] [--log /tmp/race.log]
```

It prints each run that hit the race or lost frames, then a summary: runs
without frames (must be 0), races hit, and how fast each was restored.
Without the workaround about 1 run in 180 loses its frames for good.

**The V8 wasm crash in workers.** Node 24, 25 and 26 crash the process when
workers that use wasm (Node's TypeScript type stripping included) come and
go (PLAN.md, "V8 wasm crash in workers"). Two scripts, neither part of
`pnpm test`:

```sh
node scripts/repro-wasm-wrapper-race.mjs [lanes=4] [seconds=60]   # no addon, no dependencies
node scripts/stress-worker-wasm.mjs --entry lib --exit terminate --count 2000
```

The first is plain JavaScript (wasm modules built in memory), for checking
a Node version or a V8 flag; Node 25/26 on arm64 crash within seconds.
Node 24 crashed in most 60 s runs on Linux (arm64 in Docker, x64 on
gpubox) but only about one run in nine on macOS, so judge a flag or
version there by many runs, not one. Its header has the counts. The second runs workers that load this
library (`lib/` through type stripping, or `dist/`) and connect a peer
connection pair; its options are in its header comment. Run either a
few times in a loop with a timeout; a crash is an exit by signal (SIGSEGV,
SIGBUS, SIGILL) or a `Check failed` from V8 on stderr.

## Rules

- **Stay inside your file-ownership list** (your WP section in
  `SPEC-LAYER-PLAN.md`). If you need a change in a file you don't own,
  especially `lib/internal/native-types.ts`, `src/event_sink.*`,
  `src/addon.*`, `binding.gyp`, `lib/index.ts` or `package.json`, stop and
  propose it to the coordinator in your report instead of making it.
- **The native contract** is `lib/internal/native-types.ts`. Implement it
  exactly. Members marked `@stub <your WP>` are yours to make real; remove
  the `@stub` tag when you do. Update `test/native/skeleton.test.ts`
  assertions that expected your stubs to throw.
- **Track handles are shared contract.** `Track::ToJs`, `Track::FromJs`
  and the registry semantics in `src/media_track.*` are used by both WP-M
  and WP-R, so don't change them without the coordinator. To get a real
  track in tests before WP-M lands, use a receiver's track: every
  transceiver's receiver has one before negotiation (for example
  `pc.addTransceiver('audio').receiver.track`).
- **Ownership across threads:** objects holding `Napi` references (such as
  the `RtpRegistry`) must be created and destroyed on the JS thread while
  the env is alive. `EventSink` is shared with libwebrtc observers and can
  die on the signaling thread, so it only borrows such objects.
- **Spec semantics live in JS.** Native code is mechanical: no WebIDL
  conversion, no state machines.
- **Threading:**
  - Every native-to-JS callback uses `NonBlockingCall` on an unbounded
    TSFN. Never `BlockingCall`.
  - Never hold a lock across a libwebrtc proxy call; those block on the
    signaling, worker or network thread.
  - Sink callbacks run under libwebrtc's sink lock, and on the JS thread
    for local tracks.
- **Lifetime:** any object with a TSFN needs an env cleanup hook (see
  `PeerConnection::OnEnvCleanup`), must tolerate `FinalizeSink`-style
  finalization before its destructor, and must never throw while an
  exception is pending.
- **wrtc compatibility:** where the plan's compatibility spec says
  "matches wrtc", verify it against `@roamhq/wrtc` itself. It's a
  devDependency. Load it **in a separate process**, never in the same
  process as our addon.
- **Tests** use `node:test`, in four layers:
  - **Unit:** `lib/**/Foo.test.ts`, next to the module it tests. One
    module's logic in isolation: conversion, validation and error messages,
    state caching, the ops chain, event ordering. Avoid libwebrtc where you
    can; use a small fake of the native API to inject errors or event
    orderings. Every public class and every non-trivial internal module
    gets one.
  - **Native integration:** `test/native/`. The C++ addon against real
    libwebrtc, through the raw native API.
  - **Library integration:** `test/integration/`. The public API end to end
    (e.g. nonstandard sources to sinks across two `RTCPeerConnection`s,
    worker termination, process exit).
  - **Compat:** `test/compat/`. Differential runs against `@roamhq/wrtc`, in
    a separate process.
  - WPT (`test/wpt/`, M2) is spec conformance on top of all of these.
  - Every test that creates a peer connection, sink or worker must close or
    stop it. `pnpm run test:exit` runs every test file under plain `node`
    and fails on leaked handles.
  - A worker in a test must not run TypeScript: Node's type stripper is
    wasm, and the V8 wasm crash in workers above would make the test
    flaky. Load the compiled package with `builtPackage(t)`
    (`test/integration/built-package.ts`) and write the worker's own code
    in JavaScript, or use the raw addon as `worker-only-exit.ts` does.
- **Be pragmatic about what you test.** Test behaviour that matters:
  - the contract
  - wrtc-compatibility details
  - error paths callers can hit
  - threading and lifetime edge cases
  - anything that has broken before

  Don't write tests just to raise coverage: trivial getters, re-asserting
  what the type system already guarantees, or mirroring the implementation
  line by line. If a test wouldn't catch a plausible bug, don't write it.
- **Test hygiene is required, not optional.** Every change ships with its
  tests, and every test must be:
  - **Deterministic.** Wait for the event or promise you need. No bare
    `setTimeout` sleeps standing in for synchronisation; a timeout is only
    a failure guard. No dependence on scheduling luck. If a test is flaky,
    fix it or delete it; don't retry it.
  - **Isolated.** No shared mutable state between tests, and no reliance on
    test order. Each test creates what it needs and tears it down in
    `finally` / `t.after`, even when an assertion fails.
  - **Specific.** Assert exact values, error types and messages that
    matter, not just "doesn't throw". One behaviour per test, named after
    that behaviour.
  - **Fast and local.** Unit tests in milliseconds. No network beyond
    loopback. Integration tests keep media short (a few frames or packets).
  - **Readable when it fails.** The failure message should say what broke
    without reading the test body.
- **Style:** Biome for TS (single quotes, 100 columns), Chromium
  clang-format for C++. Match the surrounding code's comment density.
  Comments explain why.
- **Reference code:** libwebrtc's own sources and tests (BSD-3) are the
  reference. Don't port code from other projects' glue; write our own.
  Check libwebrtc API claims against
  `third_party/libwebrtc-upstream/<triple>/include`, not memory.

## Report back

When you're done, report:
- what you implemented, file by file
- the test results: macOS commands, plus Docker for native work
- any contract changes you're proposing, and why
- anything you skipped or are unsure about
