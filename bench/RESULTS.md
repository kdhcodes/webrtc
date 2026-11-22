# Benchmark results: ours vs @roamhq/wrtc

Recorded 2026-11-19 with `pnpm run bench`. Full tables:
[`results/linux-x64-2026-11-19.md`](results/linux-x64-2026-11-19.md) and
[`results/darwin-arm64-2026-11-19.md`](results/darwin-arm64-2026-11-19.md).
The raw JSON and archived profiles are beside them;
`node bench/run.mjs --report <file.json>[,<rerun.json>]` re-renders the JSON.

Every table has two ratio columns:
- **ours/wrtc of the medians**
- **paired ours/wrtc**: run i of ours against run i of wrtc, which ran
  back to back with the order alternating. Its median and [min–max] are
  the figure to trust on a noisy machine.

The sections from "Verdict" on are the original pass (2026-11-19/20). A
performance pass followed; its results come first.

## After the performance pass (2026-11-20)

What changed, on the branch after `3f343f7`:
- **Sinks** (`src/media_sink.cc`): one copy per frame instead of two
  (remote tracks) or three (local tracks), into an ArrayBuffer that isn't
  zero-filled first. While more than 3 frames per sink are queued
  (`kMaxHeldFrames`, added after review), the extra frames are copied as
  before; see "Frames held while JS lags".
- **Description snapshots** (`CaptureSnapshot`, `src/peer_connection.cc`):
  a description is serialized only when it changed since the last snapshot.
- **Import:** Node builtins come through `process.getBuiltinModule`, and
  `node:crypto` loads on first use.

Measurements:
- **macOS:** `pnpm run bench --configs recv-x6,vga,local --runs 5`, run
  once on the branch and once on `3f343f7` (a copy of it), back to back
  while the Mac was awake. Neither run spans a sleep. Load at the start was
  15.5 for the branch (my own builds had just finished; it was 3–7 for most
  of the run) and 2.0 for `3f343f7`.
  - Each run is paired against wrtc. So below, "before" and "after" are
    two independent sets of paired ratios.
  - Full tables:
    [`results/darwin-arm64-2026-11-20-perfpass-before.md`](results/darwin-arm64-2026-11-20-perfpass-before.md)
    and [`-after.md`](results/darwin-arm64-2026-11-20-perfpass-after.md),
    with the JSON beside them.
  - The "after" run was built from the working tree before the commits.
    Its source is identical to `afeab1a` + `a1e03ad` apart from
    clang-format, so it predates the `kMaxHeldFrames` bound. In these runs
    the JS thread keeps up, so the bound should rarely trigger. It wasn't
    re-benchmarked.
- **Linux:** gpubox, at load below 1. It has no `perf`, `gdb` or
  `valgrind`, so there's no native profile; JS-thread profiles come from
  `--cpu-prof`.
- An overnight macOS run is discarded: the Mac slept through it.
- Raw data besides the bench tables:
  - [`results/darwin-arm64-2026-11-20-perfpass-extra.txt`](results/darwin-arm64-2026-11-20-perfpass-extra.txt):
    probe rounds, signaling-thread sample counts, import runs, the
    allocation microbenchmark and retention
  - [`results/linux-x64-2026-11-20-perfpass.txt`](results/linux-x64-2026-11-20-perfpass.txt):
    probe and codec-probe rounds, import summaries and retention
  - The JS-thread `--cpu-prof` profiles weren't kept.

### Sinks

Paired ours/wrtc, median [min–max] over 5 rounds:

| configuration | metric | before | after |
|---|---|---|---|
| local (4 x 720p30 + audio, no PC) | process CPU | 1.46 [1.40–2.14] | 1.09 [0.95–1.13] |
| | main-thread CPU | 1.25 [1.22–1.89] | 0.93 [0.83–0.97] |
| | time in `onFrame`/`onData` pushes | 2.37 [2.25–3.57] (44.5 vs 18.7 ms/s) | 1.29 [1.13–1.33] (25.8 vs 22.3 ms/s) |
| | external memory | 1.18 [1.01–1.41] | 1.02 [0.87–1.42] |
| | GC time; major GCs/s (ours) | 3.13 [2.53–3.60]; 1.40 | 2.40 [1.39–2.50]; 1.35 |
| recv-x6 (6 remote VGA sinks) | process CPU | 1.00 [0.72–1.33] | 0.97 [0.92–1.28] |
| | main-thread CPU | 0.97 [0.66–1.29] | 0.87 [0.81–1.17] |
| | main thread outside pushes and handlers | 0.89 [0.65–1.16] (33.0 vs 36.4 ms/s) | 0.81 [0.74–1.06] (28.4 vs 35.0 ms/s) |
| | external memory | 1.62 [1.54–1.82] | 1.67 [1.51–1.94] |
| | GC time; major GCs/s (ours) | 1.59 [0.84–2.00]; 1.15 | 1.85 [1.41–3.10]; 1.15 |
| vga | process CPU | 0.93 [0.85–1.08] | 0.88 [0.78–0.96] |
| | main-thread CPU | 0.91 [0.88–1.05] | 0.88 [0.86–0.98] |

- **Local-track sinks: fixed.** `pushFrame` no longer copies each frame a
  second time for every local sink.
  - Absolute, ours: push time 44.5 → 25.8 ms/s (−42%), process CPU
    13.4 → 10.6% (−21%), main-thread CPU 108 → 86 ms/s (−21%).
  - wrtc moved between the two sessions too: process CPU 9.2 → 10.8%
    (+17%), push time 18.7 → 22.3 ms/s. So part of the paired change
    (process CPU 1.46x → 1.09x, push time 2.37x → 1.29x) is wrtc's noise.
    Ours' absolute drop is the figure to quote.
- **Remote-track sinks: one copy fewer, but it doesn't show.** The removed
  copy ran on the decoder thread, so process CPU (0.97) and the main
  thread (0.81–0.87) are within the round-to-round spread of before.
- **Skipping the zero-fill:** a microbenchmark that allocates a frame-sized
  buffer and fills it (`new ArrayBuffer` vs `Buffer.allocUnsafeSlow`):
  - VGA (460 KB): 11.8 → 8.3 µs on macOS, 51.5 → 46.5 µs on gpubox.
  - 720p (1.4 MB): 48 → 29 µs on macOS, 165 → 145 µs on gpubox.
  - At 180 VGA frames/s that's about 0.6 ms/s (macOS) or 0.9 ms/s
    (Linux) of JS-thread time: real, but below what the bench resolves.
- **GC and external memory: unchanged, and not caused by the copies.**
  - `--trace-incremental-marking` shows every major GC starting with
    reason "external memory pressure". Each frame's ArrayBuffer counts as
    external memory, and V8 starts a full GC when that grows by about
    64 MB without a scavenge freeing the young buffers.
  - wrtc allocates the same buffers (`Napi::ArrayBuffer::New`, zero-filled,
    one per frame per sink). In the bench its JS allocates more garbage per
    frame, so scavenges come often enough to free those buffers first.
  - A minimal script with 4 local 720p sinks and no other JS
    (`bench/gc-sinks.mjs ours|wrtc`) gets 2.2–2.4 major GCs/s on *both*
    libraries.
  - So the GC gap depends on how much other JS garbage the app makes, not
    on the binding. Each of these major GCs took about 1–2 ms on the
    bench's 6 MB heap. They cost more with a large old generation.
  - The only binding-side fix is to reuse buffers. That changes what a
    held frame contains, so it can only be opt-in (not done; see "Not
    done").
- **Frames held while JS lags (review finding, fixed).** The first version
  held libwebrtc's buffer for every queued frame. Decoder pools don't bound
  that and never shrink:
  - H264's pool is uncapped (`VideoFrameBufferPool(true)`).
  - VP9's only warns past 68 buffers.
  - VP8's drops frames past 300.

  The review measured, at 720p and after a 30 s drain: VP8 on macOS
  retained +249 MB against +14 MB on main after a 5 s JS stall, and H264 on
  Linux grew without limit after a 15 s stall. Now each sink holds at most `kMaxHeldFrames` (3) by reference,
  and `OnFrame` copies the rest as before. The review's `retention.mjs`
  (RSS after the stall and a 7 s drain, guarded), `3f343f7` vs the branch:

  | | stall | main (3f343f7) | branch |
  |---|---|---|---|
  | macOS, VP8 | 5 s | +126, +128, +129 MB | +133, +136, +138 MB |
  | gpubox, H264 | 5 s | +108, +110 MB | +144, +149 MB |
  | gpubox, H264 | 15 s | +439, +502 MB | +514, +545 MB |
  | gpubox, VP8 | 5 s | +129, +129 MB | +138, +197 MB |

  - Both now scale the same way with the stall: what's left is freed
    backlog the allocator hasn't returned to the OS, not pool growth.
  - These were measured after a 7 s drain, before the freed backlog has
    gone back to the OS. That's why main shows +126–129 MB here, against
    the review's +14 MB after a 30 s drain.
  - The branch kept 5–35 MB more per run here (one VP8 run 68 MB). The
    re-review measured after a 30 s drain on macOS, main 8a8f9f3 vs the
    branch:
    - 5 s stall: +9 and +5 MB vs +28 and +17 MB
    - 15 s stall: +149 vs +144 MB
    - no stall: −15 vs −34 MB

    The difference doesn't grow with the stall and is within the no-stall
    control's ~20 MB swing, so it's noise. The bound holds at most 3 frames
    per sink, about 4 MB at 720p.
  - Raw data: `results/*-2026-11-20-perfpass*.txt`.
- **External ArrayBuffers:** Node 24 allows `napi_create_external_arraybuffer`
  (`process.config.variables.v8_enable_sandbox` is 0), but V8-sandbox
  builds such as Electron refuse it. It's not used:
  - It would still need a copy per frame. The decoder's buffers are pooled
    and shared by every sink, and handing one out would let one sink's
    writes show up in other sinks and the encoder.
  - V8 accounts an external backing store as ArrayBuffer memory too.
    Whether that changes the GC trigger above wasn't tested.

### Description snapshots

- **Mechanism, macOS:** `sample` of the signaling thread during
  `renegotiation-probe.mjs ours 300` (8 s each, same workload):

  | | before | after |
  |---|---|---|
  | signaling thread busy (not waiting), samples | 300 | 242 (−19%) |
  | `CaptureSnapshot` | 89 | 30 |
  | `SdpSerialize` (snapshots plus `createOffer`'s own) | 124 | 59 |

- **Renegotiation wall time: no measurable change.** Paired after/before,
  summed step medians of `renegotiation-probe.mjs`:
  - macOS (7 rounds, load 3): wall 1.10 [0.72–1.46], CPU 0.95 [0.74–1.43]
  - gpubox (7 rounds, load 0.7–0.9): wall 0.98 [0.81–1.43], CPU 1.02
    [0.79–1.36]
  - Back-to-back renegotiations on gpubox (below): 41.0 vs 46.6 ms, paired
    0.95 [0.68–1.43]
  - The snapshot work is a few percent of a renegotiation, under the noise.
- **Semantics unchanged:**
  - Each description is still serialized at capture time.
  - A cached string is reused only for the same, unchanged object. The
    check covers its candidates, the one thing libwebrtc edits in an
    installed description.

### Renegotiation on Linux

- **Steady state:** `bench/codec-probe.mjs` runs 8 video tracks and
  20–30 back-to-back renegotiations with nothing changed. These numbers
  are medians over 7 alternating rounds on gpubox, from a scratch version
  of it. That version printed the same fields plus the JS thread's CPU, and
  its raw output is in
  [`results/linux-x64-2026-11-20-perfpass.txt`](results/linux-x64-2026-11-20-perfpass.txt).
  The committed tool's rerun is there too.

  | | video payload types | ms per offer/answer round | ours/wrtc, paired |
  |---|---|---|---|
  | wrtc | 11 | 15.9 (10–16 when the CPU is clocked up) | |
  | ours before | 23 | 46.6 | |
  | ours after | 23 | 41.0 | 3.27 [1.58–4.12] |
  | ours after, VP8/VP9/AV1 only (`setCodecPreferences`) | 11 | 26.0 | 1.59 [0.66–2.88] |

  A rerun with the committed tool (5 rounds; wrtc stayed clocked up this
  time): wrtc 10.4 ms, ours 41.9 ms (23 payload types) and 25.5 ms (11).

- **What Linux offers for H264:** baseline (`42001f`), constrained baseline
  (`42e01f`) and main (`4d001f`), each with packetization-mode 0 and 1,
  each with its own rtx. That's 12 payload types.
- **H264 is about 40% of our renegotiation time on Linux.** Leaving it out
  of the codec preferences gives 0.59 [0.39–0.70] of the time, paired.
  - Per step, it saves 1–1.5 ms on `createOffer` / `createAnswer` and
    2.5–3.5 ms on each SLD/SRD.
  - The JS thread's CPU drops from 12 to 5.3 ms per round. Most of that
    is libwebrtc parsing the bigger SDP inside our native SLD/SRD calls,
    plus our own SDP parsing in JS, about 2 ms per round. wrtc's JS thread
    uses 4–6 ms.
- **The rest of the gap is libwebrtc M150 itself.**
  - At 11 payload types, ours is still slower than wrtc.
    - The support is macOS (no H264 there): the probe's summed steps are
      18.1 vs 9.4 ms, paired 1.63 [1.05–2.34].
    - On gpubox the paired ratio is 1.59 but ranges 0.66–2.88, because
      wrtc swings 10–40 ms with the CPU clock. Read it as "slower, by an
      uncertain amount". In the rerun, where wrtc stayed at 10.4 ms, it
      was 2.4x.
    - Back to back on macOS (`codec-probe.mjs`, one run each): 7.6 vs
      5.9 ms.
  - On macOS, the signaling thread's self time is mostly codec matching:
    `absl::EqualsIgnoreCase`, `webrtc::Codec` copies and destructors,
    `MatchesWithCodecRules`, `FindCodecById`, `PayloadTypePicker`. Its
    cost grows with the number of payload types, so H264's 12 extra ones
    cost more than their share.
- **With idle gaps:** `bench/renegotiation-probe.mjs`, which sleeps 100 ms
  between steps, gives 105–108 vs 38 ms (2.8–2.9x) on gpubox. The
  `powersave` governor clocks the CPU down in the gaps, so the gap
  measurements swing 2–3x between runs. That's why the control bench saw
  68 vs 27 ms.
- **Decided (2026-11-22): no H264 on any platform** (user), so offers carry VP8, VP9 and AV1 only, as the
  "after" row above. The options below are kept for when H264 returns.
- **Trimming options (superseded by the decision above):**
  - Offer only packetization-mode=1. That's 6 of the 12 payload types; I
    estimate it saves about half of the 40%, but didn't measure it.
    Chrome and mediasoup use mode 1, but a peer that only does mode 0
    would lose H264.
  - Offer only constrained baseline, mode 1 (`42e01f`, 2 payload types).
    That's what most SFUs negotiate, and most of the 40% (estimate).
  - Drop H264 on Linux, as on macOS. That's the full 40%, but an
    H264-only remote (some SFU and hardware setups) could then not send
    us video.
  - Leave it as is: renegotiation costs 41 ms of CPU instead of 26 on
    gpubox, once per renegotiation per PC.

### Import time

gpubox, `await import('dist/index.js')` in a fresh process, 9 alternating
rounds:

| | ms |
|---|---|
| before | 42.0 [41.1–43.2] |
| after | 26.9 [26.3–30.9] (paired 0.64 [0.63–0.74]) |
| wrtc (`require`) | 8.6 [8.4–9.3] |

On macOS (9 rounds, load 4–7): 20.3 → 15.6 ms, paired 0.75 [0.64–0.82];
wrtc 8.0 ms.

- Loading the addon itself (`require('wrtc.node')`) takes 1.0 ms. There
  are no expensive static initializers, and the peer connection factory
  is already created lazily. The generated WebIDL module evaluates in
  2.8 ms.
- The time was in module loading:
  - `node:crypto`, loaded for `MediaStream` ids: 7 ms
  - the ESM facades of `node:util`, `node:fs`, `node:module`, `node:url`,
    `node:path` and `node:util/types`: about 6 ms
- What's left (27 ms) is resolving, reading and compiling 42 ES modules.
  Bundling `dist/` into one file would cut most of it. That's a packaging
  change, so it's not done here.

### Not done

- **Reusing frame buffers:** the only way to remove the GC pressure. It
  would have to be an opt-in sink option (e.g. a pool that hands out a
  frame's buffer again once the app is done with it). That needs an API
  decision, so it's not built.
- **Trimming H264 payload types:** see above.
- **Lazy (on-demand) description serialization:** JS answers description
  getters from its cache, which must reflect the state at the event, so
  the SDP has to be captured when the event happens.
- **Memoizing JS-side SDP work per snapshot** (`#withEndOfCandidates`,
  `sctpSection`): about 1.5 ms per renegotiation round on gpubox, 4%.
- **Bundling `dist/`** for import time.

## Verdict

**For audio plus 640x480 VP8 without simulcast, from 1 to 8 loopback pairs,
there's no noticeable cost difference.**
- Paired CPU ratio: 0.87–1.04.
- Ours delivers frames 30–42 ms sooner.
- RSS is 5–24% higher on ours (macOS `vga-x4`: paired 1.21 [1.20–1.24]).

The other workloads are not free:

- **720p costs more CPU on ours:** 5–14% on Linux (paired 1.14 in the
  first passes, 1.05 [0.93–1.14] in the low-load rerun) and about 23% on
  macOS (1.23).
  - It is VP8 work inside libwebrtc, not the binding. On macOS encode and
    decode time per frame are both 1.36x, at better quality (QP 22 vs 27)
    and +4% bitrate. On Linux decode is 1.16x at equal QP.
  - The newer libvpx in M150 trades CPU for quality, and the coordinator's
    review reproduced the extra cost at an equal bitrate.
- **Simulcast (3 layers of 720p): inconclusive, about 0–10% either way.**
  - Low-load rerun: process CPU paired 0.92 [0.73–1.11], and per encoded
    frame 0.85 [0.68–1.06]. Ours encodes about 6% more frames.
  - The earlier "+18%" came from rounds at load 17–43, in which wrtc also
    encoded 12–20% fewer frames. It doesn't hold.
  - Both libraries do simulcast, and delivery is the same.
- **Receive-heavy (6 remote VGA sinks):**
  - CPU is the same: paired 1.01.
  - JS-thread time on sink delivery shows no measurable difference: the
    main thread's CPU outside this script's own work is 31.0 vs 30.9 ms/s
    (paired 1.00 [0.83–1.37]). The earlier "+10%" came from wall-clock
    event-loop utilization under load and doesn't hold.
  - **Solid:** GC time is 2.3x (1.5 vs 0.7 ms/s), with 1.2 major GCs/s
    against none. External memory is 36 vs 21 MB, and RSS is +19%.
  - Small in absolute terms, but it grows with frame size and sink count
    (problem 2).
- **On Linux too** (gpubox rerun; see Status): CPU paired 0.94 for
  simulcast and 1.03 for receive-heavy, and latency is lower in every
  config.
  - With 6 receiving sinks, wrtc delivered 77% of frames more than 100 ms
    late; ours delivered 0.1%.
  - This benchmark has no real SFU. `docs/sfu-test.md` covers mediasoup.
- **Control plane:**
  - `getStats()` is 2.5–5x faster on ours, and `close()` is faster.
  - Renegotiation was 2.5x slower on Linux (68 vs 27 ms on gpubox; measured
    on the pre-merge build, so it predates the H264 probe). On macOS it is
    now on par, since `main`'s H264 probe cut the offer from 23 to 11 video
    payload types.
- **A macOS regression found here is fixed on `main`** (`7eded0d`): a
  transceiver going `sendonly` and back to `sendrecv` could no longer
  renegotiate (see "Found here and fixed").
- **Exit:** ours exits in milliseconds. The one "hang" reported earlier was
  the Mac going to sleep: it didn't reproduce in 248 runs. wrtc crashed on
  exit in every completed control run.

## Status of this write-up

- **macOS:**
  - `vga`, `recv-x6` and `simulcast` are from a 5-round low-load rerun on
    `main` at `7eded0d` merged (2026-11-20 00:23 UTC). It has main-thread
    CPU and CPU per encoded frame, and the load at start was 2.97;
    `simulcast` saw load 3–18 from other agents.
  - `hd`, `vga-x8` and `control` are from a 7-round run on `f9cdacc`
    merged.
  - `audio`, `vga-x4` and `local` are from the first 5-round run (`dad1224`,
    pre-merge, same VP8 media path).
- **Linux (gpubox):**
  - All configurations are from the first 5-round runs on the pre-merge
    build. Their media paths are unchanged by the merge: on Linux the H264
    decoder works, so the offer is unchanged.
  - **7-round rerun on the merged build, collected (2026-11-19 22:29
    UTC, load under 1):** `vga`, `hd`, `vga-x8`, `recv-x6`, `simulcast`,
    `control`. It's in `results/linux-x64-2026-11-19-rerun.json`; render
    it over the two first passes with
    `--report results/linux-x64-2026-11-19-pass1.json,…-pass2.json,…-rerun.json`.
    The build predates the performance pass and `7eded0d` (the H264 gate
    changes nothing on Linux). Paired ours/wrtc, median [min–max]:

    | Config | CPU | Latency p50 | Notes |
    |---|---|---|---|
    | `vga` | 0.96 [0.87–1.05] | 46 vs 78 ms | RSS 1.06 |
    | `hd` | 1.05 [0.93–1.14] | 55 vs 90 ms | Encode 1.09. The first passes gave 1.14, so 720p on Linux costs 5–14% more. |
    | `vga-x8` | 1.00 [0.93–1.24] | 57 vs 89 ms | >100 ms late: 0.26% vs 24%. Major GC 1.55/s vs 0.05. |
    | `recv-x6` | 1.03 [0.98–1.12] | 56 vs 113 ms | >100 ms late: 0.11% vs 77%. GC time 1.60, major GC 1.15/s vs 0, external memory 37 vs 22 MB, RSS 1.17. |
    | `simulcast` | 0.94 [0.91–1.01] | 64 vs 81 ms | Equal frames encoded (85/s). >100 ms late: 8% vs 35%. |
    | `control` | renegotiation 2.50 [2.32–2.63] (66 vs 27 ms) | | 9.6 vs 6.8 KB offer; H264 still offered on Linux |

    So on Linux simulcast and receive-heavy CPU are equal to wrtc, and
    latency is much better under load. The GC difference in receive-heavy
    use is real; the performance pass showed it's V8's external-memory
    heuristic, not copies.

## Machines and versions

| | Linux (target) | macOS |
|---|---|---|
| machine | gpubox: Intel i7-6700T, 4 cores / 8 threads, 16 GB, Pop!_OS 24.04 (kernel 7.1.5), `powersave` governor | Apple M3 Pro, 12 cores, 36 GB, Darwin 27.0.0, **on battery** |
| Node | v24.22.3 | v24.22.2 |
| ours | `main` at `4a2f167` (runs say `dad1224`, a squashed work-in-progress commit), from `dist/`; the prebuilt libwebrtc `webrtc-a545de4` (M150) | rerun: `main` at `f9cdacc` merged (runs say `67b64cd`, squashed since; `scenario.mjs` is unchanged after it, only reporting and docs); `wrtc.node` sha256 `822d94ab6ad9`, native inputs `64a94f072a41`; first run as Linux |
| @roamhq/wrtc | 0.10.0 (the installed devDependency) | same |
| load (1 min) | below 1 at start; during runs mostly the benchmark itself (to ~10 at 8 pairs) | low-load rerun: 1.5–6 for `vga` / `recv-x6`, 3–18 for `simulcast`; 7-round run: 2–5 for `hd` / `vga-x8`, 6–18 for `control` (other agents) |

`perf` isn't installed on gpubox (and there's no sudo), so there are no
cycle counts. CPU time is the only CPU measure, and the paired ratios are
the noise control.

## Headline numbers

Median, then the paired ours/wrtc ratio as median [min–max] over rounds.

### Linux x64 (gpubox, 5 rounds)

| configuration | metric | ours | wrtc | paired ratio |
|---|---|---|---|---|
| audio only | CPU, % of a core | 16.0 | 18.1 | 0.88 [0.87–0.92] |
| audio + 640x480@30 | CPU, % | 78.8 | 82.9 | 0.94 [0.90–1.00] |
| | RSS, MB | 107 | 101 | 1.05 [1.03–1.07] |
| | latency p50, ms | 45.9 | 77.8 | 0.59 [0.58–0.63] |
| audio + 1280x720@30 | CPU, % | 168.6 | 146.7 | 1.14 [0.91–1.21] |
| | decode ms/frame | 9.05 | 7.64 | 1.16 [0.92–1.53] |
| | latency p50, ms | 56.8 | 91.1 | 0.62 [0.60–0.65] |
| 4 pairs at VGA | CPU, % | 343.6 | 350.8 | 1.00 [0.89–1.94] |
| 8 pairs at VGA | CPU, % | 473.0 | 443.8 | 1.04 [0.98–1.11] |
| | RSS, MB | 321 | 285 | 1.12 [1.11–1.14] |
| | external + ArrayBuffers, MB | 39.2 | 21.5 | 1.84 [1.57–2.01] |
| | latency p50, ms; frames > 100 ms | 56.4; 0.06% | 98.5; 46% | 0.57 [0.50–0.69] |
| local sinks, 4 x 720p30 | CPU, % | 31.4 | 24.7 | 1.26 [1.19–1.32] |
| control (pre-merge) | renegotiation, ms | 67.6 | 26.6 | 2.57 [2.49–2.59] |
| | getStats() p50, ms | 1.79 | 4.81 | 0.37 [0.37–0.39] |
| | exit after close | 43 ms | crashed 5/5 (SIGSEGV) | |

### macOS arm64 (merged build; rounds as noted in Status)

| configuration | metric | ours | wrtc | paired ratio |
|---|---|---|---|---|
| audio only (5 rounds, first run) | CPU, % | 9.2 | 8.9 | 1.03 |
| audio + 640x480@30 | CPU, % | 34.1 | 39.1 | 0.87 [0.82–1.14] |
| | main-thread CPU, ms/s | 30.5 | 33.2 | 0.93 [0.81–1.09] |
| | RSS, MB | 73 | 64 | 1.14 [1.10–1.18] |
| | latency p50, ms | 32.3 | 73.5 | 0.44 [0.38–0.52] |
| 4 pairs at VGA (5 rounds, first run) | RSS, MB | 179 | 145 | 1.21 [1.20–1.24] |
| audio + 1280x720@30 | CPU, % | 95.4 | 64.7 | 1.23 [0.95–1.77] |
| | encode / decode ms/frame | 8.8 / 5.8 | 5.4 / 4.0 | 1.36 / 1.36 |
| | QP; video kbps | 22.4; 2444 | 27.4; 2345 | 0.82; 1.05 |
| 8 pairs at VGA | CPU, % | 176.4 | 194.9 | 0.98 [0.84–1.15] |
| | RSS, MB | 300 | 271 | 1.10 [1.06–1.30] |
| | GC ms/s; major GCs/s | 1.61; 1.55 | 0.74; 0.00 | 2.06 [1.56–2.74] |
| | latency p50, ms | 27.4 | 61.3 | 0.46 [0.44–0.59] |
| receive-heavy: 6 VGA sinks | CPU, % | 146.2 | 148.2 | 1.01 [0.84–1.50] |
| | main-thread CPU outside own work, ms/s | 31.0 | 30.9 | 1.00 [0.83–1.37] |
| | GC ms/s; major GCs/s | 1.49; 1.20 | 0.71; 0.00 | 2.32 [1.79–3.97] |
| | external MB; RSS MB | 36.4; 261 | 21.0; 220 | 1.73; 1.19 |
| | latency p50, ms; frames > 100 ms | 28.8; 0% | 90.9; 19% | 0.32 [0.28–0.35] |
| simulcast 3 x 720p | CPU, % | 43.5 | 43.7 | 0.92 [0.73–1.11] |
| | frames encoded/s (all layers) | 84.8 | 77.9 | 1.06 [1.03–1.09] |
| | CPU per encoded frame, ms | 5.13 | 5.61 | 0.85 [0.68–1.06] |
| | frames > 100 ms late | 4.0% | 37.5% | 0.11 |
| local sinks, 4 x 720p30 (5 rounds, first run) | time in `onFrame`, ms/s | 37.0 | 13.9 | 2.66 |
| control | renegotiation, ms | 6.9 | 10.4 | 1.26 [0.35–2.66] (load 6–18) |
| | video payload types offered | 11 | 11 | |
| | getStats() p50, ms | 0.47 | 2.28 | 0.39 |
| | exit after close | 6 ms | crashed 7/7 (SIGSEGV) | |

Equal everywhere:
- Delivered rates: 100 audio callbacks/s, 29.5–29.7 video fps per sink.
  Simulcast is lower on both (25–27.5 per layer): neither reports a
  quality limitation (`qualityLimitationReason` is `none` in every run),
  but the encoders produce 85 (ours) and 78 (wrtc) of the 90 layer-frames
  per second.
- Drops: about 1% on both, from encoder frame dropping.
- Resolution: full (or the layer's expected size) on every frame.

## Where the latency gap comes from

Measured with stats over the window (macOS; VGA and recv-x6 from the low-load rerun):
- `totalPacketSendDelay` per packet: the pacer
- `jitterBufferDelay` per emitted frame
- `totalProcessingDelay` per decoded frame: arrival to decoded

| | VGA | 720p | 8 pairs | recv-x6 |
|---|---|---|---|---|
| latency p50, ours / wrtc, ms | 32 / 74 | 42 / 81 | 27 / 61 | 29 / 91 |
| pacer delay per video packet, ours / wrtc, ms | 0.24 / 17.3 | 1.1 / 19.8 | 0.26 / 14.7 | 0.27 / 20.8 |
| jitter-buffer delay per frame, ours / wrtc, ms | 22 / 57 | 24 / 66 | 20 / 48 | 20 / 69 |
| arrival to decoded per frame, ours / wrtc, ms | 25 / 66 | 30 / 72 | 21 / 55 | 22 / 80 |

**About half the gap is wrtc's older sender pacing.** It holds each video
packet 15–20 ms, against under 1.2 ms on ours (the coordinator's run found
12.3 vs 0.44 ms). The rest is on the receive side: wrtc's frames spend 2–3x
as long in the jitter buffer. Part of that is waiting for a frame's paced
packets; the rest is a larger jitter-buffer target. The two overlap, so
they don't add up exactly.

**Loopback may overstate this.** With no loss and an unconstrained link,
our pacer has nothing to wait for. On a real network both pacers pace to
the bandwidth estimate, so expect a smaller gap there.

## Receive-heavy and simulcast

- **`recv-x6`:** one pair whose sender has 6 VGA tracks, so 6 remote sinks
  get 180 frames/s of 460 KB.
  - **JS-thread cost of sink delivery: inconclusive, with no measurable
    difference.**
    - The metric is the main thread's CPU time (`process.threadCpuUsage()`)
      minus this script's pushes, content generation and handlers. That's
      mostly sink event delivery, plus the bindings' other callbacks,
      timers and GC.
    - `recv-x6`: 31.0 vs 30.9 ms/s, paired 1.00 [0.83–1.37].
    - Baseline `vga` (1 sink): 17.4 vs 19.5 ms/s. So 5 more sinks add
      about 13.6 ms/s on ours and 11.4 on wrtc, about 0.09 vs 0.08 ms per
      frame. The difference is within the run-to-run spread.
    - The earlier wall-clock event-loop utilization (136 vs 119 ms/s) was
      inflated by preemption at load 4–25.
  - **Solid:** our `DeliverToJs` copies every frame into a new zero-filled
    ArrayBuffer. That shows up as GC (2.3x the time, 1.2 major GCs/s
    against none) and external memory (+15 MB), not as measurable JS time.
  - The encoders don't match exactly: ours sends 8.6 Mbps at QP 12, wrtc
    7.8 Mbps at QP 15, which is part of why CPU is compared per frame
    where it matters.
- **`simulcast`:** 3 layers (q 1/4, h 1/2, f) of 720p, received as one
  m-line per rid. The munging comes from `test/interop/codecs.interop.ts`.
  - Two of ours and two wrtc's both negotiate it: all three SSRCs are
    sent, and each layer arrives at its own size.
  - Both send about 3 Mbps and report no quality limitation, but the
    encoders produce 85 (ours) and 78 (wrtc) of the 90 layer-frames per
    second. So CPU is compared per encoded frame.
  - CPU: paired 0.92 [0.73–1.11]; per encoded frame 0.85 [0.68–1.06];
    encode time per frame 1.04 [0.84–1.24]. **Inconclusive, about 0–10%
    either way.** The earlier +18% (rounds at load 17–43, with wrtc
    encoding 12–20% fewer frames) didn't reproduce.
  - Ours has far fewer late frames: 4% vs 37%.
  - Not covered: a real SFU, layer switching, and long runs where BWE
    ramps further.

## The exit "hang"

The first macOS run reported one of ours `control` runs as hung after
printing its results. That was **the Mac going to idle sleep, not the
library**:
- The final `control` configuration ran from about 20:38 UTC.
- The Mac slept 20:40:07–21:06:29, apart from a 16 s dark wake.
- The results file was written at 21:06:38.
- wrtc's only "hung mid-scenario" run is in the same configuration.
- See `results/exit-hang/macos-sleep-events.txt`.

Reproduction attempt on the merged build, macOS:
- 100 sequential `control` runs, plus 3 x 50 run in parallel at load
  2.6–5: **248 valid runs, 0 hung**. Exit after close was 3–20 ms
  (median 7). See `results/exit-hang/*.json.gz`.
- 2 more of the sequential runs were killed by the run timeout. They also
  straddled a sleep: 21:56–22:15, durations 510 s and 612 s against the
  505 s and 605 s sleeps.

The harness now protects against this and catches a real hang:
- **Sleep:** on macOS, `run.mjs` spawns `caffeinate -i -w <its pid>`, so
  the Mac stays awake while it runs (the JSON records `caffeinated`).
- **Sleep detection:** every run records its wall-clock start and end, and
  the drift between `Date.now()` and the monotonic clock. A drift over 1 s
  means the machine slept, and the table flags the run as invalid.
- **On a hang:** it reports the child's `process.getActiveResourcesInfo()`,
  from a 3 s unreferenced timer, and on macOS takes a native `sample`
  before killing it. If the event loop is already empty and the process
  is stuck in native teardown, the timer never fires; the `sample` covers
  that case.

Not proven impossible, but there's no evidence of a hang in our library.

## Problems found

### Found here and fixed

- **macOS: re-enabling receive failed.** Fixed in `7eded0d`.
  - Sequence: a video transceiver going `sendrecv` → `sendonly` →
    `sendrecv`, renegotiating each time. The third
    `setLocalDescription(offer)` rejected with `OperationError: Failed to
    set local offer sdp: Failed to set local video description recv
    parameters for m-section with mid='0'`.
  - It was deterministic with one track, and introduced by the H264
    decoder probe (`b860409`, `21bc394`). That left H264 send-only on
    macOS, and an m-section negotiated while `sendonly` kept H264 when
    receive was turned back on.
  - Fix: `7eded0d` gates the H264 encoder on the decoder probe as well,
    with a regression test in `test/integration/h264.test.ts`.
  - Trade-off: macOS now offers and sends no H264 in any direction.
  - Linux is unaffected by construction: both the encoder and decoder
    probes pass there.

### In ours (as found; see "After the performance pass" for 2–5)

Since then:
- **2:** one copy without the zero-fill. The GC gap is V8's
  external-memory heuristic and remains.
- **3:** fixed.
- **4:** H264 is about 40% of it; the rest is libwebrtc M150.
- **5:** 42 → 27 ms on gpubox.

1. **720p encode/decode costs 15–36% more per frame** (libvpx in M150;
   simulcast didn't show it, see above). It's libwebrtc's quality/CPU trade-off, not the binding. If
   CPU matters more than quality there, the knobs are libwebrtc's (CPU
   speed, degradation preference).
2. **Sink frames cost GC and external memory.**
   - Every remote frame is copied into a new zero-filled ArrayBuffer on
     the JS thread: `NewTypedArray` in `src/media_sink.cc`.
   - In the macOS profile, `napi_create_arraybuffer` is 45 of
     `DeliverToJs`'s 101 samples, mostly `madvise` (the zero-fill).
   - The result: 1.2–1.5 major GCs/s with several remote video sinks
     (wrtc: about 0), 2–2.3x the GC time, and +14–18 MB external memory.
   - Remedy to consider: hand the payload's buffer over (an external
     ArrayBuffer) or skip the zero-fill.
3. **Local-track sinks cost 1.9–2.7x wrtc's JS-thread time per frame.**
   - `pushFrame` copies once into the `I420Buffer` and, synchronously,
     again into the local sink's payload; then problem 2's copy follows.
   - macOS profile: `PushFrame` 57 samples (`I420Buffer::Copy` 29, sink
     `OnFrame` 26).
   - Remote-track sinks don't pay this.
4. **Renegotiation on Linux was 2.5x wrtc's** on the pre-merge build: 68
   vs 27 ms, CPU-bound per the probe. The archived macOS profile puts the
   signaling-thread time in libwebrtc:
   - `SdpOfferAnswerHandler`: 411 samples
   - our `CaptureSnapshot`, which serializes 6 descriptions after every
     SLD/SRD: 69 samples, about 14–17% of the signaling thread's handler
     samples (which include blocking calls to other threads)
   - Linux still offers H264 for both directions, so the merge may not
     change this there. Unverified until the gpubox rerun.
5. **Addon import:** 18 ms on macOS, 36 ms on Linux (wrtc: 9–10 ms). It's
   a one-time cost.

### In wrtc

- It crashed on exit in every completed control run: 10 of 10 on Linux
  (9 SIGSEGV, 1 SIGABRT) and 11 of 11 on macOS (SIGSEGV).
- Its sender pacing adds 15–20 ms per packet. Under load, late frames
  pile up:
  - 46% of frames more than 100 ms late at 8 VGA pairs on gpubox
  - 19% with 6 remote sinks on the Mac
  - 37% with simulcast
- `getStats()`, `close()` and simulcast (`sendEncodings` with rids) all
  worked. Nothing came back n/a, and `setParameters` isn't exercised.

## Method

- **Runs:** `bench/run.mjs` runs each configuration in rounds: one run of
  each implementation, back to back, with the order alternating. Each run
  is its own process (`bench/scenario.mjs`).
- **Preflight:** it refuses to run without `dist/` and an up-to-date
  `build/Release/wrtc.node`. It records the addon's sha256 and a hash of
  its native inputs.
- **Media:**
  - Pushed from the nonstandard sources on a drift-corrected 10 ms clock:
    480-sample 48 kHz audio, video at 30 fps.
  - The video is a moving texture (3 x 2 px per frame).
  - A 16-bit frame counter plus a check byte is drawn as
    macroblock-aligned 16x16 cells in the top-left 96x64 pixels. Sinks
    decode it at any layer size, which gives latency, drops and late
    frames.
  - VP8 is moved to the front of every offer, and **every pair must report
    VP8 as its only video codec, or the run fails**.
- **Measured over the window:**
  - process CPU, RSS, heap and external memory
  - event-loop delay (10 ms resolution, minus the interval)
  - the main thread's CPU (`process.threadCpuUsage()`), and how much of it
    falls outside this script's pushes, handlers and content generation
  - event-loop utilization (wall clock)
  - process CPU per encoded frame
  - GC entries
  - RTP stats summed over streams
- **Control:** 10 iterations per run after a discarded warm-up.
  `getStats()` calls are 60 ms apart, past libwebrtc's 50 ms cache.
- **Exit:** wrtc is ended with `process.exit()` after media runs. Natural
  exit is measured in `control`, and a hang is reported with diagnostics.
- **Profiles:**
  - `results/profiles/*.sample.txt.gz` are macOS `sample` captures:
    - `renegotiation-*`: `bench/renegotiation-probe.mjs ours 300`
    - `local-sinks-*`: the `local` config
  - The figures quoted above are inclusive sample counts of those frames.

## Caveats

- **Audio processing:** wrtc runs it on its send path and ours doesn't.
  That's bounded by `audio` (one audio-only pair): ours used 16.0% vs 18.1%
  of a core on Linux and 9.2% vs 8.9% on macOS. So the asymmetry is worth
  at most about 2% of a core per sending audio track, which is under 4% of
  the 8-pair total. Opus bitrates differ slightly (32 vs 29–39 kbps).
- **Loopback in one process:**
  - "CPU" is sender plus receiver.
  - There's no loss, jitter or bandwidth limit, so BWE ramps fast and the
    two libwebrtc versions settle at different qualities.
  - Pacing and jitter-buffer effects may be overstated, as above.
- **Noise:**
  - The Mac was shared with other agents and ran on battery. When it's
    loaded (`simulcast` reached 18, `control` 18), expect **±30%** on single
    macOS runs. Read the paired ratios, and the load row in the full
    tables.
  - gpubox runs the `powersave` governor, which can't be changed without
    sudo. Short CPU bursts there run at a low clock, which is why its
    control timings shift with machine activity.
  - 8 VGA pairs nearly saturate gpubox's 4 physical cores.
- **Not covered:**
  - a real SFU (mediasoup), real networks, H264
  - simulcast layer switching
  - `--src` (TS sources through type stripping, which costs memory an
    install doesn't pay)
