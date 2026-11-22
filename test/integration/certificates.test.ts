// RTCPeerConnection.generateCertificate() and RTCConfiguration.certificates
// end to end against real libwebrtc: the fingerprint in SDP, DTLS between
// peers using generated certificates (each sees the other's), and the
// default certificate when none is given.
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { test } from 'node:test';
import { type RTCCertificate, RTCPeerConnection, type RTCStatsReport } from '../../lib/index.ts';
import { connect, pair } from './harness.ts';

const ecdsa = { name: 'ECDSA', namedCurve: 'P-256' };
const rsa = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

/** `a=fingerprint` as libwebrtc writes it for `certificate`. */
function sdpFingerprint(certificate: RTCCertificate): string {
  const [{ algorithm, value } = {}] = certificate.getFingerprints();
  return `a=fingerprint:${algorithm} ${value?.toUpperCase()}`;
}

function sha256(der: ArrayBuffer): string {
  return createHash('sha256')
    .update(new Uint8Array(der))
    .digest('hex')
    .replace(/(..)(?!$)/g, '$1:');
}

/** The local or remote certificate stats of the (only) transport. */
function certificateStats(report: RTCStatsReport, which: 'local' | 'remote') {
  const transport = [...report.values()].find((s) => s.type === 'transport');
  return report.get(transport?.[`${which}CertificateId`]);
}

test('the offer carries the first certificate’s fingerprint, ECDSA or RSA', async (t) => {
  const [first, second] = await Promise.all([
    RTCPeerConnection.generateCertificate(rsa),
    RTCPeerConnection.generateCertificate(ecdsa),
  ]);
  const pc = new RTCPeerConnection({
    certificates: [first as RTCCertificate, second as RTCCertificate],
  });
  t.after(() => pc.close());
  pc.addTransceiver('audio');
  pc.addTransceiver('video');
  const { sdp } = await pc.createOffer();
  // One per m-section; libwebrtc uses only the first certificate, as Chrome.
  assert.deepEqual(sdp?.match(/a=fingerprint:.*/g), [
    sdpFingerprint(first as RTCCertificate),
    sdpFingerprint(first as RTCCertificate),
  ]);
});

test('peers using generated certificates connect, and each sees the other’s', async (t) => {
  const [mine, theirs] = await Promise.all([
    RTCPeerConnection.generateCertificate(ecdsa),
    RTCPeerConnection.generateCertificate(rsa),
  ]);
  const peers = pair(t, { a: { certificates: [mine] }, b: { certificates: [theirs] } });
  peers.a.createDataChannel('x');
  await connect(peers);
  assert.deepEqual(peers.iceErrors, []);

  const remote = peers.a.sctp?.transport.getRemoteCertificates() ?? [];
  assert.equal(remote.length, 1);
  assert.equal(sha256(remote[0] as ArrayBuffer), theirs.getFingerprints()[0]?.value);
  assert.equal(
    new X509Certificate(Buffer.from(remote[0] as ArrayBuffer)).publicKey.asymmetricKeyType,
    'rsa',
  );

  const report = await peers.a.getStats();
  assert.equal(
    certificateStats(report, 'local')?.fingerprint,
    mine.getFingerprints()[0]?.value?.toUpperCase(),
  );
  assert.equal(
    certificateStats(report, 'remote')?.fingerprint,
    theirs.getFingerprints()[0]?.value?.toUpperCase(),
  );
});

test('without certificates each connection makes its own ECDSA P-256 one, as before', async (t) => {
  const peers = pair(t);
  peers.a.createDataChannel('x');
  await connect(peers);
  const [der] = peers.a.sctp?.transport.getRemoteCertificates() ?? [];
  const key = new X509Certificate(Buffer.from(der as ArrayBuffer)).publicKey;
  assert.equal(key.asymmetricKeyType, 'ec');
  assert.equal(key.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  assert.deepEqual(peers.b.getConfiguration().certificates, []);
});
