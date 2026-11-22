// The per-connection registry of DTLS and ICE transports: one object per
// native key, built from reports that may precede it, and the timing rules
// for applying reports (closing ones held during a description, the
// connection's ICE state adopted by a single transport).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RTCDtlsTransport } from '../RTCDtlsTransport.ts';
import type { RTCErrorEvent } from '../RTCErrorEvent.ts';
import type { NativeIceTransportState } from './native-types.ts';
import {
  chromeIceConnectionState,
  chromeIceTransportState,
  type TransportEvent,
  Transports,
} from './transports.ts';

const owner = { sdp: () => null };

function ice(
  transport: number,
  state: NativeIceTransportState,
  selectedPair: { local: string; remote: string } | null = null,
): Extract<TransportEvent, { kind: 'ice:state' }> {
  return {
    kind: 'ice:state',
    transport,
    state,
    role: 'controlling',
    mid: '0',
    gathering: 'new',
    selectedPair,
  };
}

function dtls(
  transport: number,
  state: 'new' | 'connecting' | 'connected' | 'closed' | 'failed',
  remoteCertificates: ArrayBuffer[] = [],
): TransportEvent {
  return { kind: 'dtls:state', transport, state, remoteCertificates };
}

function log(transport: RTCDtlsTransport): string[] {
  const events: string[] = [];
  transport.addEventListener('statechange', () => events.push(`dtls ${transport.state}`));
  transport.addEventListener('error', () => events.push('dtls error'));
  const { iceTransport } = transport;
  iceTransport.addEventListener('statechange', () => events.push(`ice ${iceTransport.state}`));
  iceTransport.addEventListener('gatheringstatechange', () =>
    events.push(`gathering ${iceTransport.gatheringState}`),
  );
  return events;
}

test('one object per key, with null for none', () => {
  const transports = new Transports(owner);
  const first = transports.get(1);
  assert.ok(first);
  assert.equal(transports.get(1), first, 'the same key gives the same transport');
  assert.notEqual(transports.get(2), first);
  assert.equal(transports.get(null), null);
  assert.equal(first.iceTransport, transports.get(1)?.iceTransport);
});

test('a transport starts from the reports that preceded it, without events', () => {
  const transports = new Transports(owner);
  const der = new Uint8Array([0x30, 1]).buffer;
  transports.handle(dtls(1, 'connected', [der]), false);
  transports.handle(dtls(1, 'connected', []), false);
  transports.handle(ice(1, 'connected', { local: 'candidate:a', remote: 'candidate:b' }), false);
  const transport = transports.get(1);
  assert.ok(transport);
  assert.deepEqual(
    [transport.state, transport.iceTransport.state, transport.getRemoteCertificates().length],
    ['connected', 'connected', 1],
    'the certificates of the connected report stay',
  );
  assert.equal(transport.iceTransport.getSelectedCandidatePair()?.local.candidate, 'candidate:a');
});

test('reports change existing transports at once, ICE statechange and DTLS statechange alike', () => {
  const transports = new Transports(owner);
  const transport = transports.get(1) as RTCDtlsTransport;
  const events = log(transport);
  transports.handle(ice(1, 'checking'), false);
  transports.handle(dtls(1, 'connecting'), false);
  transports.handle(ice(1, 'checking'), false);
  assert.deepEqual(events, ['ice checking', 'dtls connecting'], 'an unchanged state fires nothing');
});

test('a report closing a transport during a description takes effect a task after release()', async () => {
  const transports = new Transports(owner);
  const transport = transports.get(1) as RTCDtlsTransport;
  const events = log(transport);
  transports.handle(dtls(1, 'closed'), true);
  transports.handle(ice(1, 'closed'), true);
  transports.handle(ice(2, 'checking'), true);
  assert.equal(transport.state, 'new', 'held while describing');
  transports.release();
  assert.equal(transport.state, 'new', 'still open when the description resolves');
  await new Promise(setImmediate);
  assert.deepEqual(events, ['dtls closed', 'ice closed']);
});

test('a later report applies held-back ones first, so it cannot overtake them', () => {
  const transports = new Transports(owner);
  const transport = transports.get(1) as RTCDtlsTransport;
  const events = log(transport);
  transports.handle(dtls(1, 'closed'), true);
  transports.handle(dtls(2, 'connecting'), false);
  assert.deepEqual(events, ['dtls closed']);
});

test('a transport created from a held-back closing report does not repeat it', async () => {
  const transports = new Transports(owner);
  transports.handle(dtls(1, 'closed'), true);
  const transport = transports.get(1) as RTCDtlsTransport;
  const events = log(transport);
  transports.release();
  await new Promise(setImmediate);
  assert.equal(transport.state, 'closed');
  assert.deepEqual(events, []);
});

test("a single open transport adopts the connection's ICE state, firing when the caller says", () => {
  const transports = new Transports(owner);
  transports.handle(ice(1, 'new'), false);
  const transport = transports.get(1) as RTCDtlsTransport;
  const events = log(transport);
  const fire = transports.followConnection('checking', { 1: 'checking', 2: 'closed' });
  assert.equal(transport.iceTransport.state, 'checking', 'adopted before the connection fires');
  assert.deepEqual(events, []);
  fire();
  assert.deepEqual(events, ['ice checking']);
  transports.handle(ice(1, 'checking'), false);
  assert.deepEqual(events, ['ice checking'], 'its own report then changes nothing');
});

test('with several open transports in libwebrtc, even ones without an object, nothing is adopted', () => {
  // A remote re-offer adds an unBUNDLEd transport: the connection goes
  // 'checking' while ours stays connected (and reports nothing).
  const transports = new Transports(owner);
  transports.handle(ice(1, 'connected'), false);
  const transport = transports.get(1) as RTCDtlsTransport;
  transports.followConnection('checking', { 1: 'connected', 2: 'new' })();
  assert.equal(transport.iceTransport.state, 'connected');
});

test("the connection's state is adopted only if the transport is in it, or its own report is on its way", () => {
  const transports = new Transports(owner);
  transports.handle(ice(1, 'connected'), false);
  const transport = transports.get(1) as RTCDtlsTransport;
  transports.followConnection('checking', { 1: 'connected' })();
  assert.equal(transport.iceTransport.state, 'connected', 'its last report said connected already');
  transports.handle(ice(1, 'checking'), false);
  transports.followConnection('connected', { 1: 'disconnected' })();
  assert.equal(
    transport.iceTransport.state,
    'connected',
    "the connection's, as its own report ('disconnected') is on its way",
  );
  transports.handle(ice(1, 'disconnected'), false);
  assert.equal(transport.iceTransport.state, 'disconnected', 'and it wins');
});

test("the connection's 'completed' is never adopted; a pair change then keeps 'connected'", () => {
  // libwebrtc's ICE transports are never 'completed'; the connection's
  // comes from another aggregate.
  const transports = new Transports(owner);
  transports.handle(ice(1, 'connected'), false);
  const transport = transports.get(1) as RTCDtlsTransport;
  transports.followConnection('completed', { 1: 'connected' })();
  assert.equal(transport.iceTransport.state, 'connected');
  transports.handle(ice(1, 'connected', { local: 'candidate:a', remote: 'candidate:b' }), false);
  assert.equal(transport.iceTransport.state, 'connected');
  assert.equal(transport.iceTransport.getSelectedCandidatePair()?.remote.candidate, 'candidate:b');
});

test("libwebrtc's 'failed' reads 'disconnected' (Chrome); a restart's 'checking' fires again", () => {
  const transports = new Transports(owner);
  const transport = transports.get(1) as RTCDtlsTransport;
  const events = log(transport);
  transports.handle(ice(1, 'checking'), false);
  transports.handle(ice(1, 'failed'), false);
  assert.equal(transport.iceTransport.state, 'disconnected');
  transports.handle(ice(1, 'connected'), false);
  transports.handle(ice(1, 'disconnected'), false);
  transports.handle(ice(1, 'failed'), false);
  assert.deepEqual(events, [
    'ice checking',
    'ice disconnected',
    'ice connected',
    'ice disconnected',
  ]);
  // The connection's report, with the transport 'failed' in libwebrtc.
  transports.followConnection('checking', { 1: 'failed' })();
  assert.equal(transport.iceTransport.state, 'disconnected', 'its own report already said so');
  transports.handle(ice(1, 'checking'), false);
  assert.deepEqual(events.slice(4), ['ice checking']);
});

test("Chrome's states: ICE 'failed' reads 'disconnected', the connection's 'completed' 'connected'", () => {
  const states = [
    'new',
    'checking',
    'connected',
    'completed',
    'disconnected',
    'failed',
    'closed',
  ] as const;
  assert.deepEqual(states.map(chromeIceConnectionState), [
    'new',
    'checking',
    'connected',
    'connected',
    'disconnected',
    'disconnected',
    'closed',
  ]);
  assert.deepEqual(states.map(chromeIceTransportState), [
    'new',
    'checking',
    'connected',
    'completed',
    'disconnected',
    'disconnected',
    'closed',
  ]);
});

test('the connection gathering drives every open ICE transport', () => {
  const transports = new Transports(owner);
  const open = transports.get(1) as RTCDtlsTransport;
  const closed = transports.get(2) as RTCDtlsTransport;
  transports.handle(ice(2, 'closed'), false);
  transports.gathering('gathering');
  assert.deepEqual(
    [open.iceTransport.gatheringState, closed.iceTransport.gatheringState],
    ['gathering', 'new'],
  );
});

test('close() closes every transport without events and ignores later reports', async () => {
  const transports = new Transports(owner);
  const transport = transports.get(1) as RTCDtlsTransport;
  transports.handle(ice(1, 'connected'), false);
  transports.handle(dtls(1, 'connected'), false);
  transports.handle(dtls(1, 'closed'), true);
  const events = log(transport);
  transports.release();
  transports.close();
  assert.deepEqual([transport.state, transport.iceTransport.state], ['closed', 'closed']);
  transports.handle(ice(1, 'disconnected'), false);
  await new Promise(setImmediate);
  assert.deepEqual(events, []);
  assert.equal(transport.iceTransport.state, 'closed');
});

test('ICE roles from a snapshot apply to existing transports and to ones created later', () => {
  const transports = new Transports(owner);
  transports.handle({ ...ice(2, 'new'), role: 'controlling' }, false);
  const existing = transports.get(1) as RTCDtlsTransport;
  transports.roles({ 1: 'controlled', 2: 'controlled' });
  const later = transports.get(2) as RTCDtlsTransport;
  transports.roleKnown([existing, later]);
  assert.deepEqual(
    [existing.iceTransport.role, later.iceTransport.role],
    ['controlled', 'controlled'],
  );
});

test("entering 'failed' fires only statechange, as in Chrome; a native error report fires error", () => {
  const transports = new Transports(owner);
  const transport = transports.get(1) as RTCDtlsTransport;
  const events = log(transport);
  transports.handle(dtls(1, 'connecting'), false);
  transports.handle(dtls(1, 'failed'), false);
  assert.deepEqual(events, ['dtls connecting', 'dtls failed']);

  const other = transports.get(2) as RTCDtlsTransport;
  const details: string[] = [];
  other.addEventListener('error', (event) =>
    details.push((event as RTCErrorEvent).error.errorDetail),
  );
  const otherEvents = log(other);
  const error = {
    errorType: 'NETWORK_ERROR',
    message: 'x',
    errorDetail: null,
    sctpCauseCode: null,
  };
  transports.handle({ kind: 'dtls:error', transport: 2, error } as TransportEvent, false);
  transports.handle(dtls(2, 'failed'), false);
  assert.deepEqual(otherEvents, ['dtls error', 'dtls failed']);
  assert.deepEqual(details, ['dtls-failure']);
});
