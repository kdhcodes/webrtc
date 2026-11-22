// Signaling details against real libwebrtc, where the JS layer bridges a
// gap between libwebrtc and the spec: implicit rollback, the last created
// offer/answer, ICE gathering completion and the remote description's
// candidates. The orderings themselves are unit-tested with the fake
// native (lib/RTCPeerConnection.test.ts).
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { nonstandard, RTCPeerConnection, type RTCPeerConnectionIceEvent } from '../../lib/index.ts';
import { audible, media, negotiate, next, pair } from './harness.ts';

function open(t: TestContext): RTCPeerConnection {
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  return pc;
}

/** Resolves with every candidate up to and including the null one. */
function allCandidates(pc: RTCPeerConnection): Promise<RTCPeerConnectionIceEvent['candidate'][]> {
  const seen: RTCPeerConnectionIceEvent['candidate'][] = [];
  return next<RTCPeerConnectionIceEvent>(pc, 'icecandidate', (e) => {
    seen.push(e.candidate);
    return e.candidate === null;
  }).then(() => seen);
}

const lines = (sdp: string | undefined, prefix: string) =>
  (sdp ?? '').split('\r\n').filter((line) => line.startsWith(prefix));

test('SLD and SRD of offers chained together roll back implicitly (WPT "not racy")', async (t) => {
  const pc = open(t);
  const states: string[] = [];
  pc.onsignalingstatechange = () => states.push(pc.signalingState);
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const offer = await pc.createOffer();
  await Promise.all([pc.setLocalDescription(offer), pc.setRemoteDescription(offer)]);
  assert.deepEqual(states, ['have-local-offer', 'stable', 'have-remote-offer']);
});

test('glare: the polite peer takes the remote offer over its own and the call completes', async (t) => {
  const { a: polite, b: impolite } = pair(t);
  polite.addTransceiver('audio');
  impolite.addTransceiver('video');
  await polite.setLocalDescription();
  await impolite.setLocalDescription();
  // Both offered; the polite one accepts the other's offer.
  await polite.setRemoteDescription(impolite.localDescription ?? assert.fail());
  await polite.setLocalDescription();
  await impolite.setRemoteDescription(polite.localDescription ?? assert.fail());
  assert.deepEqual([polite.signalingState, impolite.signalingState], ['stable', 'stable']);
  assert.equal(polite.localDescription?.type, 'answer');
});

/** The a=extmap lines of the media section with `mid`. */
function extmaps(sdp: string | undefined, mid: string | null): string[] {
  const section = (sdp ?? '').split('\r\nm=').find((s) => s.includes(`\r\na=mid:${mid}\r\n`));
  return lines(section, 'a=extmap:');
}

/**
 * Glare: both offer, the polite peer rolls its offer back (implicitly, by
 * SRD of the other's offer, or explicitly first) and answers.
 */
async function glare(
  polite: RTCPeerConnection,
  impolite: RTCPeerConnection,
  rollback: 'implicit' | 'explicit',
): Promise<void> {
  await polite.setLocalDescription();
  await impolite.setLocalDescription();
  if (rollback === 'explicit') await polite.setLocalDescription({ type: 'rollback' });
  await polite.setRemoteDescription(impolite.localDescription ?? assert.fail());
  await polite.setLocalDescription();
  await impolite.setRemoteDescription(polite.localDescription ?? assert.fail());
}

for (const rollback of ['implicit', 'explicit'] as const) {
  test(`after an ${rollback} rollback, the next offer with the rolled-back transceiver applies`, async (t) => {
    const { a: polite, b: impolite } = pair(t);
    const audio = polite.addTransceiver('audio');
    impolite.addTransceiver('video');
    await glare(polite, impolite, rollback);
    // The answer can't include the rolled-back audio transceiver.
    assert.equal(audio.mid, null);
    // libwebrtc's own follow-up offer gives audio-level the id 1 of the
    // rolled-back offer, which the bundled video already uses for toffset,
    // and its SLD rejects that ("A BUNDLE group contains a codec collision
    // for header extension id=1"; PLAN.md "Gotchas"). The JS layer
    // renumbers it (lib/internal/extmap-fix.ts). If this id changes, check
    // whether libwebrtc fixed the bug: then drop the workaround.
    await polite.setLocalDescription();
    assert.deepEqual(
      lines(polite.localDescription?.sdp, 'a=extmap:').filter((l) => l.endsWith('audio-level')),
      ['a=extmap:14 urn:ietf:params:rtp-hdrext:ssrc-audio-level'],
    );
    await impolite.setRemoteDescription(polite.localDescription ?? assert.fail());
    await impolite.setLocalDescription();
    await polite.setRemoteDescription(impolite.localDescription ?? assert.fail());
    assert.notEqual(audio.mid, null);
    assert.deepEqual([polite.signalingState, impolite.signalingState], ['stable', 'stable']);
  });
}

test('after the renumbered offer, audio flows and later offers from either side keep the ids', async (t) => {
  const { a: polite, b: impolite } = pair(t);
  const m = media(t);
  const audio = polite.addTransceiver(m.audio);
  impolite.addTransceiver('video');
  await glare(polite, impolite, 'implicit');
  await negotiate(polite, impolite);
  const mid = audio.mid;
  const ids = extmaps(polite.localDescription?.sdp, mid);
  const remote = impolite.getTransceivers().find((tr) => tr.mid === mid)?.receiver.track;
  const sink = new nonstandard.RTCAudioSink(remote ?? assert.fail());
  t.after(() => sink.stop());
  await next<nonstandard.RTCAudioDataEvent>(sink, 'data', (e) => audible(e.samples));
  await negotiate(impolite, polite);
  assert.deepEqual(extmaps(impolite.localDescription?.sdp, mid), ids);
  // A later new section collides with nothing either.
  polite.addTransceiver('audio');
  polite.addTransceiver('video');
  await negotiate(polite, impolite);
  assert.deepEqual(extmaps(polite.localDescription?.sdp, mid), ids);
  assert.ok(polite.getTransceivers().every((tr) => tr.mid !== null));
});

// Which kinds each side offered in the glare, polite first. Without the
// extmap workaround the first three fail; the last two never collided.
const glareCases: [polite: ('audio' | 'video')[], impolite: ('audio' | 'video')[]][] = [
  [['audio'], ['video']],
  [['video'], ['audio']],
  [['video', 'audio'], ['audio']],
  [
    ['audio', 'video'],
    ['video', 'audio'],
  ],
  [['video'], ['video']],
];
for (const [mine, theirs] of glareCases) {
  test(`glare, polite ${mine.join('+')} vs impolite ${theirs.join('+')}: both sides' follow-up offers apply`, async (t) => {
    const { a: polite, b: impolite } = pair(t);
    for (const kind of mine) polite.addTransceiver(kind);
    for (const kind of theirs) impolite.addTransceiver(kind);
    await glare(polite, impolite, 'implicit');
    // The polite peer's follow-up offer, through the implicit SLD.
    await polite.setLocalDescription();
    await impolite.setRemoteDescription(polite.localDescription ?? assert.fail());
    await impolite.setLocalDescription();
    await polite.setRemoteDescription(impolite.localDescription ?? assert.fail());
    assert.deepEqual(
      polite.getTransceivers().map((tr) => tr.mid !== null),
      polite.getTransceivers().map(() => true),
    );
    await negotiate(impolite, polite);
    await negotiate(polite, impolite);
    assert.deepEqual([polite.signalingState, impolite.signalingState], ['stable', 'stable']);
  });
}

test('setLocalDescription without SDP applies the last created offer and answer', async (t) => {
  const { a, b } = pair(t);
  a.addTransceiver('audio');
  const offer = await a.createOffer();
  await a.setLocalDescription();
  assert.equal(a.pendingLocalDescription?.sdp.split('\r\n')[1], offer.sdp?.split('\r\n')[1]);
  await b.setRemoteDescription(offer);
  const answer = await b.createAnswer();
  await b.setLocalDescription({ type: 'answer' });
  assert.equal(b.currentLocalDescription?.sdp.split('\r\n')[1], answer.sdp?.split('\r\n')[1]);
});

test("setLocalDescription({type: 'pranswer'}) without SDP applies a pranswer", async (t) => {
  const { a, b } = pair(t);
  a.addTransceiver('audio');
  await b.setRemoteDescription(await a.createOffer());
  await b.setLocalDescription({ type: 'pranswer' });
  assert.deepEqual(
    [b.signalingState, b.localDescription?.type],
    ['have-local-pranswer', 'pranswer'],
  );
});

test('an unanswered two-section offer ends gathering on both transports, in the local description too', async (t) => {
  const pc = open(t);
  pc.addTransceiver('audio');
  pc.addTransceiver('video');
  const candidates = allCandidates(pc);
  await pc.setLocalDescription();
  const ends = (await candidates).filter((c) => c?.candidate === '').map((c) => c?.sdpMid);
  // 'balanced' gathers per m-section until the answer bundles them.
  assert.deepEqual(ends, ['0', '1']);
  assert.equal(lines(pc.localDescription?.sdp, 'a=end-of-candidates').length, 2);
});

test('addIceCandidate puts the candidate and end-of-candidates into the remote description', async (t) => {
  const a = open(t);
  const b = open(t);
  a.addTransceiver('audio');
  const candidates = allCandidates(a);
  // The offer as created, before any candidate joined it.
  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  const [first] = (await candidates).filter((c) => c?.candidate);
  assert.ok(first);
  await b.setRemoteDescription(offer);
  await b.addIceCandidate(first);
  assert.deepEqual(lines(b.remoteDescription?.sdp, 'a=candidate:'), [`a=${first.candidate}`]);
  await b.addIceCandidate({ candidate: '', sdpMid: '0' });
  assert.equal(lines(b.remoteDescription?.sdp, 'a=end-of-candidates').length, 1);
});

test("addTrack right after replaceTrack(null) gets a new sender, and libwebrtc's offer agrees", async (t) => {
  const pc = open(t);
  const source = new nonstandard.RTCAudioSource();
  const [first, second] = [source.createTrack(), source.createTrack()];
  const sender = pc.addTrack(first);
  const replaced = sender.replaceTrack(null);
  const other = pc.addTrack(second);
  await replaced;
  assert.notEqual(other, sender);
  assert.deepEqual(
    pc.getSenders().map((s) => s.track),
    [null, second],
  );
  // libwebrtc made a second m-line, sending `second` (its msid names the
  // track), rather than reusing the first.
  const offer = await pc.createOffer();
  const sections = (offer.sdp ?? '').split(/\r\n(?=m=)/).slice(1);
  assert.equal(sections.length, 2);
  assert.ok(sections[1]?.includes(second.id));
  assert.ok(!sections[0]?.includes(second.id));
});
