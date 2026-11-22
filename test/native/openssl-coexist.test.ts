// libwebrtc's BoringSSL and Node's OpenSSL in one process (PLAN.md, Linux):
// a node:tls TLS 1.3 handshake plus node:crypto sign/verify while
// DTLS-secured peer connections are live. Most relevant on Linux, where the
// symbol isolation (--exclude-libs, hidden visibility) is what makes it work.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import tls from 'node:tls';
import { native } from '../../lib/internal/native.ts';
import type {
  NativeIceCandidate,
  NativePcEvent,
  NativePeerConnection,
} from '../../lib/internal/native-types.ts';

test('node:tls and node:crypto work alongside live peer connections', async () => {
  // Connected, so BoringSSL has really run a DTLS handshake, not just
  // generated certificates.
  let a!: NativePeerConnection;
  let b!: NativePeerConnection;
  const pending: Record<'a' | 'b', NativeIceCandidate[]> = { a: [], b: [] };
  let negotiated = false;
  const trickle = (target: NativePeerConnection, key: 'a' | 'b', c: NativeIceCandidate) => {
    if (negotiated) void target.addIceCandidate(c);
    else pending[key].push(c);
  };
  const connected = new Promise<void>((resolve) => {
    a = new native.PeerConnection({ iceServers: [] }, (ev: NativePcEvent) => {
      if (ev.kind === 'icecandidate') trickle(b, 'b', ev.candidate);
      if (ev.kind === 'connectionstatechange' && ev.state === 'connected') resolve();
    });
    b = new native.PeerConnection({ iceServers: [] }, (ev: NativePcEvent) => {
      if (ev.kind === 'icecandidate') trickle(a, 'a', ev.candidate);
    });
  });
  const dir = mkdtempSync(join(tmpdir(), 'wrtc-tls-'));
  try {
    a.createDataChannel('x');
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    negotiated = true;
    for (const c of pending.a) await a.addIceCandidate(c);
    for (const c of pending.b) await b.addIceCandidate(c);
    await connected;

    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    const key = readFileSync(join(dir, 'key.pem'));
    const cert = readFileSync(join(dir, 'cert.pem'));

    const server = tls.createServer({ key, cert }, (socket) => socket.end('hello over tls'));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const reply = await new Promise<{ data: string; protocol: string | null }>(
        (resolve, reject) => {
          const port = (server.address() as AddressInfo).port;
          const socket = tls.connect({ port, ca: cert, servername: 'localhost' }, () => {
            let data = '';
            socket.on('data', (chunk) => {
              data += chunk;
            });
            socket.on('end', () => resolve({ data, protocol: socket.getProtocol() }));
          });
          socket.on('error', reject);
        },
      );
      assert.equal(reply.data, 'hello over tls');
      assert.equal(reply.protocol, 'TLSv1.3');
    } finally {
      server.close();
    }

    const signature = crypto.sign('sha256', Buffer.from('x'), crypto.createPrivateKey(key));
    assert.ok(crypto.verify('sha256', Buffer.from('x'), crypto.createPublicKey(cert), signature));

    const stats = JSON.parse(await a.getStats()) as Record<string, Record<string, unknown>>;
    const transport = Object.values(stats).find((s) => s.type === 'transport');
    assert.equal(transport?.dtlsState, 'connected');
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
