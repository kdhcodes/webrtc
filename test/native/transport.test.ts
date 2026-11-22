// DTLS and ICE transports against the raw native API: the transport keys
// snapshots carry (identity under BUNDLE, across renegotiation and ICE
// restarts), the reports each transport makes and when, and the ICE roles.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeDescriptionSnapshot } from '../../lib/internal/native-types.ts';
import { connect, gathered, negotiate, Peer } from './pc-harness.ts';

/** [senderTransport, receiverTransport] of each transceiver. */
function keys(snap: NativeDescriptionSnapshot): (number | null)[][] {
  return (snap.transceivers ?? []).map((t) => [t.senderTransport, t.receiverTransport]);
}

test('max-bundle: every sender, receiver and the SCTP transport share one transport from the offer', async (t) => {
  const a = new Peer(t, { bundlePolicy: 'max-bundle' });
  a.pc.addTransceiver('audio');
  a.pc.addTransceiver('video');
  a.pc.createDataChannel('x');
  const snap = await a.pc.setLocalDescription(await a.pc.createOffer());
  assert.deepEqual(keys(snap), [
    [1, 1],
    [1, 1],
  ]);
  assert.deepEqual(snap.sctp, { key: 1, transport: 1 });
  assert.deepEqual(snap.iceRoles, { 1: 'controlling' });
});

test('before a description there is no transport; a remote offer gives the answerer its own', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.addTransceiver('audio');
  const n = await negotiate(a, b);
  assert.deepEqual(keys(n.answererLocal), [[1, 1]]);
  assert.deepEqual(n.answererLocal.iceRoles, { 1: 'controlled' });
  assert.deepEqual(n.answererLocal.sctp, null);
});

test('balanced: one transport per m-section until the answer BUNDLEs them, which closes the other', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.addTransceiver('audio');
  a.pc.addTransceiver('video');
  const offer = await a.pc.createOffer();
  const local = await a.pc.setLocalDescription(offer);
  assert.deepEqual(keys(local), [
    [1, 1],
    [2, 2],
  ]);
  await b.pc.setRemoteDescription(offer);
  const answer = await b.pc.createAnswer();
  await b.pc.setLocalDescription(answer);
  const from = a.mark();
  const remote = await a.pc.setRemoteDescription(answer);
  assert.deepEqual(keys(remote), [
    [1, 1],
    [1, 1],
  ]);
  const dropped = (kind: 'dtls:state' | 'ice:state') =>
    a.events.slice(from).filter((e) => e.kind === kind && e.transport === 2);
  assert.deepEqual(
    dropped('dtls:state').map((e) => e.kind === 'dtls:state' && e.state),
    ['closed'],
    'DTLS reports it before the completion',
  );
  // ICE reports pass through the signaling thread, so this one follows.
  const ice = await a.waitFor('ice:state', (e) => e.transport === 2 && e.state === 'closed', from);
  assert.equal(ice.selectedPair, null);
});

test('renegotiation and an ICE restart keep the transport', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.addTransceiver('audio');
  await negotiate(a, b);
  a.pc.addTransceiver('video');
  const renegotiated = await negotiate(a, b);
  assert.deepEqual(keys(renegotiated.offererRemote), [
    [1, 1],
    [1, 1],
  ]);
  const offer = await a.pc.createOffer({ iceRestart: true });
  const restarted = await a.pc.setLocalDescription(offer);
  assert.deepEqual(keys(restarted), [
    [1, 1],
    [1, 1],
  ]);
});

test('a rollback of the offer that created the SCTP transport leaves none', async (t) => {
  const a = new Peer(t);
  a.pc.createDataChannel('x');
  const offered = await a.pc.setLocalDescription(await a.pc.createOffer());
  assert.deepEqual(offered.sctp, { key: 1, transport: 1 });
  const rolledBack = await a.pc.setLocalDescription({ type: 'rollback', sdp: '' });
  assert.equal(rolledBack.sctp, null);
});

test('once connected, ICE reports the selected pair as the candidates the icecandidate events carried', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.createDataChannel('x');
  await connect(a, b);
  const pairOf = async (peer: Peer) =>
    (await peer.waitFor('ice:state', (e) => e.selectedPair !== null)).selectedPair;
  const [pairA, pairB] = await Promise.all([pairOf(a), pairOf(b)]);
  const gathered = (peer: Peer) => peer.of('icecandidate').map((e) => e.candidate.candidate);
  assert.ok(pairA && pairB);
  assert.ok(gathered(a).includes(pairA.local), `${pairA.local} was gathered by a`);
  assert.ok(gathered(b).includes(pairB.local), `${pairB.local} was gathered by b`);
  // libwebrtc reports a remote candidate it learned from a check before the
  // signaled one arrived as peer-reflexive, with a redacted address.
  if (/ typ prflx /.test(pairA.remote)) {
    assert.equal(pairA.remote.split(' ')[5], pairB.local.split(' ')[5], 'the same port');
  } else {
    assert.equal(pairA.remote, pairB.local);
  }
  const states = a.of('ice:state').map((e) => e.state);
  assert.ok(states.includes('connected') || states.includes('completed'), states.join());
  assert.ok(a.of('dtls:state').some((e) => e.state === 'connected'));
});

test("a transport dropped after the remote closed its DTLS still reports ICE 'closed', with no connection state change", async (t) => {
  // DtlsTransport::Clear() says nothing when DTLS is closed already, and
  // here nothing at the connection level changes either: the report comes
  // from the description's own check (WatchTransports).
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.addTransceiver('audio');
  const video = a.pc.addTransceiver('video');
  // b never sees the BUNDLE group: one transport per m-section.
  const from = a.mark();
  await a.pc.setLocalDescription(await a.pc.createOffer());
  const offer = (await gathered(a, from)).replace(/^a=group:BUNDLE.*\r\n/m, '');
  await b.pc.setRemoteDescription({ type: 'offer', sdp: offer });
  const fromB = b.mark();
  await b.pc.setLocalDescription(await b.pc.createAnswer());
  const answered = await a.pc.setRemoteDescription({
    type: 'answer',
    sdp: await gathered(b, fromB),
  });
  assert.deepEqual(
    (answered.transceivers ?? []).map((t) => t.senderTransport),
    [1, 2],
  );
  const dtls = (key: number, state: string, after = 0) =>
    a.waitFor('dtls:state', (e) => e.transport === key && e.state === state, after);
  await Promise.all([
    dtls(1, 'connected'),
    dtls(2, 'connected'),
    a.waitFor('connectionstatechange', (e) => e.state === 'connected'),
  ]);

  // Stopping video rejects its m-section: b drops its transport, which
  // closes a's DTLS from the far end; a's answer then drops it here too.
  const beforeStop = a.mark();
  video.stop();
  const reoffer = await a.pc.createOffer();
  await a.pc.setLocalDescription(reoffer);
  await b.pc.setRemoteDescription(reoffer);
  const answer = await b.pc.createAnswer();
  await b.pc.setLocalDescription(answer);
  await dtls(2, 'closed', beforeStop);
  const beforeDrop = a.mark();
  await a.pc.setRemoteDescription(answer);
  await a.waitFor('ice:state', (e) => e.transport === 2 && e.state === 'closed', beforeDrop);
  // getStats completes behind everything queued so far.
  await a.pc.getStats();
  assert.deepEqual(
    a.events
      .slice(beforeDrop)
      .filter((e) => e.kind === 'iceconnectionstatechange' || e.kind === 'connectionstatechange'),
    [],
  );
});
