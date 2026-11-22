// The spike as a test: two in-process peer connections, a data channel round
// trip, stats, and close.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { native } from '../../lib/internal/native.ts';
import type {
  NativeDataChannel,
  NativeIceCandidate,
  NativePcEvent,
  NativePeerConnection,
} from '../../lib/internal/native-types.ts';
import { connect, Peer } from './pc-harness.ts';

test('data channel ping/pong between two peer connections', async () => {
  const channels = new Map<number, NativeDataChannel>();
  const pending: Record<'a' | 'b', NativeIceCandidate[]> = { a: [], b: [] };
  let negotiated = false;
  let a!: NativePeerConnection;
  let b!: NativePeerConnection;

  const pong = new Promise<string>((resolve, reject) => {
    const trickle = (target: NativePeerConnection, key: 'a' | 'b', c: NativeIceCandidate) => {
      if (negotiated) target.addIceCandidate(c).catch(reject);
      else pending[key].push(c);
    };
    a = new native.PeerConnection({ iceServers: [] }, (ev: NativePcEvent) => {
      if (ev.kind === 'icecandidate') trickle(b, 'b', ev.candidate);
      if (ev.kind === 'dc:state' && ev.state === 'open') {
        channels.get(ev.channelKey)?.send(Buffer.from('ping'), false);
      }
      if (ev.kind === 'dc:message') resolve(ev.data.toString());
    });
    b = new native.PeerConnection({ iceServers: [] }, (ev: NativePcEvent) => {
      if (ev.kind === 'icecandidate') trickle(a, 'a', ev.candidate);
      if (ev.kind === 'datachannel') channels.set(ev.channelKey, ev.channel);
      if (ev.kind === 'dc:message') channels.get(ev.channelKey)?.send(Buffer.from('pong'), false);
    });
  });

  try {
    const dc = a.createDataChannel('ping', { ordered: true });
    channels.set(dc.key, dc);
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    negotiated = true;
    for (const c of pending.a) await a.addIceCandidate(c);
    for (const c of pending.b) await b.addIceCandidate(c);

    assert.equal(await pong, 'pong');
    const stats = JSON.parse(await a.getStats()) as Record<string, { type: string }>;
    const types = new Set(Object.values(stats).map((s) => s.type));
    assert.ok(types.has('data-channel'));
    assert.ok(types.has('candidate-pair'));
  } finally {
    a.close();
    b.close();
  }
});

test('the first SCTP, DTLS and ICE reports precede the SLD completion that created the transport', async (t) => {
  const a = new Peer(t);
  a.pc.createDataChannel('x');
  const offer = await a.pc.createOffer();
  const from = a.mark();
  const snapshot = await a.pc.setLocalDescription(offer);
  const seen = a.events.slice(from);
  assert.deepEqual(
    seen.filter(
      (e) => e.kind === 'sctp:state' || e.kind === 'dtls:state' || e.kind === 'ice:state',
    ),
    [
      {
        kind: 'sctp:state',
        transport: 1,
        state: 'connecting',
        maxMessageSize: null,
        maxChannels: null,
      },
      { kind: 'dtls:state', transport: 1, state: 'new', remoteCertificates: [] },
      {
        kind: 'ice:state',
        transport: 1,
        state: 'new',
        role: 'controlling',
        mid: '0',
        gathering: 'new',
        selectedPair: null,
      },
    ],
  );
  assert.deepEqual(snapshot.sctp, { key: 1, transport: 1 });
});

// The SCTP transport's 'connected' and its channels' 'open' come from
// different libwebrtc callbacks (dcsctp tells the channels first, but their
// state change is posted to the signaling thread), so their order varies.
test('SCTP reports connected with its limits; DTLS reports the remote certificate', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const dc = a.pc.createDataChannel('x');
  await connect(a, b);
  await a.waitFor('dc:state', (e) => e.channelKey === dc.key && e.state === 'open');
  const connected = await a.waitFor('sctp:state', (e) => e.state === 'connected');
  assert.deepEqual(connected, {
    kind: 'sctp:state',
    transport: 1,
    state: 'connected',
    maxMessageSize: 262144,
    maxChannels: 65535,
  });
  const dtls = a.of('dtls:state').find((e) => e.state === 'connected');
  const [der] = dtls?.remoteCertificates ?? [];
  assert.ok(der instanceof ArrayBuffer);
  assert.equal(new Uint8Array(der)[0], 0x30, 'a DER SEQUENCE');
  assert.ok(dc.id >= 0, 'the in-band id is assigned');
});

test("closing a peer connection closes the remote's channels with an SCTP_FAILURE error", async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.createDataChannel('x');
  await connect(a, b);
  const { channelKey } = await b.waitFor('datachannel');
  await b.waitFor('dc:state', (e) => e.channelKey === channelKey && e.state === 'open');
  a.pc.close();
  const closed = await b.waitFor(
    'dc:state',
    (e) => e.channelKey === channelKey && e.state === 'closed',
  );
  assert.deepEqual(closed.error, {
    errorType: 'OPERATION_ERROR_WITH_DATA',
    message: 'User-Initiated Abort, reason=Close called',
    errorDetail: 'SCTP_FAILURE',
    sctpCauseCode: 12,
  });
});

test('a channel closed by the closing procedure reports no error on either side', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const dc = a.pc.createDataChannel('x');
  await connect(a, b);
  const { channelKey } = await b.waitFor('datachannel');
  await a.waitFor('dc:state', (e) => e.channelKey === dc.key && e.state === 'open');
  dc.close();
  const [local, remote] = await Promise.all([
    a.waitFor('dc:state', (e) => e.channelKey === dc.key && e.state === 'closed'),
    b.waitFor('dc:state', (e) => e.channelKey === channelKey && e.state === 'closed'),
  ]);
  assert.deepEqual([local.error, remote.error], [undefined, undefined]);
});

test('async methods reject after close', async () => {
  const pc = new native.PeerConnection({}, () => {});
  pc.close();
  await assert.rejects(pc.createOffer(), { name: 'Error', errorType: 'INVALID_STATE' });
});
