// Transceivers, senders and receivers against the raw native API: snapshots,
// track events, stable identity and the RTP object methods. Test tracks come
// from another PC's receiver (WP-M's sources aren't available here).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { native } from '../../lib/internal/native.ts';
import type {
  NativeDescriptionSnapshot,
  NativeTrack,
  NativeTransceiverState,
} from '../../lib/internal/native-types.ts';
import { nativeError, negotiate, Peer } from './pc-harness.ts';

/** A real audio or video track: receivers have one before negotiation. */
function testTrack(source: Peer, kind: 'audio' | 'video' = 'audio'): NativeTrack {
  return source.pc.addTransceiver(kind).receiver.track;
}

/**
 * The snapshot's per-transceiver state minus the handle and the transport
 * keys (test/native/transport.test.ts), for deepEqual.
 */
function states(
  snap: NativeDescriptionSnapshot,
): Omit<NativeTransceiverState, 'transceiver' | 'senderTransport' | 'receiverTransport'>[] {
  return (snap.transceivers ?? []).map(
    ({ transceiver: _, senderTransport: _s, receiverTransport: _r, ...rest }) => rest,
  );
}

function descriptionPresence(snap: NativeDescriptionSnapshot) {
  return {
    local: snap.localDescription?.type ?? null,
    currentLocal: snap.currentLocalDescription?.type ?? null,
    pendingLocal: snap.pendingLocalDescription?.type ?? null,
    remote: snap.remoteDescription?.type ?? null,
    currentRemote: snap.currentRemoteDescription?.type ?? null,
    pendingRemote: snap.pendingRemoteDescription?.type ?? null,
  };
}

test('SLD/SRD resolve with snapshots of state, descriptions and transceivers', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const src = new Peer(t);
  a.pc.addTrack(testTrack(src), ['s1']);
  a.pc.addTransceiver('video', { direction: 'recvonly' });

  const n = await negotiate(a, b);

  assert.equal(n.offererLocal.signalingState, 'have-local-offer');
  assert.deepEqual(descriptionPresence(n.offererLocal), {
    local: 'offer',
    currentLocal: null,
    pendingLocal: 'offer',
    remote: null,
    currentRemote: null,
    pendingRemote: null,
  });
  assert.deepEqual(states(n.offererLocal), [
    {
      mid: '0',
      direction: 'sendrecv',
      currentDirection: null,
      firedDirection: null,
      stopped: false,
      stopping: false,
      receiverStreamIds: [],
    },
    {
      mid: '1',
      direction: 'recvonly',
      currentDirection: null,
      firedDirection: null,
      stopped: false,
      stopping: false,
      receiverStreamIds: [],
    },
  ]);

  assert.equal(n.answererRemote.signalingState, 'have-remote-offer');
  assert.deepEqual(descriptionPresence(n.answererRemote), {
    local: null,
    currentLocal: null,
    pendingLocal: null,
    remote: 'offer',
    currentRemote: null,
    pendingRemote: 'offer',
  });
  // firedDirection is the remote direction reversed (the spec's
  // [[FiredDirection]]); the receiver already knows the remote stream ids.
  assert.deepEqual(
    states(n.answererRemote).map((s) => [
      s.mid,
      s.direction,
      s.firedDirection,
      s.receiverStreamIds,
    ]),
    [
      ['0', 'recvonly', 'sendrecv', ['s1']],
      ['1', 'recvonly', 'sendonly', []],
    ],
  );

  assert.equal(n.answererLocal.signalingState, 'stable');
  assert.deepEqual(descriptionPresence(n.answererLocal), {
    local: 'answer',
    currentLocal: 'answer',
    pendingLocal: null,
    remote: 'offer',
    currentRemote: 'offer',
    pendingRemote: null,
  });
  assert.deepEqual(
    states(n.answererLocal).map((s) => [s.currentDirection, s.firedDirection]),
    [
      ['recvonly', 'recvonly'],
      ['inactive', 'inactive'],
    ],
  );

  assert.equal(n.offererRemote.signalingState, 'stable');
  assert.deepEqual(
    states(n.offererRemote).map((s) => [s.mid, s.currentDirection, s.firedDirection]),
    [
      ['0', 'sendonly', 'sendonly'],
      ['1', 'inactive', 'inactive'],
    ],
  );
  // The snapshot SDP is what the PC holds, byte for byte.
  const answer = n.answererLocal.localDescription;
  assert.equal(n.offererRemote.remoteDescription?.sdp, answer?.sdp);
});

test('track events carry stream ids and precede the SRD completion', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const src = new Peer(t);
  a.pc.addTrack(testTrack(src), ['s1', 's2']);
  a.pc.addTransceiver('video', { direction: 'sendonly', streams: ['v'] });

  const offer = await a.pc.createOffer();
  await a.pc.setLocalDescription(offer);
  const from = b.mark();
  const snap = await b.pc.setRemoteDescription(offer);
  // Everything the callback received before the promise settled.
  const before = b.events.slice(from).map((e) => e.kind);

  assert.deepEqual(before, ['signalingstatechange', 'track', 'track']);
  const tracks = b.of('track');
  assert.deepEqual(
    tracks.map((e) => e.streamIds),
    [['s1', 's2'], ['v']],
  );
  const transceivers = b.pc.getTransceivers();
  assert.equal(tracks[0]?.transceiver, transceivers[0]);
  assert.equal(tracks[0]?.receiver, transceivers[0]?.receiver);
  assert.equal(tracks[1]?.transceiver, transceivers[1]);
  assert.equal(snap.transceivers?.[0]?.transceiver, transceivers[0]);
  assert.equal(tracks[0]?.receiver.track.kind, 'audio');
  assert.equal(tracks[1]?.receiver.track.kind, 'video');
});

test('RTP handles have stable identity across getters, events and calls', async (t) => {
  const a = new Peer(t);
  const src = new Peer(t);
  const added = a.pc.addTransceiver('audio');
  const { sender, transceiver } = a.pc.addTrack(testTrack(src, 'video'), []);

  assert.deepEqual(a.pc.getTransceivers(), [added, transceiver]);
  assert.equal(a.pc.getTransceivers()[0], a.pc.getTransceivers()[0]);
  assert.equal(transceiver.sender, sender);
  assert.equal(added.sender, added.sender);
  assert.equal(added.receiver, added.receiver);
  assert.equal(added.receiver.track, added.receiver.track);
  const snap = await a.pc.setLocalDescription(await a.pc.createOffer());
  assert.deepEqual(
    snap.transceivers?.map((s) => s.transceiver),
    [added, transceiver],
  );
});

test('RTP handles are not constructible from JS', () => {
  for (const Ctor of [native.Transceiver, native.Sender, native.Receiver]) {
    const C = Ctor as unknown as new () => unknown;
    assert.throws(() => new C(), { name: 'TypeError', message: /is not constructible/ });
  }
});

test('addTrack reuses a matching recvonly transceiver and returns it', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const src = new Peer(t);
  b.pc.addTransceiver('audio', { direction: 'sendrecv' });
  await negotiate(b, a);
  const [remoteCreated] = a.pc.getTransceivers();

  const track = testTrack(src);
  const { sender, transceiver } = a.pc.addTrack(track, ['s']);
  assert.equal(transceiver, remoteCreated);
  assert.equal(sender, remoteCreated?.sender);
  assert.equal(sender.track, track);
  assert.equal(transceiver.direction, 'sendrecv');
});

test('removeTrack clears the track and fires removetrack remotely', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const src = new Peer(t);
  const { sender } = a.pc.addTrack(testTrack(src), ['s']);
  await negotiate(a, b);
  const { receiver } = await b.waitFor('track');

  a.pc.removeTrack(sender);
  assert.equal(sender.track, null);
  const n = await negotiate(a, b);

  assert.equal(b.of('removetrack').length, 1);
  assert.equal(b.of('removetrack')[0]?.receiver, receiver);
  // The offerer now only receives, so seen from the answerer it only sends.
  assert.equal(n.answererRemote.transceivers?.[0]?.firedDirection, 'sendonly');
  assert.throws(() => a.pc.removeTrack({} as never), {
    name: 'TypeError',
    message: 'expected a native Sender handle',
  });
});

test('direction changes take effect in currentDirection after renegotiation', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const tr = a.pc.addTransceiver('audio', { direction: 'sendrecv' });
  await negotiate(a, b);
  assert.equal(tr.currentDirection, 'sendonly');

  tr.direction = 'inactive';
  assert.equal(tr.direction, 'inactive');
  assert.equal(tr.currentDirection, 'sendonly');
  const n = await negotiate(a, b);
  assert.equal(tr.currentDirection, 'inactive');
  assert.equal(n.offererRemote.transceivers?.[0]?.currentDirection, 'inactive');

  assert.throws(
    () => {
      tr.direction = 'bogus' as never;
    },
    { name: 'TypeError', message: 'invalid direction' },
  );
});

test('stop() stops the transceiver and negotiation removes it', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const keep = a.pc.addTransceiver('audio');
  const tr = a.pc.addTransceiver('video');
  await negotiate(a, b);

  tr.stop();
  assert.equal(tr.stopping, true);
  assert.equal(tr.stopped, false);
  assert.equal(tr.direction, 'stopped');
  assert.throws(
    () => {
      tr.direction = 'sendrecv';
    },
    { errorType: 'INVALID_STATE' },
  );
  const n = await negotiate(a, b);

  assert.equal(tr.stopped, true);
  assert.equal(tr.mid, null);
  assert.deepEqual(a.pc.getTransceivers(), [keep]);
  assert.deepEqual(
    n.offererRemote.transceivers?.map((s) => s.transceiver),
    [keep],
  );
  // The pruned handle still answers.
  assert.equal(tr.currentDirection, 'stopped');
  tr.stop();
});

test('replaceTrack swaps the track synchronously and accepts null', async (t) => {
  const a = new Peer(t);
  const src = new Peer(t);
  const first = testTrack(src);
  const second = testTrack(src);
  const { sender } = a.pc.addTrack(first, []);

  sender.replaceTrack(null);
  assert.equal(sender.track, null);
  sender.replaceTrack(second);
  assert.equal(sender.track, second);
  assert.throws(() => sender.replaceTrack({} as never), {
    name: 'TypeError',
    message: 'expected a native Track handle',
  });
  assert.throws(() => sender.replaceTrack(testTrack(src, 'video')), {
    errorType: 'INVALID_STATE',
  });
});

test('setParameters round-trips getParameters and rejects invalid changes', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const tr = a.pc.addTransceiver('audio', { sendEncodings: [{ maxBitrate: 64_000 }] });
  await negotiate(a, b);

  const params = tr.sender.getParameters() as {
    transactionId: string;
    encodings: Record<string, unknown>[];
    codecs: { mimeType: string }[];
    rtcp: { cname: string };
  };
  assert.equal(typeof params.transactionId, 'string');
  assert.deepEqual(params.encodings, [
    {
      active: true,
      maxBitrate: 64_000,
      priority: 'low',
      networkPriority: 'low',
      adaptivePtime: false,
    },
  ]);
  assert.equal(params.codecs[0]?.mimeType, 'audio/opus');
  assert.notEqual(params.rtcp.cname, '');

  const encoding = params.encodings[0] as Record<string, unknown>;
  encoding.maxBitrate = 32_000;
  encoding.priority = 'high';
  await tr.sender.setParameters(params);
  assert.deepEqual((tr.sender.getParameters() as typeof params).encodings, [
    { ...encoding, maxBitrate: 32_000, priority: 'high' },
  ]);

  const again = tr.sender.getParameters() as typeof params;
  await assert.rejects(tr.sender.setParameters({ ...again, encodings: [...again.encodings, {}] }), {
    errorType: 'INVALID_MODIFICATION',
  });
});

test('setParameters applies to the current parameters, whatever transaction it was read in', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const tr = a.pc.addTransceiver('audio');
  await negotiate(a, b);
  type Params = { transactionId: string; encodings: Record<string, unknown>[] };
  const params = tr.sender.getParameters() as Params;
  // A later getParameters() starts a new libwebrtc transaction, and a
  // setParameters() ends one; the JS layer checks transactions instead.
  tr.sender.getParameters();
  (params.encodings[0] as Record<string, unknown>).maxBitrate = 20_000;
  await tr.sender.setParameters(params);
  (params.encodings[0] as Record<string, unknown>).maxBitrate = 30_000;
  await tr.sender.setParameters({ ...params, transactionId: 'anything' });
  assert.equal((tr.sender.getParameters() as Params).encodings[0]?.maxBitrate, 30_000);
});

test('setParameters matches encodings by rid when negotiation removed some', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const tr = a.pc.addTransceiver('video', { sendEncodings: [{ rid: 'lo' }, { rid: 'hi' }] });
  type Params = { encodings: Record<string, unknown>[] };
  const params = tr.sender.getParameters() as Params;
  assert.deepEqual(
    params.encodings.map((e) => e.rid),
    ['lo', 'hi'],
  );
  // An answer without simulcast leaves only the first layer.
  const offer = await a.pc.createOffer();
  await a.pc.setLocalDescription(offer);
  await b.pc.setRemoteDescription(offer);
  const answer = await b.pc.createAnswer();
  await b.pc.setLocalDescription(answer);
  await a.pc.setRemoteDescription({
    type: 'answer',
    sdp: answer.sdp.replace(/a=(simulcast|rid):.*\r\n/g, ''),
  });
  assert.deepEqual(
    (tr.sender.getParameters() as Params).encodings.map((e) => e.rid),
    ['lo'],
  );

  (params.encodings[0] as Record<string, unknown>).scaleResolutionDownBy = 2.5;
  (params.encodings[1] as Record<string, unknown>).scaleResolutionDownBy = 3.5;
  await tr.sender.setParameters(params);
  assert.deepEqual(
    (tr.sender.getParameters() as Params).encodings.map((e) => [e.rid, e.scaleResolutionDownBy]),
    [['lo', 2.5]],
  );
});

test("a receiver's parameters have no rtcp.cname", async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  a.pc.addTransceiver('audio');
  await negotiate(a, b);
  const [remote] = b.pc.getTransceivers();
  assert.ok(remote);
  const { rtcp } = remote.receiver.getParameters() as { rtcp: Record<string, unknown> };
  assert.equal('cname' in rtcp, false);
  assert.equal(typeof rtcp.reducedSize, 'boolean');
});

test('setStreams changes the stream ids the remote receiver sees', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const tr = a.pc.addTransceiver('audio', { streams: ['before'] });
  await negotiate(a, b);

  tr.sender.setStreams(['x', 'y']);
  const n = await negotiate(a, b);
  assert.deepEqual(n.answererRemote.transceivers?.[0]?.receiverStreamIds, ['x', 'y']);
});

test('capabilities feed setCodecPreferences, which restricts the offer', async (t) => {
  const a = new Peer(t);
  const caps = native.getRtpCapabilities('receiver', 'audio');
  assert.ok(caps);
  const opus = caps.codecs.find((c) => c.mimeType === 'audio/opus');
  assert.deepEqual(opus, {
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    sdpFmtpLine: 'minptime=10;useinbandfec=1',
  });
  assert.ok(caps.headerExtensions.some((e) => e.uri === 'urn:ietf:params:rtp-hdrext:sdes:mid'));
  assert.ok(
    native.getRtpCapabilities('sender', 'video')?.codecs.some((c) => c.mimeType === 'video/VP8'),
  );
  assert.equal(native.getRtpCapabilities('sender', 'data' as never), null);

  const tr = a.pc.addTransceiver('audio');
  tr.setCodecPreferences([opus]);
  const offer = await a.pc.createOffer();
  const mline = offer.sdp.split('\r\n').find((l) => l.startsWith('m=audio'));
  assert.match(mline ?? '', /^m=audio 9 UDP\/TLS\/RTP\/SAVPF 111$/);

  assert.throws(() => tr.setCodecPreferences([{ mimeType: 'audio/nope', clockRate: 1 }]), {
    errorType: 'INVALID_MODIFICATION',
  });
  tr.setCodecPreferences([]);
  const reset = await a.pc.createOffer();
  assert.ok(reset.sdp.includes('a=rtpmap:0 PCMU/8000'));
});

test('getStats with a sender or receiver selects only its streams', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const tr = a.pc.addTransceiver('audio');
  await negotiate(a, b);

  type Report = Record<string, { type: string }>;
  const types = (json: string) => Object.values(JSON.parse(json) as Report).map((s) => s.type);
  const all = types(await a.pc.getStats());
  const viaSender = types(await tr.sender.getStats());
  const viaPc = types(await a.pc.getStats(tr.sender));
  assert.ok(all.includes('peer-connection'));
  assert.ok(viaSender.includes('outbound-rtp'));
  assert.ok(!viaSender.includes('peer-connection'));
  assert.deepEqual(viaPc.sort(), viaSender.sort());
  // No packets have arrived, so the receiver selects nothing; it must still
  // be valid JSON.
  assert.deepEqual(JSON.parse(await tr.receiver.getStats()), {});
  await assert.rejects(a.pc.getStats({} as never), { name: 'TypeError' });
});

test('after close, RTP getStats resolves and setParameters rejects with INVALID_STATE', async (t) => {
  const a = new Peer(t);
  const b = new Peer(t);
  const src = new Peer(t);
  const { transceiver: tr } = a.pc.addTrack(testTrack(src), ['s']);
  await negotiate(a, b);
  const params = tr.sender.getParameters();
  a.pc.close();

  assert.equal(typeof JSON.parse(await tr.sender.getStats()), 'object');
  assert.equal(typeof JSON.parse(await tr.receiver.getStats()), 'object');
  assert.equal(typeof JSON.parse(await a.pc.getStats(tr.sender)), 'object');
  await assert.rejects(
    tr.sender.setParameters(params),
    nativeError('INVALID_STATE', 'peer connection is closed'),
  );
  assert.equal(tr.stopped, true);
  assert.deepEqual(a.pc.getTransceivers(), [tr]);
});

test('maxBitrate above 2^31 - 1 is rejected with INVALID_RANGE', async (t) => {
  const a = new Peer(t);
  const tooBig = nativeError('INVALID_RANGE', 'maxBitrate is larger than libwebrtc supports');
  assert.throws(
    () => a.pc.addTransceiver('video', { sendEncodings: [{ maxBitrate: 2 ** 31 }] }),
    tooBig,
  );

  const tr = a.pc.addTransceiver('video', { sendEncodings: [{ maxBitrate: 2 ** 31 - 1 }] });
  const params = tr.sender.getParameters() as { encodings: { maxBitrate?: number }[] };
  assert.equal(params.encodings[0]?.maxBitrate, 2 ** 31 - 1);
  await assert.rejects(
    tr.sender.setParameters({
      ...params,
      encodings: [{ ...params.encodings[0], maxBitrate: 2 ** 32 - 1 }],
    }),
    tooBig,
  );
});
