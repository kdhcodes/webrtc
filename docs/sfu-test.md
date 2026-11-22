# Testing against a local mediasoup SFU

`test/sfu/` runs our library under **mediasoup-client** (the `Safari12`
handler, which `@whereby.com/media` uses in Node, and `Chrome111`) against a
real **mediasoup** worker on this machine: data channels (correctness and
throughput) and media (audio, 3-layer VP8 simulcast, layer switching, the
cost of a consume round). The scripts are opt-in: `pnpm test` and
`test:exit` don't run them, and mediasoup isn't a dependency of the repo.

## Setup

Install mediasoup and mediasoup-client in a scratch directory **outside the
repo**. Two stacks are worth having, because mediasoup 3.20 replaced usrsctp
with its own SCTP stack and renamed the SCTP options, and mediasoup-client
3.20+ only speaks the new parameters:

```sh
# usrsctp; mediasoup-client 3.19.0 is the version @whereby.com/media pins
mkdir -p ~/scratch/ms319 && cd ~/scratch/ms319
echo '{"private":true,"allowScripts":{"mediasoup":true}}' > package.json
npm i mediasoup@3.19.22 mediasoup-client@3.19.0

# current: mediasoup's built-in SCTP stack
mkdir -p ~/scratch/ms332 && cd ~/scratch/ms332
echo '{"private":true,"allowScripts":{"mediasoup":true}}' > package.json
npm i mediasoup@3.32.2 mediasoup-client@3.26.0
```

- mediasoup's postinstall downloads a prebuilt `mediasoup-worker` (darwin-arm64
  included). npm 11 skips install scripts not listed in `allowScripts`, which
  leaves no worker. Check `node_modules/mediasoup/worker/out/Release/mediasoup-worker`.
- Our library comes from this checkout (`lib/index.ts`; `WRTC_ENTRY` overrides
  it), so build first (`pnpm run build`).

## Running

From the checkout, in the devenv shell (Node 24), on a Mac under
`caffeinate -i`:

```sh
export MEDIASOUP_DIR=~/scratch/ms319        # or ~/scratch/ms332
node test/sfu/smoke.mjs                     # one message A -> SFU -> B
node test/sfu/dc-correctness.mjs [--handler Chrome111] [--send-buffer 0]
node test/sfu/dc-throughput.mjs --size 64k [--strategy one] [--unordered] [--sfu-rwnd 256k]
node test/sfu/dc-throughput-matrix.mjs ~/scratch/ms319,~/scratch/ms332 --runs 2
node test/sfu/media.mjs [--handler Chrome111] [--max 20] [--json]
node test/sfu/video-sizes.mjs --content ramp [--sizes 640x480,1280x720] [--cap 300] [--settings ONE]
```

- mediasoup listens on `127.0.0.1` (`SFU_LISTEN_IP` changes it). Our clients
  pair their en0 host candidate with it, over lo0. The scripts print the
  selected pairs and flag a VPN one (this Mac's VPN is `utun`, 10.99.0.x).
- `smoke.mjs` and `dc-correctness.mjs` run the SFU and both clients in one
  process. `dc-throughput.mjs` and `media.mjs` run each client in a child
  process of its own (its own network thread), with signaling over HTTP on
  127.0.0.1. The driver never loads our addon.
- Every script exits on its own when done. `media.mjs` fails if a client
  process is still alive 15 s after closing.

## What they check

- **`dc-correctness.mjs`:**
  - DataProducer -> SFU -> DataConsumer in both directions: ordered,
    unordered, `maxRetransmits: 0` and `maxPacketLifeTime`.
  - Exact content and order of strings (empty, multi-byte, exactly
    `maxMessageSize` bytes) and binary (empty, 1 B to `maxMessageSize`, an
    offset view, an ArrayBuffer, a DataView).
  - A message over `maxMessageSize` throws TypeError and the channel stays
    open.
  - 200 channels at once.
  - Closing: a client closes its DataProducer or DataConsumer; the SFU closes
    a DataConsumer, a DataProducer or a transport; a client closes its
    transport. It records the events each RTCDataChannel fires, and checks
    for uncaught errors.
  - The SFU's `sctpSendBufferSize` is 4 MiB by default here; see the
    findings.
- **`dc-throughput.mjs`:** `bench/datachannel.mjs`'s burst and one-at-a-time
  pacing, through the SFU. It reports:
  - MiB/s and msg/s
  - messages the SFU dropped (`sctpsendbufferfull`)
  - gaps of 50 ms or more (400 ms ones are SCTP retransmission timeouts)
  - bytes sent and received on each leg (client to SFU, SFU to client), from
    both ends' stats
  - kernel UDP socket-buffer drops (`netstat -s -p udp`, system-wide)
  - the worker's CPU
- **`media.mjs`:**
  - Produces with Whereby's `AUDIO_SETTINGS` and `VIDEO_SETTINGS_HD`: a
    440 Hz tone, and 1280x720 at 30 fps as 3-layer VP8 simulcast.
  - Checks the tone's frequency and level at an RTCAudioSink.
  - `setPreferredLayers` 0/1/2/0/2 gives 320x180, 640x360 and 1280x720 at an
    RTCVideoSink.
  - The producer's `setMaxSpatialLayer` 0 then 2 (mediasoup-client's
    `sender.getParameters()`/`setParameters()` round trip) gives 320x180,
    then 1280x720 again, with every layer back at its original size.
  - Checks getStats on both clients, mediasoup's producer and consumer
    stats, and the candidate pairs.
  - Then three series on a fresh receive transport, adding consumers one at
    a time up to `--max`: video paused, video live, audio live. Each
    `consume()` is timed (wall, process CPU, and SRD/createAnswer/SLD
    separately), and it checks that every live consumer is decoding.

- **`video-sizes.mjs`:** the send path at many source sizes (160x120 up
  to 1920x1080, and odd ones): one RTCVideoSource producer per size, in a
  child process with its own SFU, with Safari12 and Whereby's
  `VIDEO_SETTINGS_HD`. Per layer: the size and frame rate the sender
  encoded, its bitrate and quality limitation, and the SFU's receive
  bitrate; plus the producer process's CPU. `--cap` limits the send
  transport's incoming bitrate on the SFU (`setMaxIncomingBitrate`, so a
  REMB cap) to see the encoder adapt, `--maxfr` and `--apply-maxbitrate`
  set those through `setParameters()`, `--degradation balanced` sets a
  degradation preference (senders default to 'maintain-resolution'), and
  `--settings ONE` sends a single layer. `--content` picks what is pushed: `noise` (the default,
  16x16 random blocks, the hard case) or `ramp` (a panning luma ramp,
  easy like a steady camera). The tables in SPEC-LAYER-PLAN.md, "Video
  send path", are `--content ramp`, plus `--maxfr 15`,
  `--apply-maxbitrate` and `--settings ONE --cap 300 --warmup 25` (with
  and without `--degradation balanced`) at `--sizes 1280x720` (and
  `1920x1080` for the last).

## Results (2026-11-20, macOS arm64, main at 8a8f9f3)

Every check passes on both stacks with both handlers: dc-correctness 16/16
and media 17/17, with no uncaught errors and every process exiting on its
own.

Data channel throughput. Each client is in its own process, mediasoup is on
127.0.0.1, and the SFU uses default options:

| | 1 KiB burst | 1 KiB one | 64 KiB burst | 64 KiB one |
|---|---|---|---|---|
| mediasoup 3.19 (usrsctp) | 40 MiB/s | 36 MiB/s | 64-70 MiB/s | 69-70 MiB/s |
| mediasoup 3.32 | 41 MiB/s | 36 MiB/s | 31-57 MiB/s, 400 ms stalls | 57-62 MiB/s, stalls |
| 3.32, `sctpMaxReceiverWindowBufferSize` 256 KiB | 41 MiB/s | | 50-70 MiB/s, no stalls | |
| for comparison: ours to ours, two processes (PLAN.md) | 43 MiB/s | | 125 MiB/s | |

- At 64 KiB, the single-threaded worker is the limit, at about 100% CPU.
- Neither client process dropped a packet on receive.

Consume round on one receive transport, mediasoup 3.19 with Safari12. Times
are means in ms. The SDP column is SRD + createAnswer + SLD; the full
`consume()` also includes the RPC and the SFU's own consume:

| consumers | video, SDP | video, full `consume()` | audio, SDP | audio, full `consume()` |
|---|---|---|---|---|
| 1 | 2.0 | 5.4 | 0.9 | 3.2 |
| 2-5 | 3.0 | 4.7 | 0.9 | 2.2 |
| 6-10 | 2.8 | 4.5 | 1.3 | 2.6 |
| 11-15 | 3.8 | 5.7 | 1.8 | 3.1 |
| 16-20 | 4.6 | 6.5 | 2.5 | 3.9 |

- The SDP steps grow linearly with the m-sections: about +0.15 ms per
  consumer for video.
- Process CPU per `consume()` is 5 to 10 ms. mediasoup 3.32 and Chrome111
  are within noise of this.

## Findings (mediasoup behaviour, not library bugs)

- **mediasoup drops DataConsumer messages when its SCTP send buffer is
  full.** It emits `sctpsendbufferfull` and still counts the message as
  sent. With 3.19's default `sctpSendBufferSize` (256 KiB), back-to-back
  near-max messages (256 KiB) are lost on the way to the consumer, and so
  are a few 64 KiB messages in a fast burst. There's no backpressure from
  consumer to producer. 3.32's default buffer is 2 MB.
- **mediasoup 3.32 with a dcSCTP sender:** the SFU advertises a 5 MiB
  receive window, so our sender's congestion window outgrows the worker's
  UDP receive buffer. The kernel drops packets at the worker's socket (0.1
  to 7% of the client-to-SFU leg), and dcSCTP recovers through 400 ms
  retransmission timeouts. This is the "Data channel throughput" gotcha in
  PLAN.md, on the SFU's socket instead of ours.
  - With mediasoup on the en0 address instead of 127.0.0.1, 1 KiB collapsed
    to 0.5 to 0.8 MiB/s.
  - `sctpMaxReceiverWindowBufferSize: 262144` removes the drops (24 MiB/s
    on en0, about 41 at 1 KiB and 50 to 70 at 64 KiB on 127.0.0.1).
  - usrsctp-era mediasoup (3.19) never dropped.
  - Chrome's dcSCTP should behave the same, but that's untested.
- **Closing on mediasoup 3.20+:** a client's `dataProducer.close()` leaves
  our channel in `closing` until the app closes the DataProducer on the SFU.
  The built-in stack doesn't reset its side of the stream in response. On
  3.19 the channel reaches `closed` within 1 ms.
- **How closes look on our RTCDataChannel:**

  | What happens | Events |
  |---|---|
  | Local close | `close`; no `closing`, as the spec says |
  | The SFU closes a DataConsumer or DataProducer (3.19 and 3.32) | `closing`, `close` |
  | The SFU closes the transport, 3.19 | `closing`, `close` |
  | The SFU closes the transport, 3.32 | `closing`, `error` (`sctp-failure`, cause 12, "User-Initiated Abort"), `close` |
  | Local `pc.close()` (`transport.close()`) | `readyState` becomes `closed` with no events, as the spec says; mediasoup-client handles it |

- **mediasoup-client 3.19's `Safari12` sends simulcast by SDP munging**
  (`a=ssrc-group:SIM`, no rids). It never applies the encodings'
  `maxBitrate`, so libwebrtc's default layer bitrates apply: the top layer
  ran at about 1.75 Mbps against a 1 Mbps `maxBitrate`. 3.20+ and
  `Chrome111` use `sendEncodings` with rids, and do apply it.
- Reaching spatial layer 2 took 16 to 18 s on mediasoup 3.19, against 0.75 s
  on 3.32: the downlink bandwidth estimate ramps more slowly.

## Open questions and next steps

- Whereby's production SFU version and SCTP options are unknown. If it's
  3.20 or later with the default receive window, a Node client sending bulk
  data could hit the stall above.
- Not tested: ICE restart, `replaceTrack` or `pause`/`resume` producer
  through the SFU, TCP candidates, or real network loss. (No H264: we
  never offer it.)
