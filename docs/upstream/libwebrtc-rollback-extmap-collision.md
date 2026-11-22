<!--
Draft issue for issues.webrtc.org (component: Internals > Network > Signaling
or PeerConnection). Not filed. Written 2026-11-19 from this repo's
investigation; line numbers are upstream main at
9bedb7b388b6d6204a7f6621596dd5a348df686c (2026-11-19) unless marked
otherwise. Our workaround: lib/internal/extmap-fix.ts (PLAN.md "Gotchas").
-->

# After a rollback, createOffer reuses a header extension id that collides within the BUNDLE group, and SLD rejects libwebrtc's own offer

## Summary

After a rollback (explicit, or the implicit one in SRD of a remote offer
during glare), the next offer libwebrtc creates can map an RTP header
extension to an id that the BUNDLE group already uses for a different
extension. `setLocalDescription` then rejects libwebrtc's own offer:

```
InvalidAccessError: Failed to set local offer sdp: A BUNDLE group contains a
codec collision for header extension id=1. The id must be the same across
all bundled media descriptions
```

This breaks perfect negotiation: after glare, the polite peer's follow-up
offer (the one that adds its rolled-back transceiver) always fails, so that
transceiver can never be negotiated. `createOffer` + `setLocalDescription`
and the implicit `setLocalDescription()` fail the same way.

## Affected versions

- Upstream main as of 2026-11-19 (9bedb7b).
- Regression from d1ae1e9ad4d183f4b00ad0962b35bba90162f038 ("Refactor RTP
  header extension ID allocation to be persistent and shared", 2026-04-21).
- Chrome 158 and 159 (stable and beta as of November 2026). Chrome 148
  doesn't reproduce.
- M150 (`branch-heads/7871` at 05e02da9d17f5844e84800fa524dd1eb57d7014c),
  which contains d1ae1e9. We found it on an M150 build whose
  `call/payload_type_picker.*` and `pc/sdp_payload_type_suggester.*` are
  identical to it (the `webrtc-sdk/webrtc` fork's `m150_release` at
  a545de45259b47dfac5f3635863e47cb601f1bb2).

## Minimal repro

In a Chrome 158/159 page (no network or media needed):

```js
const polite = new RTCPeerConnection();
const impolite = new RTCPeerConnection();
polite.addTransceiver('audio');
impolite.addTransceiver('video');
// Glare: both offer.
await polite.setLocalDescription();
await impolite.setLocalDescription();
// The polite peer takes the remote offer (implicit rollback of its own)...
await polite.setRemoteDescription(impolite.localDescription);
await polite.setLocalDescription();
await impolite.setRemoteDescription(polite.localDescription);
// ...and re-offers its audio transceiver.
await polite.setLocalDescription();
// Rejects: InvalidAccessError "... header extension id=1 ..."
```

With an explicit `await polite.setLocalDescription({type: 'rollback'})`
before the SRD it fails the same way, in Chrome and in M150, and so does
polite video vs impolite audio. In M150, polite video+audio vs impolite
audio fails too, while audio+video vs video+audio and video vs video don't
(no id happens to collide).

The failing offer has, in one BUNDLE group:

```
m=video ... a=mid:0  a=extmap:1 urn:ietf:params:rtp-hdrext:toffset
m=audio ... a=mid:2  a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
```

audio-level got id 1 in the rolled-back offer (where audio was mid 0); the
remote offer then bundled toffset at 1.

Expected: the follow-up offer picks an id that is free in the group (as it
does without the rollback), and SLD succeeds.

## Root cause

Line numbers are upstream main at 9bedb7b.

Header extension ids for an offer come from
`SdpPayloadTypeSuggester::SuggestRtpHeaderExtensionId`
(`pc/sdp_payload_type_suggester.cc:116-131`): first the BUNDLE group's
`RtpHeaderExtensionRecorder` (`LookupId`), then the PC-wide
`RtpHeaderExtensionPicker::SuggestMapping`
(`call/payload_type_picker.cc:440-455`). Neither is rolled back:

1. SLD of the polite peer's offer records its mappings (audio-level=1,
   transport-cc=3, mid=4, ...) in the recorder of the group named after its
   first mid, "0" (`SdpPayloadTypeSuggester::Update` ->
   `RecordRtpHeaderExtensions`, `pc/sdp_payload_type_suggester.cc:145-201`).
2. The rollback (`SdpOfferAnswerHandler::Rollback`,
   `pc/sdp_offer_answer.cc:4043`) doesn't touch `pt_suggester_`. The
   recorders and the picker keep the rolled-back offer's mappings. (In
   M150 `RtpHeaderExtensionRecorder` still has `Commit()`/`Rollback()`,
   but nothing calls `Rollback()`; on main they're gone.)
3. SRD of the remote offer records its mappings in the same recorder "0"
   (the remote's video is mid 0): toffset=1, transport-cc=4, mid=9. With
   libwebrtc's logging on, this logs `RtpHeaderExtensionRecorder: Redefining
   mapping for ...transport-wide-cc... from 3 to 4` and `... sdes:mid ...
   from 4 to 9`: the stale mappings are visible right there. Nothing
   notices that id 1 is now toffset's too.
4. The follow-up offer asks for audio-level in that group: `LookupId`
   returns the stale 1. (Had the recorder not had it, the picker's reuse
   branch at `call/payload_type_picker.cc:446-455` would return its
   remembered id 1 too: it only skips an entry when the recorder maps the
   URI to a *different* id, and never checks whether the id is taken by
   another URI in the group.)
5. `ValidateBundledRtpHeaderExtensions` (`pc/sdp_offer_answer.cc:664`,
   called at :4651) rejects the offer.

## Suggested fix

Either of these, ideally both:

- Make rollback restore the suggester's state: snapshot `pt_suggester_`'s
  per-bundle header extension recorders (and the picker's entries) when a
  local offer is applied, and restore them in
  `SdpOfferAnswerHandler::Rollback`. That's what the removed
  `Commit()`/`Rollback()` pair was for.
- Make id selection collision-proof: in `SuggestRtpHeaderExtensionId`,
  ignore a `LookupId` result, and skip a picker entry, whose id the group's
  recorder already maps to a different (uri, encrypt); fall through to a
  free id. A reverse (id -> extension) lookup on the recorder is enough.

A regression test: the repro above as a `PeerConnectionJsepTest` (or
`PeerConnectionRtpTest`), for implicit and explicit rollback, asserting the
follow-up SLD succeeds.

Related: the TODO for bugs.webrtc.org/504685269 in
`RtpHeaderExtensionRecorder::AddMapping` (`call/payload_type_picker.cc:414`,
field trial `WebRTC-ErrorOnRtpExtensionRedefinition`). If redefinitions
become errors before this is fixed, step 3 (SRD of the remote offer during
glare) would start failing too, since the stale recorder makes every glare
redefine mappings.

## Workaround (for other embedders)

Rewrite the offer before applying it: in each BUNDLE group, renumber each
a=extmap of a new m-section whose id is used by a different extension in an
already-negotiated section (to the group's id for that extension, or a
free id). Then libwebrtc logs one more "Redefining mapping" for the moved
extension, and everything else works, including later offers from either
side (they keep the new id).
