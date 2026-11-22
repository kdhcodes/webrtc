// PeerConnection additions against the raw native API: configuration,
// createOffer options, implicit SLD, ICE event snapshots, negotiationneeded
// event ids, what close() leaves working, and error shapes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import os from 'node:os';
import { type TestContext, test } from 'node:test';
import type { NativeIceCandidate } from '../../lib/internal/native-types.ts';
import { gathered, nativeError, negotiate, Peer } from './pc-harness.ts';

/** Starts gathering on `peer` and resolves with every candidate it found. */
async function gatherCandidates(peer: Peer): Promise<NativeIceCandidate[]> {
  const from = peer.mark();
  await peer.pc.setLocalDescription(await peer.pc.createOffer());
  await gathered(peer, from);
  return peer.of('icecandidate').map((e) => e.candidate);
}

/** The candidate line up to and including `typ <type>`. */
function identity(c: NativeIceCandidate): string {
  return c.candidate.split(' ').slice(0, 8).join(' ');
}

/** `candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type>` */
function parts(c: NativeIceCandidate) {
  const f = c.candidate.split(' ');
  return { protocol: f[2], port: Number(f[5]), type: f[7] };
}

test('setLocalDescription() with no argument creates and applies the offer and answer', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.addTransceiver('audio');

  const offerSnap = await a.pc.setLocalDescription();
  assert.equal(offerSnap.signalingState, 'have-local-offer');
  assert.equal(offerSnap.localDescription?.type, 'offer');
  assert.match(offerSnap.localDescription?.sdp ?? '', /^m=audio /m);

  await b.pc.setRemoteDescription(offerSnap.localDescription ?? assert.fail());
  const answerSnap = await b.pc.setLocalDescription(undefined);
  assert.equal(answerSnap.signalingState, 'stable');
  assert.equal(answerSnap.localDescription?.type, 'answer');
});

test('offerToReceive* adds or demotes transceivers; unset leaves them alone', async (t) => {
  const a = new Peer(t);
  const plain = await a.pc.createOffer({});
  assert.doesNotMatch(plain.sdp, /^m=/m);
  assert.deepEqual(a.pc.getTransceivers(), []);

  const offer = await a.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  assert.match(offer.sdp, /^m=audio /m);
  assert.match(offer.sdp, /^m=video /m);
  const added = a.pc.getTransceivers();
  assert.deepEqual(
    added.map((tr) => [tr.receiver.track.kind, tr.direction]),
    [
      ['audio', 'recvonly'],
      ['video', 'recvonly'],
    ],
  );

  const b = new Peer(t);
  const tr = b.pc.addTransceiver('audio', { direction: 'sendrecv' });
  await b.pc.createOffer({ offerToReceiveAudio: false });
  assert.equal(tr.direction, 'sendonly');
});

test('iceRestart produces new ICE credentials', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.addTransceiver('audio');
  await negotiate(a, b);
  const ufrag = (sdp: string) => /^a=ice-ufrag:(.+)$/m.exec(sdp)?.[1];
  const current = ufrag((await a.pc.createOffer()).sdp);
  assert.ok(current);

  const restarted = ufrag((await a.pc.createOffer({ iceRestart: true })).sdp);
  assert.ok(restarted);
  assert.notEqual(restarted, current);
});

test('icecandidate snapshots hold a local description containing the candidate', async (t) => {
  const a = new Peer(t);
  a.pc.addTransceiver('audio');
  const candidates = await gatherCandidates(a);
  assert.ok(candidates.length > 0);

  for (const ev of a.of('icecandidate')) {
    assert.equal(ev.snapshot?.signalingState, undefined);
    assert.equal(ev.snapshot?.transceivers, undefined);
    assert.equal(ev.snapshot?.localDescription?.type, 'offer');
    // The SDP line omits the ufrag the event's string carries, so compare
    // up to the candidate type.
    const sdp = ev.snapshot?.localDescription?.sdp ?? '';
    assert.ok(
      sdp.includes(`a=${identity(ev.candidate)} `),
      `${identity(ev.candidate)} not in\n${sdp}`,
    );
  }
  const complete = a.of('icegatheringstatechange').find((e) => e.state === 'complete');
  for (const c of candidates) {
    assert.ok(complete?.snapshot?.localDescription?.sdp.includes(`a=${identity(c)} `));
  }
});

// Snapshots reuse a description's SDP while it is the same, unchanged
// object (CaptureSnapshot). These are the cases where the object stays but
// its SDP changes, or it moves between pending and current.
test('snapshots follow every description through a trickled negotiation and renegotiation', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.addTransceiver('audio');
  const lines = (sdp: string | undefined) => (sdp ?? '').match(/^a=candidate:.*$/gm) ?? [];

  const fromA = a.mark();
  const offer = await a.pc.createOffer();
  const aOffer = await a.pc.setLocalDescription(offer);
  assert.equal(aOffer.pendingLocalDescription?.sdp, aOffer.localDescription?.sdp);
  assert.equal(aOffer.currentLocalDescription, null);
  const aGathered = await gathered(a, fromA);
  assert.ok(lines(aGathered).length > 0, 'a gathered candidates into its pending offer');

  // b gets the offer without candidates, then trickles them in.
  const bOffer = await b.pc.setRemoteDescription(offer);
  assert.deepEqual(lines(bOffer.pendingRemoteDescription?.sdp), []);
  const aCandidates = a.of('icecandidate').map((e) => e.candidate);
  for (const c of aCandidates) await b.pc.addIceCandidate(c);
  const fromB = b.mark();
  const answer = await b.pc.createAnswer();
  const bAnswer = await b.pc.setLocalDescription(answer);
  assert.equal(bAnswer.pendingRemoteDescription, null);
  assert.equal(
    lines(bAnswer.currentRemoteDescription?.sdp).length,
    aCandidates.length,
    'the remote offer, moved from pending to current, carries the trickled candidates',
  );
  assert.equal(bAnswer.remoteDescription?.sdp, bAnswer.currentRemoteDescription?.sdp);
  await gathered(b, fromB);

  // a's pending offer, with its gathered candidates, becomes current.
  const aAnswer = await a.pc.setRemoteDescription(answer);
  assert.equal(aAnswer.pendingLocalDescription, null);
  assert.equal(aAnswer.currentLocalDescription?.sdp, aGathered);
  assert.equal(aAnswer.localDescription?.sdp, aGathered);
  assert.deepEqual(lines(aAnswer.currentRemoteDescription?.sdp), []);

  // A candidate added to an installed remote description shows up in the
  // next snapshot, though nothing else about that description changed.
  const bCandidates = b.of('icecandidate').map((e) => e.candidate);
  assert.ok(bCandidates.length > 0);
  for (const c of bCandidates) await a.pc.addIceCandidate(c);
  a.pc.addTransceiver('video');
  const reoffer = await a.pc.setLocalDescription(await a.pc.createOffer());
  assert.equal(lines(reoffer.currentRemoteDescription?.sdp).length, bCandidates.length);
  assert.equal(reoffer.currentLocalDescription?.sdp, aGathered, 'unchanged current offer');
  assert.match(reoffer.pendingLocalDescription?.sdp ?? '', /^m=video /m);
  assert.equal(reoffer.localDescription?.sdp, reoffer.pendingLocalDescription?.sdp);
});

test('portRange limits the ports of host UDP candidates', async (t) => {
  const range = { min: 51200, max: 51299 };
  const a = new Peer(t, { portRange: range });
  a.pc.addTransceiver('audio');
  const udp = (await gatherCandidates(a)).map(parts).filter((c) => c.protocol === 'udp');
  assert.ok(udp.length > 0);
  for (const c of udp) {
    assert.ok(
      c.port >= range.min && c.port <= range.max,
      `port ${c.port} outside ${range.min}-${range.max}`,
    );
  }
});

test("iceTransportPolicy 'relay' gathers nothing without a TURN server", async (t) => {
  const a = new Peer(t, { iceTransportPolicy: 'relay' });
  a.pc.addTransceiver('audio');
  assert.deepEqual(await gatherCandidates(a), []);
});

test('bundlePolicy decides which m-lines gather candidates', async (t) => {
  const mlines = async (bundlePolicy: 'max-bundle' | 'max-compat') => {
    const p = new Peer(t, { bundlePolicy });
    p.pc.addTransceiver('audio');
    p.pc.addTransceiver('video');
    const candidates = await gatherCandidates(p);
    return [...new Set(candidates.map((c) => c.sdpMLineIndex))].sort();
  };
  assert.deepEqual(await mlines('max-bundle'), [0]);
  assert.deepEqual(await mlines('max-compat'), [0, 1]);
});

test('setConfiguration applies changeable fields and reports libwebrtc errors', async (t) => {
  const a = new Peer(t, { bundlePolicy: 'balanced' });
  a.pc.setConfiguration({ iceServers: [], iceTransportPolicy: 'relay', bundlePolicy: 'balanced' });
  a.pc.addTransceiver('audio');
  assert.deepEqual(await gatherCandidates(a), []);

  assert.throws(() => a.pc.setConfiguration({ bundlePolicy: 'max-bundle' }), {
    errorType: 'INVALID_MODIFICATION',
  });
  assert.throws(() => a.pc.setConfiguration({ iceCandidatePoolSize: -1 }), {
    errorType: 'INVALID_RANGE',
  });
  assert.throws(() => a.pc.setConfiguration({ iceServers: [{ urls: 'turn:example.com' }] }), {
    errorType: 'INVALID_PARAMETER',
  });
  assert.throws(() => a.pc.setConfiguration({ bundlePolicy: 'nope' as never }), {
    name: 'TypeError',
    message: 'invalid bundlePolicy',
  });
});

test('negotiationneeded carries an eventId that shouldFireNegotiationNeededEvent checks', async (t) => {
  const a = new Peer(t);
  a.pc.addTransceiver('audio');
  const { eventId } = await a.waitFor('negotiationneeded');
  assert.ok(eventId > 0);
  assert.equal(a.pc.shouldFireNegotiationNeededEvent(eventId + 1), false);
  assert.equal(a.pc.shouldFireNegotiationNeededEvent(eventId), true);

  await a.pc.setLocalDescription();
  // Not stable any more, so the event is no longer valid.
  assert.equal(a.pc.shouldFireNegotiationNeededEvent(eventId), false);
});

test('portRange {min} alone restricts host UDP ports to min-65535', async (t) => {
  const min = 64000;
  const a = new Peer(t, { portRange: { min } });
  a.pc.addTransceiver('audio');
  const udp = (await gatherCandidates(a)).map(parts).filter((c) => c.protocol === 'udp');
  assert.ok(udp.length > 0);
  for (const c of udp) assert.ok(c.port >= min, `port ${c.port} below ${min}`);
});

test('portRange {max} alone leaves host UDP ports unrestricted, as in wrtc', async (t) => {
  // 0-max: libwebrtc binds port 0 first, which lets the OS pick.
  const max = 1000;
  const a = new Peer(t, { portRange: { max } });
  a.pc.addTransceiver('audio');
  const udp = (await gatherCandidates(a)).map(parts).filter((c) => c.protocol === 'udp');
  assert.ok(udp.length > 0);
  for (const c of udp) assert.ok(c.port > max, `port ${c.port} is within 0-${max}`);
});

/**
 * A loopback STUN server that answers every request with error `code` and
 * `reason`. Resolves with its port.
 */
async function failingStunServer(t: TestContext, code: number, reason: string): Promise<number> {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (req, from) => {
    const text = Buffer.from(reason);
    const padded = Math.ceil(text.length / 4) * 4;
    const res = Buffer.alloc(20 + 4 + 4 + padded);
    // The error response class of the request's method, with its magic
    // cookie and transaction id.
    res.writeUInt16BE((req.readUInt16BE(0) & 0x3eef) | 0x0110, 0);
    res.writeUInt16BE(4 + 4 + padded, 2);
    req.copy(res, 4, 4, 20);
    res.writeUInt16BE(0x0009, 20); // ERROR-CODE
    res.writeUInt16BE(4 + text.length, 22);
    res.writeUInt8(Math.floor(code / 100), 26);
    res.writeUInt8(code % 100, 27);
    text.copy(res, 28);
    socket.send(res, from.port, from.address);
  });
  t.after(() => socket.close());
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return socket.address().port;
}

// libwebrtc doesn't gather on loopback, so with no other interface (e.g.
// offline, Wi-Fi off) there's no host candidate and no STUN request at all.
const hasNonLoopbackIPv4 = Object.values(os.networkInterfaces())
  .flat()
  .some((iface) => iface?.family === 'IPv4' && !iface.internal);

test('icecandidateerror reports a STUN server that answers with an error', {
  skip: hasNonLoopbackIPv4 ? false : 'needs a non-loopback IPv4 interface to gather on',
}, async (t) => {
  const port = await failingStunServer(t, 420, 'Unknown Attribute');
  const url = `stun:127.0.0.1:${port}`;
  const a = new Peer(t, { iceServers: [{ urls: url }] });
  a.pc.addTransceiver('audio');
  await a.pc.setLocalDescription();
  const ev = await a.waitFor('icecandidateerror');
  // `address` (the host candidate's, with its last part hidden) and `port`
  // depend on the machine.
  assert.deepEqual(
    { url: ev.url, errorCode: ev.errorCode, errorText: ev.errorText },
    // libwebrtc reports only the code's number part (420 % 100).
    { url, errorCode: 20, errorText: 'Unknown Attribute' },
  );
});

test('getStats still resolves after close(); every other async op rejects', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.addTransceiver('audio');
  await negotiate(a, b);
  const offer = await b.pc.createOffer();
  a.pc.close();

  const report = JSON.parse(await a.pc.getStats()) as Record<string, { type: string }>;
  assert.ok(Object.values(report).some((s) => s.type === 'peer-connection'));
  const closed = nativeError('INVALID_STATE', 'peer connection is closed');
  await assert.rejects(a.pc.createOffer(), closed);
  await assert.rejects(a.pc.createAnswer(), closed);
  await assert.rejects(a.pc.setLocalDescription(), closed);
  await assert.rejects(a.pc.setRemoteDescription(offer), closed);
  await assert.rejects(
    a.pc.addIceCandidate({
      candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 50000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    }),
    closed,
  );
});

test('ops in flight at close() complete normally', async (t) => {
  // createOffer/createAnswer are left out: whether libwebrtc finishes them
  // before close() (resolving) or not (rejecting with INTERNAL_ERROR) is a
  // race on its threads. Either way they settle, through libwebrtc.
  const src = new Peer(t);
  src.pc.addTransceiver('audio');
  const offer = await src.pc.createOffer();
  const b = new Peer(t);
  const tr = b.pc.addTransceiver('video');

  const srd = b.pc.setRemoteDescription(offer);
  const stats = b.pc.getStats();
  const setParameters = tr.sender.setParameters(tr.sender.getParameters());
  b.pc.close();

  assert.equal((await srd).signalingState, 'have-remote-offer');
  assert.equal(typeof JSON.parse(await stats), 'object');
  assert.equal(await setParameters, undefined);
});

test('close() mid-SRD: the SRD resolves and its track events are delivered', async (t) => {
  const src = new Peer(t);
  src.pc.addTransceiver('audio', { streams: ['s'] });
  src.pc.addTransceiver('video', { streams: ['s'] });
  const offer = await src.pc.createOffer();
  const b = new Peer(t);

  // libwebrtc has applied the offer by the time the call returns; what is
  // still in flight is its completion and events on the way to JS.
  const srd = b.pc.setRemoteDescription(offer);
  b.pc.close();
  const snapshot = await srd;

  assert.equal(snapshot.signalingState, 'have-remote-offer');
  const handles = snapshot.transceivers?.map((s) => s.transceiver);
  assert.equal(handles?.length, 2);
  assert.deepEqual(b.pc.getTransceivers(), handles);
  assert.deepEqual(
    b.of('track').map((ev) => [ev.transceiver, ev.streamIds]),
    handles?.map((h) => [h, ['s']]),
  );
});

test('a closed PC keeps the process alive only while ops are pending', async () => {
  // Without the event stream being re-ref'd for the op, the process would
  // exit before the stats arrive; if it were never unref'd, it wouldn't exit.
  const script = `
    import { createRequire } from 'node:module';
    const native = createRequire(${JSON.stringify(import.meta.url)})('../../build/Release/wrtc.node');
    const pc = new native.PeerConnection({}, () => {});
    pc.addTransceiver('audio');
    pc.close();
    pc.getStats().then((json) => {
      console.log(Object.values(JSON.parse(json)).map((s) => s.type).join());
    });
  `;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      { timeout: 20_000 },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
  });
  assert.equal(stdout.trim(), 'peer-connection');
});

test('SDP and candidate parse failures are SYNTAX_ERRORs with the offending line', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.addTransceiver('audio');
  const offer = await a.pc.createOffer();
  const mline = /^m=audio .*$/m.exec(offer.sdp)?.[0];
  assert.ok(mline);
  const broken = mline.replace(/^m=audio \d+/, 'm=audio notaport');
  await assert.rejects(
    b.pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp.replace(mline, broken) }),
    nativeError('SYNTAX_ERROR', /^failed to parse SDP: /, broken),
  );
  await assert.rejects(
    b.pc.setLocalDescription({ type: 'offer', sdp: 'garbage' }),
    nativeError('SYNTAX_ERROR', 'failed to parse SDP: Expect line: v=', 'garbage'),
  );
  await b.pc.setRemoteDescription(offer);
  const candidate = 'candidate:1 1 udp notapriority 192.0.2.1 50000 typ host';
  await assert.rejects(
    b.pc.addIceCandidate({ candidate, sdpMid: '0', sdpMLineIndex: 0 }),
    nativeError('SYNTAX_ERROR', /^failed to parse candidate: /, candidate),
  );
});
