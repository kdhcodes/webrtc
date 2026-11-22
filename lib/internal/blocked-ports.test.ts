import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBlockedCandidate, withoutBlockedCandidates } from './blocked-ports.ts';

const tcp = (port: number, tcptype = 'passive') =>
  `candidate:1 1 tcp 1518214911 192.0.2.1 ${port} typ host tcptype ${tcptype} generation 0`;
const udp = (port: number) =>
  `candidate:1 1 udp 2122260223 192.0.2.1 ${port} typ host generation 0`;

test('TCP candidates on a Fetch bad port are blocked, from either end of the list', () => {
  for (const port of [1, 22, 1719, 2049, 4190, 6679, 10080]) {
    assert.equal(isBlockedCandidate(tcp(port)), true, `port ${port}`);
  }
  assert.equal(isBlockedCandidate(tcp(2049, 'so')), true, 'simultaneous-open');
  assert.equal(isBlockedCandidate(`a=${tcp(2049)}`), true, 'with the SDP prefix');
  assert.equal(isBlockedCandidate(tcp(2049).replace('tcp', 'TCP')), true, 'case-insensitive');
  assert.equal(
    isBlockedCandidate(
      'candidate:1 1 tcp 1 192.0.2.1 5060 typ srflx raddr 0.0.0.0 rport 0 tcptype passive',
    ),
    true,
    'tcptype after raddr/rport',
  );
});

test('other ports, UDP and active TCP candidates are not blocked', () => {
  for (const port of [80, 443, 1024, 3478, 8001, 10000, 10079, 65535]) {
    assert.equal(isBlockedCandidate(tcp(port)), false, `port ${port}`);
  }
  // UDP media servers use ports on the list (mediasoup's range from 10000).
  assert.equal(isBlockedCandidate(udp(10080)), false, 'UDP');
  // Active candidates carry port 9 by convention; we never connect to them.
  assert.equal(isBlockedCandidate(tcp(9, 'active')), false, 'active');
  assert.equal(isBlockedCandidate(''), false, 'end-of-candidates');
  assert.equal(isBlockedCandidate('candidate:1 1 tcp 1 192.0.2.1'), false, 'truncated');
});

test('withoutBlockedCandidates drops only the blocked a=candidate lines, keeping line endings', () => {
  const sdp = (lines: string[]) => `${lines.join('\r\n')}\r\n`;
  const before = sdp([
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    `a=${tcp(2049)}`,
    `a=${udp(2049)}`,
    `a=${tcp(8001)}`,
    `a=${tcp(10080)}`,
  ]);
  assert.equal(
    withoutBlockedCandidates(before),
    sdp(['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', `a=${udp(2049)}`, `a=${tcp(8001)}`]),
  );
  const clean = sdp(['v=0', `a=${tcp(8001)}`]);
  assert.equal(withoutBlockedCandidates(clean), clean);
  assert.equal(withoutBlockedCandidates(`v=0\na=${tcp(2049)}\n`), 'v=0\n');
});

test('withoutBlockedCandidates removes each line with its own terminator in mixed CRLF/LF', () => {
  // An LF-only blocked candidate in a CRLF description: the next line stays.
  const mixed = `v=0\r\na=ice-ufrag:uf\r\na=${tcp(2049)}\na=ice-pwd:pw\r\na=${tcp(8001)}\n`;
  assert.equal(
    withoutBlockedCandidates(mixed),
    `v=0\r\na=ice-ufrag:uf\r\na=ice-pwd:pw\r\na=${tcp(8001)}\n`,
  );
  // A CRLF blocked candidate in an LF description.
  assert.equal(withoutBlockedCandidates(`v=0\na=${tcp(2049)}\r\na=mid:0\n`), 'v=0\na=mid:0\n');
});

test('withoutBlockedCandidates removes a blocked last line with or without a terminator', () => {
  assert.equal(withoutBlockedCandidates(`v=0\r\na=${tcp(2049)}\r\n`), 'v=0\r\n');
  assert.equal(withoutBlockedCandidates(`v=0\r\na=${tcp(2049)}`), 'v=0\r\n');
  assert.equal(withoutBlockedCandidates(`v=0\na=${tcp(2049)}`), 'v=0\n');
});

// Shapes probed against libwebrtc's addIceCandidate (accepted on an allowed
// port): it accepts all of these and connects, so on a bad port they must
// be blocked.
test('every shape libwebrtc accepts is blocked on a bad port', () => {
  const accepted = {
    'priority 0': 'candidate:1 1 tcp 0 192.0.2.1 2049 typ host tcptype passive',
    'priority 2^31': 'candidate:1 1 tcp 2147483648 192.0.2.1 2049 typ host tcptype passive',
    'priority 2^32-1': 'candidate:1 1 tcp 4294967295 192.0.2.1 2049 typ host tcptype passive',
    'component 0': 'candidate:1 0 tcp 1518214911 192.0.2.1 2049 typ host tcptype passive',
    'foundation of 33': `candidate:${'a'.repeat(33)} 1 tcp 1 192.0.2.1 2049 typ host tcptype passive`,
    'foundation with - and _': 'candidate:a-b_c 1 tcp 1 192.0.2.1 2049 typ host tcptype passive',
    'empty foundation': 'candidate: 1 tcp 1 192.0.2.1 2049 typ host tcptype passive',
    'trailing space': 'candidate:1 1 tcp 1 192.0.2.1 2049 typ host tcptype passive ',
    'trailing CRLF': 'candidate:1 1 tcp 1 192.0.2.1 2049 typ host tcptype passive\r\n',
    'no tcptype': 'candidate:1 1 tcp 1 192.0.2.1 2049 typ host',
    'TCPTYPE keyword': 'candidate:1 1 tcp 1 192.0.2.1 2049 typ host TCPTYPE passive',
    'port 02049': 'candidate:1 1 tcp 1 192.0.2.1 02049 typ host tcptype passive',
    ssltcp: 'candidate:1 1 ssltcp 1 192.0.2.1 2049 typ host',
  };
  for (const [name, candidate] of Object.entries(accepted)) {
    assert.equal(isBlockedCandidate(candidate), true, name);
  }
});

test('a shape libwebrtc rejects is not blocked, so it still rejects there', () => {
  const rejected = {
    'double space': 'candidate:1 1 tcp 1 192.0.2.1  2049 typ host tcptype passive',
    tab: 'candidate:1 1 tcp 1 192.0.2.1\t2049 typ host tcptype passive',
    'leading space': ' candidate:1 1 tcp 1 192.0.2.1 2049 typ host tcptype passive',
    'trailing tab': 'candidate:1 1 tcp 1 192.0.2.1 2049 typ host tcptype passive\t',
    'Candidate:': 'Candidate:1 1 tcp 1 192.0.2.1 2049 typ host tcptype passive',
    TYP: 'candidate:1 1 tcp 1 192.0.2.1 2049 TYP host tcptype passive',
    'tcptype ACTIVE': 'candidate:1 1 tcp 1 192.0.2.1 2049 typ host tcptype ACTIVE',
    'non-numeric priority': 'candidate:1 1 tcp notapriority 192.0.2.1 2049 typ host',
    'non-numeric component': 'candidate:1 x tcp 1 192.0.2.1 2049 typ host',
    'non-numeric port': 'candidate:1 1 tcp 1 192.0.2.1 2049x typ host',
    'negative priority': 'candidate:1 1 tcp -1 192.0.2.1 2049 typ host',
    'priority 2^32': 'candidate:1 1 tcp 4294967296 192.0.2.1 2049 typ host',
    'component 2^32': 'candidate:1 4294967296 tcp 1 192.0.2.1 2049 typ host',
    'port 2049 + 65536': 'candidate:1 1 tcp 1 192.0.2.1 67585 typ host',
    'odd extension': 'candidate:1 1 tcp 1 192.0.2.1 2049 typ host generation tcptype passive',
    'unknown transport': 'candidate:1 1 sctp 1 192.0.2.1 2049 typ host',
  };
  for (const [name, candidate] of Object.entries(rejected)) {
    assert.equal(isBlockedCandidate(candidate), false, name);
  }
});
