# Deployment notes

Things to know when running `@kdh.codes/webrtc` on servers. Most of
this comes from measurements in `PLAN.md` (Gotchas), `bench/RESULTS.md` and
`docs/sfu-test.md`.

## Supported platforms

| Platform | Notes |
|---|---|
| Linux x64 and arm64, glibc 2.34+ | Works: Ubuntu 22.04+, Debian 12+, RHEL / UBI 9 and Amazon Linux 2023, `node:24` and `node:24-slim` images. |
| Alpine, any musl image | Not supported. |
| macOS arm64, 13.5+ | Supported. |
| Windows, Intel Macs | No builds. |

Video codecs are VP8, VP9 and AV1 on every platform. There is no H264 or
H265, so a remote that can only send or receive H264 gets no video from us.

The loader names the missing or mismatched platform package when it can't
load the addon. Install the main tarball and your platform's tarball
together; see the Packaging section of `CONTRIBUTING-AGENTS.md`.

## UDP receive buffer (data-channel throughput)

This only matters for **bulk data over data channels**: file transfer, or
streaming tens of MiB/s. Media, chat and signaling-sized messages are well
within the defaults.

- **The problem:** libwebrtc's SCTP sends as fast as the receiver's
  window allows and slows down only when packets are lost. The receiver's
  kernel UDP buffer isn't part of that window. Linux's default buffer
  (`net.core.rmem_default`, 212,992 bytes on stock kernels) is small, so
  a fast sender overflows it, packets are dropped, and SCTP waits out
  retransmission timeouts.
- **Measured:** Mac → Linux over the LAN reached 1–16 MiB/s with the
  default buffer, against 41–49 MiB/s with a 4 MiB buffer.
- **Check for it:** with `nstat -az UdpRcvbufErrors Udp6RcvbufErrors`, a
  counter that climbs during transfers means drops at this buffer.

### Raising the buffer

libwebrtc doesn't set `SO_RCVBUF` on its sockets, so they get
`rmem_default`. Raise both values on the host:

```sh
sudo sysctl -w net.core.rmem_default=4194304 net.core.rmem_max=4194304
# persist: /etc/sysctl.d/90-webrtc.conf
#   net.core.rmem_default = 4194304
#   net.core.rmem_max = 4194304
```

This affects every UDP and TCP socket on the machine that doesn't set its
own size, so it costs up to 4 MiB of kernel memory per busy socket.

**Containers:** whether `net.core.*` can be set per container depends on
the kernel and runtime. Expect to set it on the host or node, not inside
the container. This hasn't been verified on a container platform.

**There's no library option for this yet.** It was deliberately left as
documentation (2026-11-20). A per-socket option in the addon would still
be capped by `rmem_max`.

## Data channels through mediasoup

From `docs/sfu-test.md`. These apply to the SFU's configuration, not to
this library:
- **mediasoup 3.20+** (its own SCTP stack): with default settings, a
  client sending bulk data can overflow the **SFU's** UDP buffer, giving
  0.4–0.8 s stalls. Setting the transport's
  `sctpMaxReceiverWindowBufferSize` to 256 KiB fixed it in testing.
- **mediasoup 3.19** (usrsctp): with the default `sctpSendBufferSize`
  (256 KiB), back-to-back messages near the 256 KiB maximum can be dropped
  on the way to consumers, while still being counted as sent. A 4 MiB send
  buffer fixed it.

## Worker threads that use wasm (TypeScript included)

Node 24, 25 and 26 have V8 bugs that **crash the whole process** when
`worker_threads` use WebAssembly that calls back into JavaScript while
other workers come and go. **TypeScript run directly by Node counts**: its
type stripping is wasm, so a `.ts` file loaded in a worker (Node 24's
default, no flags) is exposed even if nothing else uses wasm. This library
isn't involved: the crash reproduces without it
(`scripts/repro-wasm-wrapper-race.mjs`). What matters is wasm in the
worker, so `.ts` worker code that loads our compiled package is exposed
too. Workers that run plain JavaScript and no wasm are not affected.

- **Node 24** (up to at least 24.22.3): a SIGSEGV, SIGBUS, or `Check
  failed` from V8 `ThreadIsolation` / `FreeDeadCode`, rare per worker (in
  our stress runs of short-lived, overlapping workers that type-strip,
  about 1 crash per 3,000 to 17,000 workers). Fixed in V8, not yet
  backported (nodejs/node#66366, backport PR #66376).
- **Node 25 and 26**, arm64 (Linux and macOS): a SIGILL (exit code 132)
  with nothing on stderr, much more often (nodejs/node#67467).
- **Node 22**: not affected (no crash in 45,000 workers of the reproducer).

If you run `.ts` code or other wasm in workers, start Node with this flag
on the command line (`NODE_OPTIONS` refuses it, as does a worker's
`execArgv`):

```sh
node --wasm-wrapper-tiering-budget=2147483647 app.ts
```

It stops V8 compiling specialised wasm-to-JS call wrappers, which is where
both bugs live; wasm keeps calling JavaScript through the generic wrapper,
about 25 ns per call instead of 5 ns (measured on an M-series Mac), which
type stripping doesn't notice but a wasm module that calls into JavaScript
millions of times a second would. It avoided both crashes in every stress
run.

If you can't change the command line, `v8.setFlagsFromString()` works too,
with caveats. Node documents that changing V8 flags after startup "may
result in unpredictable behavior". V8 reads the budget when a wasm instance
is created, so instances created before the call keep tiering up: call it
in the main thread before any worker starts and before creating any wasm
instance whose imports share signatures with your workers'. In our runs
that held even when the main thread had already type-stripped its own `.ts`
entry point (the stripper's wasm had tiered up there first):

```js
import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--wasm-wrapper-tiering-budget=2147483647');
```

The flag affects the whole process, whichever thread sets it: a call from
inside a worker also changes it for every other thread.

`--no-wasm-code-gc` avoids the Node 24 crash but not the Node 25/26 one,
and keeps dead wasm code in memory.

This library deliberately doesn't set the flag for you: it would slow
every wasm-to-JS call in your process about five times, it only protects
wasm instances created after it's set, and setting it when the library
happens to load (late, or in a worker) would change V8 under threads that
are already running. Whether the trade is worth it is your call. This
section goes once a Node 24 release ships the fix (nodejs/node#66376) and
#67467 is fixed in Node 25/26.

## Process lifetime

- Close every `RTCPeerConnection`, and stop sources and sinks. The process
  then exits on its own (tested in every suite).
- Don't run two peer connections that talk to each other in **one process**
  for throughput tests. They share one libwebrtc network thread, and
  data-channel throughput collapses (`PLAN.md` Gotchas).
