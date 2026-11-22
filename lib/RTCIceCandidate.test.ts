import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RTCIceCandidate } from './RTCIceCandidate.ts';

const host =
  'candidate:842163049 1 udp 1677729535 192.0.2.10 50000 typ host generation 0 ufrag abcd';
const relay =
  'candidate:3 2 TCP 41885439 203.0.113.5 3478 typ relay raddr 192.0.2.10 rport 50000 tcptype passive';

function fields(c: RTCIceCandidate) {
  return {
    foundation: c.foundation,
    component: c.component,
    priority: c.priority,
    address: c.address,
    protocol: c.protocol,
    port: c.port,
    type: c.type,
    tcpType: c.tcpType,
    relatedAddress: c.relatedAddress,
    relatedPort: c.relatedPort,
  };
}

test('parses the candidate string into its fields', () => {
  assert.deepEqual(fields(new RTCIceCandidate({ candidate: host, sdpMid: '0' })), {
    foundation: '842163049',
    component: 'rtp',
    priority: 1677729535,
    address: '192.0.2.10',
    protocol: 'udp',
    port: 50000,
    type: 'host',
    tcpType: null,
    relatedAddress: null,
    relatedPort: null,
  });
  assert.deepEqual(fields(new RTCIceCandidate({ candidate: relay, sdpMLineIndex: 0 })), {
    foundation: '3',
    component: 'rtcp',
    priority: 41885439,
    address: '203.0.113.5',
    protocol: 'tcp',
    port: 3478,
    type: 'relay',
    tcpType: 'passive',
    relatedAddress: '192.0.2.10',
    relatedPort: 50000,
  });
});

test('a candidate string that does not parse leaves the fields null', () => {
  const c = new RTCIceCandidate({
    candidate: 'candidate:1 1 udp x 1.2.3.4 1 typ host',
    sdpMid: '0',
  });
  assert.equal(c.candidate, 'candidate:1 1 udp x 1.2.3.4 1 typ host');
  assert.ok(Object.values(fields(c)).every((v) => v === null));
});

// RFC 8839 as WPT RTCIceCandidate-constructor.html reads it (that file has
// the full list; these are the rules most likely to regress).
test('candidate strings outside the RFC 8839 grammar and prose do not parse', () => {
  const rejected = [
    // SDP framing and whitespace aren't part of the attribute.
    'a=candidate:1 1 udp 100 1.2.3.4 5678 typ host',
    'candidate: 1 1 udp 100 1.2.3.4 5678 typ host',
    // Ranges: component 1-256, priority 1 to 2^31 - 1, digits only.
    'candidate:1 0 udp 100 1.2.3.4 5678 typ host',
    'candidate:1 257 udp 100 1.2.3.4 5678 typ host',
    'candidate:1 1 udp 2147483648 1.2.3.4 5678 typ host',
    'candidate:1 1 udp 100 1.2.3.4 5678abc typ host',
    // Foundation: up to 32 ice-chars.
    'candidate:foo-bar 1 udp 100 1.2.3.4 5678 typ host',
    `candidate:${'a'.repeat(33)} 1 udp 100 1.2.3.4 5678 typ host`,
    // Non-host candidates need raddr and rport.
    'candidate:1 1 udp 100 1.2.3.4 5678 typ srflx',
    'candidate:1 1 udp 100 1.2.3.4 5678 typ srflx raddr 5.6.7.8',
    // TCP needs a valid tcptype right after them (RFC 6544).
    'candidate:1 1 tcp 100 1.2.3.4 5678 typ host',
    'candidate:1 1 tcp 100 1.2.3.4 5678 typ host tcptype connect',
    'candidate:1 1 tcp 100 1.2.3.4 5678 typ host generation 0 tcptype active',
  ];
  for (const candidate of rejected) {
    const c = new RTCIceCandidate({ candidate, sdpMid: '0' });
    assert.ok(
      Object.values(fields(c)).every((v) => v === null),
      `${candidate} should not parse`,
    );
  }
});

test('keywords and enum values are case-insensitive and reported lowercased', () => {
  const c = new RTCIceCandidate({
    candidate: 'candidate:1 1 TCP 100 1.2.3.4 5678 TYP HOST TCPTYPE ACTIVE',
    sdpMid: '0',
  });
  assert.deepEqual([c.protocol, c.type, c.tcpType], ['tcp', 'host', 'active']);
});

test('sdpMid and sdpMLineIndex both null is a TypeError', () => {
  assert.throws(() => new RTCIceCandidate({ candidate: host }), { name: 'TypeError' });
  assert.throws(() => new RTCIceCandidate(), { name: 'TypeError' });
});

test('toJSON gives the init members, and JSON.stringify uses it', () => {
  const c = new RTCIceCandidate({ candidate: host, sdpMid: '0', usernameFragment: 'abcd' });
  const json = { candidate: host, sdpMid: '0', sdpMLineIndex: null, usernameFragment: 'abcd' };
  assert.deepEqual(c.toJSON(), json);
  assert.deepEqual(JSON.parse(JSON.stringify(c)), json);
});

test('a candidate is accepted as the init of another (addIceCandidate round trip)', () => {
  const c = new RTCIceCandidate({ candidate: host, sdpMLineIndex: 1 });
  const copy = new RTCIceCandidate(c);
  assert.deepEqual(copy.toJSON(), c.toJSON());
});
