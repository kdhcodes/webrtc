// The DTLS, ICE and SCTP transports through the public API, two
// RTCPeerConnections against real libwebrtc: when senders, receivers and
// pc.sctp get their transports, identity under BUNDLE, renegotiation and
// ICE restarts, the selected candidate pair, and close().
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RTCDtlsTransport,
  RTCIceCandidatePair,
  RTCPeerConnection,
  type RTCPeerConnectionIceEvent,
  RTCSctpTransport,
  type RTCSessionDescriptionInit,
} from '../../lib/index.ts';
import { connect, negotiate, next, pair } from './harness.ts';

test('senders and receivers get their transport with the local offer, one object per transport', async (t) => {
  const { a, b } = pair(t);
  const audio = a.addTransceiver('audio');
  const video = a.addTransceiver('video');
  const before = audio.sender.transport;
  assert.equal(before, null, 'null before negotiation');
  await a.setLocalDescription();
  const first = audio.sender.transport;
  assert.ok(first instanceof RTCDtlsTransport);
  assert.equal(audio.receiver.transport, first, "the receiver's is the sender's");
  assert.notEqual(video.sender.transport, first, "'balanced' offers one transport per kind");

  await b.setRemoteDescription(a.localDescription as RTCSessionDescriptionInit);
  const [answering] = b.getTransceivers();
  const afterRemoteOffer = answering?.receiver.transport;
  assert.equal(afterRemoteOffer, null, 'a remote offer sets none');
  await b.setLocalDescription();
  assert.ok(answering?.receiver.transport instanceof RTCDtlsTransport);

  await a.setRemoteDescription(b.localDescription as RTCSessionDescriptionInit);
  assert.equal(video.sender.transport, first, 'the answer BUNDLEs video onto the first');
});

test('the transport stays the same object through renegotiation and an ICE restart', async (t) => {
  const p = pair(t);
  const audio = p.a.addTransceiver('audio');
  p.a.createDataChannel('x');
  await connect(p);
  const transport = audio.sender.transport;
  const { iceTransport } = transport as RTCDtlsTransport;
  assert.equal(p.a.sctp?.transport, transport, 'data channels share it under BUNDLE');

  const video = p.a.addTransceiver('video');
  await negotiate(p.a, p.b);
  assert.equal(video.sender.transport, transport);

  p.a.restartIce();
  await negotiate(p.a, p.b);
  assert.equal(audio.sender.transport, transport);
  assert.equal(audio.sender.transport?.iceTransport, iceTransport);
});

test('once connected: DTLS has the remote certificate, ICE a selected pair of gathered candidates', async (t) => {
  const p = pair(t);
  const gathered = new Set<string>();
  p.a.addEventListener('icecandidate', (e) => {
    const { candidate } = e as RTCPeerConnectionIceEvent;
    if (candidate?.candidate) gathered.add(candidate.candidate);
  });
  const audio = p.a.addTransceiver('audio');
  await connect(p);
  const dtls = audio.sender.transport as RTCDtlsTransport;
  assert.equal(dtls.state, 'connected');
  assert.equal(new Uint8Array(dtls.getRemoteCertificates()[0] ?? new ArrayBuffer(0))[0], 0x30);
  const { iceTransport } = dtls;
  assert.ok(['connected', 'completed'].includes(iceTransport.state), iceTransport.state);
  assert.deepEqual([iceTransport.role, iceTransport.component], ['controlling', 'rtp']);
  const selected = iceTransport.getSelectedCandidatePair();
  assert.ok(selected instanceof RTCIceCandidatePair);
  assert.equal(
    iceTransport.getSelectedCandidatePair(),
    selected,
    'the same object until it changes',
  );
  assert.ok(gathered.has(selected.local.candidate), `${selected.local.candidate} was gathered`);
  const remoteIce = p.b.getTransceivers()[0]?.receiver.transport?.iceTransport;
  assert.equal(remoteIce?.role, 'controlled');
  const remoteLocal = remoteIce?.getSelectedCandidatePair()?.local;
  assert.equal(remoteLocal?.port, selected.remote.port, "the remote end is b's local candidate");
  // Peer-reflexive when b's checks arrived before its candidate did: hidden.
  if (selected.remote.type === 'prflx') {
    assert.deepEqual([selected.remote.candidate, selected.remote.address], ['', null]);
  } else {
    assert.equal(selected.remote.candidate, remoteLocal?.candidate);
  }
  assert.ok(iceTransport.getLocalCandidates().length > 0);
  assert.equal(
    iceTransport.getRemoteParameters()?.usernameFragment,
    remoteIce?.getLocalParameters()?.usernameFragment,
  );
});

test('pc.sctp exists from the offer that negotiates data channels, and goes with a rollback', async (t) => {
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  pc.createDataChannel('x');
  await pc.setLocalDescription();
  const sctp = pc.sctp;
  assert.ok(sctp instanceof RTCSctpTransport);
  assert.deepEqual(
    [sctp.state, sctp.maxMessageSize, sctp.maxChannels],
    ['connecting', 65536, null],
  );
  assert.ok(sctp.transport instanceof RTCDtlsTransport);
  await pc.setLocalDescription({ type: 'rollback' });
  assert.equal(pc.sctp, null);
});

test('pc.sctp keeps its object through the answer and connects', async (t) => {
  const p = pair(t);
  p.a.createDataChannel('x');
  await p.a.setLocalDescription();
  const sctp = p.a.sctp;
  const connected = next(
    sctp as RTCSctpTransport,
    'statechange',
    () => sctp?.state === 'connected',
  );
  await p.b.setRemoteDescription(p.a.localDescription as RTCSessionDescriptionInit);
  await p.b.setLocalDescription();
  await p.a.setRemoteDescription(p.b.localDescription as RTCSessionDescriptionInit);
  assert.equal(p.a.sctp, sctp);
  await connected;
  assert.equal(sctp?.maxMessageSize, 262144);
  assert.ok((sctp?.maxChannels ?? 0) > 0);
});

test('close() closes the transports at once and without events; they stay reachable', async (t) => {
  const p = pair(t);
  const audio = p.a.addTransceiver('audio');
  await connect(p);
  const dtls = audio.sender.transport as RTCDtlsTransport;
  const events: string[] = [];
  dtls.onstatechange = () => events.push('dtls');
  dtls.iceTransport.onstatechange = () => events.push('ice');
  p.a.close();
  assert.equal(audio.sender.transport, dtls);
  assert.deepEqual([dtls.state, dtls.iceTransport.state], ['closed', 'closed']);
  assert.equal(dtls.iceTransport.getSelectedCandidatePair(), null);
  // The other side noticing the close comes through b's own transport.
  const remote = p.b.getTransceivers()[0]?.receiver.transport as RTCDtlsTransport;
  await next(remote, 'statechange', () => remote.state === 'closed');
  assert.deepEqual(events, []);
});

test("a remote re-offer adding an unBUNDLEd m-section leaves the connected transport 'connected'", async (t) => {
  // The connection goes 'checking' (the new transport is 'new'); the first
  // transport, which libwebrtc never reports changed, mustn't follow it.
  const p = pair(t);
  p.a.addTransceiver('audio');
  await connect(p);
  const transport = p.b.getTransceivers()[0]?.receiver.transport as RTCDtlsTransport;
  assert.equal(transport.iceTransport.state, 'connected');
  const checking = next(
    p.b,
    'iceconnectionstatechange',
    () => p.b.iceConnectionState === 'checking',
  );
  p.a.addTransceiver('video');
  const offer = await p.a.createOffer();
  const [session, audio, video] = (offer.sdp ?? '').split(/(?=^m=)/m) as [string, string, string];
  const sdp =
    session.replace(/^a=group:BUNDLE 0 1\r\n/m, 'a=group:BUNDLE 0\r\n') +
    audio +
    video
      .replace(/^a=ice-ufrag:.*\r\n/m, 'a=ice-ufrag:abcd\r\n')
      .replace(/^a=ice-pwd:.*\r\n/m, 'a=ice-pwd:abcdefghijklmnopqrstuvwx\r\n');
  await p.b.setRemoteDescription({ type: 'offer', sdp });
  await p.b.setLocalDescription();
  await checking;
  const transports = p.b.getTransceivers().map((x) => x.receiver.transport);
  assert.equal(new Set(transports).size, 2, 'the new m-section has its own transport');
  assert.equal(transport.iceTransport.state, 'connected');
});
