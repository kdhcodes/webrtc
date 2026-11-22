// pc.sctp and the DTLS and ICE transports under it, against the fake native
// addon: when the SCTP transport appears, its maxMessageSize, and how the
// native state events drive the three transports. The ICE transport's own
// reports are in RTCIceTransport.test.ts.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { dataDescription, negotiateData } from './internal/testing/data-channel.ts';
import { FakePeerConnection, useFakeNative } from './internal/testing/fake-native.ts';
import { RTCDtlsTransport } from './RTCDtlsTransport.ts';
import type { RTCErrorEvent } from './RTCErrorEvent.ts';
import { RTCIceTransport } from './RTCIceTransport.ts';
import { RTCPeerConnection } from './RTCPeerConnection.ts';
import { RTCSctpTransport } from './RTCSctpTransport.ts';

function setup(t: TestContext) {
  const fakes = useFakeNative(t, { PeerConnection: FakePeerConnection });
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  return { pc, fake: fakes.last('PeerConnection') };
}

function sctpOf(pc: RTCPeerConnection): RTCSctpTransport {
  assert.ok(pc.sctp, 'pc.sctp is set');
  return pc.sctp;
}

test('pc.sctp appears with the offer that negotiates data channels, at 64 KiB until the answer', async (t) => {
  const { pc, fake } = setup(t);
  const offer = dataDescription('offer');
  const sld = pc.setLocalDescription(offer);
  fake.sctp = { key: 1, transport: 1 };
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: { localDescription: offer, pendingLocalDescription: offer },
  });
  await sld;
  const sctp = sctpOf(pc);
  assert.deepEqual(
    [sctp.state, sctp.maxMessageSize, sctp.maxChannels, sctp.transport.state],
    ['connecting', 65536, null, 'new'],
  );
  const answer = dataDescription('answer');
  const srd = pc.setRemoteDescription(answer);
  await fake.flush();
  let duringSignalingStateChange: RTCSctpTransport | null = null;
  pc.onsignalingstatechange = () => {
    duringSignalingStateChange = pc.sctp;
  };
  fake.completeSetRemoteDescription({
    signalingState: 'stable',
    snapshot: {
      localDescription: offer,
      currentLocalDescription: offer,
      remoteDescription: answer,
      currentRemoteDescription: answer,
    },
  });
  await srd;
  assert.equal(pc.sctp, sctp, 'the same transport');
  assert.equal(duringSignalingStateChange, sctp, 'still set when signalingstatechange fires');
  assert.equal(sctp.maxMessageSize, 262144, 'the answer brings the remote limit');
});

test("pc.sctp follows libwebrtc's transport: gone after a rollback, new when replaced", async (t) => {
  const { pc, fake } = setup(t);
  const offer = dataDescription('offer');
  const setLocal = async (type: 'offer' | 'rollback', sctp: typeof fake.sctp) => {
    const sld = pc.setLocalDescription(type === 'offer' ? offer : { type });
    await fake.flush();
    fake.sctp = sctp;
    fake.completeSetLocalDescription({
      signalingState: type === 'offer' ? 'have-local-offer' : 'stable',
      snapshot: type === 'offer' ? { localDescription: offer, pendingLocalDescription: offer } : {},
    });
    await sld;
  };
  await setLocal('offer', { key: 1, transport: 1 });
  const first = sctpOf(pc);
  await setLocal('rollback', null);
  assert.equal(pc.sctp, null, 'rolled back');
  await setLocal('offer', { key: 2, transport: 2 });
  const second = sctpOf(pc);
  assert.notEqual(second, first, 'a new transport');
  assert.notEqual(second.transport, first.transport, 'on a new DTLS transport');
});

test('maxMessageSize follows the remote a=max-message-size, capped at what libwebrtc sends', async (t) => {
  const sizes: [number | null, number][] = [
    [1000, 1000],
    [262144, 262144],
    [1_000_000, 262144],
    [0, 262144], // 0: the remote takes any size
    [null, 65536], // absent: 64 KiB (RFC 8841)
  ];
  for (const [remote, expected] of sizes) {
    await t.test(`a=max-message-size ${remote ?? 'absent'}`, async (st) => {
      const { pc, fake } = setup(st);
      await negotiateData(pc, fake, remote);
      assert.equal(sctpOf(pc).maxMessageSize, expected);
    });
  }
});

test("SCTP state changes fire statechange; connected brings maxChannels and libwebrtc's maxMessageSize", async (t) => {
  const { pc, fake } = setup(t);
  await negotiateData(pc, fake, null);
  const sctp = sctpOf(pc);
  const log: string[] = [];
  sctp.onstatechange = () => log.push(`${sctp.state} ${sctp.maxMessageSize} ${sctp.maxChannels}`);
  fake.emit({
    kind: 'sctp:state',
    transport: 1,
    state: 'connecting',
    maxMessageSize: null,
    maxChannels: null,
  });
  fake.emit({
    kind: 'sctp:state',
    transport: 1,
    state: 'connected',
    maxMessageSize: 262144,
    maxChannels: 1024,
  });
  fake.emit({
    kind: 'sctp:state',
    transport: 1,
    state: 'closed',
    maxMessageSize: 262144,
    maxChannels: 1024,
  });
  await fake.flush();
  assert.deepEqual(log, ['connected 262144 1024', 'closed 262144 1024']);
});

test('a renegotiated a=max-message-size replaces the value libwebrtc reported when it connected', async (t) => {
  // libwebrtc restarts SCTP with the new value but reports it only with
  // its next state change.
  const { pc, fake } = setup(t);
  await negotiateData(pc, fake, 1000);
  fake.emit({
    kind: 'sctp:state',
    transport: 1,
    state: 'connected',
    maxMessageSize: 1000,
    maxChannels: 1024,
  });
  await fake.flush();
  const sctp = sctpOf(pc);
  for (const [remote, expected] of [
    [0, 262144],
    [500, 500],
  ] as const) {
    const offer = dataDescription('offer');
    const answer = dataDescription('answer', remote);
    const sld = pc.setLocalDescription(offer);
    await fake.flush();
    fake.completeSetLocalDescription({
      signalingState: 'have-local-offer',
      snapshot: { pendingLocalDescription: offer, currentRemoteDescription: answer },
    });
    await sld;
    const srd = pc.setRemoteDescription(answer);
    await fake.flush();
    fake.completeSetRemoteDescription({
      signalingState: 'stable',
      snapshot: { currentLocalDescription: offer, currentRemoteDescription: answer },
    });
    await srd;
    assert.equal(sctp.maxMessageSize, expected, `remote ${remote}`);
  }
  assert.equal(pc.sctp, sctp, 'the same transport');
});

test('the SCTP transport starts from native states reported before it existed', async (t) => {
  const { pc, fake } = setup(t);
  fake.sctp = { key: 1, transport: 1 };
  fake.emit({
    kind: 'sctp:state',
    transport: 1,
    state: 'connected',
    maxMessageSize: 100_000,
    maxChannels: 64,
  });
  fake.emit({
    kind: 'dtls:state',
    transport: 1,
    state: 'connected',
    remoteCertificates: [new ArrayBuffer(3)],
  });
  await fake.flush();
  const answer = dataDescription('answer');
  const offer = dataDescription('offer');
  const srd = pc.setRemoteDescription(offer);
  fake.completeSetRemoteDescription({
    signalingState: 'have-remote-offer',
    snapshot: { remoteDescription: offer, pendingRemoteDescription: offer },
  });
  await srd;
  const sld = pc.setLocalDescription(answer);
  await fake.flush();
  fake.completeSetLocalDescription({
    signalingState: 'stable',
    snapshot: {
      localDescription: answer,
      currentLocalDescription: answer,
      remoteDescription: offer,
      currentRemoteDescription: offer,
    },
  });
  await sld;
  const sctp = sctpOf(pc);
  assert.deepEqual(
    [sctp.state, sctp.maxMessageSize, sctp.maxChannels, sctp.transport.state],
    ['connected', 100_000, 64, 'connected'],
  );
  assert.equal(sctp.transport.getRemoteCertificates()[0]?.byteLength, 3);
});

test('the DTLS transport follows dtls:state, keeping the remote certificates', async (t) => {
  const { pc, fake } = setup(t);
  await negotiateData(pc, fake);
  const dtls = sctpOf(pc).transport;
  const log: string[] = [];
  dtls.onstatechange = () => log.push(dtls.state);
  const der = new Uint8Array([0x30, 0x82, 1]).buffer;
  fake.emit({ kind: 'dtls:state', transport: 1, state: 'connecting', remoteCertificates: [] });
  fake.emit({ kind: 'dtls:state', transport: 1, state: 'connected', remoteCertificates: [der] });
  fake.emit({ kind: 'dtls:state', transport: 1, state: 'closed', remoteCertificates: [] });
  await fake.flush();
  assert.deepEqual(log, ['connecting', 'connected', 'closed']);
  const [copy] = dtls.getRemoteCertificates();
  assert.deepEqual([...new Uint8Array(copy ?? new ArrayBuffer(0))], [0x30, 0x82, 1]);
  assert.notEqual(copy, der, 'a copy');
});

test('a DTLS error fires error with an RTCError (dtls-failure)', async (t) => {
  const { pc, fake } = setup(t);
  await negotiateData(pc, fake);
  const dtls = sctpOf(pc).transport;
  const details: string[] = [];
  dtls.onerror = (event) => details.push((event as RTCErrorEvent).error.errorDetail);
  fake.emit({
    kind: 'dtls:error',
    transport: 1,
    error: { errorType: 'NETWORK_ERROR', message: 'x', errorDetail: null, sctpCauseCode: null },
  });
  await fake.flush();
  assert.deepEqual(details, ['dtls-failure']);
});

test("the ICE transport's gathering state follows the connection's, firing first", async (t) => {
  const { pc, fake } = setup(t);
  await negotiateData(pc, fake);
  const ice = sctpOf(pc).transport.iceTransport;
  const log: string[] = [];
  ice.ongatheringstatechange = () => log.push(`ice ${ice.gatheringState}`);
  pc.onicegatheringstatechange = () => log.push(`pc ${pc.iceGatheringState}`);
  fake.emit({ kind: 'icegatheringstatechange', state: 'gathering' });
  fake.emit({ kind: 'icegatheringstatechange', state: 'complete' });
  await fake.flush();
  // 'complete' comes in the gathering completion's second task.
  await new Promise(setImmediate);
  assert.deepEqual(log, ['ice gathering', 'pc gathering', 'ice complete', 'pc complete']);
});

test('closing the connection closes all three transports without events', async (t) => {
  const { pc, fake } = setup(t);
  await negotiateData(pc, fake);
  const sctp = sctpOf(pc);
  const log: string[] = [];
  for (const target of [sctp, sctp.transport, sctp.transport.iceTransport] as EventTarget[]) {
    target.addEventListener('statechange', () => log.push(target.constructor.name));
  }
  pc.close();
  assert.deepEqual(
    [sctp.state, sctp.transport.state, sctp.transport.iceTransport.state],
    ['closed', 'closed', 'closed'],
  );
  fake.emit({
    kind: 'sctp:state',
    transport: 1,
    state: 'closed',
    maxMessageSize: null,
    maxChannels: null,
  });
  await fake.flush();
  assert.deepEqual(log, []);
  assert.equal(pc.sctp, sctp, 'still reachable after close');
});

test('the transports are not constructible', () => {
  for (const Transport of [RTCSctpTransport, RTCDtlsTransport, RTCIceTransport]) {
    assert.throws(() => new (Transport as unknown as new () => unknown)(), {
      name: 'TypeError',
      message: 'Illegal constructor',
    });
  }
});
