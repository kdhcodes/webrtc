// RTCIceTransport's getters from libwebrtc's reports and the connection's
// descriptions: role, candidates and parameters, the selected pair.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { iceSectionReader } from './internal/sdp.ts';
import { RTCIceCandidate } from './RTCIceCandidate.ts';
import { RTCIceCandidatePair } from './RTCIceCandidatePair.ts';
import {
  applyIceTransport,
  closeIceTransport,
  createIceTransport,
  type IceTransportInfo,
  markIceRoleKnown,
  type RTCIceTransport,
} from './RTCIceTransport.ts';

const HOST = 'candidate:1 1 udp 2122260223 192.0.2.1 50000 typ host generation 0 ufrag lo';
const REMOTE = 'candidate:2 1 udp 2122260223 192.0.2.2 50001 typ host generation 0 ufrag re';
// As libwebrtc serializes one learned from a connectivity check: no raddr.
const PRFLX = 'candidate:3 1 udp 1853824767 192.0.2.3 50002 typ prflx generation 0 ufrag re';

// mid 'd' (index 1) is the transport's; mid 'a' (index 0) is another one.
function sdp(ufrag: string, candidates: string[]): string {
  return [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    `a=ice-pwd:${ufrag}-session-pwd`,
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:a',
    'a=ice-ufrag:other',
    'a=candidate:9 1 udp 1 192.0.2.9 9 typ host',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=mid:d',
    `a=ice-ufrag:${ufrag}`,
    ...candidates.map((c) => `a=${c}`),
    '',
  ].join('\r\n');
}

function setup(descriptions: { local?: string; remote?: string } = {}) {
  const read = iceSectionReader();
  const transport = createIceTransport({
    section: (side, mid) => {
      const sdp = descriptions[side];
      return sdp === undefined ? null : read(sdp, mid);
    },
  });
  const apply = (info: Partial<IceTransportInfo>) =>
    applyIceTransport(transport, {
      state: 'new',
      role: 'controlling',
      mid: 'd',
      selectedPair: null,
      ...info,
    });
  return { transport, apply };
}

function events(transport: RTCIceTransport): string[] {
  const log: string[] = [];
  transport.onstatechange = () => log.push(`statechange ${transport.state}`);
  transport.onselectedcandidatepairchange = () => log.push('selectedcandidatepairchange');
  return log;
}

test("role is 'unknown' until an answer made it known, then libwebrtc's", () => {
  const { transport, apply } = setup();
  apply({ role: 'controlled' });
  assert.equal(transport.role, 'unknown');
  markIceRoleKnown(transport);
  assert.equal(transport.role, 'controlled');
  assert.equal(transport.component, 'rtp');
});

test("candidates and parameters come from each description's m-section of the transport", () => {
  const { transport, apply } = setup({
    local: sdp('lo', [HOST]),
    remote: sdp('re', [REMOTE, PRFLX]),
  });
  apply({});
  const [local] = transport.getLocalCandidates();
  assert.ok(local instanceof RTCIceCandidate);
  assert.deepEqual(
    [local.candidate, local.sdpMid, local.sdpMLineIndex, local.usernameFragment],
    [HOST, 'd', 1, 'lo'],
  );
  assert.deepEqual(
    transport.getRemoteCandidates().map((c) => c.candidate),
    [REMOTE],
    'never a peer-reflexive one',
  );
  assert.deepEqual(transport.getLocalParameters(), {
    usernameFragment: 'lo',
    password: 'lo-session-pwd',
  });
  assert.deepEqual(transport.getRemoteParameters(), {
    usernameFragment: 're',
    password: 're-session-pwd',
  });
});

test('without a description there are no candidates or parameters', () => {
  const { transport, apply } = setup();
  apply({});
  assert.deepEqual(transport.getLocalCandidates(), []);
  assert.deepEqual(transport.getRemoteCandidates(), []);
  assert.equal(transport.getLocalParameters(), null);
  assert.equal(transport.getRemoteParameters(), null);
});

test('the selected pair is one object until it changes; selectedcandidatepairchange fires before statechange', () => {
  const { transport, apply } = setup({ local: sdp('lo', []), remote: sdp('re', []) });
  const log = events(transport);
  apply({ state: 'checking' })();
  assert.equal(transport.getSelectedCandidatePair(), null);
  apply({ state: 'connected', selectedPair: { local: HOST, remote: REMOTE } })();
  const pair = transport.getSelectedCandidatePair();
  assert.ok(pair instanceof RTCIceCandidatePair);
  assert.equal(transport.getSelectedCandidatePair(), pair);
  assert.equal(pair.local, pair.local, '[SameObject]');
  assert.deepEqual(
    [
      pair.local.candidate,
      pair.local.sdpMid,
      pair.local.sdpMLineIndex,
      pair.local.usernameFragment,
    ],
    [HOST, 'd', 1, 'lo'],
  );
  assert.equal(pair.remote.candidate, REMOTE);
  apply({ state: 'connected', selectedPair: { local: HOST, remote: REMOTE } })();
  assert.deepEqual(log, [
    'statechange checking',
    'selectedcandidatepairchange',
    'statechange connected',
  ]);
});

test("a peer-reflexive remote candidate's address is hidden", () => {
  const { transport, apply } = setup();
  apply({ state: 'connected', selectedPair: { local: HOST, remote: PRFLX } });
  const remote = transport.getSelectedCandidatePair()?.remote;
  assert.ok(remote);
  assert.deepEqual(
    {
      candidate: remote.candidate,
      address: remote.address,
      relatedAddress: remote.relatedAddress,
      relatedPort: remote.relatedPort,
      port: remote.port,
      type: remote.type,
      foundation: remote.foundation,
      priority: remote.priority,
      protocol: remote.protocol,
      component: remote.component,
    },
    {
      candidate: '',
      address: null,
      relatedAddress: null,
      relatedPort: 0,
      port: 50002,
      type: 'prflx',
      foundation: '3',
      priority: 1853824767,
      protocol: 'udp',
      component: 'rtp',
    },
  );
  assert.equal(transport.getSelectedCandidatePair()?.local.address, '192.0.2.1');
});

test('a closed transport has no selected pair and ignores reports', () => {
  const { transport, apply } = setup();
  apply({ state: 'connected', selectedPair: { local: HOST, remote: REMOTE } });
  closeIceTransport(transport);
  const log = events(transport);
  apply({ state: 'disconnected' })();
  assert.equal(transport.state, 'closed');
  assert.equal(transport.getSelectedCandidatePair(), null);
  assert.deepEqual(log, []);
});

test("libwebrtc's 'gathering' starts a transport the connection's event didn't; never 'complete'", () => {
  const { transport, apply } = setup();
  const log: string[] = [];
  transport.ongatheringstatechange = () => log.push(transport.gatheringState);
  apply({ gathering: 'gathering' })();
  apply({ gathering: 'complete' })();
  assert.deepEqual(log, ['gathering']);
  assert.equal(transport.gatheringState, 'gathering', "'complete' comes with the connection's");
});
