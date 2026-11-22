<!--
Draft issue for issues.webrtc.org (component: Internals > Media > Video).
Not filed. Written 2026-11-19 from this repo's investigation. Line numbers
are upstream M150 (branch-heads/7871 at 05e02da) and upstream main at 9bedb7b388b6d6204a7f6621596dd5a348df686c
(2026-11-19), marked as such. Our workaround: src/sink_reassert.cc
(PLAN.md "Gotchas").
-->

# A packet for a signaled SSRC in the unsignaled path nulls that stream's sink for good (ReCreateDefaultReceiveStream calls SetSink(ssrc, nullptr))

## Summary

`WebRtcVideoReceiveChannel::ReCreateDefaultReceiveStream` calls
`SetSink(ssrc, default_sink_)` even when it failed to create the default
stream because a *signaled* stream for that SSRC already exists. With no
unsignaled receiver, `default_sink_` is nullptr, so this clears the
signaled stream's sink. The stream keeps receiving and decoding (stats look
healthy, `framesDecoded` climbs) but logs "VideoReceiveStreamInterface not
connected to a VideoSink" for every frame, and the remote video track gets
no frames, ever: `VideoRtpReceiver` only sets the sink again when its SSRC
changes.

In M150 a renegotiation that changes a video m-section's decoders (e.g.
sendrecv to recvonly after `removeTrack`) reaches this through a race with
an RTP packet in flight. Under CPU load about 1 such renegotiation in 180
loses the track's video permanently.

## Affected versions

- M150 (`branch-heads/7871` at
  05e02da9d17f5844e84800fa524dd1eb57d7014c): same code. Reproduced on an
  M150 build that doesn't change these files (the `webrtc-sdk/webrtc`
  fork's `m150_release` at a545de45259b47dfac5f3635863e47cb601f1bb2).
- Upstream main before 6ded79875c0aef8e08d7e79a44744736fc96cf6e ("Avoid
  recreating VideoReceiveStream on decoder updates", main@{#48423},
  2026-08-25), presumably: same code.
- Upstream main as of 2026-11-19: 6ded798 removed the trigger we hit, but
  the `SetSink(ssrc, default_sink_)` after a failed `AddRecvStream` is
  still there (`media/engine/webrtc_video_engine.cc:3532-3546` on main),
  and so is `VideoRtpReceiver`'s early return. Any other way a packet for
  a signaled SSRC reaches the unsignaled path nulls the sink the same way.
  We have no repro on main.

## Repro (M150)

Two PeerConnections in one process (Node, with this repo's bindings),
each sending the other video:

1. Negotiate, wait until A has decoded some of B's video.
2. On A, `removeTrack` the video sender and renegotiate with A offering.
   A's video transceiver goes sendrecv -> recvonly; its decoder list
   changes, so its video receive stream is recreated.
3. Put a sink on A's remote video track and wait for a frame.

With the CPU saturated (a dozen `yes > /dev/null`), step 3 times out in
about 1 run in 180 (this repo's `scripts/stress-removetrack-race.mjs`,
minus the workaround). It never failed on an idle machine. In a failing
run libwebrtc's log (info) shows, on the worker thread, right after the
renegotiation:

```
(webrtc_video_engine.cc:3401): Could not create default receive stream.
(webrtc_video_engine.cc:3208): SetSink: ssrc:4109303920 nullptr
```

followed by "VideoReceiveStreamInterface not connected to a VideoSink." for
every decoded frame, and no later `SetSink: ssrc:4109303920 (ptr)`.

## Root cause (line numbers at M150, 05e02da)

1. SLD/SRD of the recvonly offer/answer changes the receive codecs, and
   `WebRtcVideoReceiveStream::RecreateReceiveStream`
   (`media/engine/webrtc_video_engine.cc:3718-3752`) destroys the receive
   stream and creates a new one, on the worker.
2. `Call::DeliverRtpPacket` resolves each packet's sink on the network
   thread (`call/call.cc:1447-1453`) and posts the delivery to the worker
   (:1460-1468). A packet resolved to the old stream before step 1 is
   delivered after it: `IsValidSink` fails (:1493) and the packet goes to
   the undemuxable handler (:1498),
   `WebRtcVideoReceiveChannel::MaybeCreateDefaultReceiveStream`
   (`webrtc_video_engine.cc:3310-3378`).
3. `ReCreateDefaultReceiveStream` (:3381-3412) tries to add a default
   stream for the packet's SSRC. `AddRecvStream` fails, because that SSRC
   has a signaled stream ("Could not create default receive stream.",
   :3401), but the function carries on and calls
   `SetSink(ssrc, default_sink_)` (:3411). `default_sink_` is nullptr (no
   unsignaled receiver), so the signaled stream's sink is now nullptr.
4. `VideoRtpReceiver` owns that sink. It sets it in
   `GetRestartFunctionForMediaChannel_w`, which returns early when the
   SSRC hasn't changed (`pc/video_rtp_receiver.cc:140-141`), so later
   renegotiations never restore it.

On main, `ReCreateDefaultReceiveStream` is at
`media/engine/webrtc_video_engine.cc:3516-3547` (the `SetSink` at :3546),
the early return in `pc/video_rtp_receiver.cc:148`, and
`Call::DeliverRtpPacket` now resolves and delivers on the network thread
(`call/call.cc:1266-1316`), calling the undemuxable handler at :1305.

## Suggested fix

In `ReCreateDefaultReceiveStream`, don't touch the sink (or the base
minimum playout delay) of a stream it didn't create: return early when
`AddRecvStream` fails. More defensively, `MaybeCreateDefaultReceiveStream`
could drop packets whose SSRC already has a signaled receive stream, since
such a packet can only be stale.

A regression test in `webrtc_video_engine_unittest.cc`: add a signaled
receive stream for SSRC X with a sink, then feed the channel a packet for X
such that it reaches the unsignaled path (with `FakeCall`, by having
delivery report X as undemuxable), and check the stream's sink is still
the original one.

## Workaround (for other embedders)

After every successful SLD/SRD, set each video receiver's sink again, on
the worker, after any packet already in flight (we post through the
network thread, then the worker): for each video receiver, the signaled
SSRC to its `VideoRtpTrackSource::sink()`, exactly what
`GetRestartFunctionForMediaChannel_w` sets. This needs libwebrtc's internal
classes (`RtpReceiverProxyWithInternal`, `VideoRtpReceiver`,
`VideoTrackSourceProxyWithInternal`, `VideoRtpTrackSource`). With it, 0
failures in 1,620 runs under load; the race still happened 20 times, and
each time the sink was restored within 4 ms.
