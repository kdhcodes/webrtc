# libwebrtc-rs-js: plan and spike notes

Goal: a Node.js WebRTC implementation to replace `@roamhq/wrtc`. A thin C++
N-API addon over **libwebrtc M150** (our own build of upstream; see
"Building libwebrtc" below), a
spec-shaped JS layer on top, and the WPT `webrtc/` subset as the
conformance metric. Targets: macOS and Ubuntu (x64 + arm64). No Windows, no
musl/Alpine.

(The repo name is historical: the original idea was to bind an existing
Rust binding of libwebrtc via napi-rs. See "Decisions" below for why we
dropped that. The package is `@kdh.codes/webrtc`.)

## Status (2026-11-18)

**Spike passed on macOS arm64, Linux arm64 and Linux x64 (Ubuntu 24.04 in
Docker; x64 under emulation, 10/10 runs, 24 MB binary).**
- `test/spike/dc-ping.mjs` creates two in-process peer connections,
  negotiates, opens a data channel, round-trips ping/pong, fetches stats and
  closes, and then the process exits cleanly. It passed 20/20 runs on each
  platform.
- `test/spike/openssl-coexist.mjs` passes on both platforms: with live
  DTLS peer connections, it runs a `node:tls` TLS 1.3 handshake plus
  `node:crypto` sign/verify/hash in the same process.

| Measured (release) | mac arm64 | linux arm64 |
|---|---|---|
| Prebuilt `libwebrtc.a` | 740 MB (264 MB zip) | similar |
| Clean addon build | ~5 s | ~10 s |
| `wrtc.node` size | 21 MB | 20 MB |
| Negotiate + DC open + round trip | ~18 ms | ~18 ms |
| Dynamic deps | system libc++, libSystem, libobjc, Apple frameworks | libc, libm, libgcc_s only (no libstdc++, no X11) |
| Exported symbols | n/a | only `napi_register_module_v1`, `node_api_module_get_api_version_v1` |

## Decisions

1. **C++ N-API addon, not Rust.** The existing Rust bindings are shaped by
   their own SDKs. They hide things we need (pending descriptions,
   transceiver direction setter, sender `setStreams`, raw stats JSON), and
   extending them means a C++ wrapper, a cxx declaration and napi-rs glue per
   feature. A direct C++ addon is one layer, the same architecture as
   `@roamhq/wrtc`.
2. **Link a static libwebrtc, and own no binding's API.** At first that
   was a prebuilt M150 (`webrtc-a545de4`), which solved the hard build
   problems: libwebrtc itself (depot_tools, tens of GB, hours per
   platform), and BoringSSL symbol prefixing on Linux so it can't clash
   with Node's OpenSSL. Since 2026-11-22 we build upstream M150 ourselves
   (`scripts/build-libwebrtc.sh`; "Building libwebrtc" below).
3. **node-gyp** as the build tool (the standard for Node addons). Flags are
   derived from the libwebrtc build's `webrtc.ninja` by
   `scripts/gyp-webrtc.py`.
4. **All W3C semantics live in JS.** The addon stays mechanical (handles,
   calls, one event stream), while JS owns the operations chain, state
   validation, event dispatch and error types.

## Layout

See `SPEC-LAYER-PLAN.md` ("Architecture" and "WP0 outcome") for the full
layout and ownership, and `CONTRIBUTING-AGENTS.md` for commands. In short:
`src/` is the C++ addon (node-gyp, `binding.gyp`), `lib/` is the TypeScript
layer, `scripts/` holds the build helpers, `test/` has `node:test` suites,
and `docker/` has the Linux image.

Build: `scripts/build-libwebrtc.sh darwin-arm64 && pnpm install && pnpm run build`, then
`pnpm test`. Everything runs inside the devenv shell (`direnv` or
`devenv shell`).

## Native API (current, spike-level)

`new PeerConnection({iceServers}, onEvent)` with `createOffer()`,
`createAnswer()`, `setLocalDescription({type,sdp})`,
`setRemoteDescription({type,sdp})`,
`addIceCandidate({candidate,sdpMid,sdpMLineIndex})` (all Promises),
`createDataChannel(label, init?)`, `getStats()` (Promise of the libwebrtc
JSON string), `signalingState`, `connectionState`, `close()`.

`DataChannel` exposes `key`, its creation settings (`label`, `ordered`,
`maxPacketLifeTime`, `maxRetransmits`, `protocol`, `negotiated`), the live
`id` (-1 until assigned), `readyState` and `bufferedAmount`,
`maxSendQueueSize`, `send(Uint8Array, binary)` and `close()`.
`lib/internal/native-types.ts` is the full, current contract.

`onEvent(ev)` receives `{kind, ...}`:
- PC events: `signalingstatechange`, `iceconnectionstatechange`,
  `icegatheringstatechange`, `connectionstatechange` (`state`),
  `icecandidate` (`candidate`), `negotiationneeded`, `datachannel`
  (`channel`, `channelKey`).
- DC events: `dc:state` (`state`, plus `error` on a `closed` that was
  abrupt), `dc:message` (`data`, `binary`),
  `dc:bufferedamount` (`sent` = bytes just handed to SCTP, possibly part
  of a message), all with `channelKey`. The JS layer tracks
  `bufferedAmount` itself (add on `send`, subtract `sent`). Native
  `send()` is libwebrtc's blocking `Send` (a round trip to the network
  thread), not `SendAsync`, on purpose: see the gotcha "Data channel
  throughput".
  A channel that is already past `connecting` when it's wired up (e.g.
  created on a connected SCTP transport) gets a `dc:state` for its
  current state right away. For remote channels this comes after the
  `datachannel` event. Each state is reported at most once (duplicates are
  suppressed on the signaling thread), though an intermediate `closing`
  can be skipped.
- SCTP transport events: `sctp:state` (`state`, `maxMessageSize`,
  `maxChannels`), `dtls:state` (`state`, `remoteCertificates`) and
  `dtls:error`, from observers on the PC's SCTP transport and the DTLS
  transport under it (`SctpWatcher`, `src/data_channel.cc`). The first two
  are emitted when an SLD/SRD creates the transport, before that SLD/SRD's
  completion.

Key design: **one ThreadsafeFunction per PC carries every PC event, every
DC event for that PC, and every async-op completion** (ops resolve their
promise in the TSFN callback, `EventSink::BeginOp` / `CallJs` "op"). So JS sees
events and promise resolutions in exactly the order libwebrtc produced them,
which is the foundation the spec's event/promise ordering needs. All of an
environment's PCs share one delivery order (`EventOrder`, wave 3C): each
event still wakes its own PC's TSFN, but a wake delivers the oldest queued
event of any PC, so events of two PCs in one process reach JS in the order
libwebrtc emitted them, as a browser's single task queue would (without it, a
receiver's data channel message could beat the sender's `bufferedAmount`
decrease). A queued event holds an `Acquire()` on its own PC's TSFN, so a PC
can't finalize, rejecting its pending ops, while its events wait behind
another PC's. Op completions are queued in that order like events (and
always were: they are `"op"` events): each is its own TSFN call, which Node
runs in a callback scope of its own, so a promise settled there has its
continuations run at that call's microtask checkpoint, before the next
event. The JS layer's own "queue a task" steps go into the same order with
`queueTask(id, next)` (a `task` event; `next`, from an event's callback,
puts it right after the event being handled, in the order queued, and is
ignored anywhere else), where a `setImmediate` would
run before events libwebrtc reported earlier and after later ones delivered
in the same poll phase. Data channel
observers are registered as soon as a channel exists (on the signaling thread
for remote channels), so no messages are lost before JS attaches.

Lifetime:
- `close()`, the GC finalizer, or an env cleanup hook (worker termination)
  closes the PC, unregisters channel observers, and releases the TSFN.
- Async methods called after close reject immediately with
  `name: "InvalidStateError"`. When the TSFN finalizes, any ops still pending
  are rejected in the order they were started.
- Data channel observers are dropped once their channel reaches `closed`.
- **An open PC keeps the process alive, and GC will almost never close it.**
  That matches wrtc. The TSFN holds the `onEvent` callback strongly, so any
  callback that can reach the PC, directly or through a shared closure
  context, pins it forever. A spec-layer `RTCPeerConnection` dispatching
  events on itself always does. So a FinalizationRegistry on the wrapper will
  not fire. Users must call `close()`, as with wrtc. Changing this would mean
  holding the callback weakly and un-refing the TSFN when idle; it's not
  planned.

## Gotchas found

- **`CreateBuiltinVideo{En,De}coderFactory` aren't in libwebrtc's static
  library target**. We
  build the factories from the header-only `VideoEncoderFactoryTemplate` /
  `VideoDecoderFactoryTemplate` adapters (VP8, VP9, AV1 via libaom and
  dav1d; no H264, see below) in `src/runtime.cc`. The builtin encoder
  factory also wraps every encoder in a `SimulcastEncoderAdapter`; the bare template doesn't,
  and without it AV1 simulcast encoded nothing and per-layer `maxFramerate`
  on VP8 simulcast switched the sender to single-layer VP9. So encoders
  come from `src/video_encoder_factory.cc`, which adds the adapter (since
  2026-11-21).
- **A video source must call `AdaptFrame` (or its `VideoAdapter`) itself.**
  libwebrtc applies the sender's `maxFramerate` (the highest of its active
  layers), CPU and quality adaptation and `scaleResolutionDownTo` through
  the source's sink wants; the encoder only thins lower layers below that. `PushedVideoSource`
  ignored them until 2026-11-21 (SPEC-LAYER-PLAN.md, "Video send path").
- **Node addons are linked with undefined symbols allowed** (`-undefined
  dynamic_lookup` on macOS; the default for Linux shared objects). So a
  symbol missing from `libwebrtc.a` links fine and then segfaults with a null
  call at runtime. `scripts/check-undefined.sh` (run by `pnpm run build`)
  fails the build if anything other than `napi_*`/`node_*`/`uv_*` (or a
  versioned glibc symbol) is left unresolved. It has caught the missing
  builtin video factories (mac) and the X11 references (Linux).
- **Visibility:** libwebrtc is built with hidden visibility. Without
  `GCC_SYMBOLS_PRIVATE_EXTERN` the linker warns about weak template symbols
  differing in visibility. Fixed in `binding.gyp`.
- `_LIBCPP_HARDENING_MODE` from `webrtc.ninja` must be skipped because the
  toolchain already defines it.
- **`close()` fires state events** (`signalingstatechange closed`, etc.).
  The spec says `close()` fires none, so the JS layer must suppress them.
- **A data channel created on an already-connected transport is `open`
  before `CreateDataChannelOrError` returns**, so its only state change
  happens before any observer can be registered. `WireChannel` registers the
  observer and reads the initial state in one signaling-thread task, and
  reports a non-`connecting` state itself (`src/data_channel.cc`).
- **On env teardown (worker termination) Node finalizes the TSFN before
  `~PeerConnection` runs.** Closing the PC from the destructor then emitted
  into a freed TSFN and deadlocked. Fixes:
  - a per-PC env cleanup hook (registered after the TSFN, so it runs first
    because hooks are last-in first-out) closes the PC
  - `FinalizeSink` marks the sink released
  - `NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS`, so events still queued at
    teardown are dropped rather than becoming fatal
- **With `NAPI_DISABLE_CPP_EXCEPTIONS`, never throw while an exception is
  pending.** node-addon-api turns that into a fatal abort. Check
  `env.IsExceptionPending()` after reading JS values (getters can throw) and
  before throwing.
- Never hold a lock while calling a libwebrtc proxy method (e.g.
  `UnregisterObserver`). Those block on the signaling or network thread,
  which may be waiting for the same lock.
- **libwebrtc's dummy ADM (`kDummyAudio`) never pulls playout audio**, so
  with it remote audio tracks never reach sinks. `src/runtime.cc` uses our
  playout-only device instead (`src/playout_adm.*`, which pulls every
  10 ms). `TestAudioDeviceModule` isn't in libwebrtc's static library
  target.
- **Once a worker is being terminated, any Node-API call that may run JS
  fails, and node-addon-api turns that failure into a process abort**
  ("FATAL ERROR: Error::New napi_get_last_error_info"). `Worker.terminate()`
  stops the worker's JS from another thread at any moment, so this applies
  to every JS-callable native method and every TSFN callback, not only to
  env teardown. The risky calls are property gets and sets, coercions
  (`ToBoolean`/`ToNumber`/`ToString`), `InstanceOf`, creating buffers,
  typed arrays and promises, settling promises, and calling functions or
  constructors. In that code use the helpers in `src/napi_safe.h`
  (`SafeGet`, `SafeSet`, `SafeToBool`, `SafeInstanceOf`, `SafeBufferCopy`,
  `SafeArrayBufferCopy`, `SafeNewPromise`, `SafeSettle`) or raw `napi_*`
  calls, and drop what you were building on a non-`napi_ok` status (a
  failed get reads as undefined). Creating primitives, plain objects and
  arrays can't fail, so node-addon-api's versions of those are fine; for
  native handles see `NewHandle` in `src/event_sink.*`. Found by stressing
  random-time terminations of a worker with busy data channels:
  `DataChannel::Send`'s `ToBoolean()` and `CallJs`'s `Buffer::Copy` aborted
  about once per thousand. Also easy to miss:
  - `Napi::Array::Length()` (`napi_get_array_length`): use `SafeLength`
    or `SafeArrayLength`.
  - `ObjectWrap<T>::Unwrap`, which node-addon-api's method and accessor
    trampolines call on `this` as `T::Unwrap`. Every native class derives
    from `SafeObjectWrap<T>` instead of `Napi::ObjectWrap<T>`; its static
    `Unwrap` hides the base one, returns nullptr (so `undefined`) on
    failure and throws "Illegal invocation" only while JS can run. Use
    its non-throwing `TryUnwrap` for arguments (`FromJs` helpers).
  - Not coverable: the `napi_wrap` in `ObjectWrap<T>`'s constructor, for
    objects constructed from JS (`new PeerConnection(...)`, sources,
    sinks). A worker terminated exactly then can still abort. Handles that
    native code creates go through `NewHandle`, whose `napi_new_instance`
    fails first.
- **A TSFN holding a JS callback keeps whatever the callback references
  alive** (e.g. the PC). Hold per-object callbacks weakly once the object
  is closed (`EventSink`).
- **Native `getStats()` JSON is an array of stats entries** (or `{}` when a
  selector selects nothing), not an object keyed by id. The first JS layer
  keyed reports by array index; the wrtc compat test caught it.
- **After a rollback (implicit or explicit), libwebrtc can reject its own
  next offer** (worked around in JS). SLD fails with InvalidAccessError "A
  BUNDLE group contains a codec collision for header extension id=1". In
  perfect negotiation that's the polite peer's follow-up offer after glare,
  the one that adds its rolled-back transceiver.
  - **Cause** (libwebrtc M150, 05e02da): header extension ids come from the
    PC-wide `RtpHeaderExtensionPicker`, which remembers every uri-to-id
    mapping it ever handed out, and from per-BUNDLE recorders. Neither is
    reset on rollback (`call/payload_type_picker.cc:418-429`,
    `pc/sdp_payload_type_suggester.cc:123-159`), and the picker's reuse
    branch never checks that the id is still free in the target group. So
    audio-level keeps id 1 from the rolled-back offer even after the remote
    offer bundled toffset at 1. `ValidateBundledRtpHeaderExtensions` then
    rejects libwebrtc's own offer. The raw native API fails the same way.
  - **Upstream:** a regression from webrtc d1ae1e9 ("Refactor RTP header
    extension ID allocation to be persistent and shared", April 2026),
    still on upstream main in November 2026. Chrome 158 and 159 fail the
    same way (Chrome 148 doesn't). A ready-to-file report is in
    `docs/upstream/libwebrtc-rollback-extmap-collision.md` (not filed).
  - **Workaround** (`lib/internal/extmap-fix.ts`): `createOffer`
    renumbers, per BUNDLE group, each a=extmap of a not-yet-negotiated
    section whose id collides with another extension in the group (to the
    group's id for that extension, or a free id counting down from 14).
    An implicit-SLD offer that fails with exactly this error is retried
    once with a JS-created, fixed offer. Offers without a collision are
    untouched, and an implicit SLD stays one native call unless it fails.
    That failed SLD still prints libwebrtc's own error line on stderr.
  - **Risk:** libwebrtc then logs "Redefining mapping for ...
    ssrc-audio-level from 1 to 14" (its stale recorder disagrees with the
    renumbered offer); the glare itself already logs two of these, for
    transport-cc and mid, on the remote offer's SRD. Today that's only a
    log line, but a TODO (bugs.webrtc.org/504685269, field trial
    `WebRTC-ErrorOnRtpExtensionRedefinition`) would make redefinitions an
    error. If that lands before a fix, recheck this workaround (and glare
    itself) on the upgrade. The fixed offer also counts as SDP munging
    (`kRtpHeaderExtensionModified`, `pc/sdp_munging_detector.cc:597-600`;
    each fixed SLD logs "SDP munging: header extension modified"), which
    is allowed unless the `WebRTC-NoSdpMangleReject` or
    `WebRTC-NoSdpMangleAllowForTesting` field trials are set. Recheck that
    on upgrades too.
  - Tests: `lib/internal/extmap-fix.test.ts`; the rollback cases and a
    five-case glare matrix in `test/integration/signaling.test.ts`; perfect
    negotiation with glare against Chromium in
    `test/interop/renegotiation.interop.ts`. When a libwebrtc upgrade fixes
    the bug, the integration test's renumbered id assertion fails: then
    drop the workaround.
- **No H264 or H265, on any platform** (user decision, 2026-11-22). Video is VP8, VP9 and AV1. The codec factories
  (`src/runtime.cc`, `src/video_encoder_factory.cc`) list no H264 or H265
  adapter, so neither is in `getCapabilities()`, our offers or our answers,
  and our libwebrtc build sets `rtc_use_h264 = false` as well. A remote
  that can only do H264 gets its video m-line rejected.

  History, for when H264 comes back: until then a decoder probe gated H264.
  - The macOS prebuilt's FFmpeg had no H264 decoder (not Chrome-branded) and
    there is no OpenH264 decoder. Advertising H264 receive anyway gave black
    video when a remote picked it: frames arrived, none decoded, and
    libwebrtc sent about 7 PLIs/s. `H264Decoder::IsSupported()` only reports
    the build flag; whether a decoder works shows only when `Configure()`
    fails.
  - Sending H264 without decoding it broke renegotiation: a transceiver
    that went sendrecv → sendonly negotiated H264 for sending, the m-section
    kept it, and the next sendrecv offer failed SLD with "Failed to set
    local video description recv parameters for m-section". Keep send and
    receive codec sets the same.
  - The bench found H264's 12 payload types cost about 40% of a Linux
    renegotiation (bench/RESULTS.md).

  `test/integration/h264.test.ts` checks the video capabilities exactly,
  that no offer in any direction lists H264 or H265, that a remote offer
  preferring H264 is answered with VP8 and an H264-only one is rejected,
  that `setCodecPreferences` refuses H264, and the sendrecv → sendonly →
  sendrecv regression. WPT's H264 subtests fail on every platform (reason
  "H264 is not built in (no H264, by decision)").
- **A remote video track can stop getting frames for good after a
  renegotiation** (libwebrtc race, worked around natively). Seen after
  `removeTrack` then renegotiate: under CPU load about 1 run in 180 of a
  Node-to-Node repro, never on an idle machine; the Chrome interop
  removeTrack test could hit it too. The stream keeps decoding
  (`framesDecoded` climbs) but no sink, not even one on `track.clone()`,
  gets a frame.
  - **Cause** (confirmed with libwebrtc's logs on the a545de4 prebuilt;
    line numbers at upstream M150 05e02da, which has the same code):
    sendrecv to recvonly changes the m-section's decoders (a recvonly offer
    lists decoder-only formats), so `WebRtcVideoReceiveStream::
    RecreateReceiveStream` destroys and recreates the receive stream
    (`media/engine/webrtc_video_engine.cc:3718-3752`). A packet the network
    thread had already resolved to the old stream reaches the worker after
    that and goes to the undemuxable handler (`call/call.cc:1447-1501`).
    `ReCreateDefaultReceiveStream` (`webrtc_video_engine.cc:3381-3412`)
    can't add a default stream for that SSRC ("already exists"), but still
    calls `SetSink(ssrc, default_sink_)` (:3411) with `default_sink_ ==
    nullptr`, which nulls the signaled stream's sink. `VideoRtpReceiver`
    never sets it again: it returns early when the SSRC is unchanged
    (`pc/video_rtp_receiver.cc:140-141`).
  - **Upstream:** webrtc 6ded798 (main@{#48423}, 2026-08-25) stopped
    recreating the stream on decoder changes, which removes this trigger,
    but `ReCreateDefaultReceiveStream`'s `SetSink(nullptr)` is still on
    main. Our M150 build has it too; a fix could go in `patches/`. A
    ready-to-file report is in
    `docs/upstream/libwebrtc-default-sink-nulled.md` (not filed).
  - **Workaround** (`src/sink_reassert.cc`): after every successful
    SLD/SRD, each video receiver's sink is set again on the worker, as the
    receiver does on setup (`GetRestartFunctionForMediaChannel_w`), through
    libwebrtc's internal classes (`RtpReceiverProxyWithInternal`,
    `VideoRtpReceiver`, `VideoRtpTrackSource`; each downcast is a
    `dynamic_cast`, and anything unexpected is skipped). The task hops
    through the network thread first, so it lands after any stale packet.
    It's idempotent and skipped once the PC is closing (`PcRef::closed`).
    Under load, 0 failures in 1,620 prototype runs (20 races, each restored
    within 4 ms), and 0 in 700 runs of the stress script on macOS (3 races,
    restored within 2.7 ms). Remove it when a libwebrtc upgrade lacks
    `RecreateReceiveStream` (a `static_assert` on 6ded798's
    `VideoReceiveStreamInterface::SetDecoders` fails the build then) or
    upstream fixes the `SetSink(nullptr)`; recheck it on every upgrade.
  - Tests: `test/integration/renegotiation.test.ts` (video keeps flowing
    across direction changes; the libwebrtc log shows a re-assert after
    every SLD/SRD). The race itself: `scripts/stress-removetrack-race.mjs`
    (CONTRIBUTING-AGENTS.md).
- **libwebrtc's SCTP and DTLS transport objects aren't proxied.**
  `pc->GetSctpTransport()` (and `dtls_transport()` under it) return the raw
  objects, whose `RegisterObserver`/`UnregisterObserver` must run on the
  network thread (`NetworkThread()`, `src/runtime.h`).
- **An oversized data channel message, or one that overflows libwebrtc's
  16 MiB send queue, closes the whole channel** (`NETWORK_ERROR` "Failure
  to send data") rather than failing that send. The oversized one is still
  reported to `OnBufferedAmountChange` as sent. So the JS layer throws the
  spec's TypeError (over `pc.sctp.maxMessageSize`) or OperationError (queue
  full, as Chrome does) before calling native `send()`.
- **libwebrtc goes through `closing` before `closed` even for an abrupt
  close** (the SCTP association aborted, e.g. the remote PC closed), on
  purpose ("observers may be expecting that"). The spec fires no `closing`
  then, but Chrome does, and so do we: the remote side of a `pc.close()`
  sees `closing`, `error` (`sctp-failure`, cause 12), `close`. Verified
  against Chromium in `test/interop/datachannel.interop.ts`.
- **Data channel throughput: a receiver whose UDP socket overflows stalls
  for seconds.** (Measured with `bench/datachannel.mjs`, macOS arm64,
  2026-11-19/20.) dcSCTP's congestion control only sees loss, and its
  receive window (5 MiB) counts SCTP's reassembly buffer, not the kernel
  socket's backlog. When the receiving process's network thread can't keep
  up, slow start (on a ~0 ms RTT) overflows the receiving UDP socket's
  buffer in one burst; macOS's default is 786,896 bytes, about 384
  datagrams. dcSCTP then recovers through retransmission timeouts at its
  400 ms minimum RTO, several in a row (the receiver sees 400-410 ms gaps).
  - **Two PCs in one process** always hit it: one network thread does both
    sides, so it can't drain B's socket while sending A's burst. All ~390
    drops (macOS `netstat -s -p udp`, "dropped due to full socket buffers",
    equal to the transport stats' lost packets) happen in the first ~60 ms,
    then 3 to 8 timeouts; a 4 s run at 64 KiB averages 5 to 50 MiB/s, a
    short test 0.5 to 2 MiB/s. After recovery it runs at ~73 MiB/s, with
    the network thread ~90% busy. `@roamhq/wrtc` is the same.
  - **Two processes on one Mac:** ours 125 MiB/s at 64 KiB, 43 MiB/s (44k
    msgs/s) at 1 KiB, no loss. `@roamhq/wrtc` collapses there too at
    times: a review run gave 7.9 MiB/s with 1,516 socket-buffer drops (with
    `--poll 1`, other runs reached 97 to 144 MiB/s, one with 0.15% loss and
    two timeouts).
  - A bigger `SO_RCVBUF` (experiment, not shipped) makes it worse until
    the buffer can hold the whole 5 MiB window: 2 and 4 MB gave 1 to
    3 MiB/s with 850 to 4,300 drops, 7 MB gave 71 MiB/s with none. Linux
    caps an unprivileged `SO_RCVBUF` at `net.core.rmem_max` (208 KiB by
    default), so it isn't a cross-platform fix.
  - **The blocking `DataChannel::Send` is load-bearing.** Each native
    `send()` is a round trip from the JS thread to the network thread (the
    JS thread spends ~86% of a 1 KiB burst waiting in it). Switching to
    libwebrtc's `SendAsync` (tried, reverted; the variant had a
    `dc:senddropped` event for refused sends) made 4 KiB 10% faster but
    let a 1 KiB burst outrun the receiving process: 0.4 to 0.95 MiB/s,
    5 to 8% loss, all of it socket-buffer drops and 400 ms timeouts. Don't
    make the sender faster without a way to keep the receiver from
    overflowing.
  - **Browsers (Playwright, same Mac) were slow only over the VPN path.**
    Unpinned, Chromium runs were 0.24 to 5 MiB/s and highly variable, and
    every Firefox run 0.2 to 4 MiB/s with 7 to 15% loss, mostly without
    kernel socket drops. Those pairs used this Mac's VPN interface
    (10.99.0.x, `utun`), and our side saw the browser's packets arrive from
    the VPN's address: they went through the VPN software and back.
    Pinned to the LAN address (`--candidates ' 192\.168\.'`):
    - us to Chromium: 70 MiB/s at 64 KiB, 37 MiB/s (38k msgs/s) at 1 KiB,
      no loss.
    - Chromium to us: 21 MiB/s at 64 KiB, 0.46 MiB/s at 1 KiB, with 0.5 to
      9% loss and 400 ms timeouts but no kernel receive drops on this Mac:
      the packets are lost before our socket, probably in Chromium's own
      send path. Cause not established.
    - Chromium to Chromium and anything with Firefox couldn't be pinned:
      Chromium still hides its host addresses behind mDNS, and Firefox
      gathered only the VPN interface (even with a capture grant), so
      ICE fails without the VPN path. **The usrsctp (Firefox, mediasoup)
      question is open**: try with the VPN off, or against a mediasoup
      worker.
  - **Linux (gpubox, x64, Pop!_OS 24.04, `rmem_default` 212,992):** two
    processes give ~75 MiB/s at 16 to 256 KiB with 1.3 to 1.9% loss, all
    of it receive-buffer overflow (`RcvbufErrors`, ~8k per run) recovered
    by fast retransmit (no pause of 50 ms or more), and 21 MiB/s at 1 KiB
    with none. One process: 41 MiB/s, one 414 ms timeout.
  - **Mac (Wi-Fi) to gpubox (gigabit Ethernet) over the LAN:** 6.5 to
    16 MiB/s, 0.8 to 9% loss (once 20% at 1 KiB, 0.84 MiB/s), all of it
    gpubox `RcvbufErrors`, none on the Mac. With the receiver's
    `SO_RCVBUF` at 4 MiB (the experiment again; gpubox's `rmem_max` is
    4 MiB) drops went to 0: 1 KiB 0.84 to 41 MiB/s, 16 KiB 12 to 49 MiB/s.
    64 KiB still lost 9 to 13% somewhere on the path (Wi-Fi) and gave 2 to
    23 MiB/s. **So Linux's default 208 KiB receive buffer costs real
    throughput across a network, not just on loopback.** A configurable
    receive buffer (bounded by `net.core.rmem_max`, which is 208 KiB on
    stock distributions) is worth adding.
  - `dc:bufferedamount` used to read `buffered_amount()` per event, another
    blocking signaling-to-network hop per message sent. Dropping it made
    one-message-per-`bufferedamountlow` sending at 1 KiB 56% faster
    (24 to 38 MiB/s across two processes) and changed nothing else.
  - Keep data channel tests' volumes small, and measure throughput across
    two processes, never with both PCs in one process.
- **Sink frames are copied once, on the JS thread** (`src/media_sink.cc`,
  performance pass 2026-11-20).
  - The sink adapter keeps a reference to libwebrtc's I420 buffer, which
    is immutable once it's in a `VideoFrame`. `DeliverToJs` copies it
    into a fresh ArrayBuffer per frame and per sink, as wrtc does, so
    every frame a sink delivers is independent.
  - The ArrayBuffer comes from `napi_create_buffer`, because
    `napi_create_arraybuffer` zero-fills. JS gets a plain `Uint8Array` /
    `Int16Array` over it, not a Buffer.
  - Don't hand out libwebrtc's memory as an external ArrayBuffer: V8
    sandbox builds (Electron) refuse it, and writes would reach other
    sinks and the encoder.
  - A video sink queues at most `kMaxQueuedFrames` (3) frames for JS, held
    by reference, and drops the oldest past that (`framesDropped`); audio
    is unbounded. The bound is what keeps decoder pools safe: a held buffer
    can't go back to the decoder's pool, and the pools don't bound that: H264's (`VideoFrameBufferPool(true)`) is
    uncapped, VP9's only warns past 68, VP8's stops at 300 and then drops
    frames, and none shrinks. Holding every queued frame retained +249 MB
    (VP8, 720p, macOS) after a JS stall, and grew without limit with H264
    on Linux.
  - Many-sink workloads trigger major GCs ("external memory pressure")
    when the app makes too little other JS garbage for scavenges to free
    the frame buffers first. wrtc behaves the same (bench/RESULTS.md).
- **Snapshots reuse serialized SDP** (`CaptureSnapshot`,
  `src/peer_connection.cc`).
  - `PcRef::serialized` keeps each description's SDP, keyed by the object
    and a fingerprint of its candidates.
  - The rule behind it: libwebrtc M150 (05e02da) edits an installed description
    only to add or remove candidates (`pc/sdp_offer_answer.cc`).
  - If an upgrade adds another in-place edit, add it to the fingerprint,
    or snapshots go stale. `test/native/pc.test.ts` checks the known
    cases.
- **Import time:** runtime modules get Node builtins through
  `process.getBuiltinModule`, not `import ... from 'node:*'`. Each import
  builds an ESM facade, and `node:crypto` loads on first use. Together
  that was 15 of 42 ms on gpubox; `lib/index.test.ts` checks the
  `node:crypto` part.
- **Renegotiation on Linux costs about 2.5–4x wrtc's** (bench/RESULTS.md).
  - About 40% of it was H264's 12 payload types: libwebrtc's codec
    matching grows with the payload-type count. H264 is gone since
    2026-11-22 (Gotchas, "No H264 or H265").
  - The rest is M150's own SDP work.
- lldb can't attach to the nix-built `node` (hardened runtime). Use the macOS
  crash reports in `~/Library/Logs/DiagnosticReports/node-*.ips` for native
  stacks.
- The build uses the devenv (nix) clang and libc++ headers, but the output
  links the system `/usr/lib/libc++.1.dylib`, which is what we want for
  distribution.
- **V8 wasm crash in workers** (investigated 2026-11-21). Not ours: two V8
  bugs in wasm-to-JS wrapper tier-up crash the whole process when
  `worker_threads` that run wasm calling JS imports come and go. Node's
  TypeScript type stripping (amaro) is such wasm, so any `.ts` code in a
  worker is exposed, whether or not it uses this library. Consumer guidance
  is in `docs/deployment.md`; the draft upstream comments in
  `docs/upstream/node-wasm-wrapper-crashes.md`.
  - **Node 24** (V8 13.6, up to at least 24.22.3, every platform tried): a
    SIGSEGV/SIGBUS or `Check failed` in `ThreadIsolation`
    (`UnregisterWasmAllocation`, `TryLookupJitPageLocked`), under
    `Runtime_TierUpWasmToJSWrapper` -> `~WasmCodeRefScope` ->
    `WasmEngine::FreeDeadCode`. V8 13.x made the import wrapper cache
    process-wide and refcounted; `WasmImportWrapperCache::MaybeGet` adds a
    reference before checking `is_dying()`, so a tier-up in one isolate can
    take a reference to a wrapper whose last reference the wasm code GC
    just dropped on another thread, and frees it a second time when its
    scope ends. Fixed upstream by V8 9b8ca54d5a ("Fix lookup of wrappers
    marked is_dying"); nodejs/node#66366, backport PR #66376 open (not in
    any Node 24 release). **Confirmed**: Node 24.22.3 built from source with
    that commit and its CHECK-adding parent (68210d500a) applied survived
    29,044 workers of the reproducer on gpubox (native x64), interleaved
    with the official 24.22.3, which crashed in all 7 of its runs (about
    1,300 workers per crash). Node 22 (V8 12.4, a per-module cache) is
    clean.
  - **Node 25 and 26** (V8 14.1/14.6), arm64 only: SIGILL (exit 132) at
    the first instruction of a freshly tiered wrapper (`0xd2800650`, `movz
    x16, #0x32`, valid in the core), nodejs/node#67467, open. Stale
    instructions on another core, not the code GC: `--no-wasm-code-gc`
    doesn't help. Much more frequent than Node 24's: usually within the
    first few hundred workers.
  - **Mitigation** (documentation only, `docs/deployment.md`): `node
    --wasm-wrapper-tiering-budget=2147483647` (no wrapper tier-up at all,
    so neither bug's code runs; wasm-to-JS calls stay on the generic
    wrapper: about 25 ns per wasm-to-JS call instead of 5 ns on an M-series
    Mac, while type-stripping all of `lib/` 30 times took 390-400 ms
    without it and 370-450 ms with it, noise on a loaded Mac). Also works set at
    runtime with `v8.setFlagsFromString()` before any worker starts, even
    after the main thread has tiered its own imports up, as `node app.ts`
    has (Node 26, macOS: 0 crashes in 40,697 workers; its control crashed
    at 700; with 2147483647, 0 in 39,161 on the command line and 0 in
    22,908 at runtime). Measured runs mostly used 1000000000; 2147483647
    (the flag's maximum) removes the edge case of an import called more
    than 1e9 times in one instance, since the budget is per import per
    instance. `--no-wasm-code-gc` fixes Node 24 only. `NODE_OPTIONS`
    refuses this flag (Node allows only a few V8 flags there, such as
    `--max-old-space-size`), and a worker's `execArgv` refuses it
    (ERR_WORKER_INVALID_EXEC_ARGV); `v8.setFlagsFromString` inside a worker
    is accepted and changes it for the whole process. The budget is read
    when a wasm instance is created, so instances created before the flag
    is set keep tiering up.
  - **Decision (2026-11-21): documentation only.** The library doesn't set
    the flag on import and has no opt-in export: it would cost every wasm
    user in the process about 5x per wasm-to-JS call, it only protects
    instances created after it's set, and an import that happens late or
    in a worker would change it process-wide while other threads run.
    Drop the guidance once a Node 24 release ships #66376 and #67467 is
    fixed.
  - **Our addon is not involved.** `scripts/repro-wasm-wrapper-race.mjs`
    reproduces both with no addon and no TypeScript: worker churn, each
    worker calling a 24-import module a random number of times. Our
    native code has no signal handlers or `mprotect`/`madvise`, and
    flags that change only V8's wrapper tier-up or code GC make the crash
    go away, so hypotheses (a) (our code running JS in a dying env) and (b)
    (interfering with code-space protection) are out, as is any effect of
    `-z nodelete`; (c), a V8 bug, is it. The crash needs: two
    or more isolates using wasm (workers), a wrapper whose last holder dies
    (an exiting or terminated worker), and a tier-up of the same signature
    in another isolate at that moment. The library doesn't change the
    rate measurably: workers that only type-strip crash as often.
  - **Counts** (Linux arm64 in Docker unless noted; a "run" of the
    reproducer is 4 lanes for 60 s, interleaved across configurations so
    machine load is comparable; "workers" before a crash are rounded down
    to 100):

    | Workload | Configuration | Runs / lifecycles | Crashes |
    |---|---|---|---|
    | reproducer, no addon | Node 24.22.3 | 31 runs (about 2,200 workers per crash) | 22 |
    | reproducer | `--wasm-wrapper-tiering-budget` (command line 19,452 + `setFlagsFromString` 16,247 + 2,882 workers) | 38,581 | 0 |
    | reproducer | `--no-wasm-code-gc` (command line 19,170 + `setFlagsFromString` 15,553 + 2,820) | 37,543 | 0 |
    | reproducer | Node 22.23.5 | 20,830 | 0 |
    | reproducer | Node 25.9.0 | 8 runs | 8 (SIGILL) |
    | reproducer | Node 26.13.1 | 56 runs | 56 (SIGILL) |
    | reproducer | Node 26, budget flag (command line 108,904 + `setFlagsFromString` 28,485) | 137,389 | 0 |
    | reproducer | Node 26, `--no-wasm-code-gc` | 27 runs | 27 (SIGILL) |
    | reproducer, macOS arm64 | Node 24.22.2 (nixpkgs) | 27 runs, about 124,000 workers | 3 |
    | reproducer, macOS arm64 | budget / nocodegc / Node 22 (too few to judge at macOS's rate) | 28,949 / 28,571 / 24,739 | 0 / 0 / 0 |
    | reproducer, macOS arm64 | Node 26.13.1 / `--no-wasm-code-gc` / budget 1000000000 / budget 2147483647 | 6 runs / 6 runs / 60,926 / 39,161 | 6 / 6 / 0 / 0 |
    | reproducer, Linux x64 (emulated in Docker) | Node 24.22.3 | 18 runs, 17,836 workers | 6 |
    | reproducer, Linux x64 (gpubox, native) | official 24.22.3 / 24.22.3 + V8 9b8ca54d5a | 7 runs / 29,044 workers | 7 / 0 |
    | reproducer, Linux x64 (emulated) | Node 25.9.0 / 26.13.1 | 14,920 / 22,412 | 0 / 0 |
    | library, `wt` (below) | `lib/` (type stripping) | 3,280 | 1 |
    | library, `wt` | `dist/` | 2,760 | 0 |
    | library, `wt` | `dist/` + a trivial `.ts` import | 2,760 | 0 |
    | `wt` without the addon | type-strips all of `lib/` (`stripTypeScriptTypes`), then timers | 2,880 | 1 (same stack) |
    | library, `wt` | `lib/`, budget flag | 2,760 | 0 |
    | library, `wt` | `dist/`, `--no-experimental-strip-types` | 2,760 | 0 |
    | library, `wt`, macOS arm64 | `lib/` | 2,320 | 0 |
    | library, lanes, terminate within 800 ms | `lib/` + PC pair / `lib/` loaded only / no addon, `lib/` stripped / `dist/` + PC pair | 17,277 / 17,399 / 17,372 / 17,372 | 1 / 1 / 0 / 0 |
    | library, natural exit (PC pair, audio, sink) | `lib/`, 3 lanes / 3 per round / same plus a main-thread PC | 3,030 / 5,400 / 6,900 | 0 / 0 / 0 |

    `wt` is a scratch harness from the earlier review: 30 rounds per run of
    one worker terminated at 0.2-1.4 s, one that calls `process.exit()`,
    or two terminated together; each runs 3 PC pairs with echoing data
    channels, `getStats()` every 20 ms and an unclosed raw PC (40
    lifecycles per run). At about 1 crash per 3,000 lifecycles (`wt`) or
    17,000 (lanes), these library rows can't separate configurations at
    95% (that needs about 3 mean intervals clean, 9,000+ lifecycles each);
    the reproducer rows carry the conclusions. What they do show: Node's
    type stripper without the addon crashes the same way at the same rate
    as the library's workers, and nothing about it is specific to
    terminating (the reproducer's workers all exit on their own).
  - **Tests:** test workers never run TypeScript (`built-package.ts`, see
    CONTRIBUTING-AGENTS.md "Rules"). Stress: `scripts/stress-worker-wasm.mjs`
    (the library) and the reproducer above. Recheck on Node upgrades
    (drop the guidance once a fixed Node 24 is the floor; Node 26 needs
    #67467).
- **Our types and lib.dom's must be assignable both ways** (since
  2026-11-23). wrtc's types re-export the DOM's, so wrtc code mixes
  `wrtc.MediaStream` with the global `MediaStream`. `scripts/check-dom-types.mjs`
  (in `pnpm run typecheck`) compiles `test/dom-compat/` against the
  published declarations with the current TypeScript's lib.dom and with
  TypeScript 5.8's (the `typescript-5.8` devDependency), checks that the
  `on<event>` setters still refuse a handler of another event, and
  compiles the declarations without a DOM lib (`test/dom-compat/no-dom/`) with both
  versions. What it took:
  - `build:ts` (`scripts/build-ts.mjs`) drops tsc's `#private;` and the
    `[Symbol.toStringTag]` getters from the `.d.ts` files: a JS private
    field makes a class nominal, so no DOM-typed value was assignable to it.
  - The 23 `on<event>` getters of `MediaStream`, `RTCPeerConnection`,
    `RTCDataChannel` and the three transports return `AnyEventHandler`
    (`lib/internal/events.ts`), `(event: Event)` through a method
    signature: lib.dom's handlers take their own event type, and only the
    bivariant comparison accepts them; `Event` itself keeps ours assignable
    to lib.dom's handlers. Only the getter's type takes part in
    assignability; the setters keep taking only their own event's handler.
    `MediaStreamTrack`'s handlers are its own `(ev: Event) => unknown`,
    which lib.dom's (also `Event`) already matched.
  - Where lib.dom's dictionary types differ between TypeScript versions
    with no one type of ours assignable to and from both (TypeScript 5.8's
    `echoCancellation` is `boolean`-only), the generator types that member
    as the consumer's own lib.dom has it (`LIB_DOM_MEMBERS` in
    `scripts/gen-idl.mjs`, via `declare global` interfaces that are empty
    without a DOM lib).
  - What can't hold is `@ts-expect-error` with the reason in the test:
    mostly spec members lib.dom lacks (`RTCIceTransport.role` and others,
    `RTCIceCandidate.relayProtocol`/`url`), which make DOM-typed transports,
    and everything holding one, not assignable to ours.

## Linux

Build and run: `docker build -f docker/linux.Dockerfile -t wrtc-linux . &&
docker run --rm wrtc-linux`. The image is Ubuntu 24.04 with clang 21 from
apt.llvm.org and the latest Node 24.

How the Linux build works (the `OS=='linux'` block in `binding.gyp`):
- The current Linux prebuilt uses Chromium's hermetic libc++
  (`use_custom_libcxx=true`, namespace `std::__Cr`). We compile with
  **clang** (`CC`/`CXX` set in the Dockerfile) against the bundled
  `third_party/libc++` headers with `-nostdinc++`. libc++ itself is already
  inside `libwebrtc.a`, so we link with `-nostdlib++`. **GCC must not be
  used**: it ignores libc++'s `trivial_abi` and silently miscompiles calls
  that pass `unique_ptr`/`shared_ptr`.
  The clang floor comes from the bundled libc++'s
  `__configuration/compiler.h`.
- `_LIBCPP_HARDENING_MODE` from `webrtc.ninja` is kept on Linux (it's only
  dropped on mac). `scripts/gyp-webrtc.py` handles this.
- `-Wl,--exclude-libs,ALL` plus `-fvisibility=hidden` keep everything in
  `libwebrtc.a` (BoringSSL, libc++abi, ...) out of the dynamic symbol table,
  so none of it can interpose with Node's OpenSSL or libstdc++. Our build's
  BoringSSL symbol prefixing (`prefix_boringssl` in
  `scripts/build-libwebrtc.sh`) is a second layer on top of that.
- Our Linux libwebrtc is built with `rtc_use_x11 = false` and
  `rtc_use_pipewire = false` (`third_party/args/linux-*.gn`), so
  `libwebrtc.a` references no Xlib, PipeWire, GIO or DRM symbols (checked
  with `llvm-nm -u`). Only desktop capture and the ALSA/Pulse audio devices'
  typing detection used them, and we use neither. If we ever ship either,
  turn them back on and load those libraries lazily (`dlopen`), so the
  addon still loads without them.
- The dummy audio device works headless, as expected.
- **`-Wl,-z,nodelete` keeps the addon mapped for the life of the process**
  (`readelf -d` shows `FLAGS_1 ... NODELETE`). Without it, a process whose
  main thread never loads the addon segfaulted (exit 139) when the worker
  that did exited. Node `dlclose()`s an addon when the last env that loaded
  it is destroyed, and glibc then unmapped wrtc.node while our code was
  still in use:
  - libwebrtc's network, worker and signaling threads (`src/runtime.cc`,
    process-wide, never stopped) were parked inside it. `wrtc-worker` faulted
    returning into `webrtc::Event::Wait` on its next timed wakeup, and
    `wrtc-network` was in `PhysicalSocketServer::WaitEpoll`.
  - BoringSSL's thread-local `pthread_key` destructor
    (`bssl::thread_local_destructor`) is registered from inside wrtc.node. Any
    JS-thread call that reaches `RAND_bytes`, e.g. `CreateRandomUuid()` when a
    source creates its track, sets a value for it on the worker's thread.
    That thread's exit (`__nptl_deallocate_tsd`) then called the unmapped
    destructor.

  Shown with gdb at `_dl_close` plus a core of each fault, and with
  `LD_DEBUG=files` ("calling fini", "destroying link map" for wrtc.node
  before the crash). There's no per-env fix: the runtime and BoringSSL's
  key are process-wide by design. A main thread that also loads the addon
  holds a reference until exit, which is why it never showed there. macOS
  is unaffected: dyld never unloads an image with thread-local variables
  (`MH_HAS_TLV_DESCRIPTORS`) or ObjC metadata, which wrtc.node has, so
  Node's `dlclose()` is a no-op there. Covered by "a process that loads the
  addon only in workers survives their exit" (`test/integration/`).
- The V8 wasm crash in workers found while verifying the nodelete fix
  (once listed here as open) is a V8 bug in Node 24 on every platform tried
  (with a different one in Node 25/26 on arm64), not ours and not
  Linux-specific: see Gotchas, "V8 wasm crash in workers".

Linux x64 was built and tested with `docker build --platform linux/amd64 ...` (emulated
on an arm64 Mac, so timings are not meaningful). macOS x64 has not been tried.

**glibc floor of the prebuilt addons: 2.34** (both arches).
Our `libwebrtc.a` is built against Chromium's old sysroot, but symbol
versions are bound when the addon is linked, against the build machine's
glibc (Ubuntu 24.04, 2.39): libpthread/libdl symbols land at 2.34 (merged
into libc in 2.34). To lower it, link on an older base (an Ubuntu 20.04 or Debian
11 image gives 2.31, still with clang 21 from apt.llvm.org), or against
Chromium's Debian bullseye sysroot with `--sysroot`. Not done yet.

## Building libwebrtc

We build upstream libwebrtc M150 (`branch-heads/7871`, pinned in
`scripts/build-libwebrtc.sh`) ourselves, with the gn args in
`third_party/args/` and our patches in `patches/` (each patch's header says
why it's there). How to build, refresh the TURN root certificates, and
check a build matches the checkout: CONTRIBUTING-AGENTS.md, "Rebuilding
libwebrtc".

`libwebrtc.a` is a build input only: it's linked statically into
`wrtc.node`, and that's all we ship to npm. Installs pull the platform
package for their OS and CPU (`@kdh.codes/webrtc-<triple>`, `wrtc.node`
only, about 6–8 MB compressed) through the main package's
`optionalDependencies`. Our libwebrtc builds are also published, as assets
of a GitHub release per configuration (`libwebrtc-<config id>`,
`scripts/libwebrtc-assets.sh`), so CI links against them without building
libwebrtc (CONTRIBUTING-AGENTS.md, "CI and releases").

## Next steps

See `SPEC-LAYER-PLAN.md` (revision 2, reviewed) for the plan from here: WP0
scaffolding, then the media and RTP slices, then the JS peer connection
(milestone 1: the user's nonstandard sources and sinks working across two
PCs), then WPT, data channels and the rest (milestone 2).

## Open questions

Resolved (2026-11-18):
- Keep wrtc's `nonstandard` API shape. The user consumes it, and it's the
  priority over data channels.
- Never-closed PCs keep the process alive, as in wrtc (see Lifetime).
- No CI for now; everything is verified locally (macOS directly, Linux via
  Docker). Superseded 2026-11-22: GitHub Actions builds and tests every
  platform, and publishes to npm on `v*` tags (CONTRIBUTING-AGENTS.md, "CI
  and releases").

Known gaps:
- The Docker image pins Node, pnpm and clang's major version, but not the
  Ubuntu digest or clang's point release.
