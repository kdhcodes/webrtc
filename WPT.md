# WPT results

Web Platform Tests `webrtc/` (`test/wpt/`) on linux-x64, 2026-11-24, at [`9eda166`](https://github.com/kdhcodes/webrtc/commit/9eda166c7ffef59298dd148d42e54f8317b0ec01):
**2204 / 2337 subtests pass.**

"Fail" is every subtest that didn't pass: FAIL, TIMEOUT, NOTRUN, SKIP or
PRECONDITION_FAILED. A failure listed without a reason has none recorded
in `test/wpt/expectations.json`; one marked **unexpected** differs from it.

| Section | Pass | Fail | Total |
|---|---:|---:|---:|
| [Peer connection](#peer-connection) | 801 | 20 | 821 |
| [RTP](#rtp) | 238 | 5 | 243 |
| [Stats](#stats) | 119 | 1 | 120 |
| [Data channels](#data-channels) | 212 | 2 | 214 |
| [ICE and DTLS](#ice-and-dtls) | 142 | 14 | 156 |
| [Codecs](#codecs) | 83 | 46 | 129 |
| [Simulcast](#simulcast) | 31 | 22 | 53 |
| [Protocol and IDL](#protocol-and-idl) | 578 | 23 | 601 |
| **Total** | **2204** | **133** | **2337** |

## Peer connection

<details>
<summary>801 / 821 subtests pass, in 90 tests</summary>

| Test | Passed | Status |
|---|---:|---|
| `RTCConfiguration-bundlePolicy.html` | 17 / 18 | OK |
| `RTCConfiguration-certificates.html` | 1 / 1 | OK |
| `RTCConfiguration-iceCandidatePoolSize.html` | 7 / 7 | KILLED |
| `RTCConfiguration-iceServers.html?interop-2026` | 6 / 6 | OK |
| `RTCConfiguration-iceServers.html?rest` | 110 / 114 | OK |
| `RTCConfiguration-iceTransportPolicy.html?interop-2026` | 3 / 3 | OK |
| `RTCConfiguration-iceTransportPolicy.html?rest` | 15 / 19 | TIMEOUT |
| `RTCConfiguration-rtcpMuxPolicy.html` | 10 / 10 | OK |
| `RTCConfiguration-validation.html` | 1 / 1 | OK |
| `RTCError.html?interop-2026` | 21 / 21 | OK |
| `RTCError.html?rest` | 0 / 0 | TIMEOUT |
| `RTCPeerConnection-GC.https.html` | 2 / 2 | OK |
| `RTCPeerConnection-SLD-SRD-timing.https.html` | 1 / 1 | OK |
| `RTCPeerConnection-add-track-no-deadlock.https.html` | 1 / 1 | OK |
| `RTCPeerConnection-addIceCandidate-connectionSetup.html` | 3 / 3 | OK |
| `RTCPeerConnection-addIceCandidate-timing.https.html` | 4 / 4 | OK |
| `RTCPeerConnection-addIceCandidate.html?interop-2026` | 2 / 2 | OK |
| `RTCPeerConnection-addIceCandidate.html?rest` | 34 / 34 | OK |
| `RTCPeerConnection-addTcpIceCandidate.html` | 83 / 83 | OK |
| `RTCPeerConnection-addTrack.https.html` | 12 / 12 | OK |
| `RTCPeerConnection-addTransceiver-renegotiation.https.html` | 4 / 4 | OK |
| `RTCPeerConnection-addTransceiver.https.html?interop-2026` | 4 / 4 | OK |
| `RTCPeerConnection-addTransceiver.https.html?rest` | 16 / 16 | OK |
| `RTCPeerConnection-canTrickleIceCandidates.html` | 3 / 3 | OK |
| `RTCPeerConnection-candidate-in-sdp.https.html` | 1 / 1 | OK |
| `RTCPeerConnection-connectionState.https.html` | 8 / 8 | OK |
| `RTCPeerConnection-constructor.html` | 22 / 22 | OK |
| `RTCPeerConnection-createAnswer.html` | 3 / 3 | OK |
| `RTCPeerConnection-createOffer.html?interop-2026` | 4 / 4 | OK |
| `RTCPeerConnection-createOffer.html?rest` | 4 / 4 | OK |
| `RTCPeerConnection-description-attributes-timing.https.html` | 4 / 4 | OK |
| `RTCPeerConnection-description-candidate-replaced.https.html` | 4 / 4 | OK |
| `RTCPeerConnection-explicit-rollback-iceGatheringState.html` | 6 / 6 | OK |
| `RTCPeerConnection-generateCertificate.html` | 11 / 11 | OK |
| `RTCPeerConnection-getTransceivers.html` | 1 / 1 | OK |
| `RTCPeerConnection-helper-test.html` | 2 / 2 | OK |
| `RTCPeerConnection-iceConnectionState-disconnected.https.html` | 1 / 2 | OK |
| `RTCPeerConnection-iceConnectionState.https.html` | 14 / 14 | OK |
| `RTCPeerConnection-iceGatheringState.html?interop-2026` | 2 / 2 | OK |
| `RTCPeerConnection-iceGatheringState.html?rest` | 9 / 9 | OK |
| `RTCPeerConnection-onicecandidateerror.https.html` | 1 / 2 | TIMEOUT |
| `RTCPeerConnection-onnegotiationneeded.html` | 24 / 24 | OK |
| `RTCPeerConnection-onsignalingstatechanged.https.html` | 3 / 3 | OK |
| `RTCPeerConnection-ontrack.https.html` | 9 / 9 | OK |
| `RTCPeerConnection-operations.https.html?interop-2026` | 18 / 18 | OK |
| `RTCPeerConnection-operations.https.html?rest` | 10 / 10 | OK |
| `RTCPeerConnection-plan-b-is-not-supported.html` | 1 / 1 | OK |
| `RTCPeerConnection-pranswer-description-types.html` | 2 / 2 | OK |
| `RTCPeerConnection-remote-track-currentTime.https.html` | 4 / 4 | OK |
| `RTCPeerConnection-remote-track-mute.https.html` | 4 / 6 | OK |
| `RTCPeerConnection-remote-track-properties.https.html?interop-2026` | 2 / 4 | OK |
| `RTCPeerConnection-remote-track-properties.https.html?rest` | 4 / 4 | OK |
| `RTCPeerConnection-removeTrack.https.html` | 14 / 14 | OK |
| `RTCPeerConnection-restartIce-onnegotiationneeded.https.html` | 1 / 1 | OK |
| `RTCPeerConnection-restartIce.https.html` | 25 / 28 | OK |
| `RTCPeerConnection-setDescription-transceiver.html` | 6 / 6 | OK |
| `RTCPeerConnection-setLocalDescription-answer.html` | 7 / 7 | OK |
| `RTCPeerConnection-setLocalDescription-offer.html?interop-2026` | 1 / 1 | OK |
| `RTCPeerConnection-setLocalDescription-offer.html?rest` | 7 / 7 | OK |
| `RTCPeerConnection-setLocalDescription-parameterless.https.html?interop-2026` | 1 / 1 | OK |
| `RTCPeerConnection-setLocalDescription-parameterless.https.html?rest` | 12 / 12 | OK |
| `RTCPeerConnection-setLocalDescription-pranswer-parameterless.html` | 5 / 5 | OK |
| `RTCPeerConnection-setLocalDescription-pranswer.html` | 4 / 4 | OK |
| `RTCPeerConnection-setLocalDescription-rollback.html` | 6 / 6 | OK |
| `RTCPeerConnection-setLocalDescription.html` | 3 / 3 | OK |
| `RTCPeerConnection-setRemoteDescription-answer.html` | 3 / 3 | OK |
| `RTCPeerConnection-setRemoteDescription-nomsid.html` | 1 / 1 | OK |
| `RTCPeerConnection-setRemoteDescription-offer.html?interop-2026` | 2 / 2 | OK |
| `RTCPeerConnection-setRemoteDescription-offer.html?rest` | 13 / 13 | OK |
| `RTCPeerConnection-setRemoteDescription-pranswer.html` | 4 / 4 | OK |
| `RTCPeerConnection-setRemoteDescription-replaceTrack.https.html` | 6 / 6 | OK |
| `RTCPeerConnection-setRemoteDescription-rollback.html?interop-2026` | 2 / 2 | OK |
| `RTCPeerConnection-setRemoteDescription-rollback.html?rest` | 20 / 20 | OK |
| `RTCPeerConnection-setRemoteDescription-tracks.https.html` | 14 / 14 | OK |
| `RTCPeerConnection-setRemoteDescription.html` | 7 / 7 | OK |
| `RTCPeerConnection-transceivers.https.html` | 44 / 44 | OK |
| `RTCPeerConnection-video-element-loadedmetadata-event.html` | 1 / 1 | OK |
| `RTCPeerConnection-videoDetectorTest.html` | 1 / 1 | OK |
| `RTCTrackEvent-constructor.html` | 7 / 7 | OK |
| `RTCTrackEvent-fire.html` | 9 / 9 | OK |
| `RollbackEvents.https.html` | 8 / 8 | OK |
| `legacy/RTCPeerConnection-createOffer-offerToReceive.optional.html` | 18 / 18 | OK |
| `legacy/munge-dont.html` | 3 / 5 | OK |
| `legacy/onaddstream.https.html` | 1 / 1 | OK |
| `legacy/simplecall_callbacks.optional.https.html` | 1 / 1 | OK |
| `no-media-call.html` | 1 / 1 | OK |
| `promises-call.html` | 1 / 1 | OK |
| `simplecall-no-ssrcs.https.html` | 1 / 1 | OK |
| `simplecall.https.html` | 1 / 1 | OK |
| `toJSON.html` | 2 / 2 | OK |

Not passing (or not as expected):

- `RTCConfiguration-bundlePolicy.html` `"balanced" bundle policy should gather ICE candidates for each media type in use`: FAIL: libwebrtc doesn't make the later m-sections of a kind bundle-only in a 'balanced' initial offer (JSEP 4.1.1), so it gathers on every m-section's transport; Chromium 159 (Playwright) fails it the same way
- `RTCConfiguration-iceCandidatePoolSize.html`: test status KILLED: native: after two PCs with iceCandidatePoolSize 255, the next new RTCPeerConnection() blocks in PeerConnectionFactory::Create for over 60 s while the network thread binds UDP sockets for the 510 pooled sessions (BasicPortAllocatorSession::OnNetworksChanged); wrtc is killed here too
- `RTCConfiguration-iceServers.html?rest` `new RTCPeerConnection(config) - with turn server and empty string username should succeed`: FAIL: libwebrtc rejects a TURN server with an empty username or credential (InvalidAccessError, ice_server_parsing.cc); Chrome 159 passes the strings through Blink and throws the same, as does wrtc
- `RTCConfiguration-iceServers.html?rest` `new RTCPeerConnection(config) - with turns server and empty string username should succeed`: FAIL: libwebrtc rejects a TURN server with an empty username or credential (InvalidAccessError, ice_server_parsing.cc); Chrome 159 passes the strings through Blink and throws the same, as does wrtc
- `RTCConfiguration-iceServers.html?rest` `setConfiguration(config) - with turn server and empty string username should succeed`: FAIL: libwebrtc rejects a TURN server with an empty username or credential (InvalidAccessError, ice_server_parsing.cc); Chrome 159 passes the strings through Blink and throws the same, as does wrtc
- `RTCConfiguration-iceServers.html?rest` `setConfiguration(config) - with turns server and empty string username should succeed`: FAIL: libwebrtc rejects a TURN server with an empty username or credential (InvalidAccessError, ice_server_parsing.cc); Chrome 159 passes the strings through Blink and throws the same, as does wrtc
- `RTCConfiguration-iceTransportPolicy.html?rest`: test status TIMEOUT
- `RTCConfiguration-iceTransportPolicy.html?rest` `Changing iceTransportPolicy from "all" to "relay" causes an ICE restart which should fail, with no new candidates`: TIMEOUT: waits for iceConnectionState 'failed', which Chrome never reports (a failed ICE transport reads 'disconnected', as ours now does); libwebrtc also keeps the previous generation's working pair after the restart 'relay' prompts, so neither side fails; Chrome 159 times out the same
- `RTCConfiguration-iceTransportPolicy.html?rest` `Changing iceTransportPolicy from "all" to "relay" on the answerer has no effect on a subsequent offer/answer`: NOTRUN: not run: the subtest before times out (as in Chrome 159)
- `RTCConfiguration-iceTransportPolicy.html?rest` `Changing iceTransportPolicy from "all" to "relay", and back to "all" prompts an ICE restart`: NOTRUN: not run: the subtest before times out (as in Chrome 159)
- `RTCConfiguration-iceTransportPolicy.html?rest` `Changing iceTransportPolicy from "relay" to "all" causes an ICE restart which should succeed`: NOTRUN: not run: the subtest before times out (as in Chrome 159)
- `RTCError.html?rest`: test status TIMEOUT
- `RTCPeerConnection-iceConnectionState-disconnected.https.html` `ICE restart when ICE is disconnected results in checking, then connected`: FAIL: libwebrtc never resets has_been_writable_ (P2PTransportChannel::ComputeIceTransportState), so after the restart the transport stays 'disconnected' until a new pair works, then 'connected'; Chrome 159 fails the same
- `RTCPeerConnection-onicecandidateerror.https.html`: test status TIMEOUT
- `RTCPeerConnection-onicecandidateerror.https.html` `icecandidateerror fires for each failing server`: TIMEOUT: libwebrtc's URLs: a UDP TURN server's gains '?transport=udp', so 'turn:turn1.invalid:3478' never arrives (TURN servers also report STUN errors as stun:&lt;host&gt;); Chrome 159 reports the same URLs and times out too
- `RTCPeerConnection-remote-track-mute.https.html` `pc.close() on one side causes mute events on the other`: FAIL: no mute on RTCP BYE: libwebrtc doesn't report a BYE (SPEC-LAYER-PLAN.md "MediaStreamTrack"); Chromium 159 (Playwright) fails it the same way (no mute)
- `RTCPeerConnection-remote-track-mute.https.html` `transceiver.stop() on one side (without renegotiation) causes mute events on the other`: FAIL: no mute on RTCP BYE: libwebrtc doesn't report a BYE (SPEC-LAYER-PLAN.md "MediaStreamTrack"); Chromium 159 (Playwright) fails it the same way (no mute)
- `RTCPeerConnection-remote-track-properties.https.html?interop-2026` `Remote audio track ID is different on different PCs`: FAIL: a remote track's id is the sender's msid track id (libwebrtc's), the same on every PC, as in Chrome; Chromium 159 fails it too
- `RTCPeerConnection-remote-track-properties.https.html?interop-2026` `Remote video track ID is different on different PCs`: FAIL: a remote track's id is the sender's msid track id (libwebrtc's), the same on every PC, as in Chrome; Chromium 159 fails it too
- `RTCPeerConnection-restartIce.https.html` `restartIce() does not trigger negotiation ahead of initial negotiation`: FAIL: libwebrtc: restartIce() before the first negotiation fires negotiationneeded (CheckIfNegotiationIsNeeded() is true with no current local description, not a spec step); Chrome 159 and wrtc fire it too
- `RTCPeerConnection-restartIce.https.html` `restartIce() survives remote offer containing partial restart`: FAIL: libwebrtc: max-compat still offers BUNDLE and the answer accepts it, so the re-offer's new ufrag on the second m-section restarts no transport and the answer keeps the old credentials; Chrome 159 and wrtc do the same
- `RTCPeerConnection-restartIce.https.html` `restartIce() survives remote offer containing partial restart (perfect negotiation)`: FAIL: libwebrtc: max-compat still offers BUNDLE and the answer accepts it, so the re-offer's new ufrag on the second m-section restarts no transport and the answer keeps the old credentials; Chrome 159 and wrtc do the same
- `legacy/munge-dont.html` `Rejects SDP munging between createAnswer and setLocalDescription`: FAIL: assert_unreached: Should have rejected: undefined Reached unreachable code
- `legacy/munge-dont.html` `Rejects SDP munging between createOffer and setLocalDescription`: FAIL: assert_unreached: Should have rejected: undefined Reached unreachable code

</details>

## RTP

<details>
<summary>238 / 243 subtests pass, in 35 tests</summary>

| Test | Passed | Status |
|---|---:|---|
| `RTCRtpParameters-encodings.html?interop-2026` | 13 / 13 | OK |
| `RTCRtpParameters-encodings.html?rest` | 31 / 31 | OK |
| `RTCRtpParameters-headerExtensions.html` | 1 / 1 | OK |
| `RTCRtpParameters-maxFramerate.html` | 15 / 15 | OK |
| `RTCRtpParameters-rtcp.html` | 2 / 2 | OK |
| `RTCRtpParameters-transactionId.html?interop-2026` | 2 / 2 | OK |
| `RTCRtpParameters-transactionId.html?rest` | 6 / 6 | OK |
| `RTCRtpReceiver-getCapabilities.html` | 3 / 3 | OK |
| `RTCRtpReceiver-getContributingSources.https.html` | 2 / 2 | OK |
| `RTCRtpReceiver-getParameters.html?interop-2026` | 3 / 3 | OK |
| `RTCRtpReceiver-getParameters.html?rest` | 0 / 1 | OK |
| `RTCRtpReceiver-getSynchronizationSources.https.html` | 13 / 13 | OK |
| `RTCRtpReceiver-jitterBufferTarget.html` | 12 / 12 | OK |
| `RTCRtpReceiver-track-settings.tentative.html` | 0 / 1 | OK |
| `RTCRtpReceiver.https.html` | 8 / 8 | OK |
| `RTCRtpSender-encode-same-track-twice.https.html` | 1 / 1 | OK |
| `RTCRtpSender-getCapabilities.html` | 3 / 3 | OK |
| `RTCRtpSender-getParameters.html` | 1 / 1 | OK |
| `RTCRtpSender-maxFramerate.https.html` | 1 / 2 | OK |
| `RTCRtpSender-replaceTrack.https.html` | 11 / 11 | OK |
| `RTCRtpSender-setParameters.html?interop-2026` | 1 / 1 | OK |
| `RTCRtpSender-setParameters.html?rest` | 2 / 2 | OK |
| `RTCRtpSender-setStreams.https.html` | 5 / 5 | OK |
| `RTCRtpSender-transport.https.html` | 8 / 8 | OK |
| `RTCRtpSender.https.html` | 8 / 9 | OK |
| `RTCRtpTransceiver-direction.html` | 3 / 3 | OK |
| `RTCRtpTransceiver-stop.html` | 9 / 9 | OK |
| `RTCRtpTransceiver-stopping.https.html?interop-2026` | 6 / 6 | OK |
| `RTCRtpTransceiver-stopping.https.html?rest` | 10 / 10 | OK |
| `RTCRtpTransceiver.https.html?interop-2026` | 12 / 12 | ERROR |
| `RTCRtpTransceiver.https.html?rest` | 33 / 34 | OK |
| `legacy/RTCRtpTransceiver-with-OfferToReceive-options.optional.https.html` | 4 / 4 | OK |
| `outbound-rtp-encoding-index.https.html` | 3 / 3 | OK |
| `receiver-track-live.https.html` | 4 / 4 | OK |
| `recvonly-transceiver-can-become-sendrecv.https.html` | 2 / 2 | OK |

Not passing (or not as expected):

- `RTCRtpReceiver-getParameters.html?rest` `getParameters() with simulcast video receiver`: FAIL: headerExtensions is empty: a simulcast receiver has no signaled SSRC before media arrives, and libwebrtc reports no header extensions for that default stream (WebRtcVideoReceiveChannel::GetDefaultRtpReceiveParameters). Chromium 159 fails it too
- `RTCRtpReceiver-track-settings.tentative.html` `RTCRtpReceiver.track.getSettings() contains resolution entries`: FAIL: a remote video track's getSettings() returns wrtc's fixed 640x480 from the start, not the received resolution (the &lt;video&gt; element does see the frames' sizes)
- `RTCRtpSender-maxFramerate.https.html` `setParameters() with maxFramerate limits the encoded frame rate of a VideoTrackGenerator track generated at 60 fps`: FAIL: needs a Worker with VideoTrackGenerator, OffscreenCanvas and VideoFrame (not shimmed)
- `RTCRtpSender.https.html` `Video sender @dtmf is null`: FAIL: the subtest also asserts an audio sender's dtmf is not null; ours is always null, as RTCDTMFSender isn't implemented (DTMF is out of scope). Chromium 159 passes
- `RTCRtpTransceiver.https.html?interop-2026`: test status ERROR: checkStop's unawaited checkThrows(() =&gt; sender.dtmf.insertDTMF(...)) rejects: sender.dtmf is null (DTMF is out of scope), so it throws TypeError, not InvalidStateError, and the harness reports the unhandled rejection; every subtest still runs. Unhandled rejection: assert_equals: insertDTMF on stopped transceiver throws InvalidStateError expected "InvalidStateError" but got "TypeError"
- `RTCRtpTransceiver.https.html?rest` `track with video stays muted when setting the transceiver direction to 'sendrecv' after 'inactive' but no packets flow`: FAIL: a video sender with a null track still sends RTP padding, which unmutes the remote track; Chromium 159 (Playwright) fails it the same way

</details>

## Stats

<details>
<summary>119 / 120 subtests pass, in 13 tests</summary>

| Test | Passed | Status |
|---|---:|---|
| `RTCPeerConnection-certificateStats.https.html` | 1 / 1 | OK |
| `RTCPeerConnection-getStats-timestamp.https.html` | 2 / 2 | OK |
| `RTCPeerConnection-getStats.https.html?interop-2026` | 13 / 13 | OK |
| `RTCPeerConnection-getStats.https.html?rest` | 5 / 5 | OK |
| `RTCPeerConnection-mandatory-getStats.https.html` | 73 / 73 | OK |
| `RTCPeerConnection-transport-stats.https.html` | 2 / 2 | OK |
| `RTCRtpReceiver-audio-jitterBufferTarget-stats.https.html` | 1 / 1 | OK |
| `RTCRtpReceiver-getStats.https.html?interop-2026` | 4 / 4 | OK |
| `RTCRtpReceiver-getStats.https.html?rest` | 1 / 1 | OK |
| `RTCRtpReceiver-video-jitterBufferTarget-stats.html` | 1 / 1 | OK |
| `RTCRtpSender-getStats.https.html` | 4 / 5 | OK |
| `getstats.html` | 1 / 1 | OK |
| `rtp-stats-lifetime.https.html` | 11 / 11 | OK |

Not passing (or not as expected):

- `RTCRtpSender-getStats.https.html` `sender.getStats() should work on a stopped transceiver but not have outbound-rtp stats after renegotiation`: FAIL: libwebrtc's stats for a stopped sender are empty from stop() on, not only after renegotiation (no outbound-rtp in the second report); Chromium 159 (Playwright) fails it the same way

</details>

## Data channels

<details>
<summary>212 / 214 subtests pass, in 26 tests</summary>

| Test | Passed | Status |
|---|---:|---|
| `RTCDataChannel-GC.html` | 2 / 2 | OK |
| `RTCDataChannel-binaryType.window.js` | 10 / 10 | OK |
| `RTCDataChannel-bufferedAmount.html` | 30 / 30 | OK |
| `RTCDataChannel-close.html` | 12 / 12 | OK |
| `RTCDataChannel-iceRestart.html` | 2 / 2 | OK |
| `RTCDataChannel-id.html` | 5 / 5 | OK |
| `RTCDataChannel-send-blob-order.html` | 2 / 2 | OK |
| `RTCDataChannel-send-close-array-buffer-negotiated.window.js` | 1 / 1 | OK |
| `RTCDataChannel-send-close-array-buffer.window.js` | 1 / 1 | OK |
| `RTCDataChannel-send-close-blob-negotiated.window.js` | 1 / 1 | OK |
| `RTCDataChannel-send-close-blob.window.js` | 1 / 1 | OK |
| `RTCDataChannel-send-close-string-negotiated.window.js` | 1 / 1 | OK |
| `RTCDataChannel-send-close-string.window.js` | 1 / 1 | OK |
| `RTCDataChannel-send.html` | 26 / 27 | OK |
| `RTCDataChannelEvent-constructor.html` | 4 / 4 | OK |
| `RTCDataChannelInit-maxPacketLifeTime-enforce-range.html` | 17 / 17 | OK |
| `RTCDataChannelInit-maxRetransmits-enforce-range.html` | 17 / 17 | OK |
| `RTCPeerConnection-createDataChannel.html?interop-2026` | 4 / 4 | OK |
| `RTCPeerConnection-createDataChannel.html?rest` | 48 / 48 | OK |
| `RTCPeerConnection-ondatachannel.html` | 8 / 8 | OK |
| `RTCSctpTransport-constructor.html` | 4 / 4 | OK |
| `RTCSctpTransport-events.html` | 2 / 2 | OK |
| `RTCSctpTransport-maxChannels.html?interop-2026` | 2 / 2 | OK |
| `RTCSctpTransport-maxChannels.html?rest` | 3 / 4 | OK |
| `RTCSctpTransport-maxMessageSize.html` | 7 / 7 | OK |
| `protocol/sctp-format.html` | 1 / 1 | OK |

Not passing (or not as expected):

- `RTCDataChannel-send.html` `Sending multiple messages simultaneously in unordered mode works reliably`: FAIL: send() of a message over sctp.maxMessageSize (262144) throws a TypeError, as Chromium 159 (Playwright) does (its text: "Trying to send message larger than max-message-size"); the test's own TODO (crbug.com/490588131) says its 5 MiB message exceeds max-message-size. wrtc doesn't throw; libwebrtc then closes the channel
- `RTCSctpTransport-maxChannels.html?rest` `Sctp transport has null maxChannels and 65536 maxMessageSize in have-local-offer after rollback`: FAIL: libwebrtc's offer after rolling back the one that created the SCTP transport has no m=application section, so there is no SCTP transport; Chromium 159 (Playwright) fails it the same way

</details>

## ICE and DTLS

<details>
<summary>142 / 156 subtests pass, in 27 tests</summary>

| Test | Passed | Status |
|---|---:|---|
| `RTCCertificate.html` | 4 / 5 | OK |
| `RTCDtlsTransport-getRemoteCertificates.html` | 1 / 1 | OK |
| `RTCDtlsTransport-getRemoteCertificates.https.html` | 1 / 1 | OK |
| `RTCDtlsTransport-onerror.html` | 0 / 1 | TIMEOUT |
| `RTCDtlsTransport-state.html` | 4 / 4 | OK |
| `RTCIceCandidate-constructor.html` | 65 / 65 | OK |
| `RTCIceConnectionState-candidate-pair.https.html` | 1 / 1 | OK |
| `RTCIceTransport-peer-reflexive-remote.html` | 1 / 2 | OK |
| `RTCIceTransport.html?interop-2026` | 3 / 3 | OK |
| `RTCIceTransport.html?rest` | 13 / 17 | OK |
| `RTCPeerConnectionIceErrorEvent.html` | 1 / 1 | OK |
| `RTCPeerConnectionIceEvent-constructor.html` | 8 / 8 | OK |
| `protocol/candidate-exchange.https.html?interop-2026` | 4 / 4 | OK |
| `protocol/candidate-exchange.https.html?rest` | 4 / 4 | OK |
| `protocol/crypto-suite.https.html` | 6 / 6 | OK |
| `protocol/dtls-certificates.html` | 4 / 4 | OK |
| `protocol/dtls-close.html` | 1 / 1 | OK |
| `protocol/dtls-fingerprint-validation.html` | 5 / 5 | OK |
| `protocol/dtls-setup.https.html` | 7 / 7 | OK |
| `protocol/fingerprint-change-requires-ice-restart.html` | 0 / 2 | OK |
| `protocol/handover-datachannel.html` | 0 / 1 | TIMEOUT |
| `protocol/handover-failure.html` | 0 / 1 | TIMEOUT |
| `protocol/handover-media.html` | 0 / 3 | TIMEOUT |
| `protocol/handover-torture.html` | 2 / 2 | OK |
| `protocol/handover.html` | 2 / 2 | OK |
| `protocol/ice-state.https.html` | 3 / 3 | OK |
| `protocol/ice-ufragpwd.html` | 2 / 2 | OK |

Not passing (or not as expected):

- `RTCCertificate.html` `RTCPeerConnection({ certificates }) should generate offer SDP with fingerprint of all provided certificates`: FAIL: libwebrtc uses only the first certificate, so the offer carries only its fingerprint; Chromium 159 (Playwright) fails it the same way
- `RTCDtlsTransport-onerror.html`: test status TIMEOUT
- `RTCDtlsTransport-onerror.html` `fingerprint error is surfaced using RTCDtlsTransport.onerror`: TIMEOUT: no error event on a failed DTLS handshake, as in Chromium 159 (Playwright) (which times out here too) and wrtc: both transports go to 'failed' with only statechange; libwebrtc doesn't report why DTLS failed, so 'fingerprint-failure' isn't available
- `RTCIceTransport-peer-reflexive-remote.html` `remote-candidate stats do not expose the address of a peer-reflexive candidate`: FAIL: stats: libwebrtc reports a peer-reflexive remote candidate's address as "" rather than leaving it out (getSelectedCandidatePair() hides it); Chromium 159 (Playwright) reports "" too
- `RTCIceTransport.html?rest` `RTCIceTransport should synchronously transition to "closed" with no event if the underlying transport is closed due to PC.close()`: FAIL: flaky under load: libwebrtc can report 'checking' before setRemoteDescription(answer) resolves (the remote's checks arrive first), so the test's listener, added after that await, sees 'connected' first (failed once on gpubox under load and once on a GitHub linux-x64 runner)
- `RTCIceTransport.html?rest` `RTCIceTransport should transition to "disconnected" if packets stop flowing`: FAIL: flaky on Linux, as its DataChannel twin (see that reason): libwebrtc reports pc1's ICE 'checking' before it applies setRemoteDescription(answer), so the transport is already 'checking' when the test starts listening. One failure in a full Linux x64 run on 2026-11-21
- `RTCIceTransport.html?rest` `RTCIceTransport.role should not change when the answerer initiates an ICE restart`: FAIL: m150 doesn't re-determine ICE roles on a restart: the old offerer sets itself controlled when it applies the answer while the restarting answerer stays controlled, until the role conflict's tie-breaker settles it. Chromium 159 (Playwright) (newer libwebrtc) swaps the roles, and its role is null, so it fails too; the API can't set roles
- `RTCIceTransport.html?rest` `Two connected iceTransports should have matching local/remote candidates returned`: FAIL: the test expects gatheringState 'gathering' or 'completed' (not an RTCIceGathererState) once connected; ours is 'complete', as is Chromium 159 (Playwright)'s, which fails earlier in this subtest (its role is null)
- `protocol/fingerprint-change-requires-ice-restart.html` `setRemoteDescription rejects a changed DTLS fingerprint in a re-offer without an ICE restart`: FAIL: assert_unreached: Should have rejected: A changed remote fingerprint in a re-offer without an ICE restart must be rejected Reached unreachable code
- `protocol/fingerprint-change-requires-ice-restart.html` `setRemoteDescription rejects a changed DTLS fingerprint without an ICE restart`: FAIL: assert_unreached: Should have rejected: A changed remote fingerprint without an ICE restart must be rejected Reached unreachable code
- `protocol/handover-datachannel.html`: test status TIMEOUT
- `protocol/handover-datachannel.html` `Handover with datachannel reinitiated from new callee completes`: TIMEOUT: libwebrtc ICE race (SPEC-LAYER-PLAN.md "Transports", Not done): the second answerer's first connectivity check reaches the offerer before its trickled candidate, and the offerer prunes that peer-reflexive pair at once in favour of the first answerer's host pair (still alive), so its ICE stays on the first answerer and the new DTLS handshake never completes or fails. Chromium 159 (Playwright) passes (presumably its mDNS candidates delay the second answerer's first check)
- `protocol/handover-failure.html`: test status TIMEOUT
- `protocol/handover-failure.html` `A handover whose new DTLS association fails to verify reports failed and stops using the previous association`: TIMEOUT: flaky: libwebrtc ICE race (SPEC-LAYER-PLAN.md "Transports", Not done): the second answerer's first connectivity check reaches the offerer before its trickled candidate, and the offerer prunes that peer-reflexive pair at once in favour of the first answerer's host pair (still alive), so its ICE stays on the first answerer and the new DTLS handshake never completes or fails. Chromium 159 (Playwright) times out too
- `protocol/handover-media.html`: test status TIMEOUT
- `protocol/handover-media.html` `Media (audio) keeps flowing to the offerer after a DTLS handover via ICE restart`: FAIL: flaky: libwebrtc ICE race (SPEC-LAYER-PLAN.md "Transports", Not done): the second answerer's first connectivity check reaches the offerer before its trickled candidate, and the offerer prunes that peer-reflexive pair at once in favour of the first answerer's host pair (still alive), so its ICE stays on the first answerer and the new DTLS handshake never completes or fails. Chromium 159 (Playwright) passes (presumably its mDNS candidates delay the second answerer's first check)
- `protocol/handover-media.html` `Media (video) keeps flowing to the offerer after a DTLS handover via ICE restart`: FAIL: flaky: libwebrtc ICE race (SPEC-LAYER-PLAN.md "Transports", Not done): the second answerer's first connectivity check reaches the offerer before its trickled candidate, and the offerer prunes that peer-reflexive pair at once in favour of the first answerer's host pair (still alive), so its ICE stays on the first answerer and the new DTLS handshake never completes or fails. Chromium 159 (Playwright) passes (presumably its mDNS candidates delay the second answerer's first check)
- `protocol/handover-media.html` `Media keeps flowing to the offerer on every transport after a DTLS handover with multiple transports`: TIMEOUT: flaky: libwebrtc ICE race (SPEC-LAYER-PLAN.md "Transports", Not done): the second answerer's first connectivity check reaches the offerer before its trickled candidate, and the offerer prunes that peer-reflexive pair at once in favour of the first answerer's host pair (still alive), so its ICE stays on the first answerer and the new DTLS handshake never completes or fails. Chromium 159 (Playwright) fails it too

</details>

## Codecs

<details>
<summary>83 / 129 subtests pass, in 21 tests</summary>

| Test | Passed | Status |
|---|---:|---|
| `RTCRtpEncodingParameters-codec-opus-stereo.https.html` | 0 / 2 | OK |
| `RTCRtpParameters-codec.html?interop-2026` | 18 / 19 | OK |
| `RTCRtpParameters-codec.html?rest` | 2 / 3 | OK |
| `RTCRtpParameters-codecs.html?interop-2026` | 18 / 18 | OK |
| `RTCRtpParameters-codecs.html?rest` | 16 / 20 | OK |
| `RTCRtpReceiver-video-anyCodec.html` | 1 / 1 | OK |
| `RTCRtpTransceiver-setCodecPreferences.html?interop-2026` | 3 / 7 | OK |
| `RTCRtpTransceiver-setCodecPreferences.html?rest` | 17 / 17 | OK |
| `protocol/additional-codecs.html` | 0 / 1 | OK |
| `protocol/av1-profile-asymmetry.https.html` | 0 / 1 | OK |
| `protocol/codecs-filtered-by-direction.https.html` | 2 / 2 | OK |
| `protocol/codecs-subsequent-offer.https.html` | 0 / 1 | OK |
| `protocol/h264-fmtp-modifies-level.https.html` | 0 / 3 | OK |
| `protocol/h264-profile-levels.https.html?interop-2026` | 0 / 8 | OK |
| `protocol/h264-profile-levels.https.html?rest` | 0 / 11 | OK |
| `protocol/h264-unidirectional-codec-offer.https.html` | 0 / 3 | OK |
| `protocol/h265-level-id.https.html` | 0 / 3 | OK |
| `protocol/h265-loopback.https.html` | 0 / 1 | OK |
| `protocol/rtx-codecs.https.html` | 4 / 4 | OK |
| `protocol/video-codecs.https.html` | 1 / 3 | OK |
| `protocol/vp8-fmtp.html` | 1 / 1 | OK |

Not passing (or not as expected):

- `RTCRtpEncodingParameters-codec-opus-stereo.https.html` `Sending and receiving a mono track with opus (stereo decoder upmix)`: FAIL: a remote audio track's getSettings() returns wrtc's fixed values (channelCount 1, lib/MediaStreamTrack.ts), not the decoder's channel count (2 from the stereo opus decoder in Chrome)
- `RTCRtpEncodingParameters-codec-opus-stereo.https.html` `Sending and receiving a stereo track with opus`: FAIL: fails at its prerequisite: getUserMedia ignores constraints (wrtc parity) and its fake microphone is mono, so getSettings().channelCount is 1, not 2. Past that it reads the remote track's channel count through an &lt;audio&gt; element; Chromium 159 gets that far and fails 'Remote track is also stereo'
- `RTCRtpParameters-codec.html?interop-2026` `Stats output-rtp should match the selected codec in simulcast usecase on a video sender`: FAIL: H264 is not built in (no H264, by decision)
- `RTCRtpParameters-codec.html?rest` `Stats output-rtp should match the selected mixed codecs in simulcast usecase on a video sender`: FAIL: H264 is not built in (no H264, by decision): getCapabilities has no H264, so the test passes undefined to setCodecPreferences
- `RTCRtpParameters-codecs.html?rest` `RTCRtpSender.getParameters() codecs should match remote SDP (video, with fmtp checks, answerer)`: FAIL: sdpFmtpLine comes from remoteDescription.sdp, which libwebrtc re-serializes: fmtp parameters sorted and VP9's profile-id=0 added ('max-fr=50;max-fs=12277;profile-id=0;unknownparam=foo')
- `RTCRtpParameters-codecs.html?rest` `RTCRtpSender.getParameters() codecs should match remote SDP (video, with fmtp checks, offerer)`: FAIL: sdpFmtpLine comes from remoteDescription.sdp, which libwebrtc re-serializes: fmtp parameters sorted and VP9's profile-id=0 added ('max-fr=50;max-fs=12277;profile-id=0;unknownparam=foo')
- `RTCRtpParameters-codecs.html?rest` `setParameters() with codecs undefined should reject with InvalidModificationError (audio)`: FAIL: RTCRtpParameters.codecs is required in the spec's IDL, so WebIDL conversion throws TypeError first ("required member 'codecs' is undefined"); the test predates that. Chromium 159 throws the same TypeError
- `RTCRtpParameters-codecs.html?rest` `setParameters() with codecs undefined should reject with InvalidModificationError (video)`: FAIL: RTCRtpParameters.codecs is required in the spec's IDL, so WebIDL conversion throws TypeError first ("required member 'codecs' is undefined"); the test predates that. Chromium 159 throws the same TypeError
- `RTCRtpTransceiver-setCodecPreferences.html?interop-2026` `setCodecPreferences() filters on receiver and prefers receiver order`: FAIL: H264 is not built in (no H264, by decision)
- `RTCRtpTransceiver-setCodecPreferences.html?interop-2026` `setCodecPreferences() modifies the order of video codecs in createOffer`: FAIL: H264 is not built in (no H264, by decision)
- `RTCRtpTransceiver-setCodecPreferences.html?interop-2026` `setCodecPreferences() should allow setting H264 as first codec`: FAIL: H264 is not built in (no H264, by decision)
- `RTCRtpTransceiver-setCodecPreferences.html?interop-2026` `setCodecPreferences() with only H264 should succeed`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/additional-codecs.html` `Listing an additional codec in the answer causes it to be sent.`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/av1-profile-asymmetry.https.html` `setParameters() ignores the asymmetrical AV1 parameter 'profile'`: FAIL: libwebrtc's setParameters check (media_engine.cc: "Attempted to use an unsupported codec for layer 0") matches encodings[].codec against the negotiated codecs with every fmtp parameter, so AV1 with another profile is rejected with InvalidModificationError rather than matched as the spec's codec dictionary match does. Chromium 159 fails it too (the same check)
- `protocol/codecs-subsequent-offer.https.html` `A subsequent offer after a VP8-only negotiation includes at least all mandatory to implement codecs`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-fmtp-modifies-level.https.html` `Level 2.0 alone limits the sent video to level 2.0`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-fmtp-modifies-level.https.html` `Level 2.0 with max-fs/max-mbps raised allows level 3.1 sized video`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-fmtp-modifies-level.https.html` `Level 3.1 with max-fs/max-mbps lowered limits video to level 2.0 sizes`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?interop-2026` `Level 3.1 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?interop-2026` `Level 3.2 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?interop-2026` `Level 4 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?interop-2026` `Level 4.1 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?interop-2026` `Level 4.2 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?interop-2026` `Level 5 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?interop-2026` `Level 5.1 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?interop-2026` `Level 5.2 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?rest` `Level 1 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?rest` `Level 1.1 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?rest` `Level 1.2 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?rest` `Level 1.3 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?rest` `Level 2 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?rest` `Level 2.1 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?rest` `Level 2.2 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?rest` `Level 3 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?rest` `Level 6 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?rest` `Level 6.1 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-profile-levels.https.html?rest` `Level 6.2 H264 video is appropriately constrained`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/h264-unidirectional-codec-offer.https.html` `Offer to receive a recvonly H264 codec on a recvonly transceiver`: PRECONDITION_FAILED: H264 is not built in (no H264, by decision)
- `protocol/h264-unidirectional-codec-offer.https.html` `Offer to send a sendonly H264 codec on a sendonly transceiver`: PRECONDITION_FAILED: H264 is not built in (no H264, by decision)
- `protocol/h264-unidirectional-codec-offer.https.html` `Offering a recvonly codec on a sendrecv transceiver`: PRECONDITION_FAILED: H264 is not built in (no H264, by decision)
- `protocol/h265-level-id.https.html` `Offer to receive level-id=30 and set codec from getCapabilities`: PRECONDITION_FAILED: H265 is not available for sending.
- `protocol/h265-level-id.https.html` `Offer to receive level-id=30 and set codec from getParameters`: PRECONDITION_FAILED: H265 is not available for sending.
- `protocol/h265-level-id.https.html` `Offer to send H265, answer to receive level-id=30 results in level-id=30`: PRECONDITION_FAILED: H265 is not available for sending.
- `protocol/h265-loopback.https.html` `Negotiate H265 loopback and verify frames are flowing`: PRECONDITION_FAILED: H265 not available for sending or receiving. Loopback requires both.
- `protocol/video-codecs.https.html` `H.264 and VP8 should be negotiated after handshake`: FAIL: H264 is not built in (no H264, by decision)
- `protocol/video-codecs.https.html` `H.264 and VP8 should be supported in initial offer`: FAIL: H264 is not built in (no H264, by decision)

</details>

## Simulcast

<details>
<summary>31 / 53 subtests pass, in 17 tests</summary>

| Test | Passed | Status |
|---|---:|---|
| `RTCPeerConnection-setRemoteDescription-simulcast.https.html` | 0 / 1 | OK |
| `protocol/simulcast-answer.html` | 1 / 3 | OK |
| `protocol/simulcast-offer.html` | 1 / 1 | OK |
| `simulcast/av1.https.html` | 0 / 1 | TIMEOUT |
| `simulcast/basic.https.html` | 1 / 1 | OK |
| `simulcast/getStats.https.html` | 0 / 1 | TIMEOUT |
| `simulcast/h264.https.html` | 0 / 1 | OK |
| `simulcast/negotiation-encodings.https.html?interop-2026` | 5 / 5 | OK |
| `simulcast/negotiation-encodings.https.html?rest` | 6 / 15 | OK |
| `simulcast/rid-manipulation.html` | 1 / 1 | OK |
| `simulcast/screenshare.https.html` | 1 / 1 | OK |
| `simulcast/setParameters-active.https.html` | 3 / 3 | OK |
| `simulcast/setParameters-encodings.https.html` | 10 / 15 | OK |
| `simulcast/setParameters-maxFramerate.https.html` | 0 / 1 | TIMEOUT |
| `simulcast/vp8.https.html` | 1 / 1 | OK |
| `simulcast/vp9-scalability-mode.https.html` | 1 / 1 | OK |
| `simulcast/vp9.https.html` | 0 / 1 | TIMEOUT |

Not passing (or not as expected):

- `RTCPeerConnection-setRemoteDescription-simulcast.https.html` `createAnswer() attaches to an existing transceiver with a remote simulcast offer`: FAIL: libwebrtc never pairs an existing transceiver with a remote offer's m-section that has a=simulcast; it creates a new recvonly one (pc/sdp_offer_answer.cc, AssociateTransceiver: "a transceiver cannot be associated because AddTrack cannot be called to initialize it"); Chromium 159 (Playwright) fails it the same way
- `protocol/simulcast-answer.html` `Disabling encodings locally does not change the SDP`: FAIL: assert_not_equals: Could not find simulcast attribute. got disallowed value undefined
- `protocol/simulcast-answer.html` `Using the ~rid SDP syntax in a remote offer does not control the local encodings active flag`: FAIL: assert_not_equals: got disallowed value false
- `simulcast/av1.https.html`: test status TIMEOUT: AV1 simulcast with two rids and no scalabilityMode (as here) encodes only rid 0: libwebrtc's legacy path sends one stream unless an encoding has a scalabilityMode (IsCodecDisabledForSimulcast); Chromium 159 (Playwright) encodes only rid 0 too. So rid 1's &lt;video&gt; never gets loadedmetadata. With a mode both rids are encoded (SimulcastEncoderAdapter)
- `simulcast/av1.https.html` `AV1 simulcast setup with two streams`: TIMEOUT: AV1 simulcast with two rids and no scalabilityMode (as here) encodes only rid 0: libwebrtc's legacy path sends one stream unless an encoding has a scalabilityMode (IsCodecDisabledForSimulcast); Chromium 159 (Playwright) encodes only rid 0 too. So rid 1's &lt;video&gt; never gets loadedmetadata. With a mode both rids are encoded (SimulcastEncoderAdapter)
- `simulcast/getStats.https.html`: test status TIMEOUT: three layers from getUserMedia's 640x480: libwebrtc's resolution-based simulcast layer limit (LimitSimulcastLayerCount, kSimulcastFormats: 3 layers need more than 489,600 px) encodes only the first two, so rid 2's &lt;video&gt; never gets loadedmetadata; Chromium 159 (Playwright, with or without its field-trial testing config) encodes two layers from 640x480 too
- `simulcast/getStats.https.html` `Simulcast getStats results`: TIMEOUT: three layers from getUserMedia's 640x480: libwebrtc's resolution-based simulcast layer limit (LimitSimulcastLayerCount, kSimulcastFormats: 3 layers need more than 489,600 px) encodes only the first two, so rid 2's &lt;video&gt; never gets loadedmetadata; Chromium 159 (Playwright, with or without its field-trial testing config) encodes two layers from 640x480 too
- `simulcast/h264.https.html` `H264 simulcast setup with two streams`: FAIL: H264 is not built in (no H264, by decision)
- `simulcast/negotiation-encodings.https.html?rest` `Choices in rids in sRD(offer) are ignored`: FAIL: libwebrtc never pairs an existing transceiver with a remote offer's m-section that has a=simulcast; it creates a new recvonly one (pc/sdp_offer_answer.cc, AssociateTransceiver: "a transceiver cannot be associated because AddTrack cannot be called to initialize it"); Chromium 159 (Playwright) fails it the same way
- `simulcast/negotiation-encodings.https.html?rest` `Duplicate rids in sRD(offer) are ignored`: FAIL: libwebrtc never pairs an existing transceiver with a remote offer's m-section that has a=simulcast; it creates a new recvonly one (pc/sdp_offer_answer.cc, AssociateTransceiver: "a transceiver cannot be associated because AddTrack cannot be called to initialize it"); Chromium 159 (Playwright) fails it the same way
- `simulcast/negotiation-encodings.https.html?rest` `Rollback of sRD(reoffer) with a single rid results in all previous encodings`: FAIL: libwebrtc disables the layers a remote description drops (RtpSenderBase::DisableEncodingLayers, permanent), and rollback does not restore them; Chromium 159 (Playwright) fails it the same way
- `simulcast/negotiation-encodings.https.html?rest` `addTrack, then rollback of sRD(simulcast offer), brings us back to having a single encoding without a rid`: FAIL: libwebrtc never pairs an existing transceiver with a remote offer's m-section that has a=simulcast; it creates a new recvonly one (pc/sdp_offer_answer.cc, AssociateTransceiver: "a transceiver cannot be associated because AddTrack cannot be called to initialize it"); Chromium 159 (Playwright) fails it the same way
- `simulcast/negotiation-encodings.https.html?rest` `addTrack, then sRD(simulcast recv offer) results in simulcast`: FAIL: libwebrtc never pairs an existing transceiver with a remote offer's m-section that has a=simulcast; it creates a new recvonly one (pc/sdp_offer_answer.cc, AssociateTransceiver: "a transceiver cannot be associated because AddTrack cannot be called to initialize it"); Chromium 159 (Playwright) fails it the same way
- `simulcast/negotiation-encodings.https.html?rest` `sRD(simulcast offer) can narrow the simulcast envelope from a previous negotiation`: FAIL: libwebrtc narrows the simulcast envelope when it applies the remote reoffer (UpdateSimulcastLayerStatusInSender disables the missing layers at sRD), not when the answer is applied, so getParameters() in have-remote-offer already lacks them; Chromium 159 (Playwright) fails it the same way
- `simulcast/negotiation-encodings.https.html?rest` `sRD(simulcast offer) can narrow the simulcast envelope from a previous negotiation by removing the first encoding`: FAIL: libwebrtc narrows the simulcast envelope when it applies the remote reoffer (UpdateSimulcastLayerStatusInSender disables the missing layers at sRD), not when the answer is applied, so getParameters() in have-remote-offer already lacks them; Chromium 159 (Playwright) fails it the same way
- `simulcast/negotiation-encodings.https.html?rest` `sRD(simulcast offer), addTrack, then rollback brings us back to having a single encoding`: FAIL: libwebrtc keeps the send encodings a remote simulcast offer gave the transceiver it created, after addTrack took that transceiver over and the offer was rolled back; Chromium 159 (Playwright) fails it the same way
- `simulcast/negotiation-encodings.https.html?rest` `simulcast is not supported for audio`: FAIL: libwebrtc never pairs an existing transceiver with a remote offer's m-section that has a=simulcast; it creates a new recvonly one (pc/sdp_offer_answer.cc, AssociateTransceiver: "a transceiver cannot be associated because AddTrack cannot be called to initialize it"); Chromium 159 (Playwright) fails it the same way
- `simulcast/setParameters-encodings.https.html` `addTrack, then a unicast setParameters, then sRD(simulcast offer) results in simulcast without the settings from setParameters`: FAIL: libwebrtc never pairs an existing transceiver with a remote offer's m-section that has a=simulcast; it creates a new recvonly one (pc/sdp_offer_answer.cc, AssociateTransceiver: "a transceiver cannot be associated because AddTrack cannot be called to initialize it"); Chromium 159 (Playwright) fails it the same way
- `simulcast/setParameters-encodings.https.html` `addTrack, then rollback of sRD(simulcast offer), brings us back to having a single encoding without any previously set parameters`: FAIL: libwebrtc never pairs an existing transceiver with a remote offer's m-section that has a=simulcast; it creates a new recvonly one (pc/sdp_offer_answer.cc, AssociateTransceiver: "a transceiver cannot be associated because AddTrack cannot be called to initialize it"); Chromium 159 (Playwright) fails it the same way
- `simulcast/setParameters-encodings.https.html` `addTrack, then sRD(simulcast offer) interrupted by a unicast setParameters results in simulcast without the settings from setParameters`: FAIL: libwebrtc never pairs an existing transceiver with a remote offer's m-section that has a=simulcast; it creates a new recvonly one (pc/sdp_offer_answer.cc, AssociateTransceiver: "a transceiver cannot be associated because AddTrack cannot be called to initialize it"); Chromium 159 (Playwright) fails it the same way
- `simulcast/setParameters-encodings.https.html` `rollback of a remote offer that disabled a previously negotiated simulcast should restore simulcast along with any previously set parameters`: FAIL: libwebrtc disables the layers a remote description drops (RtpSenderBase::DisableEncodingLayers, permanent), and rollback does not restore them; Chromium 159 (Playwright) fails it the same way
- `simulcast/setParameters-encodings.https.html` `rollback of sRD(simulcast offer) interrupted by setParameters(simulcast) brings us back to having a single encoding without any previously set parameters`: FAIL: libwebrtc never pairs an existing transceiver with a remote offer's m-section that has a=simulcast; it creates a new recvonly one (pc/sdp_offer_answer.cc, AssociateTransceiver: "a transceiver cannot be associated because AddTrack cannot be called to initialize it"); Chromium 159 (Playwright) fails it the same way
- `simulcast/setParameters-maxFramerate.https.html`: test status TIMEOUT: three layers from getUserMedia's 640x480: libwebrtc's resolution-based simulcast layer limit (LimitSimulcastLayerCount, kSimulcastFormats: 3 layers need more than 489,600 px) encodes only the first two, so rid 2's &lt;video&gt; never gets loadedmetadata; Chromium 159 (Playwright, with or without its field-trial testing config) encodes two layers from 640x480 too
- `simulcast/setParameters-maxFramerate.https.html` `Simulcast setParameters maxFramerate reduces the framerate`: TIMEOUT: three layers from getUserMedia's 640x480: libwebrtc's resolution-based simulcast layer limit (LimitSimulcastLayerCount, kSimulcastFormats: 3 layers need more than 489,600 px) encodes only the first two, so rid 2's &lt;video&gt; never gets loadedmetadata; Chromium 159 (Playwright, with or without its field-trial testing config) encodes two layers from 640x480 too
- `simulcast/vp9.https.html`: test status TIMEOUT: VP9 simulcast with two rids and no scalabilityMode (as here) encodes only rid 0: libwebrtc's legacy path sends one stream unless an encoding has a scalabilityMode (IsCodecDisabledForSimulcast); Chromium 159 (Playwright) encodes only rid 0 too. So rid 1's &lt;video&gt; never gets loadedmetadata
- `simulcast/vp9.https.html` `VP9 simulcast setup with two streams`: TIMEOUT: VP9 simulcast with two rids and no scalabilityMode (as here) encodes only rid 0: libwebrtc's legacy path sends one stream unless an encoding has a scalabilityMode (IsCodecDisabledForSimulcast); Chromium 159 (Playwright) encodes only rid 0 too. So rid 1's &lt;video&gt; never gets loadedmetadata

</details>

## Protocol and IDL

<details>
<summary>578 / 601 subtests pass, in 25 tests</summary>

| Test | Passed | Status |
|---|---:|---|
| `historical.html?interop-2026` | 5 / 5 | OK |
| `historical.html?rest` | 16 / 16 | OK |
| `idlharness.https.window.js?exclude=(RTCSessionDescription\|RTCPeerConnectionIceErrorEvent\|RTCRtpReceiver\|RTCDtlsTransport\|RTCIceTransport\|RTCDTMFToneChangeEvent\|RTCError\|RTCErrorEvent)` | 369 / 379 | OK |
| `idlharness.https.window.js?include=(RTCSessionDescription\|RTCPeerConnectionIceErrorEvent\|RTCRtpReceiver\|RTCDtlsTransport\|RTCIceTransport\|RTCDTMFToneChangeEvent\|RTCError\|RTCErrorEvent)` | 134 / 141 | OK |
| `protocol/RTCPeerConnection-payloadTypes.html` | 1 / 1 | OK |
| `protocol/bundle.https.html?interop-2026` | 1 / 1 | OK |
| `protocol/bundle.https.html?rest` | 2 / 3 | OK |
| `protocol/direction.html` | 2 / 2 | OK |
| `protocol/jsep-initial-offer.https.html` | 1 / 1 | OK |
| `protocol/missing-fields.html` | 2 / 2 | OK |
| `protocol/msid-generate.html` | 12 / 12 | OK |
| `protocol/msid-parse.html` | 5 / 5 | OK |
| `protocol/pt-no-bundle.html` | 1 / 1 | OK |
| `protocol/rtp-clockrate.html` | 1 / 1 | OK |
| `protocol/rtp-demuxing.html` | 1 / 2 | OK |
| `protocol/rtp-extension-support.html` | 6 / 6 | OK |
| `protocol/rtp-headerextensions.html` | 6 / 6 | OK |
| `protocol/rtp-payloadtypes.html?interop-2026` | 1 / 1 | OK |
| `protocol/rtp-payloadtypes.html?rest` | 2 / 2 | OK |
| `protocol/sdes-dont-dont-dont.html` | 2 / 2 | OK |
| `protocol/split.https.html` | 1 / 1 | OK |
| `protocol/transceiver-direction-match.html` | 1 / 1 | OK |
| `protocol/transceiver-mline-recycling.html` | 2 / 2 | OK |
| `protocol/unknown-media-types-negotiation.html` | 3 / 7 | OK |
| `protocol/unknown-mediatypes.html` | 1 / 1 | OK |

Not passing (or not as expected):

- `idlharness.https.window.js?exclude=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFSender interface object length`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?exclude=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFSender interface object name`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?exclude=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFSender interface: attribute canInsertDTMF`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?exclude=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFSender interface: attribute ontonechange`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?exclude=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFSender interface: attribute toneBuffer`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?exclude=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFSender interface: existence and properties of interface object`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?exclude=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFSender interface: existence and properties of interface prototype object`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?exclude=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFSender interface: existence and properties of interface prototype object's "constructor" property`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?exclude=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFSender interface: existence and properties of interface prototype object's @@unscopables property`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?exclude=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFSender interface: operation insertDTMF(DOMString, optional unsigned long, optional unsigned long)`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?include=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFToneChangeEvent interface object length`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?include=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFToneChangeEvent interface object name`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?include=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFToneChangeEvent interface: attribute tone`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?include=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFToneChangeEvent interface: existence and properties of interface object`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?include=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFToneChangeEvent interface: existence and properties of interface prototype object`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?include=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFToneChangeEvent interface: existence and properties of interface prototype object's "constructor" property`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `idlharness.https.window.js?include=(RTCSessionDescription|RTCPeerConnectionIceErrorEvent|RTCRtpReceiver|RTCDtlsTransport|RTCIceTransport|RTCDTMFToneChangeEvent|RTCError|RTCErrorEvent)` `RTCDTMFToneChangeEvent interface: existence and properties of interface prototype object's @@unscopables property`: SKIP: RTCDTMFSender is out of scope (SPEC-LAYER-PLAN.md)
- `protocol/bundle.https.html?rest` `max-bundle with an offer without bundle only negotiates the first m-line`: FAIL: promise_test: Unhandled rejection with value: object "InvalidAccessError: Failed to set remote offer sdp: max-bundle is used but no bundle group found."
- `protocol/rtp-demuxing.html` `Can demux two video tracks with different payload types on a bundled connection`: FAIL: H264 is not built in (no H264, by decision): getCapabilities has no H264, so the test passes [undefined] to setCodecPreferences, which throws
- `protocol/unknown-media-types-negotiation.html` `A local description may not substitute one unknown media type for another`: FAIL: assert_unreached: Should have rejected: undefined Reached unreachable code
- `protocol/unknown-media-types-negotiation.html` `A recycled m= section does not reuse the mid of the m= section it replaced`: FAIL: assert_not_equals: the rejected m= section is recycled for the transceiver got disallowed value "unicorns"
- `protocol/unknown-media-types-negotiation.html` `An answer may not substitute one unknown media type for another`: FAIL: assert_unreached: Should have rejected: undefined Reached unreachable code
- `protocol/unknown-media-types-negotiation.html` `An m= section rejected for an unknown media type may be recycled by the offerer`: FAIL: promise_test: Unhandled rejection with value: object "InvalidAccessError: Failed to set remote offer sdp: Failed to add remote stream ssrc: 2462559321 to {mid: recycled, media_type: audio}"

</details>
