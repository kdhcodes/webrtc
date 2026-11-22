# Spec layer plan

The plan for turning the native spike into a usable `@roamhq/wrtc`
replacement. Written so that work packages (WPs) can be handed to subagents.
Read `PLAN.md` first for the native architecture, gotchas and decisions. This
doc assumes it.

Status: **WP0 and wave A (WP-M, WP-R) done, reviewed, fixed and
re-reviewed; next is WP-T, then WP-P.** Last updated 2026-11-18.

Where things stand:
- The native layer implements the whole contract (the i420 helpers
  last, 2026-11-22).
- `test/native/remote-media.test.ts` proves the milestone 1 media path at
  the native level on macOS and Linux: nonstandard sources, two PCs, sinks
  on the remote tracks, and clones of remote tracks.
- Milestone 1 still needs the JS `RTCPeerConnection` (WP-P) and its
  compat scenario.

Revision 2 changes, from the review:
- Restructured around the user's critical path, as vertical slices.
- Added a playout audio device, without which remote audio sinks never fire.
- Moved all shared native scaffolding into WP0.
- Description completion now uses snapshots.
- Added an exact wrtc compatibility spec.
- Corrected the close and negotiationneeded semantics.
- Added the WPT runner traps.

## Goal and milestones

The user consumes `@roamhq/wrtc` through `nonstandard.RTCAudioSource`,
`RTCAudioSink`, `RTCVideoSource` and `RTCVideoSink`, and maybe
`getUserMedia`. They don't use data channels.

**Milestone 1 (M1): the user can switch.** Two `RTCPeerConnection`s exchange
audio and video from the nonstandard sources, and remote tracks are read back
through the nonstandard sinks, on macOS and Linux. It also requires:
- the standard PC surface those programs use (see answered question 1)
- `require('<pkg>')` has wrtc's export shape, where unimplemented names
  throw "not implemented" when used
- differential tests show the same observable behaviour as `@roamhq/wrtc`
  for everything in "wrtc compatibility spec" below

**First deployment (2026-11-20):** the user's meeting-processing Node
workers (local stack, `node:24-bookworm-slim`) ran on the `@kdh.codes/webrtc`
tarballs in place of `@roamhq/wrtc` and "worked great". Those tarballs were
native build `abafa9992df4`, from before the WPT fix waves. The waves change
behaviour the workers can see (remote tracks start muted and fire `ended`,
RTP parameters, native changes), so re-run the local stack on fresh
tarballs once they merge.

**Milestone 2 (M2): conformance and the rest.**
- WPT harness with a wrtc baseline
- data channel spec layer
- `getUserMedia`
- `i420ToRgba` / `rgbaToI420`
- `portRange`
- remaining WPT triage

Out of scope: Plan B (libwebrtc removed it), Windows, CI, packaging and
prebuilds, `RTCDTMFSender`, encoded transforms, simulcast tuning.

## Answered questions (2026-11-18)

1. **Standard APIs in M1 scope:** all of `addTrack` / `addTransceiver`,
   `ontrack` with `streams`, `replaceTrack`, `removeTrack`, `getStats`,
   `restartIce`, `getSenders` / `getReceivers` / `getTransceivers`, and
   transceiver `direction`.
2. **Consumption:** TypeScript, Node 24, `import`. **Decision: ship ESM**
   (`"type": "module"`, `exports` with `types` + `import` + `default`). Node
   24 also allows `require()` of it. A TypeScript consumer whose tsconfig
   compiles to CommonJS with `module: node16` would get TS1479. If that
   comes up, add a CJS build.
3. **wrtc divergences:** the proposed defaults (⚑ below) are accepted:
   - `track.stop()` matches wrtc
   - `rotation` and `byteOffset` are honoured
   - `getUserMedia` produces synthetic media

## Architecture

```
lib/                      TypeScript sources of the JS layer
  index.ts                export shape identical to @roamhq/wrtc
  RTCPeerConnection.ts    ...one module per interface
  nonstandard/            RTCAudioSource/Sink, RTCVideoSource/Sink, i420 helpers
  internal/
    native.ts             loads build/Release/wrtc.node (single place)
    native-types.ts       TypeScript types for the native contract
    webidl.ts             conversion helpers used by generated code
    generated/            output of scripts/gen-idl.mjs (committed)
    events.ts             Event subclasses
    ops-chain.ts          the RTCPeerConnection operations chain
    errors.ts             DOMException / RTCError helpers
dist/                     tsc output, gitignored (same depth as lib/, so the
                          relative path to build/Release/wrtc.node works from both)
src/                      native addon (C++)
scripts/gen-idl.mjs       @webref/idl -> lib/internal/generated/*.ts
lib/**/*.test.ts          unit tests, colocated with the module they test
test/
  native/                 native integration: the raw addon against libwebrtc
  integration/            library integration: the public API end to end
  compat/                 differential tests against @roamhq/wrtc
  wpt/                    vendored WPT subset, runner, expectations (M2)
```

### Testing layers (decided 2026-11-18)

| Layer | Where | What it covers |
|---|---|---|
| Unit | `lib/**/Foo.test.ts`, next to the code | One module in isolation: conversion and validation, state caching, ops chain, event ordering. Mostly without libwebrtc, using a small fake native where needed. Every public class and non-trivial internal module gets one. |
| Native integration | `test/native/` | The C++ addon against real libwebrtc, through the raw native API. |
| Library integration | `test/integration/` | The public API end to end in Node: the user's nonstandard sources and sinks across two PCs, worker termination, process exit. |
| Compat | `test/compat/` | Differential runs against `@roamhq/wrtc` in a separate process. |
| WPT (M2) | `test/wpt/` | Black-box conformance of the standard API. It's the guide for spec behaviour, but it doesn't cover the nonstandard API, Node lifecycles or wrtc compatibility. |

Policy (from the user, 2026-11-18): be pragmatic, with no tests that only
pad coverage. But good test hygiene is a requirement for every change from
now on: deterministic, isolated, specific, fast, and with cleanup. Details
are in `CONTRIBUTING-AGENTS.md` ("Be pragmatic" and "Test hygiene").

### Conventions (all WPs)
- **TypeScript, compiled with `tsc`.** Settings: `strict`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly` (no enums, namespaces or
  parameter properties) and `rewriteRelativeImportExtensions`, with relative
  imports written with `.ts` extensions. That way tests can run the `.ts`
  directly with Node's type stripping, while `dist/` gets `.js`. Output is
  ESM (`module`/`moduleResolution: nodenext`). No default exports.
- **Use Node's built-in `EventTarget`, `Event` and `DOMException`.**
  Standard (WebIDL) event subclasses expose their payload as the spec's
  attributes: getters on the prototype reading private fields (the brand
  check), made enumerable by the shape pass below. Reads and destructuring
  behave like wrtc's plain-object events; a spread, `Object.keys` or
  `JSON.stringify` don't (⚑, user decision 2026-11-21; "Events" in the
  wrtc compatibility spec). The nonstandard sinks' `data` and `frame`
  events aren't WebIDL and keep wrtc's own enumerable properties.
  `on<event>` attributes use one shared helper.
- **Native objects are private.** Hold each handle in an ECMAScript `#native`
  field. Classes are constructible only where the spec (or wrtc) allows;
  enforce that with an internal token.
- **WebIDL shape is applied centrally.** `lib/index.ts` runs
  `applyInterfaceShapes` (`lib/internal/interface-shape.ts`) over the
  exports, driven by `lib/internal/generated/interfaces.ts`: IDL members on
  the prototype become enumerable, operation and class `length`s follow the
  IDL, `on<event>` accessors get a brand check (the one the class passes to
  `registerInterface`, which every class with event handlers must call),
  promise-returning operations (static ones too) reject instead of
  throwing, and `@@toStringTag` is a data property. Write classes normally;
  don't redo any of that per class. A module that binds prototype methods at
  load (the `mediaDevices` singleton) calls `shapeInterface` on its class
  first. Every other member's brand check is its private-field read; a
  member that reads no private state (a getter that always returns null,
  say) starts with `this.#x;` so a foreign receiver throws TypeError.
  - Exception: `MediaDevices`' `getUserMedia`, `getDisplayMedia`,
    `enumerateDevices` and `getSupportedConstraints` stay lenient about
    `this`: Node code calls them detached (wrtc compatibility; see
    `lib/mediaDevices.ts`).
  - The classes' own `get [Symbol.toStringTag]()` getters are overwritten by
    the pass in the package; they only matter to tests that import a class
    module directly, without `lib/index.ts`.
  - `pnpm gen:idl` writes the shapes; `scripts/gen-idl.test.ts` fails with
    "run pnpm gen:idl" when a committed generated file is stale.
- **Spec semantics live in JS.** The native layer stays mechanical
  (`PLAN.md`, Decisions 4).
- **Threading rule for every native callback into JS:**
  `NonBlockingCall` on an unbounded TSFN queue. Never `BlockingCall`, never a
  bounded TSFN queue (a full one blocks or fails the producer). A sink may
  bound its own queue by dropping, as the video sink does (see
  `RTCVideoSink`). Sink callbacks run while libwebrtc holds the broadcaster's
  sink lock, and `RemoveSink` is a blocking proxy call (worker thread for
  video, signaling thread for audio; `pc/media_stream_track_proxy.h:37,58`).
  So any blocking delivery deadlocks against `stop()`. For local tracks the
  sink runs synchronously on the JS thread inside `onData`/`onFrame`, where a
  blocking call deadlocks on itself.
- **TSFN ref policy, stated per object:**
  - PC stream: ref'd until `close()` (already the case).
  - Sinks: ref'd until `stop()`, as in wrtc.
  - Tracks and sources: no TSFN.
- Tests use `node:test`. Every WP keeps `pnpm test` green on macOS. Native
  WPs also run the Linux Docker build and tests (`docker build --build-arg
  ... -t wrtc-linux-<wp>`; tags are per WP so parallel runs don't collide).

### Description snapshots (event atomicity)

The spec's set-description algorithm does all of this in **one task**, in
this order:
1. update the signaling state, descriptions and transceivers
   (`currentDirection`, `[[FiredDirection]]`)
2. fire `signalingstatechange`
3. process removed and muted tracks
4. fire every `track` event
5. resolve the promise

libwebrtc instead calls `OnSignalingChange`, `OnTrack` and `OnRemoveTrack`
during processing, as separate TSFN tasks, and its getters are live. WPT
checks this (`RTCPeerConnection-description-attributes-timing`,
`*-SLD-SRD-timing`). So:
- The completion op for `setLocalDescription` / `setRemoteDescription`
  carries a **snapshot**:
  - `signalingState`
  - all six descriptions
  - for every transceiver: its handle, `mid`, `direction`,
    `currentDirection`, `firedDirection`, `stopped` and `stopping`
- JS **buffers** the `signalingstatechange`, `track` and `removetrack` events
  that arrive while an SLD/SRD is in flight. When the completion arrives, it
  applies the snapshot and then dispatches in spec order, all in that one
  callback.
- JS caches every attribute and answers getters from the cache, never from
  live native reads. The cached local description's SDP is refreshed from
  `icecandidate` events.
- There is no native `currentDirection` change hook, and the snapshot makes
  one unnecessary.

## Native contract (target)

This is the interface between the native work and the JS work, typed in
`lib/internal/native-types.ts` (written in WP0). Change it only through the
coordinator.

All async PC methods resolve through the per-PC event stream, and every
PC's stream is delivered in one environment-wide order (wave 3C,
`EventOrder` in `src/event_sink.h`). Sinks have their own TSFN. Today's
surface is in `PLAN.md` ("Native API").

### Process-wide (`src/runtime.cc`)
- **Playout audio device.** `src/playout_adm.*` (in place of `kDummyAudio`;
  written clean-room from a behavioural spec). It pulls
  playout every 10 ms at 48 kHz mono via `NeedMorePlayData` and **never
  records**. A stall of up to 2 s is made up with back-to-back pulls; a
  longer one drops the backlog.
  - Without it, remote audio never reaches `RemoteAudioSource` sinks:
    `AudioDeviceDummy` has no playout thread.
  - `TestAudioDeviceModule` (which wrtc uses) isn't in libwebrtc's static
    library target.
- **Global track registry.** Native track wrappers are keyed by the libwebrtc
  track pointer, holding a `scoped_refptr`, across all PCs. The same libwebrtc
  track always maps to the same JS handle (needed for `sender.track` /
  `receiver.track` / `track` event identity).

### PeerConnection (extend)
- `config`:
  - standard: `iceServers`, `iceTransportPolicy`, `bundlePolicy`,
    `rtcpMuxPolicy`, `iceCandidatePoolSize`
  - nonstandard: `portRange {min, max}` (`port_allocator_config`, M2) and
    `sdpSemantics` (accept `"unified-plan"` only)
- `setConfiguration(config)`, `restartIce()`
- `createOffer({iceRestart})`, `createAnswer()`
- `setLocalDescription(desc?)` (no argument = the implicit overload,
  `api/peer_connection_interface.h:1055`) and `setRemoteDescription(desc)`,
  both resolving with the snapshot above
- `addIceCandidate(c)`. End-of-candidates has no libwebrtc API, so JS
  validates it against the remote description and resolves without a native
  call.
- `addTrack(track, streamIds[])` returns `{sender, transceiver}`.
  `removeTrack(sender)`.
- `addTransceiver(trackOrKind, {direction, streams, sendEncodings})` returns
  a transceiver. `getTransceivers()` returns stable handles.
- `getStats(selector?)` resolves to a JSON string (selector = sender or
  receiver; `api/peer_connection_interface.h:974,978`)
- `shouldFireNegotiationNeededEvent(eventId)`
  (`api/peer_connection_interface.h:1096`)
- `queueTask(id, next)` (added 2026-11-21): a `task` event (`id`) in the
  environment's one order, behind everything queued so far, or with `next`
  from an event's callback right after that event (FIFO among the `next`
  tasks that callback queues; ignored outside a callback, microtasks
  included). The JS layer's "queue a task" steps that must keep their place
  among native events use it.
- Events:
  - `track` (`receiver`, `transceiver`, `streamIds`)
  - `removetrack` (`receiver`, from `OnRemoveTrack`, `:1375`)
  - `receiver:unmute` (`receiver`, from the receiver's
    `RtpReceiverObserverInterface::OnFirstPacketReceivedAfterReceptiveChange`;
    `src/receiver_mute.cc`, added 2026-11-20 for remote track muting)
  - `icecandidateerror` (`address`, `port`, `url`, `errorCode`,
    `errorText`)
  - transports (`src/transport.*`, added 2026-11-20 for wave 2):
    `dtls:state`, `dtls:error` and `ice:state` name a per-PC transport key
    (`transport`), `sctp:state` its SCTP transport's key. SLD/SRD
    snapshots carry each transceiver's `senderTransport` and
    `receiverTransport` keys, `sctp` (`{key, transport}` or null) and the
    ICE roles (`iceRoles`). `ice:state` goes through the signaling thread;
    the rest is emitted as before.
  - `negotiationneeded` (`eventId`)

### Transceiver / Sender / Receiver
- **Stable identity:** a per-PC map keyed by pointer, holding a
  `scoped_refptr`, pruned when a transceiver is removed after stop.
  `GetTransceivers()` returns the same proxy objects, so pointer keys are
  valid.
- `Transceiver`: `mid`, `direction` (get/set via `SetDirectionWithError`),
  `currentDirection`, `stopped`, `stopping`, `stop()` (`StopStandard`),
  `sender`, `receiver`, `setCodecPreferences(codecs)`.
- `Sender`: `track`, `replaceTrack(track|null)`, `getParameters()`,
  `setParameters(p)` (`SetParametersAsync`), `setStreams(ids[])`,
  `getStats()`, `setDefaultDegradationPreference(p)` (send path: fills the
  preference only if unset, synchronously via a blocking signaling-thread
  call, with no result event; see "Video send path").
- `Receiver`: `track` (always present), `getParameters()`,
  `setJitterBufferMinimumDelay(seconds|null)` (wave 3B), `getStats()`.
- Static `getCapabilities(kind)` for both, from the factory.

### Media
- `Track` handle: `id`, `kind`, `enabled` (get/set). That's all.
  - libwebrtc has no proxied stop (`set_ended()` lives only on the concrete
    `MediaStreamTrack<T>`, `api/media_stream_track.h:42`).
  - wrtc has no mute/unmute/ended events.
  - So `readyState`, `muted` and `ended` are JS-side. No per-track TSFN:
    the one native mute signal (`receiver:unmute`) comes through the PC's
    event stream.
- `AudioSource`: a custom `Notifier<AudioSourceInterface>`. Its send
  streams register with `AudioState` as usual, but our playout device never
  records, so only pushed audio reaches the encoder.
  - `createTrack()` and `pushData(...)` fan out synchronously to the
    registered `AudioTrackSinkInterface`s, with no buffering, matching wrtc.
- `VideoSource({isScreencast, needsDenoising})`: a
  `VideoTrackSourceInterface` built like `AdaptedVideoTrackSource`
  (`media/base/adapted_video_track_source.h:36`), whose sink methods are
  private and so can't be subclassed for this.
  - `createTrack()` and `pushFrame(...)`; frames are timestamped with
    `webrtc::TimeMicros()`.
  - **Adapts for the encoders** (changed 2026-11-21; it used to never call
    `AdaptFrame`): libwebrtc's `VideoAdapter` over the senders' aggregated
    sink wants drops frames (frame rate) and crops and scales (libyuv box
    filter, from the pushed memory). Our own sinks are a separate group and
    get frames as pushed. See "Video send path" in the wrtc compatibility
    spec.
- `AudioSink(track, onData)`: `AddSink`. Delivers
  `{samples, bitsPerSample, sampleRate, channelCount, numberOfFrames}` with
  `samples` copied into a fresh buffer. `stop()` removes the sink and
  releases the TSFN. Every buffer is delivered, in order.
- `VideoSink(track, onFrame)`: delivers `{width, height, rotation, data}`,
  where `data` is tightly packed I420 (chroma stride `(w+1)/2`). Convert
  non-I420 buffers with `ToI420()`. At most 3 frames wait for the JS thread
  (oldest dropped); the read-only `framesDropped` counts the drops (added
  2026-11-22, see `RTCVideoSink`).
- Both sinks queue payloads in their own queue and keep at most one wake on
  the TSFN; each wake delivers the oldest payload and re-posts itself if more
  wait (`Delivery` in `src/media_sink.cc`).
- M2: `i420ToRgba` uses **libyuv `I420ToABGR`** (libyuv names are
  reversed relative to memory byte order, so the RGBA-named functions
  would scramble channels). `rgbaToI420` reproduces wrtc's libyuv
  `ABGRToI420` in our own loops (`src/yuv.cc`); see "`i420ToRgba` /
  `rgbaToI420`" in the compatibility spec for why.

## wrtc compatibility spec (M1 contract for the JS layer)

Taken from wrtc's sources (WonderInventions/node-webrtc 27d0b2b, verified by
the plan review and spot-checked by the coordinator). Items marked ⚑ were decided
by answered question 3; the accepted default is shown.

**Goal (user, 2026-11-22): drop-in, not total parity.** "Total wrtc
compatibility isn't the holy grail, we just want to make sure consumers can
drop this library in without having to change their code." Keep what code
can observe and rely on: API shapes, return values, error *types* and *when*
something throws or doesn't. Error *messages* are ours: clear and actionable,
not copied from wrtc (some of wrtc's are unhelpful, e.g. its missing-binary
failure). Don't reproduce wrtc quirks no consumer depends on.

**Error messages (2026-11-22).** Where this spec lists wrtc's validation, it
fixes the error type and the cases that throw, not the text. Our messages
name the API and the field, then say what was expected and what was given,
and how it is made up where that helps:
"RTCVideoSource.onFrame: frame.data has 1000 bytes, but a 640x480 I420 frame
needs 460800 (a 640x480 Y plane, then 320x240 U and V planes)",
"RTCAudioSource.onData: data.sampleRate must be a number from 0 to 65535, not
the string "48000"", "getUserMedia: constraints is missing: it must be an
object such as {audio: true, video: true}". The helpers are `mustBe()` and
`describe()` in `lib/internal/errors.ts` (a value is described by its type,
or a primitive by its value, cut to 40 characters; it never runs user code
or throws, and the nonstandard converters build a message only when they
throw it, after every member has been read, so messages can't change read
order or which error wins). WebIDL conversions
keep the Chrome-style messages (`lib/internal/webidl.ts`). The differential
tests in `test/compat` compare an error's name and whether a call threw,
never its message (`test/compat/errors.mjs`); the unit tests pin the text.
Checked 2026-11-22: no code in @whereby.com/assistant-sdk, core, media,
rtcstats or mediasoup-client matches on an error message from this API.
(media's `VegaRtcManager._restartIce` switches on `error.message`, but only
for the SFU's own "missing transportId" and "no such transport"; anything
else retries. The rest branch on `error.name`, for getUserMedia's
NotAllowedError and the like, or only log the message.)

### `RTCAudioSource`
- `new RTCAudioSource()`, `.createTrack()`, `.onData(data)`.
- `onData` validation throws a `TypeError` in the same cases as wrtc (the
  first failing member, in the order samples, bitsPerSample, sampleRate,
  channelCount, numberOfFrames; then these checks):
  - `bitsPerSample` must be 16.
  - `numberOfFrames`, if given, must equal `floor(sampleRate / 100)`. So
    20 ms frames throw.
  - The sample byte length must be `channelCount * numberOfFrames * 2`.
  - `sampleRate` is `uint16`.
- `samples` may be any TypedArray or ArrayBuffer. ⚑ wrtc reads the whole
  underlying ArrayBuffer from offset 0, ignoring `byteOffset`. Default:
  honour `byteOffset` (the wrtc behaviour only works by accident for
  offset-0 arrays, which is what conforming callers pass).

### `RTCAudioSink`
- `new RTCAudioSink(track)`, an EventTarget with `ondata`, `.stop()` and
  `.stopped`.
- The `data` event carries own properties `samples` (Int16Array, fresh
  buffer), `bitsPerSample`, `sampleRate`, `channelCount` and
  `numberOfFrames`.
- A sink on a **remote** track sees the mixer's format (48 kHz, 480 frames
  per event), not the sender's pushed format. A sink on a **local** track
  sees the pushed format. Tests must expect this.
- After `stop()`, events already queued are dropped (check `stopped` before
  dispatching). An unstopped sink keeps the process alive, until its
  track ends (below).
- **Lossless, with an unbounded queue** (as wrtc; kept so by user decision
  2026-11-22, when the video sink got its bound): however far the event
  loop falls behind, every buffer is delivered, in order, and waits in
  native memory until it is (about 1 kB per 10 ms of 48 kHz mono, so a
  stall costs little). Dropping audio would corrupt transcription and
  recording, which is what the user's workers do with it.
- **⚑ A sink stops itself when its track ends** (divergence, user request
  2026-11-21, found running the local-stack workers): by the track's own
  `stop()` (at once), or because its source ended, i.e. its transceiver
  stopped (locally or by a description) or its peer connection closed
  (after the track's `ended` event, in that task). `stopped` then reads
  true and the process can exit. A sink made on an ended track starts
  stopped. Applies to `RTCVideoSink` too, and only to sinks on that track
  (a clone has its own). wrtc keeps every sink, and the process, alive
  until `sink.stop()`, and keeps delivering a stopped local track's media;
  Chrome delivers nothing from an ended track. Where it releases sinks in
  practice (from its review): mediasoup-client's `Consumer.close()` (it
  calls `track.stop()` before renegotiating; the sink loses only the
  jitter-buffer tail), assistant-sdk's `AudioMixer` used directly via
  `/tools` (its `stopAudioMixer()` ends the mixed track), and stopped
  getUserMedia tracks. The `Assistant` itself stops its combined-audio
  sink before the mixer, so it isn't one of them. Internal hook: `whenEnded()` in
  `lib/MediaStreamTrack.ts` (sinks call their private stop: a subclass's
  `stop()` override may not be ready, e.g. in the constructor on an ended
  track; a throwing callback is reported without skipping the rest).
  Tested in the sink unit tests, `test/compat` (`mediaAfterTrackStop`) and
  `test/integration/sink-exit.ts` (remote sinks plus a local one ended by
  `stop()`; exits on its own, hangs without the change). Note:
  mediasoup-client can't close the first m-section, only set it inactive,
  but consumer close calls `track.stop()`, which now stops that sink too.

### `RTCVideoSource`
- `new RTCVideoSource({isScreencast = false, needsDenoising})`, with
  `.isScreencast` and `.needsDenoising` (**`null`** when unset).
- `.createTrack()`, `.onFrame({width, height, data})`.
- The size check is exact: `data.byteLength` must be
  `w*h + 2*((w+1)/2)*((h+1)/2)`, otherwise `TypeError`. A frame with a
  zero width or height is empty (its data must be too) whatever the sign of
  the other, and does nothing, as in wrtc; this package threw for `0 x -3`
  before 2026-11-22. Otherwise negative sizes and frames over 2^31 - 1
  bytes are TypeErrors, as they were in wrtc (except where its wrapped
  arithmetic crashed it; see "Sizes past wrtc's C `int` arithmetic" under
  the i420 helpers).
- ⚑ `rotation` is ignored in wrtc. Default: honour it (0/90/180/270). It's
  harmless for callers that don't set it, and the docs promise it.
- **⚑ Frames for senders are adapted (divergence, 2026-11-21; Chrome).**
  wrtc never adapts a pushed frame. Ours follows the encoder's sink wants
  as Chrome's sources do: `maxFramerate` drops frames, and
  `scaleResolutionDownTo` and CPU overload apply. Resolution adaptation
  (quality scaling) needs an explicit `degradationPreference`: video
  senders default to 'maintain-resolution' (⚑, user decision; Chrome
  defaults to 'maintain-framerate'). Sinks on the source's tracks still
  get every frame as pushed (within their queue bound; see
  `RTCVideoSink`). Details, the simulcast layer limits and the
  measurements: "Video send path" below.

### `RTCVideoSink`
- `new RTCVideoSink(track)`, an EventTarget with `onframe`, `.stop()` and
  `.stopped`.
- The `frame` event has own property `frame: {width, height, rotation,
  data}`, where **`data` is a `Uint8Array`** (not `Uint8ClampedArray`),
  tightly packed I420.
- `stop()` semantics are the same as for the audio sink.
- On a local track the pixels are never rotated and never adapted (since
  2026-11-21): the source keeps our sinks apart from its senders. Before,
  a sender to a peer that didn't negotiate CVO made the source rotate the
  pixels for every sink. wrtc never rotates or adapts.
- **⚑ At most 3 frames wait for the event loop; `framesDropped` counts
  the rest** (divergence and nonstandard addition, user decision
  2026-11-22, from a review of the production receive path). wrtc, and
  ours before, queued every frame until JS took it, so a stalled event
  loop (GC, CPU load, a slow handler) piled up frames in native memory
  without limit: 1080p30 is 93 MB a second. Now a frame that arrives while
  3 wait drops the oldest waiting one at once, releasing its buffer, and
  increments `framesDropped` (a read-only number on `RTCVideoSink`, not in
  wrtc; an atomic read in the native sink; frames discarded by `stop()`
  aren't counted). Latest frame wins, as in video pipelines.
  - Why 3: 100 ms at 30 fps, so a short GC pause or slow handler still
    loses nothing, and at most 9 MB per sink at 1080p (plus the frame
    being copied into JS). It also caps the decoder-pool buffers a sink
    holds by reference, which the old code capped at 3 by copying every
    later frame into a buffer of its own; now nothing is copied in
    `OnFrame`.
  - Frames that arrive are in order, each with its own rotation and size.
    On a local track, frames pushed within one task count too: push 5 in a
    row and the sink gets the last 3.
  - Measured (macOS arm64, a 2 s stall of the receiving thread with a
    remote 1080p30 track): RSS grew 123.5 MB before, 7.1 MB after, with
    57 of 60 frames dropped. Per-frame cost when JS keeps up is unchanged
    (720p local push to event: 45.6 µs median before and after).
  - Tests: `test/native/media.test.ts` (a stalled local sink keeps the
    newest 3, RSS stays bounded; audio never drops) and
    `test/integration/video-sink-stall.test.ts` (a remote track with the
    sender in a worker: a 500 ms stall drops the oldest frames, then
    delivery resumes in order; no drops at 720p30 while JS keeps up).
  - Not done: skipping the frame's copy into JS when nothing listens. The
    native side would need the listener count, which `EventTarget` doesn't
    expose (`once` and `signal` remove listeners invisibly), and the user's
    sinks always listen.

### `i420ToRgba` / `rgbaToI420` (M2)
Implemented 2026-11-22 (`lib/nonstandard/i420.ts`, `src/yuv.cc`). Checked
byte for byte against `@roamhq/wrtc` 0.10.0 on the same machine by
`test/compat/i420.test.ts` (macOS arm64, Linux arm64 in Docker, Linux x64
on gpubox).
- `i420ToRgba(i420, rgba)` and `rgbaToI420(rgba, i420)`, each frame
  `{width, height, data}`. Synchronous: they write into the destination's
  `data` and return `undefined`. I420 is tightly packed (chroma
  `ceil(w/2)` x `ceil(h/2)`), RGBA is R, G, B, A in memory.
- Colour: BT.601 limited range (Y 16..235 maps to 0..255); RGBA output
  alpha is 255, RGBA input alpha is ignored. A chroma sample averages its
  2x2 block (an odd last column or row averages 2 or 1 pixels).
- `i420ToRgba` is libyuv `I420ToABGR`; today's libyuv gives wrtc's bytes.
- **`rgbaToI420` chroma follows wrtc per architecture.** wrtc 0.10.0 is
  libwebrtc M106 (libyuv 1839), whose `ABGRToI420` chroma rounding
  differs by architecture: on arm, the rounded half sum of the 2x2 block
  times half coefficients, +0.5 (`RGB2xToU`); on x86, two rounding pair
  averages (vertical, then horizontal: `pavgb`) and full coefficients
  without the +0.5 (`LIBYUV_RGBTOU_TRUNCATE`). So wrtc's own output
  differs by one between its arm64 and x64 builds, in about a third of
  chroma samples (e.g. pure red's V is 240 on arm64, 239 on x64).
  Today's libyuv rounds differently again (a rounded average of 4), so
  `src/yuv.cc` has its own row loops reproducing the old ones for the
  architecture it's built for. Luma is the same everywhere. Per call at
  1280x720 / 1920x1080: 0.4 / 0.9 ms on an M-series Mac (libyuv's
  `ABGRToI420` 0.1 / 0.3 ms; the stats example's tuned JS 1.2 / 2.8 ms),
  0.9 / 2.1 ms on gpubox x64 (JS 3.3 / 7.5 ms). `i420ToRgba` (libyuv):
  0.19 / 0.43 ms on the Mac, 0.28 / 0.68 ms on gpubox (JS 2.6 / 5.9 and
  6.4 / 14.4 ms).
- **Validation (the same error type in the same cases as wrtc).** Both
  arguments are converted in full (getters read in order: width, height,
  data of the first, then the second), then the first failure throws a
  `TypeError`:
  - not an object;
  - `width`/`height` not an int32 number (truncated otherwise: 4.5 is 4,
    NaN is 0);
  - a negative width or height in a non-empty frame (below);
  - `data` not a TypedArray (any element type) or ArrayBuffer;
  - a size too large (below);
  - the wrong length: I420 as for `onFrame`, RGBA `w*h*4`.
  - A detached buffer (view or ArrayBuffer) reads as empty, as in wrtc
    (a length error for a real frame; an empty frame is accepted).
    The same holds for `onFrame` and `onData` (`bytes()` in
    `lib/nonstandard/convert.ts`). A view's overriding own `buffer`,
    `byteOffset` and `byteLength` properties are ignored, as in wrtc.
  - Then sizes that differ.
  - An empty frame (a zero width or height, whatever the sign of the
    other, with empty data) does nothing, as in wrtc.
- **Sizes past wrtc's C `int` arithmetic are "too large" (simplified
  2026-11-22).** wrtc computed the expected lengths in C `int` and
  converted them to size_t, so negative or overflowing sizes wrapped (and
  its RGBA product's overflow is undefined behaviour: its arm64 builds
  wrap `w*h` to 32 bits, x64 computes it exactly). We used to reproduce
  that per `process.arch` for its messages. Now (`frameError()` and
  `frameSize` in `lib/nonstandard/convert.ts`):
  - Any negative width or height of a non-empty frame is a TypeError.
    wrtc threw for most negative sizes too (no length matched), but
    accepted, and did nothing with, every negative size whose wrapped
    lengths happened to match the data: -1 x -1 with 1 byte of I420 and 4
    of RGBA, -3 x -1 with 3 and 12, and so on. The review's boundary grid
    found 134 calls that succeeded before this change and threw with its
    first version, all with a negative size in the i420 helpers; those
    with a zero other size are no-ops again (next point), the rest throw.
    A recorded divergence
    (`negativeWrapped` in `test/compat/i420.test.ts`); no real caller
    passes them.
  - The most plausible negative call, a frame with a zero width or height
    and a negative other size (`0 x -N` or `-N x 0`) with empty data, stays
    a no-op in the i420 helpers and becomes one in `onFrame`, as in wrtc
    (checked against @roamhq/wrtc 0.10.0; compat cases "zero by negative"
    in both scenarios). Chosen so that the likeliest accidental input, a
    computed size that went to zero and below, doesn't start throwing.
  - An I420 frame over 2^31 - 1 bytes, an RGBA frame over 2^31 - 1
    pixels, or a non-empty RGBA frame over 536870911 pixels wide (its row,
    `width * 4`, must fit libyuv's int stride) is "too large", whatever its
    data. Exactly there wrtc's arithmetic overflowed: it threw for every
    buffer except one matching the wrapped length, which it then overran
    and crashed on (2147483647 x 2147483647 with 4 bytes of RGBA and 1 of
    I420 on arm64), and it passed a too-wide row's overflowing stride to
    libyuv. So the outcome changes only where wrtc crashed. `onFrame` uses
    the same I420 rule.
  - The native side still re-checks every size (`src/yuv.cc`).
- ⚑ **A view's byteOffset and byteLength are honoured** (as for `onData`
  and `onFrame`). wrtc checks and converts the whole underlying buffer
  from offset 0.
- The native side re-checks every size and reads both frames' getters
  before taking either data pointer, so no call can touch memory outside
  the views.

### `MediaStreamTrack` (as used with these)
- **⚑ `muted` (divergence, decided by the user 2026-11-20: match the spec
  and Chrome).** wrtc's tracks are never muted and fire no `mute` /
  `unmute`. Ours, for a receiver's track (and its clones; local tracks
  stay unmuted):
  - It starts muted (webrtc-pc "create an RTCRtpReceiver"), so it is muted
    in the `track` event.
  - It unmutes, with `unmute`, on the first RTP packet after its
    transceiver's [[Receptive]] became true (webrtc-pc §"MediaStreamTrack"
    in "MediaStream API Extensions for Network Use"). The signal is
    libwebrtc's `OnFirstPacketReceivedAfterReceptiveChange`, which is what
    Chrome unmutes on (`rtc_rtp_receiver_impl.cc`); it re-arms each time
    [[Receptive]] goes false and true again, so a track muted by
    renegotiation unmutes again once media resumes, not before. It arrives
    through the PC's event stream (`receiver:unmute`) and isn't held back
    during an SLD/SRD, so it keeps its order relative to them.
  - It mutes, with `mute`, when an SLD, SRD or rollback takes its
    [[FiredDirection]] from sendrecv/recvonly to anything else ("process
    the removal of a remote track"), and was unmuted. The event fires in
    that description's completion task, after `signalingstatechange` and
    before stream `removetrack`/`addtrack`, `track`, and the promise's
    resolution (webrtc-pc "set the session description"; Chrome's
    `DidModifyTransceivers` does the same).
  - Clones follow the receiver's track, each firing its own event (Chrome
    keeps the muted state on the source). An ended track never changes.
  - **Not done, as in Chrome:** muting on an RTCP BYE (the spec's MUST;
    libwebrtc surfaces no BYE, and Chrome fails WPT's two BYE subtests,
    `remote-track-mute`'s `transceiver.stop()` and `pc.close()` ones) or
    on a media timeout (Chrome's video frame monitor is disabled by
    default, `kMediaStreamTrackEmptyVideoFrameMonitor`). A video sender
    whose track is null still sends padding, which unmutes, as in Chrome.
  - A local `transceiver.stop()` doesn't mute (the track ends, below). A
    remote offer that rejects the m-section (the other side stopped it)
    mutes in its task and then ends the track (webrtc-pc processes a
    rejected m-section as direction inactive before stopping the
    transceiver).
  - Sinks are unaffected: muting is JS state only, and an
    `RTCAudioSink`/`RTCVideoSink` gets whatever media arrives, muted or not
    (including one attached in the `track` event, before the first packet).
  - Checked: @whereby.com/core, media, assistant-sdk and mediasoup-client
    don't handle mute/unmute; rtcstats only reads `track.muted`.
  - `test/compat/nonstandard.test.ts` asserts the divergence (muted in
    `ontrack`: wrtc false, ours true; both false once ours unmutes).
- **⚑ `ended` on receiver tracks (divergence, coordinator decision
  2026-11-20, following the user's "match Chrome").** wrtc ends a
  receiver's track synchronously and fires nothing. Ours ends it, and
  every live clone, in a queued task (`setImmediate`), each with an
  `ended` event, when:
  - its transceiver stops locally (`transceiver.stop()`; webrtc-pc "stop
    sending and receiving" with disappear false, which ends the track;
    Media Capture's "ended" runs in a queued task, so `readyState` is still
    "live" right after `stop()`, as WPT `RTCRtpTransceiver-stopping`
    checks);
  - a description stops it (a rejected m-section) or removes it (a
    rollback that drops its transceiver): the event comes after the
    SLD/SRD promise resolves;
  - its peer connection closes. webrtc-pc's `close()` runs "close the
    connection" with disappear **false**, which stops every transceiver and
    so ends their tracks with events (disappear true, without events, is
    only for document unload). "No events after close" applies to the
    connection's own events, not the tracks'.
  - A track the app already stopped fires nothing (its `stop()` set
    "ended" first, and the queued task does nothing to an ended track).
    `track.stop()` itself never fires `ended`, as in the spec.
  - Chrome ends a remotely stopped or rolled-back track before the SRD
    resolves (it fails those two WPT `RTCRtpTransceiver-stopping`
    subtests); ours follows the spec there. Locally stopped, both queue it.
  - Consumers (checked by the coordinator): @whereby.com/assistant-sdk's
    AudioMixer detaches a remote audio track on `ended` (so this fixes it);
    mediasoup-client 3.19's Consumer removes its `ended` listener before
    closing, so its own close doesn't double-fire.
  - Sinks: a sink on an ended receiver track gets no media (libwebrtc
    stopped receiving), so it stops itself once the source ends (see the
    `RTCAudioSink` entry); one created afterwards starts stopped.
  - `test/compat` asserts it: `nonstandard.test.ts` (readyState right after
    `close()` and the `ended` count) and `two-pc-media.test.ts` (`ended` on
    stop and close; readyState right after `close()`). A task later both
    implementations read "ended".
- ⚑ `stop()`: wrtc only flags the wrapper, and media keeps flowing to
  senders and sinks. Ours: **match wrtc for senders** (set `readyState` to
  `"ended"`; a sender keeps sending), but the track's sinks stop (since
  2026-11-21; see "A sink stops itself when its track ends").

### `getUserMedia` (M2)
Implemented 2026-11-20 (`lib/mediaDevices.ts`, `lib/internal/synthetic-media.ts`).
wrtc's behaviour was probed against `@roamhq/wrtc` 0.10.0 on macOS arm64;
`test/compat/getusermedia.test.ts` checks every item below against it.

- **Validation (matches wrtc).** Both `getUserMedia` and
  `mediaDevices.getUserMedia` always return a promise; they never throw.
  - A non-object (no argument, `undefined`, `null`, a string, number or
    boolean) rejects with a `TypeError`. A function counts as an object.
  - If both `audio` and `video` are `undefined`, it rejects with a
    `TypeError`.
  - Otherwise each truthy member gets a track, audio first. So
    `{audio: false, video: false}` and `{audio: null}` resolve with an empty
    stream (the spec would reject), `{audio: 'x'}` gives audio, and
    `{audio: 0, video: 1}` gives video.
  - A throwing getter on the constraints rejects with what it throws.
- **Constraint objects are ignored (matches wrtc).** `width`, `height`,
  `frameRate`, `facingMode`, `sampleRate`, `channelCount`, `deviceId`
  (even `{exact: 'bogus'}`), `min` values nothing can meet, and `advanced`
  all resolve with the same fixed tracks. There is no
  `OverconstrainedError`. We don't honour `width`/`height`/`frameRate`
  either: `getSettings()` stays truthful and the same for every track.
- **Settings (match wrtc).** `getSettings()` gives, as for every track:
  - audio: `deviceId: "FakeAudioDevice"`, `groupId: "FakeDeviceGroup"`,
    AGC, EC and NS false, mono, 48 kHz, 16-bit, `latency: 0`,
    `volume: 0.25`
  - video: `deviceId: "FakeVideoDevice"`, 640x480, `aspectRatio` 4/3,
    30 fps, `facingMode: "user"`
  - wrtc has no `getCapabilities()`/`getConstraints()`; ours return `{}`.
- **Tracks and streams (match wrtc).**
  - Ids are UUIDs, tracks start live, enabled and unmuted, and the stream
    is active.
  - `clone()` gives a live track with a new id.
  - `stop()` only flags the track: the stream stays active while another
    track is live, and `enabled` keeps its value.
- **⚑ Content (divergence).** wrtc's tracks carry nothing. Local sinks get
  no events in a second. Over a connected PC its gUM senders sent 0
  packets in 3 s, while a nonstandard video track on the same PC sent 91
  frames. Ours carry:
  - 48 kHz mono **digital silence** in 10 ms chunks
  - a **still 640x480 frame of 75% colour bars** (BT.601 limited range:
    white, yellow, cyan, green, magenta, red, blue, black; 80 px each)
    at 30 fps

  That's the formats `getSettings()` reports. Silence decodes to silence
  at a remote sink, and the bars survive VP8 to within a few luma levels.
  Kept by the user's decision (2026-11-20). In a meeting, the other
  participants see the bars whenever the worker's gUM camera is on.
- **The generator.**
  - It is one shared clock: an unref'd 10 ms interval that counts what's
    due since each source started, so the rate doesn't drift with late
    timers. After a stall it catches up by at most 50 ms of audio and one
    video frame.
  - It never keeps the process alive.
  - Each gUM call gets its own sources. Each source runs until every track
    on it (clones and `stream.clone()`s included) has ended or been
    garbage-collected (a `FinalizationRegistry`).
    - Everything that consumes a track holds its JS wrapper while it does:
      senders, streams, and `RTCAudioSink`/`RTCVideoSink` until `stop()`.
      So a collected wrapper is unused.
    - The source's stop callback must not reference the native track: the
      wrapper map would then keep the wrapper alive for good.
    - Measured with 50 gUM audio+video pairs dropped without `stop()`:
      before, 100 feeds kept running at 9.7% of a core; now they're
      collected and stop.
  - Cost on an M-series Mac, with nothing consuming the tracks:
    - The first source costs about 0.85% of one core, mostly the shared
      10 ms clock.
    - Each further audio+video pair costs about 0.14%, mostly the native
      460 KB copy of each video frame, 30 times a second.
    - Skipping that work while nothing consumes the track would need a
      native "has sinks" query, which the contract doesn't have. So would
      pushing one shared immutable frame instead of copying it. Neither is
      done: either would change the native contract and invalidate the
      prebuilt binaries, and a consumed track's encoder costs far more.
  - A feed whose push throws is caught on its own: it neither crashes the
    process nor starves the other feeds. The first failure emits a process
    warning.
- **⚑ `label` (divergence).** wrtc's is `undefined`. Ours is
  "Fake audio device" or "Fake video device", the same labels
  `enumerateDevices` lists, so code that maps a track's label back to its
  device (as `@whereby.com/media` does) finds it. Clones keep it. A
  receiver's track is "remote audio" or "remote video" (see "Media and
  RTP" below). Other tracks keep `""`.
- **Exit (matches wrtc).** Live gUM tracks keep neither process alive. As
  usual, wrtc's process sometimes segfaults on its way out.
- **`mediaDevices`.**
  - wrtc's prototype has `enumerateDevices`, `getSupportedConstraints`,
    `getDisplayMedia` and `getUserMedia`. Its
    `mediaDevices.getUserMedia === getUserMedia`.
  - **`getSupportedConstraints` (matches wrtc):** a fresh
    `{width: true, height: true}` on each call, though neither
    implementation honours those constraints.
  - **`getDisplayMedia` (matches wrtc):** it is `getUserMedia` under
    another name: the same validation, the same fake devices and settings.
    `{audio: true}` gives an audio track.
  - **Divergence:** ours binds every method (the four above and the
    listener methods) to each instance, so they work when copied off it,
    as assistant-sdk's polyfills do. So `mediaDevices.getUserMedia` is not
    `=== getUserMedia`.
- **⚑ `enumerateDevices` (divergence).** wrtc throws `Error` "Not yet
  implemented; file a feature request against node-webrtc", synchronously.
  Ours resolves with a fresh list on each call: an `audioinput`
  (`FakeAudioDevice`) and a `videoinput` (`FakeVideoDevice`), both in
  `groupId` `FakeDeviceGroup`, matching the gUM tracks' settings and
  labels.
  - The entries are `MediaDeviceInfo` objects (exported; not
    constructible; getters plus `toJSON()` in the spec's member order).
  - The labels are non-empty, since Node has no permission prompt to hide
    them behind.
  - No `audiooutput` is listed.
- **With `@whereby.com/core` (checked offline, no room).**
  - `startMedia({audio: true, video: true})` and the camera re-enable path
    both call our gUM, with `{facingMode: "user", height: {min: 360,
    ideal: 720}, frameRate: 30, aspectRatio: 16/9}` for video. That is
    ignored, so the track is 640x480.
  - Given a stream instead, core enumerates devices only on `devicechange`.
    Until then its device list is empty and re-enabling the camera drops
    video without calling gUM, with either package.
- **CommonJS (matches wrtc's shape).** `require()` of the built package
  (Node 24's `require(esm)`) exposes `getUserMedia`, `mediaDevices`, the
  classes and `nonstandard` as wrtc's `require()` does, plus `default`.
  `test/integration/commonjs.test.ts` builds `dist/` into a temporary
  `node_modules` and checks this. It requires that no module in the
  package uses top-level `await`.

### `RTCPeerConnection` (divergences found by WPT, WP-W)
- **Rollback of the other side's offer (divergence).** wrtc accepts
  `setLocalDescription({type: 'rollback'})` in `have-remote-offer` and
  `setRemoteDescription({type: 'rollback'})` in `have-local-offer`, rolling
  back the other side's offer; so does libwebrtc itself. Ours rejects both
  with `InvalidStateError` before reaching libwebrtc, because:
  - JSEP (RFC 8829) defines a rollback as discarding the offer that side
    made: a local rollback applies only in `have-local-offer`, a remote one
    only in `have-remote-offer`;
  - WPT requires it (`RTCPeerConnection-setLocalDescription-rollback.html`,
    `RTCPeerConnection-setRemoteDescription-rollback.html?rest`);
  - Chrome rejects both.

  Code that rolls back its own offer is unaffected, including perfect
  negotiation's polite peer (explicit or implicit rollback). See
  `validStates` in `lib/RTCPeerConnection.ts`.
- **Remote TCP candidates aimed at a Fetch "bad port" are ignored
  (divergence).** webrtc-pc requires connections to the Fetch bad port list
  to be prohibited, silently (`RTCPeerConnection-addTcpIceCandidate.html`).
  libwebrtc itself drops only ports below 1024 other than 80 and 443, for
  every protocol; Chrome blocks the rest in its network service, which an
  embedder doesn't have. wrtc doesn't filter them.
  - Ours removes such `a=candidate` lines from a remote description before
    libwebrtc sees it, so they are missing from `remoteDescription`,
    `pendingRemoteDescription` and `currentRemoteDescription`.
    `addIceCandidate()` validates one as usual, then resolves without
    passing it on or adding it to the remote description. Chrome keeps them
    in the SDP and blocks only the connection.
  - Only TCP candidates that we would connect to: UDP is untouched (media
    servers use ports on the list, e.g. mediasoup's range from 10000), and
    so are `tcptype active` candidates (port 9 by convention). The check
    is exactly as lenient as libwebrtc's parser (probed shape by shape):
    whatever it accepts on a bad port is blocked, and whatever it rejects
    still goes to it and rejects as before.
  - See `lib/internal/blocked-ports.ts`.
- **Events of different peer connections reach JS in the order libwebrtc
  reported them (wave 3C).** Each PC's events were already in order; across
  PCs in one process (or worker) the order was whichever PC's queue libuv
  polled first. Now all of an environment's PCs share one FIFO, as a
  browser's event loop does (`EventOrder`, `src/event_sink.h`): for example,
  a data channel message never reaches the receiver before the sender's
  `bufferedAmount` has dropped for it. Each event is still its own task.
  - Peers in different processes see no change. In one process
    (mediasoup-client's send and recv transports) only the interleaving of
    two PCs' events changes, to libwebrtc's.
  - Op completions (createOffer, SLD/SRD, getStats, ...) are in the same
    order: they are `op` events, each its own TSFN call settled in its own
    callback scope, so an awaited native promise's continuation runs in
    its completion's task, before the next event of any PC
    (`test/native/event-order.test.ts`).
  - The JS layer's own "queue a task" steps go into that order too
    (`queueTask(id, next)`, added 2026-11-21), where a `setImmediate` ran
    before native events libwebrtc had queued earlier and after later ones
    delivered in the same poll phase:
    - A gathering completion's second task (`iceGatheringState` 'complete'
      and the null candidate) is queued `next`: it runs right after the
      first, before any later event or op completion of any PC. Until
      2026-11-21 it was a `setImmediate` that only a later native event ran
      first, so another PC's op completion could still resolve ahead of
      it (the "accepted gap" 3C's review recorded).
    - getParameters()'s `[[LastReturnedParameters]]` clear is queued
      behind what is already queued, so `setParameters-encodings`'
      "getParameters, then sLD(unicast answer) interrupted by a simulcast
      setParameters results in unicast" passes (as in Chromium 159).
    - Still `setImmediate`s, not yet observed to matter: the
      negotiationneeded check when the operations chain empties, a
      description's held-back transport closes, replaceTrack's
      `[[SenderTrack]]` task and the `ended` of a track whose source
      ended.
  - wrtc reads `bufferedAmount` live from libwebrtc, so it never had this
    case; its own events have no cross-PC order either.
  - WPT: the `bufferedAmount` flakes are gone (30 of 30 in 12 runs of the
    data channel group), and `setParameters-encodings`' "Success task for
    setRemoteDescription(offer) clears [[LastReturnedParameters]]" passes
    (Chromium 159 fails it).
  - **Not an ordering gap:** `RTCIceTransport.html?rest`'s two "transition
    to 'disconnected' if packets stop flowing" subtests, recorded flaky on
    Linux as op completions overtaking events, fail because libwebrtc
    reports pc1's ICE 'checking' before it applies pc1's
    setRemoteDescription(answer): pc2 starts checks as soon as its own
    answer is set, and a check that reaches pc1 first makes a
    peer-reflexive pair, so pc1's iceconnectionstatechange 'checking' is
    queued ahead of the SRD's signalingstatechange and completion. JS
    delivers that order faithfully, and sharing the order changed nothing
    (2026-11-21, Linux arm64 Docker on an otherwise idle host: 20 of 56
    subtest runs failed on the base, 24 of 56 with `queueTask`; a probe of
    the steps, 7 of 240 and 8 of 240; macOS: 0 of 30 in WPT under CPU
    load either way, the probe about 1 in 30 under heavy load). Chromium's
    mDNS host candidates delay pc2's first check, which is presumably why
    it doesn't see this. Fixing it would mean holding back a real
    libwebrtc report, so it stays recorded as flaky on Linux.
  - **Accepted gap:** a PC's event can now run under another PC's TSFN
    async resource, so `executionAsyncId()` in an event callback may name
    the other PC's. AsyncLocalStorage is unaffected (its store is undefined
    in event callbacks before and after this change); only async_hooks-based
    tooling would notice.
- **`send()` of a message over `pc.sctp.maxMessageSize` throws a TypeError
  (divergence; matches Chrome; WP-D).** Checked again in wave 3C: Chromium
  159 throws the same TypeError (its text: "Trying to send message larger
  than max-message-size") and the channel stays open. wrtc doesn't throw;
  libwebrtc then closes the channel (PLAN.md "Gotchas"). WPT's 5 MiB
  unordered-mode subtest sends more than the 256 KiB limit (its TODO says
  so) and fails in both.

### `RTCRtpSender` / `RTCRtpReceiver` (divergences found by WPT idlharness)
- **⚑ No H264 or H265 (divergence on Linux; user decision 2026-11-22).**
  Video is VP8, VP9 and AV1 on every platform: `getCapabilities('video')`,
  offers and answers never list H264 or H265, `setCodecPreferences` with an
  H264 codec throws InvalidModificationError, and an H264-only remote offer
  gets its video m-line rejected. wrtc on Linux offers and decodes H264, and
  this package did until now; **wrtc users on Linux lose H264.** On macOS
  nothing changes (no H264 there before either). mediasoup-client 3.19
  (Safari12 handler) and Whereby negotiate VP8/VP9 and never require H264
  (checked 2026-11-22: Whereby core sets `h264On: false`; its H264
  prioritization only reorders a codec that is present, and
  `deprioritizeH264` leaves an m-line without H264 alone). See PLAN.md
  Gotchas, "No H264 or H265", and `test/integration/h264.test.ts`; WPT's
  H264 subtests fail everywhere with the reason "H264 is not built in (no
  H264, by decision)".
- **`getCapabilities()` with no argument throws TypeError (divergence).**
  WebIDL overload resolution requires the argument. wrtc (and this package
  before the WebIDL shape work) returned null. `getCapabilities(undefined)`
  still returns null, as the spec's string conversion gives `"undefined"`,
  an unknown kind.
- **`replaceTrack()` with no argument rejects with TypeError (matches
  wrtc).** The package used to resolve it like `replaceTrack(null)`; wrtc
  rejects ("Expected an object"), as does the spec. `replaceTrack(null)`
  and `replaceTrack(undefined)` still clear the track.
- **`getSynchronizationSources()` and `getContributingSources()` report
  libwebrtc's sources (matches wrtc, except as below; wave 3C).** This
  package returned `[]` until now. Both read libwebrtc's `GetSources()`
  (the SSRCs or CSRCs with a packet in the last 10 s; a blocking call to
  the worker thread, as `getParameters()` is). Divergences from wrtc:
  - `timestamp` is Performance time (`performance.timeOrigin +
    performance.now()` when the last packet arrived), as webrtc-pc and
    Chrome say; wrtc gives libwebrtc's monotonic milliseconds.
  - They add `rtpTimestamp` and, for audio with RFC 6464 levels, a linear
    `audioLevel` (127 dBov is 0), which wrtc leaves out.
  - Not done: `captureTimestamp` and `senderCaptureTimeOffset` (the
    abs-capture-time extension).

  mediasoup-client 3.19 and Whereby never call them. See
  `Receiver::GetSources` in `src/rtp.cc` and `#sources` in
  `lib/RTCRtpReceiver.ts`.

### RTP parameters (divergences found by WPT)
Kept by the coordinator after review (2026-11-20): a mediasoup-client and
Whereby-flow comparison with main encoded every layer identically
(simulcast 4/2/1 and 2/1 with Safari12 and Chrome111, `setMaxSpatialLayer`,
`setRtpEncodingParameters`, the `maxBitrate` round trip, VP9 SVC), and so
did AV1 SVC, compared directly between two of our peer connections rather
than through mediasoup.
mediasoup-client reads only `rid` and `active` from the encodings it gets
back. See `lib/internal/rtp-parameters.ts` and `lib/RTCRtpSender.ts`.
- **Video encodings show `scaleResolutionDownBy` (divergence).** wrtc
  omits it unless it was set. Ours shows libwebrtc's own default, which is
  the spec's: 2^(n-1-i) over the layers the sender was created with (a
  layer a remote description removed still counts), or 1 for an encoding
  without one when another has one.
  - Passed back to `setParameters()` unchanged, these defaults are dropped
    again, so libwebrtc keeps applying its default rather than explicit
    values. Explicit 4/2/1 would change the layering when the input is too
    small for every layer (`test/integration/parameters.test.ts`).
  - Caveat: in that case the shown defaults are not what libwebrtc
    encodes. libwebrtc sends fewer layers, scaled relative to the ones it
    sends: three layers at 640x360 show 4/2/1 but encode 320 and 640 wide.
  - Caveat: setting exactly the default values is indistinguishable from
    leaving them unset; both keep libwebrtc's default.
  - Removing every scale from a simulcast sender's encodings keeps
    libwebrtc's pyramid; the spec sets each missing one to 1. (With one
    encoding, or when another encoding has a scale, the two agree.)
- **Same-task `transactionId` (divergence).** Calls to `getParameters()`
  in the same task return the same parameters and `transactionId`
  ([[LastReturnedParameters]]); wrtc returns a new one each call. They go
  stale a task later, or as soon as a native result (an applied
  description, a created offer, stats) is delivered.
- **The same parameters set twice now succeeds (divergence).** Two
  `setParameters(p)` calls with one `getParameters()` result in the same
  task both apply; wrtc rejects the second with `InvalidModificationError`.
  A `setParameters()` racing a description that narrows the simulcast
  envelope also succeeds, applying to the layers that remain (matched by
  rid).
- **Codecs (divergence).** A sender's `codecs` are the current remote
  description's m-section codecs, in its order, and a receiver's the
  current local description's, minus codecs libwebrtc lacks and their RTX.
  So they are there for `recvonly` and `inactive` transceivers too. wrtc
  reports libwebrtc's list, only for a stream it is sending or receiving
  (and formats `sdpFmtpLine` differently).
- **Audio drops `scaleResolutionDownBy` and `maxFramerate` (divergence).**
  `getParameters()` never shows them on audio, and `setParameters()`
  ignores them, even invalid values (the spec).
- **A receiver's `rtcp.cname` is omitted (matches wrtc).** This package
  used to report `""`.

### Transports (WPT fix wave 2, gap C)
Checked against `@roamhq/wrtc` 0.10.0 and Chromium 159 (Playwright). See
`lib/internal/transports.ts`, `lib/RTCIceTransport.ts` and
`src/transport.*`. mediasoup-client 3.19 (all handlers) and
`@whereby.com/core`/`media`/`rtcstats` never read `transport`, `sctp`,
`iceTransport` or `getSelectedCandidatePair` (checked 2026-11-20); the
connection-level states they do read are unchanged.
- **`sender`/`receiver.transport` (matches wrtc).** This package returned
  null until now; wrtc never did. Both: null until a description sets one;
  from the local offer on, one `RTCDtlsTransport` per libwebrtc transport,
  shared by everything BUNDLEd on it (data channels included) and kept
  through renegotiation and ICE restarts; a remote offer sets none (the
  spec, and Chrome); the objects stay reachable after `close()`, 'closed'.
  A rollback (explicit, or the implicit one of glare) restores the last
  stable state's transports (the spec's `[[LastStableStateSenderTransport]]`)
  rather than what libwebrtc's senders point at.
- **`pc.sctp` from the offer (matches wrtc and Chrome).** It used to appear
  with the answer (WP-D). It is libwebrtc's SCTP transport: created by an
  offer, local or remote, that negotiates data channels, gone after a
  rollback to a state without one, and a new object when libwebrtc replaces
  it (an answer BUNDLEing the data channels onto another transport).
  `maxMessageSize` is 65536 until the answer, as WPT expects (Chrome: null).
- **`RTCIceTransport.role` is 'unknown' until an answer or pranswer using
  the transport is applied (divergence; WPT).** wrtc reports libwebrtc's
  role from the offer on; Chrome reports null.
- **The candidate getters work (divergence).** wrtc throws "Not yet
  implemented!" from `getSelectedCandidatePair()`, `getLocalCandidates()`,
  `getRemoteCandidates()`, `getLocalParameters()` and
  `getRemoteParameters()`.
  - The selected pair is an `RTCIceCandidatePair` (exported, not
    constructible), the same object until it changes (Chrome returns a new
    dictionary each call); a peer-reflexive remote candidate has
    `candidate` '' and `address`/`relatedAddress` null (webrtc-pc, WPT).
  - Candidates and parameters are read from the local and remote
    descriptions' m-section of the transport (the spec's definition): no
    peer-reflexive remote ones. Chrome's lists only what it gathered, and
    returns null parameters.
- **ICE and DTLS state timing (matches Chrome; diverges from webrtc-pc,
  which fires the transport's `statechange` before the connection's
  events).** An ICE transport's state is libwebrtc's for that transport;
  its reports pass through the signaling thread, so they follow the
  `iceconnectionstatechange` they cause. With one open ICE transport in
  libwebrtc (everything BUNDLEd) the transport takes on its new state with
  the connection's event, firing after it, so each reads the other's new
  state, as in Chrome. It only ever takes on a state libwebrtc has it in or
  is about to report: the event carries every watched transport's state
  (one blocking call to the network thread per change), and the
  connection's 'completed' is never taken on (libwebrtc's ICE transports
  are never 'completed'; the connection's comes from another aggregate).
  DTLS reports arrive directly, before `connectionstatechange` (which waits
  for them with one blocking call to the network thread).
  `selectedcandidatepairchange` fires before a `statechange` in the same
  report (webrtc-pc; Chrome fires them in separate tasks, pair first).
- **`gatheringState`** goes to 'gathering' with the connection's
  `iceGatheringState` (the transport's event first), or with libwebrtc's own
  report for a transport a later description added while the connection
  was gathering already; it goes to 'complete' with the connection's.
  **Not done:** a rollback doesn't reset it to 'new', and a transport a
  description adds after the connection's gathering completed stays 'new'
  until the connection gathers again.
- **A transport dropped by a description (bundled away, rolled back)
  closes a task after the SLD/SRD resolves** (WPT); Chrome closes its DTLS
  transport before, and never closes its ICE transport.
- **DTLS 'failed' fires only `statechange` (matches wrtc and Chrome; wave
  3C).** Wave 2C fired `error` (errorDetail 'dtls-failure') first, as
  webrtc-pc asks. Chromium 159 and wrtc fire none (probed with a
  fingerprint mismatch: both sides reach 'failed'), and libwebrtc never
  reports the cause, so the 'fingerprint-failure' WPT wants was never
  possible. `error` still fires if libwebrtc's `DtlsTransportObserver`
  reports one (m150 never does). Nothing in mediasoup-client or Whereby
  listens for it.
- **`srtpCipher` uses the IANA names (divergence; matches Chrome; wave
  3C).** libwebrtc m150, and wrtc, report `AES_CM_128_HMAC_SHA1_80` (and
  `AEAD_AES_128_GCM`, ...); later libwebrtc, and so Chromium 159, reports
  `SRTP_AES128_CM_HMAC_SHA1_80` (`SRTP_AEAD_AES_128_GCM`, ...), which WPT
  expects. `statsReportFromJson()` renames them. Whereby's code only has
  it in sample fixtures; `@whereby.com/rtcstats` uploads it as is.
- **Not done:**
  - **ICE roles after an ICE restart the answerer offers.** m150 doesn't
    re-determine roles (its `redetermine_role_on_ice_restart` is unused):
    the old offerer sets itself controlled when it applies the answer, the
    restarting side stays controlled, and the role conflict's tie-breaker
    settles it (ours read 'controlled' on both in WPT; after a second, the
    original roles again in one probe). Chromium 159's newer libwebrtc
    swaps them (stats `iceRole`); WPT wants them kept. Its
    `RTCIceTransport.role` is null, so it fails that subtest too, as does
    wrtc. The API can't set roles, so it stays.
  - Remote-candidate stats show a peer-reflexive address as "" (Chromium
    159 does too).
  - **A DTLS handover to a second answerer can stall** (WPT
    `protocol/handover*`): after the offerer's ICE restart, the new
    answerer's first connectivity check can reach the offerer before its
    trickled candidate does. The offerer then has a peer-reflexive pair to
    it, which libwebrtc prunes at once in favour of the old answerer's
    host pair (still writable, since the old answerer still answers checks
    from the offerer's new candidates). Its pruning compares candidate
    priority before ICE generation (`BasicIceController::PruneConnections`),
    and a pruned pair is never checked again. So the offerer's ICE stays
    on the old answerer, and the new DTLS handshake never completes or
    fails. With both peers in one process the check always wins that
    race. Delivering the new answerer's candidates first makes it pass
    (verified). Chromium 159 passes `handover-datachannel` and
    `handover-media`'s single-transport subtests, presumably because its
    mDNS host candidates delay the new answerer's first check. A fix in
    our layer would mean dropping the old remote candidates on the
    restart, which would break the RFC 8445 behaviour of keeping the old
    pair until the new one works, for every ICE restart (Whereby's P2P
    restarts ICE). Production never hands over to another peer.

### Transceiver lifecycle and rollback (WPT fix wave, gap E)
Checked against `@roamhq/wrtc` 0.10.0 and Chromium 159 (Playwright), each
scenario run identically in all three. JS only (`#applyTransceivers`,
`#fireTrack` and `addTrack` in `lib/RTCPeerConnection.ts`); the native
contract is unchanged. Production check (2026-11-20, read-only):
- mediasoup-client 3.19 (Safari12 and Chrome111 handlers) calls
  `transceiver.stop()` in `stopSending()`, but reads `transceiver.mid`
  before it. It finds transceivers by `mid` within `getTransceivers()`,
  which never held removed ones. It never rolls back and never listens
  for `track`.
- Whereby's P2P manager never calls `stop()` or rolls back. It only uses
  `removeTrack()`, so its offers carry no rejected m-sections. It filters
  `getTransceivers()` by kind or direction, never by position. Its
  `ontrack` keys on `streams[0]`, and emits `STREAM_ADDED` once per
  stream id.
- `@whereby.com/rtcstats` only traces `track` events.

The entries:
- **A removed transceiver reads stopped and dissociated (matches wrtc and
  Chrome).** This covers a transceiver stopped and then negotiated away,
  and one created by a remote offer that was rolled back. It now reads
  `mid` null, `direction` and `currentDirection` 'stopped', and `stopped`
  true. This package used to keep its last `mid` and directions.
  `getTransceivers()`, `getSenders()` and `getReceivers()` already left it
  out.
- **No `track` event for a remote offer's rejected (port 0) m-section
  (divergence; webrtc-pc and Chrome).** libwebrtc reports `OnTrack` for
  one, and wrtc fires the event, with an ended track. The transceiver is
  still created, already stopped, and the answer removes it.
  - Unchanged, and the same in all three: an m-section that arrives
    `inactive` (or `recvonly` from the remote side) fires no `track`. A
    re-offer that rejects an m-section already received on fires none
    either.
  - In practice only a port-0 section that still says it sends (WPT's
    `ontrack` test writes `a=sendonly` with an ssrc) fired one. Chrome,
    libwebrtc and mediasoup-client 3.19 (`MediaSection.close()`) write a
    rejected section as `a=inactive` (Chrome and libwebrtc with no msid or
    ssrc; mediasoup-client drops the ssrcs but keeps the msid). libwebrtc fires
    no `OnTrack` for that, so wrtc fires nothing either (probed with an
    offer from Chrome after `stop()`).
  - Whereby's peers never stop transceivers. A rejected m-section carries
    no media, so no usable track is lost.
- **`getTransceivers()` is in the order JS first saw each transceiver
  (divergence; matches Chrome and webrtc-pc).** wrtc uses libwebrtc's
  order. The two differ only when `addTrack()`/`addTransceiver()` runs
  while a remote offer that creates transceivers is in flight. libwebrtc
  applies that offer first, while the spec creates the offer's
  transceivers when it completes.
- **`addTrack()` while a remote offer is in flight reuses the transceiver
  that offer created (matches wrtc and Chrome).** This package used to
  add a second transceiver, and so an extra m-line in the next offer. It
  applies only when the spec's own pick finds nothing.
- **A `direction` set, or a `stop()`, while an SLD/SRD is in flight is
  kept (matches wrtc, whose getters are live).** It used to be overwritten
  by the completion's older snapshot. Descriptions now only change
  `direction` by stopping the transceiver, and stopping never reverts.
- **Not done:**
  - ~~No `track` event when a description only changes a receiving
    transceiver's remote streams.~~ Done in wave 3B: see "Media and RTP".
  - **A stopped sender's `getStats()` is empty from `stop()` on, not only
    after renegotiation.** Chrome does the same, and fails that
    `RTCRtpSender-getStats` subtest too.

### Certificates (WPT fix wave, gap G)
Checked against `@roamhq/wrtc` 0.10.0 and Chromium 159 (Playwright), each
call run identically in all three. See `lib/RTCCertificate.ts`,
`convertConfiguration` and `setConfiguration` in `lib/RTCPeerConnection.ts`,
and `src/certificate.*`. A certificate crosses the native boundary as PEM
(no native handle); a PC parses it back (`RTCCertificate::FromPEM`, about
0.03 ms) only when constructed with one.

Production check (2026-11-20, read-only):
- mediasoup-client 3.19 and `@whereby.com/core`/`media` never pass
  `certificates` and never call `generateCertificate`.
- `@whereby.com/rtcstats` 5.4.2 defines a forwarding getter for
  `generateCertificate` on its wrapper when the static exists, which it now
  does. It never calls it. Ours doesn't use `this`, so a detached call works.
- mediasoup-client's `updateIceServers()` passes `getConfiguration()` back to
  `setConfiguration()`. That keeps working: the certificates are the same
  objects, or `[]`.
- Without certificates, libwebrtc gets exactly the configuration it got
  before. It generates its default ECDSA P-256 certificate asynchronously,
  as always, with no added work at construction.

The entries:
- **`RTCPeerConnection.generateCertificate()` and `RTCCertificate` exist
  (divergence).** wrtc has neither, so feature detection now finds them.
  - Supported: ECDSA P-256, and RSASSA-PKCS1-v1_5 with SHA-256 at 1024 to
    8192 bits (libwebrtc's `KeyParams::IsValid`: the exponent must also
    exceed the modulus length). `expires` is in ms; libwebrtc caps it at a
    year, and the default is 30 days. `expires` reads in whole seconds.
  - One `getFingerprints()` entry, sha-256 in lower case, which is the
    fingerprint libwebrtc writes into SDP.
  - Errors are Chrome's: TypeError for a malformed dictionary,
    NotSupportedError for an unknown name or unsupported parameters.
  - Chrome's rules where they differ from webrtc-pc: `expires` must be a
    number (the spec's conversion also takes `'5000'` or `null`), and an
    `expires` that is present but `undefined` is a TypeError.
  - An even RSA public exponent (e.g. `[1, 0, 2]`) passes the key-parameter
    checks, then fails in BoringSSL. Ours rejects with OperationError
    "certificate generation failed"; Chrome rejects with `undefined`.
  - Keys are made on Node's libuv threadpool, which is shared with `fs`,
    `dns.lookup` and `zlib`. RSA-2048 takes about 0.1 s and RSA-4096 up
    to about a second on an M-series Mac; RSA-8192 took about 5 s in
    Chrome. Each holds a pool thread that long. A pending generation keeps
    the process alive, and `worker.terminate()` waits for it.
- **`certificates` entries must be `RTCCertificate`s (divergence; Chrome).**
  wrtc accepts any objects (`[{}]`) and ignores them. Ours throws a
  TypeError, as it did before this wave ("not implemented"). A non-array
  value and `[null]` are TypeErrors in both.
- **The certificates are used (divergence).** wrtc ignores them, so its
  fingerprint is always that of a certificate it generated itself. Ours uses
  the first one, as libwebrtc and Chrome do. The others stay in the
  configuration but are unused.
- **An expired certificate throws InvalidAccessError at construction**
  ("Expired certificate(s).", as Chrome, wherever it is in the list).
  `setConfiguration()` doesn't check expiry; neither does Chrome.
- **`getConfiguration().certificates` (divergence).** wrtc has no
  `certificates` member. Ours returns the list the PC was constructed with,
  as the same objects (the spec; Chrome returns new wrappers each call), or
  `[]` as before.
- **`setConfiguration()` can't change the certificates (divergence;
  Chrome).** On a PC constructed with certificates, only the same objects
  in the same order pass. A reordered or partial list, `[]`, or leaving the
  member out is InvalidModificationError, as in Chrome, where libwebrtc
  compares them. On a PC constructed without certificates, any non-empty
  list is InvalidModificationError. wrtc ignores the member.
- **Not done:**
  - Only the first certificate is used, so WPT's "fingerprint of all
    provided certificates" fails. It fails in Chrome too.
  - `RTCCertificate` isn't serializable: there is no `postMessage` here.
  - Other WebCrypto algorithms reject with NotSupportedError without their
    parameters being checked. Chrome checks them first, so a malformed one
    is a TypeError there.

### Media and RTP (WPT fix wave 3B)
Checked against `@roamhq/wrtc` 0.10.0 and Chromium 159 (Playwright), each
scenario run identically in all three. See `#applySnapshot` and
`#applyTransceivers` in `lib/RTCPeerConnection.ts`, `lib/RTCRtpReceiver.ts`
and `Receiver::SetJitterBufferMinimumDelay` in `src/rtp.cc`.

Production check (2026-11-21, read-only):
- mediasoup-client 3.19 never listens for `track`, `addstream` or
  `removestream`, and never reads a remote track's `label` or
  `jitterBufferTarget`. Run against a fake server (consume, close,
  consume on a recycled m-line, pause/resume, a two-consumer batch, then
  30 close+consume cycles), its Chrome111 and Safari12 recv transports got
  38 `track` events before this wave and 38 after, phase by phase. The one
  extra `track` after the first close, in both, is mediasoup-client's
  `probator` consumer.
- Whereby's P2P manager emits STREAM_ADDED once per stream id from
  `ontrack`, and updates its video track id per stream. A Whereby-style
  flow between two of our PCs got the same `track` and STREAM_ADDED counts
  before and after, phase by phase: addTrack with one shared stream, three
  unchanged renegotiations, one the other way, an ICE restart,
  replaceTrack, and screenshare added, removed and re-added. So did an
  msid-less remote offer applied three times (one stream, one `track`).
  Whereby never calls `setStreams()`.
- `@whereby.com/rtcstats` traces `addstream` and `removestream` with
  `addEventListener`, so its trace now has `onaddstream`/`onremovestream`
  lines, as it does in Chrome. Nothing else in `@whereby.com/core`, `media`
  or `assistant-sdk` reads them. rtcstats dumps `label` only for
  getUserMedia streams.
- **Reachable behaviour changes (from the review):**
  - Whereby sets `jitterBufferTarget`, so that entry below changes what
    its received media does when its flag is on.
  - A `Session.replaceTrack` racing a `removeTrack` now leaves the new
    track on the sender (see the replaceTrack entry).
  - Both are listed under their entries.

The entries:
- **`track` fires when a description only adds a remote stream
  (divergence; Chrome and webrtc-pc).** An SRD or a rollback, local or
  remote, fires `track` for a transceiver that isn't stopped, receives,
  and either didn't receive before ([[FiredDirection]]) or gained a remote
  stream (Chrome's `DidModifyTransceivers`). libwebrtc's `OnTrack`, which
  wrtc follows, covers only the first. Examples are the remote side's
  `setStreams()` and a rollback that restores the previous msid.
  - Losing a stream, or keeping the same ones, fires nothing.
  - An SLD still fires only what `OnTrack` reports. Chrome fires `track`
    for an SRD or rollback only.
  - The events come in the snapshot's transceiver order.
  - The sequences were compared with Chromium 159 step by step: the first
    offer, an unchanged renegotiation, `setStreams(s2)`, its rollback, and
    `setStreams(s1, s2)`.
- **`addstream` and `removestream` events (divergence; Chrome).** wrtc has
  neither. As in Chrome, they compare the remote streams of the
  transceivers whose `direction` receives (Chrome's `getRemoteStreams()`)
  before and after an SLD, SRD or rollback. They fire after the streams'
  `removetrack`/`addtrack` and before `track`, `addstream` first.
  - The event is a `MediaStreamEvent` with `stream` an enumerable
    prototype getter, as in Chrome (an own property until 2026-11-21;
    "Events" below). The class isn't exported, since wrtc has none.
  - **Listeners only:** there is no `onaddstream`/`onremovestream`
    attribute. webrtc-pc's historical list says they must not exist (WPT
    `historical.html`, which Chrome fails), and leaving them out keeps
    feature detection reading as it does with wrtc.
  - Chrome's `addStream`, `removeStream`, `getLocalStreams` and
    `getRemoteStreams` aren't added either.
  - A paused mediasoup consumer shows how this works. Its receiver's
    streams are cleared when it stops receiving. Its `direction` is
    already 'inactive', so that fires nothing. Resuming fires `addstream`,
    as in Chrome.
- **A receiver's track `label` is "remote audio" or "remote video"
  (divergence; the spec and Chrome).** wrtc's is `undefined`, and ours
  used to be `""`. Ours is set from the receiver's creation, before
  negotiation too, and clones keep it.
  - The `id` is unchanged: the sender's msid track id (or a random one for
    a transceiver created locally), the same as Chrome's.
  - `test/compat/two-pc-media.test.ts` asserts it.
- **`replaceTrack()` then `removeTrack()` in the same task leaves the new
  track (divergence; the spec and Chrome).** wrtc's `sender.track` reads
  `null`. Ours is set in replaceTrack's queued step even though
  `removeTrack()` cleared it, as the spec says and Chrome shows.
  - The queued step asks the native sender for its track and sets it again
    if it differs, so the cached track stays what libwebrtc sends. Until
    renegotiation that track is sent. It compares with libwebrtc's track,
    not the cached one. `removeTrack()` then `addTrack()` of the old track
    (reusing a never-negotiated sender) ends where it started, and the
    cache alone would miss it (fixed after review; base had the same gap).
  - mediasoup-client's `stopSending()` does `replaceTrack(null)` and then
    `removeTrack()`, which ends with `null` either way.
  - **Whereby (race only):** if `Session.replaceTrack` is still in flight
    when `removeStream()` runs `removeTrack(sender)`, the sender keeps the
    new track, as in Chrome. A later `addTrack()` of that track then
    throws InvalidAccessError (it already has a sender), where it used to
    succeed.
- **`setLocalDescription()` with another connection's DTLS fingerprint is
  InvalidModificationError (matches wrtc's error name; Chrome).** This is
  Chrome's `FingerprintMismatch()`. The SDP is rejected before libwebrtc
  sees it when its first `a=fingerprint` line isn't the one in the last
  created offer (for an answer or pranswer, the last created answer).
  - SDP without a fingerprint, and every other munge, still goes to
    libwebrtc.
  - **SDP the connection produced itself is rejected too** when no offer
    (or answer) of that type was created with `createOffer()` /
    `createAnswer()`. An example is `setLocalDescription(pc.localDescription)`
    after a parameterless SLD, whose offer libwebrtc made. Chromium 159
    rejects that with InvalidModificationError too. Before, libwebrtc
    accepted it (checked on 8cb6130). wrtc can't get there: its
    parameterless `setLocalDescription()` throws TypeError "Expected an
    object". mediasoup-client and Whereby always pass a description from
    `createOffer()`/`createAnswer()`.
  - libwebrtc rejected such SDP anyway, as an OperationError that left the
    connection in a session error state where every later `createOffer()`
    failed. wrtc rejects it with InvalidModificationError.
  - Our signaling-state check comes first; Chrome checks the fingerprint
    first. Only a description wrong in both ways gets a different error.
- **`jitterBufferTarget` reaches libwebrtc (divergence).** wrtc 0.10
  accepts and reads back the value, and its WPT stats subtest fails. Ours
  passes `ms / 1000` to libwebrtc's `SetJitterBufferMinimumDelay`, and
  `null` restores libwebrtc's default, as in Chrome.
  - The validation is the spec's, as before: 0 to 4000 ms, RangeError, the
    last valid value kept.
  - The call blocks on the worker thread, as `getParameters()` does.
    libwebrtc keeps a value set before the receiver has media.
  - Setting it still works after `close()`, as in Chrome, and reads back.
  - **Whereby:** behind its `increaseIncomingMediaBufferOn` flag it sets
    400 ms (`MEDIA_JITTER_BUFFER_TARGET`) on every P2P receiver
    (`P2pRtcManager.ts:529`) and every mediasoup consumer's receiver
    (`VegaRtcManager/index.ts:2286`). That was a no-op. It now adds a
    400 ms minimum playout delay to received media, including what
    `RTCAudioSink`/`RTCVideoSink` get, as in Chrome. Its legacy
    `playoutDelayHint` stays a plain expando with no effect.
- **Not done (each fails in Chromium 159 too, unless noted):**
  - Remote track ids are the same on every PC (the sender's msid id).
  - `setParameters()` with `codecs` undefined is a TypeError, as in
    Chrome. The spec's IDL makes `codecs` required; WPT still expects
    InvalidModificationError.
  - The AV1 `profile` asymmetry: libwebrtc's codec check compares every
    fmtp parameter.
  - A simulcast receiver's `headerExtensions` is empty before media
    arrives.
  - Opus stereo: our getUserMedia is mono and ignores `channelCount`
    (wrtc parity). Chrome gets past that and fails at the remote channel
    count.
  - An audio sender's `dtmf` is null: DTMF is out of scope. Chrome passes
    this one.

### ICE and configuration (WPT fix wave 3A)
Checked against `@roamhq/wrtc` 0.10.0 and Chromium 159 (Playwright), each
scenario run identically in all three; Chrome's behaviour was also read in
Blink's source. JS only (`copyConfiguration` in `lib/RTCPeerConnection.ts`,
`chromeIceConnectionState`/`chromeIceTransportState` in
`lib/internal/transports.ts`); the native contract is unchanged.

Production check (2026-11-21, read-only):
- mediasoup-client 3.19 (Safari12 and Chrome111):
  - `updateIceServers()` takes `getConfiguration()`, replaces `iceServers`
    and passes it to `setConfiguration()`. Verified with mediasoup 3.32.2
    and both handlers: three `updateIceServers()` per transport, our
    normalised output passed back to `setConfiguration()`, a server and
    client `restartIce()`, and data before and after.
  - `restartIce()` uses `createOffer({iceRestart: true})` (send) or a
    remote offer (recv), never `pc.restartIce()`. It sets
    `iceTransportPolicy` only at construction.
  - It watches `connectionState` (and `iceConnectionState` only where
    `connectionState` is missing), and re-emits `icecandidateerror`.
- Whereby (`@whereby.com/media`, `core`, `assistant-sdk`):
  - Never calls `getConfiguration()`, `setConfiguration()` or
    `restartIce()`. `iceServers` come from the signal server; `useOnlyTURN`
    sets `iceTransportPolicy: 'relay'` at construction.
  - The P2P manager treats `connected` and `completed` alike, and ignores
    `negotiationneeded` while `iceConnectionState` is 'new'. It restarts
    ICE (`createOffer({iceRestart: true})`, offerer only) when 'failed'
    arrives, or when 'disconnected' lasts `ICE_RESTART_DELAY` (2 s).
    `connectionState` 'failed' sets its failed status and the
    network-blocked analytics. Its comments note that Chrome never reports
    'failed' and that a Chrome answerer never reports 'completed'.
  - The SFU path goes through mediasoup-client (`updateIceServers()`,
    `restartIce()`, transport `connectionState`).
- `@whereby.com/rtcstats` reads only the constructor's configuration and
  traces the state events.

The entries:
- **`getConfiguration().iceServers` (divergence; Chrome, and the spec for
  `urls`).** Each server's `urls` is always a list (the spec's "set a
  configuration" makes a string one), and `username` and `credential`
  are always present, `''` when not given, as Chrome returns them. wrtc
  returns each server as given.
- **A TURN server with an empty `username` or `credential` is rejected
  (matches wrtc and Chrome; WPT expects it accepted).** libwebrtc's parser
  rejects it with InvalidAccessError ("ICE server parsing failed: TURN
  server with empty username or password"). Blink passes the empty strings
  through and Chrome 159 throws the same error. wrtc throws too, so no
  input wrtc accepted is rejected.
- **`iceConnectionState` is never 'failed' or 'completed', and
  `RTCIceTransport.state` is never 'failed' (divergence; Chrome).**
  - Blink remaps an ICE transport's 'failed' to 'disconnected'
    (`RTCIceTransport::OnStateChanged`, crbug.com/957487). It then
    computes `iceConnectionState` from its transports
    (`ComputeIceConnectionState`), and no libwebrtc ICE transport is
    ever 'completed'.
  - So ours maps libwebrtc's states: the connection's 'failed' reads
    'disconnected' and 'completed' reads 'connected', and a repeated state
    fires nothing. Each ICE transport's 'failed' reads 'disconnected'.
  - `connectionState` is libwebrtc's, unchanged, and still goes to
    'failed', as in Chrome.
  - libwebrtc reports 'failed' once every candidate pair has timed out
    (about 15 s without an answer), without the end of remote candidates
    the spec's 'failed' also needs.
  - Observed in Chromium 159 and ours: a candidate that never answers
    gives `iceConnectionState` checking → disconnected and
    `connectionState` connecting → failed. wrtc gives 'failed' for both.
    A controlling offerer now stays 'connected' where wrtc and this
    package went on to 'completed'. An ICE restart after such a failure
    still goes to 'checking' (from a connection that was once connected,
    libwebrtc goes on reading 'disconnected'; see "Not done").
  - In Whereby's P2P manager this is the path it takes in Chrome. The
    reviewer measured its handlers, base vs this change:
    - **Never connected, offerer.** Base: FAILED and an immediate ICE
      restart at +15.0 s. Now: DISCONNECTED then FAILED (from
      `connectionState`) in the same tick at +15.0 s, and the restart at
      +17.0 s, 2 s after 'disconnected', as in Chrome.
    - **Peer dies mid-call, offerer.** The restart stays at +7.7 s (2 s
      after 'disconnected' at +5.7 s), and FAILED stays at +22.8 s, now
      from `connectionState`. What goes away: the queued second restart,
      `numIceFailed`, and the duplicate `P2PLocalNetworkFailed` /
      `CONNECTION_BLOCKED_BY_NETWORK`.
    - **Answerer.** It never restarts; FAILED timing is unchanged.
    - **mediasoup-client** reads `connectionState` only, so it is
      unaffected.
  - Known differences from Chrome, already on base (not from this
    change):
    - With unbundled transports and a dead peer, ours goes to 'failed'
      at about 5 s; Chrome goes to 'disconnected' at about 6 s and
      'failed' at about 16 s. This is libwebrtc's own behaviour, and
      matches Chrome with BUNDLE.
    - With several transports the event order differs: ours fires
      `iceconnectionstatechange`, `connectionstatechange`, then the
      transports' `statechange` (T1, T0); Chrome fires the connection's
      ICE event, T1, `connectionstatechange`, then T0.
    - With two transports, both still read 'new' inside the connection's
      'checking' event.
- **`icecandidateerror` without a local port has `address` and `port`
  null (divergence; Chrome and the spec).** libwebrtc reports `''` and 0
  for a TURN-over-TCP connection that failed. Chrome's handler nulls both,
  and wrtc passes them through.
- **Not done (libwebrtc; Chromium 159 fails each the same way):**
  - `restartIce()` before the first negotiation fires
    `negotiationneeded`. wrtc does too. libwebrtc's
    `CheckIfNegotiationIsNeeded()` returns true while there is no current
    local description, which isn't a spec step.
  - A "partial ICE restart" with `max-compat` restarts nothing. That
    policy still offers BUNDLE and the answer accepts it, so the re-offer's
    new credentials on the second m-section belong to no transport.
    libwebrtc answers with the old ones; wrtc does the same.
  - After an ICE restart from 'disconnected', the state goes straight to
    'connected', with no 'checking'. libwebrtc never resets
    `has_been_writable_`, so an unwritable transport that was once
    writable reads 'disconnected' until a new pair works.
  - Changing `iceTransportPolicy` to 'relay' prompts an ICE restart, but
    the previous generation's pair keeps working, so neither side fails.
    WPT waits for `iceConnectionState` 'failed', which Chrome (and now
    ours) never reports, so the test times out in both.
  - `icecandidateerror`'s `url` is libwebrtc's. A UDP TURN server's URL
    gains `?transport=udp`. A TURN server also reports its STUN errors as
    `stun:<host>:<port>`. WPT expects the URLs as configured.
- **Environment (macOS, not a bug):** `addTcpIceCandidate`'s two port-8001
  subtests fail while something listens on port 8001. Here that is the
  Whereby local stack's API server (`*:8001`). The TCP connect succeeds
  and the STUN check is never answered, so ICE stays 'checking' past the
  test's 1 s; Chromium 159 fails them too. With nothing listening, the
  connect is refused and ICE fails in about 100 ms (port 8002 here; Linux
  passes). The VPN interfaces blamed before weren't the cause.

### Video send path (2026-11-21)
Why: Whereby's assistant-sdk sends video from `nonstandard.RTCVideoSource`
through mediasoup-client 3.19's Safari12 handler with simulcast
(`VIDEO_SETTINGS_HD`), and its customers push many sizes. Checked against
`@roamhq/wrtc` 0.10.0 (own process) and Chromium 159 (Playwright, a canvas
`captureStream()` track), each scenario run identically in all three, two
PCs in one process or page. See `PushedVideoSource` in
`src/media_source.cc`, `src/video_encoder_factory.cc`, and
`test/integration/video-send.test.ts`.

The entries:
- **⚑ The source adapts frames for its senders (divergence; Chrome).**
  `PushedVideoSource` runs libwebrtc's `VideoAdapter` over the senders'
  aggregated sink wants, as `AdaptedVideoTrackSource` and Chrome's
  `WebRtcVideoTrackSource` do. It drops frames for the frame rate and
  centre-crops and scales (libyuv box filter) for max/target pixels,
  alignment and requested resolution. Before, it never called
  `AdaptFrame`, so every want was ignored. wrtc ignores them too. What the
  encoder asks for depends on the sender's degradation preference, whose
  default is ours (next entry).
  - `maxFramerate` is honoured. One encoding at 640x480, 30 fps pushed:
    `maxFramerate` 10 encoded 10 fps and 5 encoded 4.3 to 5 (Chrome
    9.3 to 9.7 and 4.7 to 5; before, and wrtc, 30). `sendEncodings`
    `maxFramerate` 10: ours and Chromium 10 fps, wrtc 30. wrtc's
    `setParameters()` rejects the change (InvalidStateError).
  - `scaleResolutionDownBy` and `scaleResolutionDownTo` apply, and CPU
    overload lowers the frame rate (or, with a preference that allows it,
    the resolution).
  - `isScreencast` maps as in Chrome (libwebrtc does it from
    `is_screencast()`): content type screen and no quality scaling, so the
    resolution holds under any preference (tested). A 1280x720 screencast
    with a 200 kbps start stays 1280x720 in ours and in Chromium (with
    `contentHint` 'detail').
  - **Our sinks are kept apart**: an `RTCVideoSink` on the source's track
    gets every frame as pushed (as a local preview in Chrome, and as
    before). The adapter `VideoSinkAdapter` registers itself
    (`SetUnadaptedVideoSink`); everything else is a sender.
  - Rotation is applied per group, so a sender to a peer without CVO no
    longer rotates the pixels our sinks see.
  - Cost: with nothing asked for, one copy per frame, as before. A scaled
    frame is scaled straight from the pushed memory, and the full-size
    copy is only made if a sink of ours or an unscaled sender needs it.
- **⚑ Video senders default to `degradationPreference`
  'maintain-resolution' (divergence from Chrome; user decision
  2026-11-21, matching wrtc and the base).** Chrome's and libwebrtc's
  default for a camera-like track is 'maintain-framerate', under which a
  single, non-screencast layer starts small even with plenty of bandwidth
  and steps up only as quality allows. Measured over 40 s in an
  unconstrained loopback, single-layer VP8 at 30 fps, 1 s samples: ours
  under 'maintain-framerate' (libwebrtc's default, which this branch used
  before the decision) against Chromium 159 (Playwright, canvas `captureStream()`,
  contentHint '', with and without its field-trial testing config, which
  gave the same) and the base:

  | pushed, content | ours with Chrome's default | Chromium 159 | base (and ours now) |
  |---|---|---|---|
  | 1280x720, hard (textured) | 320x180@30, about 600 kbps, for all 40 s | the same, 610 kbps | 1280x720@20, 2.5 Mbps |
  | 1280x720, easy (panning ramp) | 320x180, 480x270 by 5 s, 640x360 by 9 s, 960x540 by 13 s, 1280x720 at 21 s | the same, step for step | 1280x720@30 from the start |
  | 640x480, hard | 480x360@30 from 2 to 40 s, 1.7 Mbps | the same | 640x480@30 |
  | 640x480, easy | 640x480@30 | the same | 640x480@30 |

  Nothing of ours makes it stick: libwebrtc caps a single layer by size
  (`GetMaxDefaultVideoBitrateKbps`: 2.5 Mbps at 720p, 1.7 Mbps at VGA),
  hard content keeps QP over the quality scaler's threshold at that rate,
  and the initial frame dropper starts it low when the first frame meets
  a start estimate under 300 kbps (500 kbps above VGA). The user chose
  to keep the pushed size instead:
  - `RTCRtpSender` sets it when a video sender reaches JS (`addTrack`,
    `addTransceiver`, or the description that created its transceiver),
    through native `setDefaultDegradationPreference()`: one
    signaling-thread task that fills in an unset preference, with no
    result event. libwebrtc keeps it in the init parameters until the
    sender has an SSRC, and keeps it across `replaceTrack()` (tested with a
    remote offer's transceiver given a track that way). Every local video
    track here is a `PushedVideoSource` (RTCVideoSource, and getUserMedia's
    synthetic source); a forwarded remote track's source never adapts
    anyway, so all video senders get it.
  - `getParameters()` doesn't show it, as Chrome shows no
    `degradationPreference` until the app sets one; one the app set is
    shown. `setParameters()` without one goes back to the default, so
    wrtc-era `getParameters()` → `setParameters()` round trips
    (mediasoup-client's layer switching, Whereby's P2P `maxBitrate`) keep
    it and pass the transaction checks as before. Audio is untouched.
  - `setParameters({..., degradationPreference: 'maintain-framerate'})`
    opts into Chrome's behaviour. 'balanced' adapts too, and also lowers
    the frame rate: hard 1280x720 ran at 320x180@10 in ours and in
    Chromium alike. Leaving it out again goes back to the default
    (tested).
  - Simulcast is unaffected in practice: quality scaling and the initial
    frame dropper only act on a single active layer, and bandwidth drops
    layers. Whereby's camera through Safari12 matches the base per layer
    (table below). Under CPU overload a simulcast sender now drops frames
    rather than encoding late.
  - Under a 300 kbps cap a single 1280x720 layer goes back to the base's
    behaviour (720p at a few fps); with 'balanced' it keeps the frame rate
    at 960x540 (table below).
  - **Whereby P2P** (read-only check of `@whereby.com/media`): `Session`
    sends camera video with `addTrack()`, one layer, no `sendEncodings`,
    and never sets `degradationPreference`; it caps `maxBitrate` with a
    `getParameters()`/`setParameters()` round trip
    (`setVideoBandwidthUsingSetParameters`: unlimited with one peer, 384
    kbps with two, down to 64 kbps with seven). An assistant sending
    video in a P2P room therefore sends the pushed size. With one peer
    that is the full size and rate; with more, the cap makes it drop frame
    rate
    rather than resolution, where a Chrome participant's camera would
    shrink instead. Set 'maintain-framerate' for Chrome's trade-off. Neither mediasoup-client
    3.19 nor Whereby sets `degradationPreference` anywhere.
- **⚑ Every video encoder goes through `SimulcastEncoderAdapter`
  (divergence; Chrome).** `CreateBuiltinVideoEncoderFactory()` isn't in
  libwebrtc's static library target (upstream's or the current
  prebuilt's), and the bare template factory had
  no fallback when a codec can't do the requested simulcast in one encoder
  (InitEncode's ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED). The adapter passes
  through to the codec's own simulcast or single layer, and otherwise runs
  one encoder per layer. wrtc's builtin factory has the adapter, so this
  is also wrtc parity: wrtc encodes 15/10/5 fps per layer from
  `sendEncodings`, which ours sent as single-layer VP9 before.
  - AV1 simulcast with `scalabilityMode` (two rids, L1T1 or L1T3, 640x480)
    encoded nothing (every `Encode()` failed, -7); now both layers, as in
    Chromium. `encoderImplementation` reads "SimulcastEncoderAdapter
    (libaom, libaom)".
  - VP8 simulcast with a different `maxFramerate` per layer (WPT
    `simulcast/setParameters-maxFramerate`'s 15/10/5) made libvpx refuse
    and libwebrtc switch the sender to **VP9 with one layer**; now 14.7/10/5
    fps on three VP8 layers (Chromium 15/10/5).
  - Unchanged: VP8 simulcast with one frame rate still uses libvpx's own
    simulcast ("libvpx"); one active layer of several is encoded alone, as
    in Chrome.
- **Simulcast layers are limited by the source size (libwebrtc, as in
  Chrome; documented, not changed).** `LimitSimulcastLayerCount`
  (`video/config/simulcast.cc`, the `kSimulcastFormats` tables, applied
  unless the `WebRTC-LegacySimulcastLayerLimit` field trial is Disabled)
  caps the layers by the pushed frame's pixel count, rounding up within
  10% of the next size up:

  | pushed size | layers (VP8/H264; VP9/AV1 the same here) |
  |---|---|
  | more than 489,600 px: 960x540 (exactly 518,400), 1280x720, 1920x1080 | 3 |
  | more than 122,400 px: 480x270, 640x360, 640x480, 900x506 | 2 |
  | 122,400 px or fewer: 320x240, 321x241, 160x120 | 1 |

  The first encodings are kept. With explicit `scaleResolutionDownBy`
  4/2/1, a 640x480 source sends 160x120 and 320x240, and its full-size
  layer is never sent (Chromium 159 alike at 640x360, 640x480, 900x506,
  960x540, 320x240 and 480x270; wrtc at 640x360, 640x480 and 960x540). Legacy SDP simulcast
  (mediasoup-client's Safari12) has no scales, so libwebrtc halves from
  the top and keeps it: 320x240 and 640x480. CPU adaptation that shrinks
  the frame lowers the count further. WPT `simulcast/getStats` and
  `setParameters-maxFramerate` ask three layers of a 640x480 camera, so
  their third `<video>` never loads; the same shape in Chromium 159
  encodes two layers too, with or without Chromium's field-trial testing
  config (which Playwright turns off by default).
- **VP9 and AV1 send one layer for several encodings unless an encoding
  has a `scalabilityMode` and a scale (libwebrtc's
  `IsCodecDisabledForSimulcast`; Chromium 159 the same; documented).** Two
  rids with no mode: rid 0 only (VP9 160x120 L1T3, AV1 160x120 L1T1);
  with `L1T1` or `L1T3` on both: both.
- **Not done:** `MediaStreamTrack.contentHint` is still JS-only (wrtc
  parity), so 'motion', 'detail' and 'text' don't reach libwebrtc's
  degradation preference or content type as they do in Chrome; use
  `isScreencast` or `degradationPreference`.

Through mediasoup (`test/sfu/video-sizes.mjs --content ramp`: mediasoup 3.32.2 with
mediasoup-client 3.19.0, Safari12, `VIDEO_SETTINGS_HD`, 30 fps pushed, 10 s
warmup then 5 s measured, macOS arm64, one size per process). Content is
easy (`--content ramp`: a panning luma ramp, like a steady camera) unless
noted. Cells: each layer the sender encoded as size@fps (the SFU's receive
kbps); then the producer process's CPU (our library, mediasoup-client and
pushing the frames; the mediasoup worker is separate), % of one core. The third SSRC of the three is silent unless
listed. Before = base `124738c`.

| pushed | before | after (default 'maintain-resolution') | wrtc 0.10.0 |
|---|---|---|---|
| 160x120 | 160x120@30 (144); 4% | 160x120@30 (157); 5% | 160x120@30 (143); 4% |
| 320x240 | 320x240@30 (272); 7% | 320x240@30 (274); 9% | 320x240@30 (273); 5% |
| 321x241 | 321x241@30 (279); 7% | 321x241@30 (276); 7% | 321x241@30 (249); 5% |
| 640x360 | 320x180@30 (151), 640x360@30 (701); 10% | 320x180@30 (146), 640x360@30 (692); 11% | 320x180@30 (151), 640x360@30 (669); 11% |
| 640x480 | 320x240@30 (215), 640x480@30 (870); 14% | 320x240@30 (204), 640x480@30 (861); 10% | 320x240@30 (200), 640x480@30 (773); 13% |
| 1280x720 | 320x180, 640x360, 1280x720 @30 (131/501/2412); 55% | same @30 (148/516/2539); 32% | same @30 (138/453/2270); 47% |
| 1920x1080 | 480x270, 960x540, 1920x1080 @4 (45/149/269); 264% | same @28.5 (336/1172/4826); 187% | same @9 (198/1081/4484); 285% |

The layers and their sizes, rates and bitrates match the base, layer by
layer, so Whereby's Safari12 camera is unchanged. (A first run of this
branch under 'maintain-framerate' gave the same layers too.) CPU varies
between sessions by about 1.5x (55% and 32% at 1280x720 in two
sessions), and 1920x1080 by more (below).

Checks at 1280x720, same content:

| case | before | after (default) | after, 'balanced' |
|---|---|---|---|
| `maxFramerate` 15 on every layer (`setParameters`) | 29 fps; 56% CPU | 15 fps; 20% CPU | |
| Whereby's `maxBitrate` 150k/500k/1M applied with `setParameters` | 141/482/966 kbps | 136/501/992 kbps | |
| one layer (`--settings ONE`), no cap | 1280x720@30 (2.56 Mbps) | 1280x720@30 (2.56 Mbps) | |
| one layer, SFU cap 300 kbps | 1280x720@8 (162 kbps) | 1280x720@11 (181 kbps) | 960x540@29 (243 kbps) |
| one layer, 1920x1080 pushed, cap 300 kbps | 1920x1080@3 (152 kbps) | 1920x1080@4 (178 kbps) | 960x540@29 (243 kbps) |
| three layers, cap 300 kbps (noise) | 320x180@29 only | 320x180@29 only | |

What this shows:
- **Layers:** 1 up to 321x241, 2 at 640x360 and 640x480 (the top SSRC
  stays silent), 3 from 1280x720; the same in all three builds. Under
  Safari12 the kept layers are the top ones (320x240 and 640x480 from
  640x480), so the full size is sent.
- **`maxBitrate`:** Safari12 never applies Whereby's encodings (libwebrtc's
  defaults: about 2.4 Mbps on the 720p top layer), as noted in
  `docs/sfu-test.md`. Applied with `setParameters()`, it is respected,
  before and after.
- **`maxFramerate`** is respected now (15 of 30), and costs less CPU; it
  wasn't before, nor in wrtc for one encoding (wrtc honours per-layer
  values in `sendEncodings`, through its builtin factory's adapter).
- **Constrained bandwidth:** by default a single layer holds its size and
  drops frame rate (720p at 11 fps under 300 kbps), as the base did.
  With 'balanced' (or 'maintain-framerate') it scales down and keeps the
  frame rate (960x540@29), as in Chrome. Simulcast drops layers either
  way.
- **CPU** per stream (% of one core, M-series Mac, including pushing the
  frames from JS): about 5% at 160x120, 7 to 9% at 320x240, 10 to 14% at
  640x360/480, 30 to 55% at 1280x720 three layers.
- **1920x1080 is near libvpx's limit here**, in every build: three layers
  ran at 4 to 9 fps at about 2.6 cores in one session and 28.5 fps at
  1.9 cores in another; single-layer 1080p in a loopback varied from 30
  down to 4.5 fps between runs (`encode_ms` spikes to 350 ms; Chromium
  159 with a canvas 18.5 fps, wrtc 6.5). CPU overload now lowers the
  frame rate by default; with 'maintain-framerate' it scales to 1280x720
  after about 25 s (two 5 s overuse checks) and returns to 30 fps, where
  the base never adapted. Prefer pushing 1280x720 or less on macOS arm64.
- Hard content (`--content noise`, 16x16 random blocks) is the worst
  case: the same layers, but libvpx drops frames to hold the bitrate
  (1280x720 at 11 to 14 fps through mediasoup in all three builds,
  1920x1080 at 2 to 3 fps).

WPT (macOS): a full run passed 2179 of 2337 subtests (2178 at the wave 3
outcome). That is a run count: it includes flaky subtests that passed this
time. `expectations.json` (and `wrtc-comparison.md`, made from it) records
2170 PASS plus 13 FLAKY, up from 2169. `RTCRtpSender-maxFramerate`'s
canvas subtest passes. The simulcast `vp9`, `av1`, `getStats` and
`setParameters-maxFramerate` timeouts stay, with the reasons above (as in
Chromium 159). Unchanged by the 'maintain-resolution' default (a full run
after it: 2179, no unexpected results). With the default: Linux arm64
(Docker) and Linux x64 (gpubox) 864 tests pass, 0 fail, test:exit clean
(64 files).

### Events (2026-11-21)
- **⚑ Event payloads are the spec's prototype getters (divergence, user
  decision 2026-11-21).** `RTCTrackEvent` (`receiver`, `track`,
  `streams`, `transceiver`), `RTCPeerConnectionIceEvent` (`candidate`,
  `url`), `RTCPeerConnectionIceErrorEvent` (`address`, `port`, `url`,
  `errorCode`, `errorText`), `RTCDataChannelEvent` (`channel`),
  `RTCErrorEvent` (`error`) and `MediaStreamTrackEvent` (`track`) expose
  their payload as WebIDL attributes: enumerable getters on the prototype
  that read private fields, so a foreign receiver throws a TypeError. The
  shape pass (`lib/internal/interface-shape.ts`) makes them enumerable
  from the generated table, like every other attribute. The legacy,
  unexported `MediaStreamEvent` (`addstream`/`removestream`) does the same
  by hand, as Chrome's does. `RTCTrackEvent.streams` is a frozen array,
  the same object on every read. `selectedcandidatepairchange` is a plain
  `Event` in the spec and has no payload; DTMF is unsupported, so there is
  no `RTCDTMFToneChangeEvent`.
  - wrtc's events are plain objects with the payload as own properties.
    Direct reads (`e.track`) and destructuring (`const { track } = e`)
    work the same in both. Code that copies or enumerates an event loses
    the payload with ours: `{...e}`, `Object.keys(e)`, `Object.entries(e)`,
    `Object.assign({}, e)`, `JSON.stringify(e)` (`'{}'`) and
    `structuredClone(e)` (`{}`). `for…in` still sees it (the getters are
    enumerable), as in browsers. Read the fields by name instead, as
    browser code must.
  - Unchanged: `instanceof` (each is still an `Event` subclass of its
    exported class), `type`, `bubbles`, `cancelable`, and the
    constructors' WebIDL validation of their init dictionaries.
  - Checked before deciding (coordinator, re-checked read-only in
    `~/repos/personal/whereby-sdk-trial` including `node_modules`):
    mediasoup-client 3.19's `lib/`, Whereby core, media and assistant-sdk
    copy no event; they read `e.candidate`, `e.track`, `e.streams`,
    `e.channel`, `e.error` and the `icecandidateerror` fields by name.
    rtcstats 5.4.2 reads `e.candidate`, `e.track`, `e.streams`, `e.stream`
    and `event.channel`. webrtc-adapter 9.0.4 (Whereby media) would rewrap
    events, but it detects no browser from the polyfilled `navigator`
    (`Node.js/20`) and shims nothing.
  - WPT: the idlharness subtests that failed for this (26, "Event payloads
    are own properties of the event, by convention") pass, so idlharness
    passes every subtest it runs. macOS: 2196 PASS plus 13 FLAKY of 2337
    (2170 before), no unexpected results. 872 unit tests, 0 failing;
    test:exit clean.
  - `test/compat` records it as divergences (`eventShapes.trackKeys`,
    `eventShapes.icecandidateKeys`, `open.datachannelEventKeys`), and
    compares destructuring, which matches.
- The nonstandard sinks' `data` (`RTCAudioSink`) and `frame`
  (`RTCVideoSink`) events aren't WebIDL: they keep wrtc's own enumerable
  properties.

### Types
- Ship `.d.ts` files at least as permissive as wrtc's `types/`.
  `RTCVideoFrame.data` is typed `Uint8Array` with no `rotation`;
  `index.d.ts` re-exports the DOM types.
- WP0 adds a type-check fixture of typical wrtc-consuming code.

## Work packages and waves

```
WP0 (coordinator, serial)
  │
  ├── Wave A, in parallel
  │     WP-M  media slice: native + JS nonstandard classes
  │     WP-R  RTP slice: native transceivers/senders/receivers + snapshots
  │
  ├── WP-T  unit-test backfill (after wave A merges): colocated unit tests
  │         for everything wave A and WP0 shipped, plus the fake native
  │         helper that WP-P's unit tests will use
  │
  ├── Wave B
  │     WP-P  JS RTCPeerConnection (signaling core + media methods), MediaStream
  │           → M1: two-PC media through the sinks, differential-tested vs wrtc
  │
  └── Wave C (M2), in parallel
        WP-W  WPT harness + wrtc baseline
        WP-D  data channel spec layer
        WP-G  getUserMedia, i420 helpers, portRange
```

Each delegated WP runs in its own worktree on its own branch, with an
explicit file-ownership list.

### WP0: scaffolding and contracts (coordinator)
Everything that more than one WP would otherwise edit is done here, so the
waves only add code inside files they own.

- **TypeScript and tooling:**
  - `tsconfig.json` per the conventions
  - `pnpm build:ts` and `pnpm test`
  - all devDependencies for every wave (`typescript`, `webidl2`,
    `@webref/idl`, `@roamhq/wrtc` for differential tests), so the lockfile
    is settled
  - the type-check fixture of wrtc-consuming code
- **JS skeleton:** `lib/index.ts` with wrtc's full export shape (stubs throw
  "not implemented"), `native.ts`, and `native-types.ts` covering the whole
  target contract above. `scripts/gen-idl.mjs`:
  - merge partial dictionaries across the `@webref/idl` files
  - emit dictionary converters, enum validators and TS types
  - hand-add `portRange` and `sdpSemantics`
- **Native skeleton:**
  - headers and stub `.cc` for every native class in the contract
    (`src/rtp.*`, `src/media_track.*`, `src/media_source.*`,
    `src/media_sink.*`, `src/yuv.*`, `src/playout_adm.*`), already in
    `binding.gyp`, registered in `addon.cc` with constructor refs in
    `AddonData`
  - the extended `NativeEvent` fields
  - the global track registry and a `Track::FromJs` helper for track handles
    (WP-R needs them for `addTrack` / `replaceTrack`)
  - stubs return "not implemented" errors
  - the build and `check-undefined.sh` pass
- **Worktree support:**
  - a `WRTC_LIBWEBRTC_DIR` override in `scripts/gyp-webrtc.py`, so worktrees
    share one `third_party/libwebrtc`
  - a `scripts/setup-worktree.sh` that links `third_party/` and runs
    `pnpm install`
  - per-WP Docker image tags
- **`CONTRIBUTING-AGENTS.md`:** conventions, commands, the threading and TSFN
  rules, and how to propose a contract change. It's short, because briefs
  link to it.
- **Done when:** `pnpm build`, `pnpm build:ts` and `pnpm test` pass on macOS
  and in Docker, `require('.')` has wrtc's export shape, the generated
  converters have tests, and the existing spikes still pass.

### WP0 outcome (2026-11-18)

What exists now, for briefing later WPs:

**Native**
- `src/media_track.*`: the global track registry and `Track` handle are
  **implemented**, with `Track::ToJs` and `Track::FromJs`.
- `src/rtp.*`, `src/media_source.*`, `src/media_sink.*`, `src/yuv.*` and
  `src/playout_adm.*` are stubs that throw `ERR_WRTC_NOT_IMPLEMENTED`.
- The new PeerConnection methods are registered stubs in
  `src/peer_connection.cc`. Implemented: `restartIce`, `iceGatheringState`
  and `iceConnectionState`.
- `src/event_sink.*` already converts every new event field and the
  description snapshot to JS. RTP objects become JS via the
  `RtpRegistry` interface (`src/rtp.h`), which WP-R implements and must
  keep.

**JS**
- `lib/internal/native-types.ts` types the whole contract, with `@stub`
  tags naming the owning WP.
- `lib/internal/webidl.ts` plus `lib/internal/generated/idl.ts` (from
  `scripts/gen-idl.mjs`) provide converters for 34 enums and 78
  dictionaries, including wrtc's `portRange` and `sdpSemantics`.
- `lib/index.ts` has wrtc's export shape. Each public class has its own
  stub module, so ownership is per file. The nonstandard stubs carry their
  full public types.

**Tests and tooling**
- `test/unit/exports.test.ts` checks the export shape against wrtc, loaded
  in a child process.
- `test/types/wrtc-consumer.ts` is a type-check fixture of
  nonstandard-API code. **WP-P extends it with the PC surface.**
- Biome (`pnpm run lint` / `format`) and clang-format (Chromium style).
- `scripts/setup-worktree.sh` and the `WRTC_LIBWEBRTC_DIR` override.
- The Docker image runs `typecheck` and `pnpm test`.
- `CONTRIBUTING-AGENTS.md` has the commands and rules for subagents.

**After the WP0 review** (fixes in the commit after `01e639b`):
- **RTP registry:**
  - `AddonData` has `transceiver_ctor`, `sender_ctor` and `receiver_ctor`.
  - The `RtpRegistry` is owned by the `PeerConnection` (JS thread) and only
    borrowed by `EventSink`, which can die on the signaling thread.
  - `RtpRegistry::Create` takes the sink as a `weak_ptr`.
- **Snapshots** carry `receiverStreamIds` per transceiver.
- **Track contract:**
  - `Track::ToJs` / `Track::FromJs` and the registry semantics are frozen
    as contract (`src/media_track.h`).
  - `FromJs` rejects prototype-only fakes.
  - WP-R gets test tracks from `addTransceiver(kind).receiver.track`.
- **More `@stub WP-R` tags:**
  - `createOffer` options, including the legacy `offerToReceiveAudio` and
    `offerToReceiveVideo`
  - the `RTCConfiguration` fields
  - implicit SLD
- **Public types:**
  - Sink constructors take `MediaStreamTrackLike`.
  - `MediaStreamTrack` declares the full Media Capture surface, with
    `kind: string`.
  - `needsDenoising` is typed `?: boolean`, as in wrtc's `.d.ts`; it's
    still `null` at runtime.
  - `test/types-dom/` (via `tsconfig.dom.json`) checks that DOM-annotated
    wrtc code compiles.
- **Interface conversions:** `registerInterface(name, brandCheck)` takes a
  brand check, not a constructor; use `#field in value`. Unregistered
  interfaces reject. A `todo` test lists the ones not registered yet. **Every
  class a WP implements must register itself.**
- **WebIDL details:**
  - no `-0` from integer conversion
  - `@@iterator` is read once
  - `ByteString`, `float` and `SharedArrayBuffer` are handled per spec
  - `record` keeps `__proto__` keys
- **Generator:** it fails on unknown types, extended attributes or
  ambiguous unions, and it now loads `mst-content-hint`.
- **Tests:**
  - `test/native/openssl-coexist.test.ts` replaces the spike script.
  - `pnpm run test:exit` runs each native test file under plain `node` and
    fails on hangs (leaked handles). Docker runs it too.

Ownership additions to the lists below:
- WP-P also owns `lib/RTCPeerConnectionIceEvent.ts`,
  `lib/RTCPeerConnectionIceErrorEvent.ts`, `test/types/` and `test/types-dom/`
  (adding the PC surface).
- WP-G owns `lib/mediaDevices.ts` and `lib/nonstandard/i420.ts`.
- **`portRange` moves from WP-G to WP-R.** It's parsed in
  `src/peer_connection.cc`, which WP-R owns, and it's a few lines.
- Nobody owns `lib/RTCDtlsTransport.ts`, `RTCIceTransport.ts` or
  `RTCSctpTransport.ts` yet.

### WP-M: media slice (native + JS)
- **Owns:**
  - native: `src/media_*`, `src/playout_adm.*`, `src/yuv.*`, and the
    ADM swap in `src/runtime.cc`
  - JS: `lib/MediaStreamTrack.ts`, `lib/nonstandard/*`
  - tests in `test/native/media*` and `test/compat/nonstandard*`
- **Native:**
  - the synthetic playout ADM
  - `AudioSource` (with `is_external_source`) and `VideoSource`
  - `AudioSink` and `VideoSink` (NonBlockingCall, ref'd until `stop()`,
    an env cleanup hook as in `PLAN.md` Gotchas)
  - the track handle
- **JS:** the four nonstandard classes and `MediaStreamTrack`, exactly per
  the compatibility spec.
- **Tests:**
  - local source-to-sink loopback (no PC): 8k/16k/48k, mono and stereo;
    odd video sizes; the validation errors (type and cases; the
    messages are ours since 2026-11-22)
  - `stop()` drops queued events
  - differential runs against `@roamhq/wrtc` comparing event shapes,
    defaults and errors
  - Linux via Docker

### WP-R: RTP slice (native)
- **Owns:** `src/rtp.*` and the PC-side additions in `src/peer_connection.*`,
  plus tests in `test/native/rtp*`.
- **Implements:**
  - the PeerConnection, Transceiver, Sender and Receiver contract
  - the SLD/SRD snapshots
  - `track` / `removetrack` events
  - `shouldFireNegotiationNeededEvent`
  - the extended config
- Use libwebrtc's own `pc/` sources and tests as the reference.
- **Tests:** two PCs; addTransceiver and addTrack (with a WP0 stub track,
  or WP-M's track once merged); negotiate; then check:
  - snapshot contents
  - `currentDirection` and `mid`
  - `track` events carrying the stream ids
  - `replaceTrack(null)`
  - a `setParameters` round trip
  - stable handle identity across `getTransceivers()` calls
- Linux via Docker.

### Contract decisions after the WP-R review (2026-11-18)

Taken by the coordinator; implemented in the "WP-R fixes" pass before WP-T.

1. **`getStats` works after `close()`** (PC, sender, receiver), because the
   spec has no `[[IsClosed]]` check there.
   - `close()` no longer releases the per-PC TSFN. It **unrefs** it, so a
     closed PC doesn't keep the process alive.
   - Starting an op re-refs it, and when the last pending op completes on
     a closed PC it is unref'd again, so `await pc.getStats()` after close
     still completes.
   - The TSFN is released in `~PeerConnection` and on env cleanup.
   - Every other async op still rejects immediately after close (the JS
     layer enforces the spec's InvalidStateError anyway).
   - Ops in flight at `close()` complete normally. Native events emitted
     by close are still delivered; the JS layer drops them.
2. **Handles don't pin a closed PC.** At `close()` every registry entry
   becomes weak, and later wraps are weak, so a handle that references its
   PC (as spec wrappers will) can't leak it. Identity holds while JS holds
   the handle.
3. **Pruning happens when snapshots are converted.**
   - `RtpRegistry` gets `Retain(live transceivers)`, called by
     `SnapshotToJs` with the snapshot's full list.
   - Entries for transceivers not in it become weak; `getTransceivers()`
     keeps doing the same.
4. **One error shape.** Every rejection or throw from native code for a
   runtime condition is an `Error` with `errorType`, using libwebrtc's
   RTCErrorType names (`INVALID_STATE`, `INVALID_PARAMETER`,
   `INVALID_MODIFICATION`, `SYNTAX_ERROR`, `INVALID_RANGE`,
   `UNSUPPORTED_OPERATION`, `INTERNAL_ERROR`, and so on):
   - Ops on a closed PC: `INVALID_STATE`.
   - SDP and candidate parse failures: `SYNTAX_ERROR`, with the libwebrtc
     parse error text and offending line as `sdpLine`.
   - `TypeError` stays reserved for wrong argument types, which means a
     JS-layer bug, because the JS layer validates first.
   - Documented in `native-types.ts` as `NativeError`.
5. **`portRange`.** Natively `min` defaults to 0 and `max` to 65535, as in
   wrtc. `{min: 60000}` restricts to 60000–65535, and `{max}` alone is
   unrestricted, as in wrtc. The JS layer validates `min <= max`, with a
   `TypeError` as in wrtc.
6. **Smaller contract notes** to document in `native-types.ts`:
   - events delivered after the PC object was collected may lack RTP
     fields
   - `sender.track` reads `null` after close (JS keeps its cache)
   - native doesn't detect foreign senders or receivers (JS must)
   - `maxBitrate` above INT_MAX is rejected natively with `INVALID_RANGE`
   - removed transceivers drop out of `getTransceivers()` and snapshots
   - `offerToReceive*` can change transceivers without an event (JS
     re-reads them)
   - `receiver.getStats()` is `{}` until packets arrive
   - `replaceTrack` uses `INVALID_STATE` for a kind mismatch or a stopped
     sender
   - `setParameters` applies only the writable members, on top of the
     sender's parameters as they are when it's called, read and applied
     in one signaling-thread task. (It started from the last
     `getParameters()` until the RTP parameters work, which also moved
     the `transactionId` check to JS and matches encodings by rid; see
     "RTP parameters" in the wrtc compatibility spec.)
   - `firedDirection` is passed through as-is (spec-correct)
   - `rtcpMuxPolicy: 'negotiate'` stays out of the contract

**As built** (WP-R fixes, merged `d32a236`), where it differs from the
decisions above:
- Decision 1 as written still leaked closed PCs, because the TSFN held the
  `onEvent` callback strongly. The callback now lives in the sink: strong
  until `close()`, weak after. The TSFN has no JS function. Events that
  arrive after the callback is collected are dropped.
- Decision 6's "`sender.track` reads null after close" was wrong: libwebrtc
  keeps a sender's track. That's now documented correctly in
  `native-types.ts`.
- `createOffer` / `createAnswer` in flight at `close()` may resolve or
  reject with `INTERNAL_ERROR`, depending on a race inside libwebrtc. The
  JS layer never surfaces these, because chained ops on a closed PC never
  settle (spec).
- Pruning has an epoch guard, so a snapshot captured before a transceiver
  existed can't weaken it. One edge remains: a sender or receiver of a
  removed transceiver that is wrapped between snapshot capture and
  delivery stays strong until the next snapshot or `getTransceivers()`.
- `icecandidateerror` reports `errorCode` as libwebrtc gives it, and the
  JS layer passes it through unchanged. STUN binding errors carry only the
  number part (a STUN 420 arrives as 20, and the class digit is lost, so it
  can't be mapped back); 701 means unreachable.

### Decisions after the WP-M review (2026-11-18)

Taken by the coordinator; implemented in the "WP-M fixes" pass before WP-T.

1. **Native `Track.clone()`** joins the contract: a new track on the same
   source, as in wrtc, so received tracks can be cloned, e.g. to relay or
   fork a remote track into a sink or another PC. The JS
   `MediaStreamTrack.clone()` uses it for every track and still copies
   `enabled`.
2. **Native sinks are ref'd until `stop()`.** The ObjectWrap is `Ref()`'d in
   `Start` and `Unref()`'d in `DoStop`, so GC can't silently stop one.
3. **Accepted, documented divergences** from wrtc's sink events. Events are
   real `Event`s:
   - `{...e}`, `JSON.stringify(e)` and `structuredClone(e)` lose `type`
   - `for…in` walks `Event.prototype`
   - a non-function `ondata` reads back `null`
   - the payload fields are `readonly`

   Also, `ondata`/`onframe` run in assignment order relative to
   `addEventListener` listeners, as the HTML spec says, whereas wrtc always
   runs them last. The compat test asserts this.
4. **The ADM pulls only while playout runs** (`StartPlayout` /
   `StopPlayout`).
5. **Remote compat scenario:** the differential test gains a two-PC remote
   scenario once WP-P exists. By hand, both deliver remote audio at
   48 kHz, 1 channel, 480 frames. Only wrtc's very first pre-packet event
   differs (16 kHz).

### WP-P as built (merged `9051142`, under review)

- **Milestone 1:** `test/compat/two-pc-media.test.ts` runs the same
  two-PC script, with nonstandard sources and sinks plus the standard PC
  calls in scope, against `@roamhq/wrtc` and ours in separate processes.
  Results are identical apart from asserted intentional divergences:
  - `negotiationneeded` isn't fired when an offer was already chained in
    the same task
  - a `""` candidate fires before `null`
  - remote streams fire `removetrack`
  - stats entries are frozen
  - `getConfiguration()` includes `certificates: []`
  - errors are spec exceptions (`OperationError`/`RTCError` for SDP,
    `InvalidAccessError` for TURN without credentials, and so on)
  - after `close()`: transceivers stay listed, `getStats` resolves, and no
    events fire
- **Other deliberate divergences from wrtc:**
  - `RTCSessionDescription`/`RTCIceCandidate` fields are prototype getters,
    so spread gives `{}`; JSON works
  - `sdpSemantics: 'plan-b'` throws `TypeError`
  - the legacy callback overloads return an already-resolved promise
  - events dispatch synchronously in the native callback (wrtc uses
    `nextTick`)
  - `setParameters` and sender/receiver `getStats` work (wrtc's didn't)
- **Spec divergences:**
  - munged SDP is accepted in SLD, like libwebrtc, Chrome and wrtc
  - `transport`/`dtmf`/`transform` are `null` (`transport` is the DTLS
    transport since WPT fix wave 2), and CSRC/SSRC lists are
    empty
  - `jitterBufferTarget` is validated but never applied
  - a nonstandard `transceiver.stopped` (wrtc has it)
  - `currentDirection` after close is libwebrtc's `'stopped'`
- **libwebrtc workaround in `addTrack`:** when libwebrtc would pick a
  stopping transceiver (it throws where the spec reuses or creates), the
  JS layer reuses the spec's choice by hand (`replaceTrack` + `setStreams`
  + direction) or falls back to `addTransceiver`. The fallback loses
  libwebrtc's `created_by_addtrack` flag.
- **Contract gaps** (none blocking):
  - no native per-transport end-of-gathering signal (JS derives transports
    from the local SDP's BUNDLE groups)
  - no way to make native `addTrack` reuse a specific transceiver
  - `getParameters()` lacks `degradationPreference`
  - the stats JSON shape (now documented)
- **Not done yet:**
  - `createDataChannel` (WP-D)
  - non-empty `certificates` / `generateCertificate`
  - `setConfiguration` doesn't check `portRange` changes

### After milestone 1: getting to "actually replace wrtc" (decided 2026-11-19)

Milestone 1 proves feature parity for the user's usage in tests. Before the
user can switch, these come next, in this order:

1. **WP-V: real-app trial with `@whereby.com/core`.**
   - **Setup:**
     - work in a local clone of the public SDK (`github.com/whereby/sdk`)
       at `~/repos/personal/whereby-sdk-trial`
     - never touch `~/repos/whereby`, and never push anything
     - use `@whereby.com/core`'s `WherebyClient` directly, on Node, with
       polyfills modelled on `packages/assistant-sdk/src/utils/polyfills.ts`
       but importing our package instead of `@roamhq/wrtc`
     - core runs media through mediasoup-client's Safari12 handler (with
       `isNodeSdk`)
   - **Run:** two Node clients join the user's open test room
     (`https://kevin-embedded.whereby.com/none-rec-5fvg55`) through
     Whereby's SFU. One sends a tone and a test pattern from the
     nonstandard sources via `getLocalMedia().startMedia(stream)`; the
     other receives into the nonstandard sinks. No assistant key is
     needed.
   - **Pass criteria:**
     - both join
     - media flows both ways with the expected formats
     - `getStats` works
     - leaving and `destroy()` are clean, and the processes exit
   - It's the decisive acceptance test: a real SFU, real network, real
     codecs.
   **Outcome (2026-11-19): passed.** All four live scenarios pass on our
   package through Whereby's SFU (macOS; 28 joins in total):

   | Scenario | Ours | `@roamhq/wrtc` 0.9.1 |
   |---|---|---|
   | `basic` (send A/V, receive into sinks, stats, toggles, leave, exit) | 17/17 | 13/17 |
   | `bidi` (both send and receive) | 19/19 | 13/19 |
   | `rejoin` | 18/18 | 13/18 |
   | `gum` | 12/12 | 8/12 |

   Measured on ours:
   - **Remote audio:** 48 kHz mono, 480 frames per event. It arrives
     bit-exact in level and pitch (8000 amplitude in, about 8060 out,
     440 Hz). Mic off gives exact silence.
   - **Video:** the SFU forwards 640x480 VP8 simulcast (2 active layers),
     delivered as I420 `Uint8Array`.
   - **Connection:** ICE connects in about 60 ms (sender) and `joinRoom()`
     resolves in about 400 ms.
   - **Stats:** `getStats` works on the PC, senders and receivers.
   - **Exit:** clean, code 0.

   wrtc, by contrast:
   - SIGSEGVs on exit
   - raises an unhandled rejection from mediasoup's `getSenderStats`
   - attenuates and distorts the pushed tone (audio processing on its send
     path)
   - its `setParameters` is a no-op

   The one library fix the trial needed: `MediaDevices` methods must work
   when copied off the object, as assistant-sdk's polyfills copy them
   (`c3f05ec`).

   Notes:
   - No data channel was ever requested by the SFU. A colocated browser
     participant could make it announce one; `createDataChannel` then
     throws, which Vega catches and logs. That's non-fatal, but it argues
     for WP-D before relying on this in production.
   - Core's camera re-enable path never calls `getUserMedia` with
     assistant-sdk's polyfills, on either package. The cause (found
     2026-11-20) is not the missing video input in their device list. When
     `startMedia` is given a stream, core enumerates devices only on a
     `devicechange` event. Until one fires, its device list is empty and
     re-enabling the camera drops video. With a `devicechange` and a listed
     `videoinput`, or with `startMedia({audio, video})`, core calls
     `getUserMedia` (see "wrtc compatibility spec", `getUserMedia`).
   - The trial app lives, uncommitted, in
     `~/repos/personal/whereby-sdk-trial/apps/libwebrtc-trial/`. Run it
     with `node src/run-trial.ts basic|bidi|rejoin|gum`, or
     `WRTC_IMPL=roamhq` to compare.
   - **`gum-video` (macOS, 2026-11-20, `a3022a5` tarballs): 16/16.**
     - Core's camera-on path really called our `getUserMedia` with
       `{video:{facingMode:'user', height:{min:360, ideal:720},
       frameRate:30, aspectRatio:16/9}}`.
     - The sender's stream got a live video track, and the receiver got
       the 640x480 colour bars through the SFU.
     - Both clients exited 0 with no uncaught errors.
     - The trial installed our package under the alias `libwebrtc-rs-js`,
       pointing at `kdh.codes-webrtc-0.0.0.tgz`, plus the scoped
       darwin-arm64 platform package. That's the swap recipe for the
       user's workers, and it works under pnpm 10 with
       `node-linker=hoisted`.
   - **Linux x64 (gpubox, 2026-11-19): passed.**

     | Scenario | Result | Exit code |
     |---|---|---|
     | `basic` | 17/17 | 0 |
     | `bidi` | 19/19 | 0 |
     | `rejoin` | 18/18 | 0 |
     | `gum` | 12/12 | 0 |

     Each ran once, from the installed linux-x64 tarballs (confirmed via
     `/proc/self/maps`).
     - **Media:** audio is bit-exact as on macOS. The sender sends VP8
       simulcast with 2 active layers; the receiver gets 640x480.
     - **Timing:** ICE connects in 41–61 ms; DTLS completes in about 100 ms.
     - **Headless:** stderr is silent with no `DISPLAY` set.
     - **Resources:** 150–190 MB RSS per client.
     - **@roamhq/wrtc on the same box:**
       - `basic`: 14/17, exit code 1.
       - The sender died with SIGABRT; the receiver with SIGTRAP (a V8
         fatal check in wrtc's finalizer during env cleanup).
       - It raised `getSenderStats` unhandled rejections.
     - **Re-running it:** the gpubox copy is in
       `~/repos/personal/whereby-sdk-trial`; the steps are in its
       `apps/libwebrtc-trial/logs-gpubox/`.
   - **Not yet covered:** long sessions, packet loss or bandwidth limits,
     TURN-only paths, more than 2 participants.
2. **WP-I: Chrome interop,** local only (no CI). Playwright drives Chrome
   against our Node peer: offer/answer both ways, audio and video both ways
   into nonstandard sinks, renegotiation.
   - **Done (merged `5ab713e`; reviewed, fixed and re-reviewed twice).**
     Run it with `pnpm run test:interop`; it isn't part of `pnpm test`.
     Setup is in CONTRIBUTING-AGENTS.md.
   - **Results:** 19 pass and 1 skips on macOS; 20 pass on gpubox (Linux
     x64).
   - **What's verified:** real media in both directions, checked by tone
     frequency, frame size and luma.
     - Offer and answer from either side.
     - Renegotiation from each side, including removeTrack.
     - replaceTrack.
     - VP8, VP9 and AV1 both ways; H264 both ways on Linux, send only on
       macOS (H264 since removed: see "No H264 or H265").
     - Three-layer simulcast, with Chrome decoding all three via WPT-style
       rid/mid munging; plus the spec downgrade when it's declined.
     - close() from either side, with the Node process exiting.
   - **Found:**
     - **The macOS prebuilt has no H264 decoder,** yet we advertised H264
       receive. Fixed by a decoder probe in item 4, then superseded by no
       H264 at all (PLAN.md Gotchas, "No H264 or H265").
     - **A rare libwebrtc race after a removeTrack renegotiation.** See
       PLAN.md Gotchas.
   - **Also hardened the compat harness:**
     - fuller failure diagnostics
     - synchronous result writes
     - a 90 s guard
     - tolerance for wrtc-only crashes when its JSON came through complete
3. **WP-K: local packaging.** Prebuilt `.node` builds for **macOS arm64,
   Linux arm64 and Linux x64**, installable locally without building
   libwebrtc. Nothing is published yet.
   - **Done (merged `f02b40e`, reviewed and re-reviewed).** Packaging
     commands and details are in CONTRIBUTING-AGENTS.md ("Packaging").
   - **Layout:**
     - The main package carries only `dist/`.
     - Each platform package `@kdh.codes/webrtc-<os>-<arch>` carries
       only a stripped `wrtc.node`.
     - The platform packages are optional **peerDependencies**, not
       `optionalDependencies`. The reviewer showed with a fake registry that
       under `optionalDependencies`, npm installs a squatted package of that
       name and runs its postinstall. The package is now
       `@kdh.codes/webrtc`, and the user owns the `kdh.codes` npm org
       (2026-11-19). So nobody else can publish into the scope, which closes
       that risk under either wiring.
     - The cost is that you install both tarballs explicitly.
   - **Loader** (`lib/internal/addon-path.ts`):
     - It loads `build/Release` in a checkout, otherwise the platform
       package.
     - Both manifests carry a `nativeBuild` id, a hash of the native inputs
       in `scripts/native-inputs.sh`. A mismatched pair is refused.
     - The error messages cover a missing package, musl, and dlopen
       failures.
   - **Install:** `"gypfile": false` means `pnpm install` never builds the
     addon.
   - **Building:** macOS locally, Linux arm64 in Docker, Linux x64 on gpubox
     (`scripts/prebuild.sh`).
   - **Smoke tests:** `scripts/smoke-install.sh` passes on clean, offline,
     compiler-free installs on all three platforms.
   - **Floors:** glibc 2.34 since the switch to our own libwebrtc build
     (Ubuntu 22.04+, Debian 12+, RHEL 9, AL2023) and macOS 13.5 (Node 24's
     own floor).
   - **Open:**
     - **Lowering the glibc floor further: deliberately not done** (user,
       2026-11-19). The target is mostly Linux, including containers. The
       floor is glibc 2.34. Containers:
       - **work:** `node:24` / `node:24-slim` (Debian 12, glibc 2.36),
         `ubuntu:22.04` and later, `debian:12` and later, RHEL/UBI 9 and
         Amazon Linux 2023 (glibc 2.34)
       - **don't work:** any Alpine or musl image (`node:24-alpine`)
       If that changes, build the Linux addons on an older base (Ubuntu
       20.04 or Debian 11 plus clang 21 from apt.llvm.org) or against
       Chromium's bullseye sysroot.
     - licence notices before the tarballs go to anyone else (done
       2026-11-22: `LICENSE`, MIT, and `THIRD_PARTY_NOTICES.md` in every
       package)
     - no musl, macOS x64 or Windows builds
4. **H264 receive only with a working decoder, and the rename to
   `@kdh.codes/webrtc`** (user, 2026-11-19).
   - **Done (merged `21bc394`; reviewed and fixed).**
   - **H264:** a decoder probe (`src/h264_probe.*`, since deleted)
     advertised H264 receive only if a decoder could actually be
     configured: none on macOS, unchanged on Linux. **Superseded on
     2026-11-22: no H264 at all** (user; "No H264 or H265" above).
   - **Name:** `@kdh.codes/webrtc`; the platform packages are
     `@kdh.codes/webrtc-<os>-<arch>`, and the tarballs are named
     `kdh.codes-webrtc-*.tgz`. The user owns the `kdh.codes` npm org.
     - First named `@kdh.codes/node-webrtc`. Renamed on 2026-11-20 (user)
       so it can't be confused with the legacy `node-webrtc` project,
       which `@roamhq/wrtc` forks.
5. **WP-D: data channels** (moved up from M2; user, 2026-11-19).
   - **Done (merged `f24f3e5`; reviewed, fixed, re-reviewed twice).**
   - **Covers:**
     - `createDataChannel`, including the mediasoup `negotiated: true` path
     - `ondatachannel`, `send()` for every type with ordered Blobs, and
       JS-tracked `bufferedAmount`
     - the spec's close semantics, and `pc.sctp` with the DTLS and ICE
       transports
     - 550 tests; a compat scenario against wrtc (wrtc is wrong in about a
       dozen places); 8 Chrome interop tests
   - **Native:** the SCTP and DTLS watchers run on the network thread
     (`NetworkThread()` in `runtime.*`). `src/napi_safe.h` and
     `SafeObjectWrap` mean worker termination can't abort through
     node-addon-api's throw-on-failure paths. 4,000+ random worker
     terminations ran with 0 crashes.
   - **Deviations:** listed in the WP-D section below and in PLAN.md
     Gotchas.
   - **Open:** throughput, measured incidentally at only 0.5–2 MiB/s over
     loopback; under investigation.
6. **Done 2026-11-20. Each item reviewed, fixed and re-reviewed; details
   in PLAN.md Gotchas, `bench/RESULTS.md` and `docs/`:**
   - **libwebrtc workarounds** (`3f343f7`):
     - rollback BUNDLE-extmap collision: renumbering in JS
     - removeTrack race: `src/sink_reassert`
     - the `WRTC_LOG` hook
     - ready-to-file upstream reports in `docs/upstream/` (not filed)
   - **H264 encoder gated on the decoder probe** (`7eded0d`), fixing a
     macOS sendonly→sendrecv renegotiation failure (H264 since removed).
   - **Benchmark against wrtc** (`pnpm run bench`, `5bcb403`; Linux data
     in `d519606`).
     - At VGA, and for simulcast and receive-heavy use, CPU is on par.
     - 720p costs 5–14% more on Linux.
     - Latency is lower everywhere.
     - Linux renegotiation is 2.5x slower, but a mediasoup consume round
       costs only 2–5 ms.
   - **Data-channel throughput** (`8a8f9f3`):
     - one process collapses because of libwebrtc (dcSCTP plus a shared
       network thread)
     - two processes reach about 125 MiB/s on macOS and 75 MiB/s on Linux
     - the Linux default UDP receive buffer limits throughput over a real
       network; documented in `docs/deployment.md` rather than made an
       option (user decision)
   - **Opt-in tests against a local mediasoup SFU** (`cd8aa9e`,
     `docs/sfu-test.md`): data channels and media pass on mediasoup 3.19
     and 3.32.
   - **Performance pass** (`f6ce5b8`):
     - sinks copy once, holding at most 3 frames per sink by reference
     - snapshots serialize only what changed
     - import time on Linux down from 42 to 27 ms
     - Not done: trimming H264 profiles (user: leave it), opt-in sink
       buffer reuse, bundling `dist/`.
   - **Tarballs** rebuilt from `d519606` (native build `abafa9992df4`).
     Smoke tests pass on macOS (npm and pnpm), on Linux arm64 in Docker,
     and on Linux x64 on gpubox (npm and pnpm).

Milestone 2 (WPT, data channels, `getUserMedia`, i420 helpers) stays
optional polish, though `assistant-sdk`'s polyfills use `getUserMedia` and
`mediaDevices` events, and the same polyfills install `RTCDataChannel` as a
global.

**Decided defaults** (user, 2026-11-19), which WP-V may revisit:
- no synthetic legacy `track`/`stream` stats (`mediaType` is restored on
  RTP entries)
- descriptions and candidates keep spec prototype getters (JSON works,
  spread doesn't)

**Drop-in compatibility found while scoping WP-V:** `assistant-sdk` does
`import wrtc from "@roamhq/wrtc"` and uses `wrtc.X` as both values and
types, and it subclasses `RTCPeerConnection` and the nonstandard sources
and sinks. Our ESM package therefore needs a **default export** that
re-exports the namespace (types included), and subclassing must keep
working with our brand checks.

### WP-T: unit-test backfill (after wave A merges)
- The colocated-unit-test convention was adopted after wave A started, so
  wave A's tests are mostly integration tests. WP-T backfills the unit layer
  before WP-P starts:
  - unit tests next to every `lib/` module from WP0 and WP-M
  - a reusable fake of the native API (`lib/internal/testing/fake-native.ts`)
    that implements `native-types.ts`, for error injection and event-order
    tests
- WP-P and later WPs then write their unit tests as they go, as normal.

### WP-P: JS peer connection (after wave A merges)
- **Owns:**
  - `lib/RTCPeerConnection.ts`, `RTCSessionDescription.ts`,
    `RTCIceCandidate.ts`, `RTCRtpTransceiver.ts`, `RTCRtpSender.ts`,
    `RTCRtpReceiver.ts`, `RTCTrackEvent.ts`, `MediaStream.ts`,
    `RTCStatsReport.ts`
  - `lib/internal/{events,ops-chain,errors}.ts`
  - their tests
- It's one WP because signaling and media share `RTCPeerConnection.ts` and
  the SLD/SRD completion path.
- **Develop against the real addon.** A fake native is only for
  error-injection unit tests.
- **Must implement:**
  - **Operations chain:**
    - `createOffer`, `createAnswer`, `setLocalDescription`,
      `setRemoteDescription`, `addIceCandidate` and `replaceTrack` are
      chained.
    - When the chain is empty, InvalidStateError and similar are thrown in
      the same task, from JS-cached state
      (`RTCPeerConnection-operations.https.html`).
  - **Close:**
    - after `close()`, chained promises that complete **never settle** (the
      spec says "if [[IsClosed]], abort these steps"), so JS swallows
      native rejections
    - no events fire
    - getters, `getTransceivers()`, `getConfiguration()` and `close()` still
      work
    - `restartIce()` is a no-op
    - other methods throw InvalidStateError
  - **Snapshots and buffering** per "Description snapshots".
  - **`negotiationneeded`:**
    - drop it if closed
    - defer it while the JS chain is non-empty, and re-check the latest
      event id when the chain empties
    - otherwise fire it if `shouldFireNegotiationNeededEvent(id)`
    - libwebrtc already handles the "not stable" queueing, so don't
      reimplement it
  - **`icecandidate`:**
    - wrap it in `RTCIceCandidate`, with parsed candidate fields
    - the per-transport `""` candidate comes first
    - the gathering-complete task then updates `iceGatheringState`, fires
      `icegatheringstatechange`, then fires the `null` candidate
  - **End-of-candidates** in `addIceCandidate`, handled in JS.
  - **`MediaStream`:**
    - the spec constructors plus wrtc's `new MediaStream({id})`
    - stream identity in `track` events: the same stream id on one PC means
      the same `MediaStream` object
    - `addtrack` / `removetrack` events
  - The PC media methods; `track` events per snapshot ordering.
  - `getStats` returning `RTCStatsReport` (Map-like, frozen entries).
  - Argument validation through the generated converters, with exact error
    types.
- **M1 acceptance:**
  - `test/compat/two-pc-media.ts`: audio and video from nonstandard
    sources, through two PCs, received in nonstandard sinks on remote
    tracks (expecting 48 kHz audio)
  - the same script passes against `@roamhq/wrtc` in a separate process,
    and the observable outputs match
  - Linux via Docker

### WP-W: WPT harness and wrtc baseline (M2)
- **Owns:** `test/wpt/` and `scripts/wpt-*.mjs`.
- Vendor a pinned WPT commit's `webrtc/` subset with `resources/` and record
  the commit hash.
- **One child process per test file, with a hard kill timeout.** Open PCs
  keep processes alive, and it avoids `vm` realm mismatches:
  `assert_throws_js` compares constructors, and data tests use `instanceof
  ArrayBuffer`. Put the implementation's exports and shims on `globalThis`
  and run with `vm.runInThisContext`.
- Honour `META: timeout=long` and `META: script=` in `.window.js` files.
- **Shims:**
  - `document` only after testharness.js has loaded, so it still picks
    `ShellTestEnvironment` (originally there was no `document` at all)
  - the DOM shim `test/wpt/dom-shim.ts` (see "DOM shim" in the WP-W
    outcome): media elements over our sinks, and a 2D canvas whose
    `captureStream()` the helper uses (it probes
    `HTMLCanvasElement.prototype.captureStream`, `wpt-pc-helper:551-552`;
    this was an empty class before the shim)
  - `navigator.mediaDevices`
  - a stubbed `testharnessreport.js`
- **Expectations:** `test/wpt/expectations.json` per subtest (PASS / FAIL /
  SKIP with a reason). `pnpm wpt` reports deltas.
- **wrtc baseline:** the same runner with `@roamhq/wrtc` as the
  implementation, in its own processes; never load both addons in one
  process. Use it as a signal, not a gate: wrtc's EventTarget ignores
  listener options and dispatches plain objects, so its numbers are noisy.

### WP-W outcome (merged `6001b50`, 2026-11-20)
- **Status:** done. Reviewed, fixed, re-reviewed, small follow-ups checked
  by the coordinator. How to run it is in `CONTRIBUTING-AGENTS.md` under
  "Web Platform Tests"; `pnpm test` doesn't run it.
- **Pin:** WPT `0eefed92899544e837b8263db492a6235fa858a1`
  (`test/wpt/vendor/WPT_COMMIT`), 282 files, 2.2 MB, BSD `LICENSE.md`
  kept. `scripts/wpt-fetch.mjs --commit <sha>` re-vendors.
- **Results (macOS arm64, 2267 subtests in 224 run tests, about 3 min):**
  ours 1719 PASS, wrtc 992 PASS (`test/wpt/wrtc-comparison.md`; wrtc from
  one run). The gate reported no unexpected results on repeated runs.
- **Linux x64 (gpubox):** one run before the review gave 12 platform
  differences (H264 decodable, two TCP port-8001 subtests) and one
  ICE-restart subtest that fails only there. They are now platform-keyed
  expectations. Re-run on gpubox after the review fixes (2026-11-20): one
  unexpected result, "iceConnectionState can go to checking without
  explictly calling addIceCandidate", which passed 5 of 5 runs alone and is
  now `{darwin: PASS, linux: [PASS, FAIL]}` (`72c371e`).
- **Library fixes:** `RTCStats.timestamp` in ms (was µs); wrong-side
  rollback is InvalidStateError (a deliberate wrtc divergence, recorded
  above); ICE server URLs must be `scheme:host[:port]` (SyntaxError before
  the TURN credential check), without rejecting any host wrtc accepted.
- **Biggest remaining gaps (expectation reasons have root causes):**
  1. WebIDL shape (about 200): enumerability, receiver checks, operation
     `length`, missing `RTCCertificate`/`RTCIceCandidatePair`.
  2. Encodings and `get`/`setParameters` (about 70).
  3. Transports (about 68): `sender`/`receiver.transport` always null,
     `RTCIceTransport` lacks `getSelectedCandidatePair`/`role`,
     `pc.sctp` only after the answer. **Fixed in wave 2 (gap C):** 88 more
     subtests pass; see "Transports" in the wrtc compatibility spec for
     what's left and the divergences.
  4. Rollback doesn't remove transceivers it created; stopped transceiver
     state (about 45). **Fixed in gap E:** 13 more subtests pass (by then
     earlier waves had fixed most of the 45). A removed transceiver reads
     stopped and dissociated, and `getTransceivers()` is in JS order.
     `addTrack()` during an SRD reuses the offer's transceiver. A rejected
     m-section fires no `track`. See "Transceiver lifecycle and rollback"
     in the wrtc compatibility spec for the divergences and what's left
     (stream-only `track` events, 3 subtests).
  5. `generateCertificate` (22). **Fixed in gap G:** 37 more subtests pass.
     That includes idlharness's RTCCertificate subtests and the DTLS, stats
     and `getRemoteCertificates` tests that need a generated certificate.
     - In `expectations.json`, the subtests recorded as PASS on macOS went
       from 2054 to 2091 of 2267.
     - Those are expectation counts, not run counts. A run also passes some
       subtests recorded as flaky, so it counts more: 2069 at `8dc445e`,
       and 2106 on this branch.
     - `generateCertificate()`, `RTCCertificate` and
       `RTCConfiguration.certificates` follow Chrome.
     - One subtest still fails, as in Chrome: libwebrtc uses only the first
       of several certificates.

     See "Certificates" in the wrtc compatibility spec for the divergences.
  6. Remote tracks never mute (wrtc parity; about 20 plus hangs). **Fixed
     in wave 1D (`5b76b76`):** mute/unmute and `ended` as Chrome and the
     spec; see the `MediaStreamTrack` divergence entries.
  7. TCP candidates to Fetch "bad ports" aren't ignored (20; wrtc passes,
     though only because its connection never leaves 'new' in that test).
     **Fixed in wave 1F:** 19 pass; the two port-8001 subtests fail only on
     a Mac with a VPN interface. (Wave 3A: the cause is a listener on port
     8001, not the VPN; see "ICE and configuration".)
- **Native issues found, not fixed:** after PCs with
  `iceCandidatePoolSize: 255`, the next `new RTCPeerConnection()` blocks
  more than 60 s in `PeerConnectionFactory::Create` while the network
  thread binds sockets for 510 pooled sessions (wrtc too); libwebrtc
  rejects an empty TURN username/credential, which the spec allows
  (so does Chrome; kept, see "ICE and configuration").
- **DOM shim (wave 3, in parallel, 2026-11-21):** `test/wpt/dom-shim.ts`
  (harness only, no dependencies) gives the child a `document`, installed
  after testharness.js so it keeps its shell environment. Its media
  elements play `srcObject` through our `RTCVideoSink`/`RTCAudioSink`, so
  `loadedmetadata`, `playing`, `videoWidth`, `currentTime` and
  `requestVideoFrameCallback` follow decoded media. Its 2D canvas feeds
  `captureStream()` into an `RTCVideoSource`, and `drawImage(video)` converts
  the current I420 frame to RGBA, which `detectSignal` reads. The helper's
  video noise now comes from a canvas, as in a browser. jsdom, happy-dom
  and linkedom were rejected: their globals clash with the implementation's
  realm, and none plays media. A native canvas library would add a binary
  dependency for four drawing calls.
  - 30 skipped test ids and 7 skipped subtests now run, among them
    `getSynchronizationSources` (13 subtests, passing since 3C). Still
    skipped: WebGL (`relay-canvas`) and `<video src>` (`capture-video`).
    Audio `jitterBufferTarget` (3B) and the replaceTrack signal checks
    pass on it too.
  - **What a pass proves.** Video size, pixels and frame callbacks prove
    that decoded frames arrived. A reviewer broke the media on purpose
    (dropped frames, silent senders, a flat grey canvas, only the first
    frame kept), and every video-dependent pass failed.
    - Audio-only passes do not prove audio was received, only that the
      receive pipeline runs. A remote `RTCAudioSink` gets libwebrtc's
      playout silence before any packet arrives, and `getUserMedia`'s audio
      is silent anyway.
    - With the sender pushing nothing, these still pass:
      `remote-track-currentTime`'s audio subtest, `receiver-track-live`
      (4) and `getContributingSources [audio]`.
    - `currentTime`, for video too, proves one decoded frame. From the
      first frame it is wall-clock time while playing (the spec's
      MediaStream timeline).
  - Library gaps it exposed, recorded as expectation reasons:
    - `maxFramerate` isn't enforced: `PushedVideoSource` never calls
      `AdaptFrame`. **Fixed 2026-11-21** ("Video send path").
    - VP9 simulcast with two rids and no `scalabilityMode` encodes only
      rid 0; with `L1T1` both rids are encoded. AV1 with no mode encodes
      only rid 0, and with `L1T1` or `L1T3` on both rids libaom encodes
      neither. **2026-11-21:** the no-mode cases are libwebrtc's, as in
      Chrome; AV1 with a mode is fixed (SimulcastEncoderAdapter).
    - Three-layer simulcast from a 640x480 source encodes two layers.
      **2026-11-21:** libwebrtc's resolution-based layer limit, as in
      Chrome; documented.
    - A remote track's `getSettings()` returns fixed values
      (`channelCount`, width/height).
    - The sinks don't report RTP timestamps (`requestVideoFrameCallback`
      metadata has no `rtpTimestamp`).

### WPT fix wave 1 outcome (2026-11-20)
- **Merged:** 1A WebIDL shape (`212aba9`), 1D remote mute/unmute and
  `ended` (`5b76b76`, guard `b9bf208`), 1F small spec gaps (`01e4b6e`), 1B
  RTP encodings and parameters (`da447c4`). Each was reviewed, fixed and
  re-reviewed. Their wrtc divergences are recorded in the wrtc compatibility
  spec above.
- **Result (macOS, main `da447c4`):** WPT 1968 PASS of 2267 (WP-W baseline
  1719; wrtc 992), no unexpected results; 726 unit tests, 0 failing.
- **Production check:** the reviewers re-ran Whereby's mediasoup-client 3.19
  flows (Safari12/Chrome111 simulcast, setMaxSpatialLayer, maxBitrate, SVC)
  and compared encoded layers with main: identical. Through mediasoup-client
  3.19, VP9 SVC never reaches the encoder (`L1T1`) on either build, so
  Whereby's SVC reduction path is inert there.
- **Next:** wave 2 is transports (gap C), then transceiver lifecycle and
  rollback (gap E), sequentially; then certificates (G). The
  `ontrack`-for-a-rejected-m-section question goes with E. Rebuild tarballs
  and re-run the user's local stack after wave 1 (native changes).

### WPT fix wave 2 outcome (2026-11-20)
- **Merged:** 2C transports (`a666a79`), 2E transceiver lifecycle and
  rollback (`8dc445e`) and 2G certificates (`127d72f`). Each was reviewed,
  fixed and re-reviewed. Their divergences are in the "Transports",
  "Transceiver lifecycle and rollback" and "Certificates" sections of the
  wrtc compatibility spec.
- **Result (macOS, full runs):** WPT 2069 PASS of 2267 at `8dc445e`, 2105
  after 2G (wave 1 1968; wrtc 992), no unexpected results; 801 unit tests,
  0 failing; test:exit clean. (WP-W gap notes count subtests recorded as
  PASS in `expectations.json`, which leaves out flaky ones, so they're a
  little lower.)
- **Production check:** mediasoup-client 3.19 and Whereby read none of the
  new transport APIs; connection-level states and their timing are
  unchanged. 2E's reviewer ran mediasoup-client's Chrome111 and Safari12
  handlers against a fake server: recycled m-sections (consume → close →
  consume, and stopSending → produce, 20–30 cycles) keep one `track` per
  consumer on a live transceiver and a bounded `getTransceivers()`.
  `addTrack()` during an in-flight remote offer now reuses its transceiver
  (Whereby's `Session.addTrack` isn't gated on that), where before it added
  a second one whose audio the peer never got. Neither mediasoup-client nor
  Whereby passes `certificates` or calls `generateCertificate`; a PC
  without certificates gets the same native configuration and cost as
  before, and Safari12's `getConfiguration()` → `setConfiguration()` round
  trip still works (2G's reviewer ran it).
- **Hang check:** one of 14 runs of 2C's reviewer's stress script (300 PC
  pairs closed or GCed mid-negotiation) stalled with no output; 41 more on
  2C and 39 on its base, idle, under CPU load and during WPT, all
  finished. No deadlock path found by reading. Unexplained; watch for it.
- **Data channel flakes:** `bufferedAmount`'s negotiated
  "data.length on send" (the known cross-PC event order), and one-off
  timeouts in `send-blob-order` and `send-close-string`, are recorded
  flaky (`b6adf21`); an A/B of the data channel group showed them on the
  base before 2C (4 of 8 runs) and none on 2C (0 of 8).
- **Fixed (found in review, predated wave 2):** `RTCPeerConnection`'s
  `#remoteStreams` gained one `MediaStream` per distinct remote stream id
  and was never pruned, so a long-lived mediasoup recv transport grew
  without bound. It now holds them weakly: one object per id while a
  transceiver's associated streams or the app hold it (`a56eabb`). Edge,
  reviewed and accepted: a stream that only its own listeners keep (the
  app set `onaddtrack` and dropped it) can be collected once no receiver
  is associated with it; if its id comes back, the receiver joins a new
  object, whose `addtrack` nobody hears. webrtc-pc reuses "previously
  created" streams; Chrome (reportedly) only reuses ones a receiver holds.
  Whereby and mediasoup-client don't listen for addtrack/removetrack.
- **Linux x64 (gpubox, main `a22e4c6`, 2026-11-21):** WPT 2111 PASS, no
  unexpected results; unit tests 800 of 801 with 0 failing after fixing a
  race in `remote-mute.test.ts` (`40a1f91`: it listened for unmute only
  after `negotiate()` returned, but media can resume before); test:exit 61
  files ok.
- **Tarballs:** rebuilt from `a22e4c6` (native build `7474c8e6bf79`, all
  three platforms), smoke-installed on darwin-arm64.
- **Next:** the user's local-stack re-run on these tarballs. The WP-W gap
  list is closed apart from the noted "Not done" items.
- **Wave 3 (started 2026-11-21, user decisions):** 3A ICE and configuration,
  3B media/RTP, 3C data channels plus a Chrome-alignment audit ("match
  Chrome's behaviour for now"); SDP munging stays accepted (Whereby may
  need it); H264/H265 left. Queued after wave 3 merges: standard events
  switch from own-property payloads to the spec's prototype getters (user:
  yes; production reads fields directly, checked in mediasoup-client 3.19,
  Whereby core/media/assistant-sdk and rtcstats; the nonstandard sink
  `data`/`frame` events keep own properties). In parallel: a WPT-only DOM
  shim (`<video>`/`<audio>` playing a MediaStream, backed by our sinks) so
  the browser-element tests run.

### WPT fix wave 3 outcome (2026-11-21)
- **Merged:** 3B media/RTP, 3A ICE and configuration, 3C data channels plus
  cross-PC event order and the Chrome audit, 3D the WPT DOM shim. Each was
  reviewed, fixed and re-reviewed; divergences are in the wrtc
  compatibility spec ("Media and RTP", "ICE and configuration", and the
  3C entries). Also merged: sinks stop themselves when their track's
  source ends (`614d5e3`, `cb98638`; user request from the local stack)
  and `-z nodelete` on Linux (a worker-only load segfaulted at worker
  exit; PLAN.md).
- **Result:** WPT on macOS 2178 PASS of 2337 (the DOM shim runs 30 more
  test ids; 2131 of 2267 before it), Linux x64 2139 of 2267 before the
  shim; no unexpected results. 853 unit tests, 0 failing; test:exit clean
  on macOS and Linux x64.
- **Production-visible changes** (re-test on the local stack):
  `iceConnectionState` never 'failed'/'completed' (Chrome; Whereby's
  P2PRtcManager restarts 2 s after 'disconnected' when a connection never
  connected, as with Chrome clients); Whereby's 400 ms `jitterBufferTarget`
  now applies; stream-only `track` events and `addstream`/`removestream`;
  remote track label 'remote audio'/'remote video'; one process-wide event
  order across PCs; sinks release the process when their source ends.
- **Open:**
  - Send path (assistant-sdk customers will send video at many sizes):
    `maxFramerate`/adaptation ignored for pushed `RTCVideoSource` frames;
    3-layer simulcast from <=640x480 sends 2 layers (libwebrtc's
    resolution limit); VP9 two-rid simulcast needs `scalabilityMode`; AV1
    with `scalabilityMode` encodes nothing. A test assistant is to be
    scoped with the user. **Done 2026-11-21** (adaptation and AV1 fixed,
    the rest documented as Chrome's): see "Video send path" in the wrtc
    compatibility spec. Video senders keep the pushed size by default
    (user decision), so single-layer senders behave as before apart from
    `maxFramerate`.
  - Events switch to the spec's prototype getters (user: yes). **Done
    2026-11-21:** see "Events" in the wrtc compatibility spec.
  - The V8 wasm crash in workers: a Node 24/25/26 bug, not ours (PLAN.md,
    "V8 wasm crash in workers"); documented for consumers in
    `docs/deployment.md`. Recheck on new Node releases.
  - Known flakes recorded in the expectations (the libwebrtc handover
    race; pc1's early ICE 'checking' in `RTCIceTransport.html?rest`, first
    put down to op completions vs events: on 2026-11-21 op completions
    proved to be in the shared order already, and the JS layer's own
    queued tasks joined it, but that flake is a libwebrtc race; see the
    3C entry in the wrtc compatibility spec).

### WP-D: data channel spec layer (M2)
- **Owns:** `lib/RTCDataChannel.ts`, `RTCDataChannelEvent`, tests.
- **`RTCDataChannel`:**
  - `binaryType`, with `arraybuffer` as the default and `blob` via Node's
    `Blob`
  - `send()` for string, ArrayBuffer, view and Blob, with **Blob sends kept
    in order** relative to later sends
  - `bufferedAmount` tracked in JS (add on `send`, subtract `dc:bufferedamount.sent`)
  - `bufferedAmountLowThreshold` and `bufferedamountlow`
  - the `open`, `close`, `closing` and `error` events
  - the init-dict attributes
- Uses WP-P's PC through an internal hook, so it doesn't edit
  `RTCPeerConnection.ts`.

### WP-G: getUserMedia, i420 helpers, portRange (M2)
- Small items per the compatibility spec. `getUserMedia` needs a timer
  feeding synthetic frames and samples.
- i420 helpers done 2026-11-22: "`i420ToRgba` / `rgbaToI420`" in the
  compatibility spec.

## Process

- WP0 is done by the coordinator before anything is delegated.
- **Each delegated WP gets:**
  - its own worktree, set up with `scripts/setup-worktree.sh`
  - a brief linking its section here, `PLAN.md` and `CONTRIBUTING-AGENTS.md`
  - its file-ownership list
  - the rule that contract changes are proposed to the coordinator, never
    made unilaterally
- **On return:**
  - the coordinator merges and runs macOS tests, the Linux Docker build and
    tests, and (from M2) WPT
  - a **fresh reviewer agent** reviews the diff
  - the findings are fixed, and the reviewer confirms
- Wave A's two WPs touch disjoint files once WP0 has landed. WP-R tests
  against a stub track until WP-M merges, then re-runs with real tracks
  before wave B starts.

## Decisions from the user (2026-11-18)

- Priorities: sources and sinks first, then maybe `getUserMedia`. The i420
  helpers and `portRange` are only for export compatibility.
- TypeScript, compiled with `tsc`.
- No CI. Verify locally on macOS, and via Docker for Linux.
- Keep wrtc's `nonstandard` API shape.
- The plan is reviewed by an independent agent before work starts. Done:
  revision 2 incorporates that review.
