// TURN over TLS (`turns:`) through the public API. libwebrtc verifies the
// server's certificate chain against the roots compiled into it
// (rtc_base/ssl_roots.h, which patches/0003-ssl-roots-from-node.patch
// regenerates from Node's bundled roots; scripts/gen-ssl-roots.sh).
//
// The local test needs no network: a TLS server on loopback with a
// certificate from a throwaway CA must be refused, which shows verification
// is on. The network probe, a public TURN server whose chain ends at ISRG
// Root X1 (Let's Encrypt), is opt in:
//   WRTC_TURNS_PROBE=1 node --test test/integration/turns.test.ts
// (or WRTC_TURNS_PROBE=<host>[:<port>] for another server).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import tls from 'node:tls';
import { RTCPeerConnection, type RTCPeerConnectionIceErrorEvent } from '../../lib/index.ts';
import { next } from './harness.ts';

/** A CA no root store has, and a certificate it issued for 127.0.0.1. */
function throwawayChain(t: TestContext): { key: Buffer; cert: Buffer; ca: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'wrtc-turns-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string) => join(dir, name);
  const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
  const newKey = ['-newkey', 'rsa:2048', '-nodes'];
  const ca = ['-subj', '/CN=wrtc throwaway CA', '-days', '1'];
  openssl('req', '-x509', ...newKey, ...ca, '-keyout', file('ca.key'), '-out', file('ca.pem'));
  const leaf = ['-subj', '/CN=127.0.0.1'];
  openssl('req', '-new', ...newKey, ...leaf, '-keyout', file('key.pem'), '-out', file('leaf.csr'));
  // An IP SAN for the address the client dials. The chain check fails first
  // (unknown_ca, during the handshake), which is what the test asserts; the
  // name check after it (X509_check_host, DNS names only) would refuse an
  // IP-only SAN too, but never runs.
  writeFileSync(file('leaf.ext'), 'subjectAltName=IP:127.0.0.1\n');
  openssl(
    'x509',
    '-req',
    '-in',
    file('leaf.csr'),
    '-CA',
    file('ca.pem'),
    '-CAkey',
    file('ca.key'),
    '-CAcreateserial',
    '-days',
    '1',
    '-extfile',
    file('leaf.ext'),
    '-out',
    file('leaf.pem'),
  );
  return {
    key: readFileSync(file('key.pem')),
    cert: readFileSync(file('leaf.pem')),
    ca: readFileSync(file('ca.pem')),
  };
}

/** A relay-only peer connection gathering through `url`; closed after the test. */
function gatherThrough(t: TestContext, url: string): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceTransportPolicy: 'relay',
    iceServers: [{ urls: url, username: 'wrtc-test', credential: 'not-a-real-credential' }],
  });
  t.after(() => pc.close());
  pc.createDataChannel('x');
  return pc;
}

// The throwaway chain comes from the openssl CLI (macOS, gpubox and the test
// image have it; a stock node image doesn't).
const noOpenssl = spawnSync('openssl', ['version']).error
  ? 'needs the openssl CLI to make a throwaway CA, and there is none on PATH'
  : false;

test('a turns: server whose certificate comes from an unknown CA fails the TLS handshake', {
  skip: noOpenssl,
}, async (t) => {
  const { key, cert, ca } = throwawayChain(t);
  // The server sends the whole chain, CA included, as a real one would.
  const server = tls.createServer({ key, cert: Buffer.concat([cert, ca]) });
  const handshakeErrors: string[] = [];
  let secureConnections = 0;
  const clientRejected = new Promise<void>((resolve) => {
    server.on('tlsClientError', (err: NodeJS.ErrnoException) => {
      handshakeErrors.push(err.code ?? err.message);
      resolve();
    });
  });
  server.on('secureConnection', (socket) => {
    secureConnections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `turns:127.0.0.1:${(server.address() as AddressInfo).port}?transport=tcp`;

  const pc = gatherThrough(t, url);
  const failed = next<RTCPeerConnectionIceErrorEvent>(
    pc,
    'icecandidateerror',
    (e) => e.url === url,
  );
  await pc.setLocalDescription();
  const [event] = await Promise.all([failed, clientRejected]);

  assert.deepEqual(
    handshakeErrors,
    ['ERR_SSL_TLSV1_ALERT_UNKNOWN_CA'],
    'libwebrtc rejects the chain with an unknown_ca alert',
  );
  assert.equal(secureConnections, 0, 'no TLS session, so no TURN traffic');
  assert.equal(event.errorCode, 701, 'reported as unreachable');
});

const probe = process.env.WRTC_TURNS_PROBE;
const probeServer =
  probe === '1' ? 'any.turn.svc.whereby.com:443' : (probe?.replace(/^([^:]+)$/, '$1:443') ?? '');

test(`turns: to ${probeServer || 'a public TURN server'} gets past TLS to TURN's 401 (network)`, {
  skip: !probe && 'needs the network; set WRTC_TURNS_PROBE=1 to run it',
}, async (t) => {
  // Bogus credentials: the 401 only comes back over a verified TLS session.
  // A chain the roots don't cover fails as 701 before any TURN traffic.
  const url = `turns:${probeServer}?transport=tcp`;
  const pc = gatherThrough(t, url);
  const failed = next<RTCPeerConnectionIceErrorEvent>(
    pc,
    'icecandidateerror',
    (e) => e.url === url,
  );
  await pc.setLocalDescription();
  const event = await failed;
  assert.deepEqual(
    { errorCode: event.errorCode, errorText: event.errorText },
    { errorCode: 401, errorText: 'Unauthorized.' },
    'TURN refused the credentials, so the TLS handshake (and chain verification) succeeded',
  );
});
