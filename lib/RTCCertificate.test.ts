// RTCPeerConnection.generateCertificate() and RTCCertificate against a fake
// generator: the algorithm normalization and error mapping (Chrome's, probed
// with Chromium 159). Real keys, fingerprints in SDP and DTLS are in
// test/integration/certificates.test.ts.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import {
  fakeCertificateGenerator,
  nativeError,
  useFakeNative,
} from './internal/testing/fake-native.ts';
import { RTCCertificate } from './RTCCertificate.ts';
import { RTCPeerConnection } from './RTCPeerConnection.ts';

const ecdsa = { name: 'ECDSA', namedCurve: 'P-256' };
const rsa = (overrides: object = {}) => ({
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
  ...overrides,
});

function fakeGenerator(t: TestContext) {
  const generateCertificate = fakeCertificateGenerator();
  useFakeNative(t, { generateCertificate });
  return generateCertificate;
}

test('generateCertificate asks libwebrtc for ECDSA P-256 or RSA, with expires', async (t) => {
  const generator = fakeGenerator(t);
  await RTCPeerConnection.generateCertificate(ecdsa);
  await RTCPeerConnection.generateCertificate({
    name: 'ecdsa',
    namedCurve: 'P-256',
    expires: 2500.7,
  });
  await RTCPeerConnection.generateCertificate(rsa({ hash: { name: 'sha-256' } }));
  await RTCPeerConnection.generateCertificate(
    rsa({ modulusLength: 1024, publicExponent: new Uint8Array([0, 0, 1, 0, 3]), expires: 0 }),
  );
  assert.deepEqual(generator.calls, [
    [{ type: 'ecdsa' }, undefined],
    [{ type: 'ecdsa' }, 2500],
    [{ type: 'rsa', modulusLength: 2048, publicExponent: 65537 }, undefined],
    [{ type: 'rsa', modulusLength: 1024, publicExponent: 65539 }, 0],
  ]);
});

test('generateCertificate rejects what Chrome rejects, before generating anything', async (t) => {
  const generator = fakeGenerator(t);
  const cases: [string, unknown, string][] = [
    ['unknown name', 'invalid-algo', 'NotSupportedError'],
    ['unknown name in a dictionary', { name: 'invalid-algo' }, 'NotSupportedError'],
    ['null (the name "null")', null, 'NotSupportedError'],
    ['no name', {}, 'TypeError'],
    ['another WebCrypto algorithm', { name: 'HMAC', hash: 'SHA-256' }, 'NotSupportedError'],
    ['ECDSA as a string (no namedCurve)', 'ECDSA', 'TypeError'],
    ['ECDSA without namedCurve', { name: 'ECDSA' }, 'TypeError'],
    ['a curve name in the wrong case', { name: 'ECDSA', namedCurve: 'p-256' }, 'NotSupportedError'],
    ['P-384', { name: 'ECDSA', namedCurve: 'P-384' }, 'NotSupportedError'],
    ['SHA-1', rsa({ hash: 'SHA-1' }), 'NotSupportedError'],
    ['an unknown hash', rsa({ hash: 'SHA-999' }), 'NotSupportedError'],
    ['no hash', rsa({ hash: undefined }), 'TypeError'],
    ['no modulusLength', rsa({ modulusLength: undefined }), 'TypeError'],
    ['a negative modulusLength', rsa({ modulusLength: -1 }), 'TypeError'],
    ['an exponent that is not a Uint8Array', rsa({ publicExponent: [1, 0, 1] }), 'TypeError'],
    [
      'an exponent above 2^32',
      rsa({ publicExponent: new Uint8Array([1, 0, 0, 0, 1]) }),
      'NotSupportedError',
    ],
    ['expires -1', { ...ecdsa, expires: -1 }, 'TypeError'],
    ['expires a string', { ...ecdsa, expires: 'invalid' }, 'TypeError'],
    [
      'expires a numeric string (Chrome takes only numbers)',
      { ...ecdsa, expires: '5000' },
      'TypeError',
    ],
    ['expires present but undefined', { ...ecdsa, expires: undefined }, 'TypeError'],
    ['expires above 2^53', { ...ecdsa, expires: 2 ** 64 }, 'TypeError'],
    ['an unknown name before a bad expires', { name: 'bogus', expires: -1 }, 'NotSupportedError'],
    [
      'a bad expires before unsupported parameters',
      { ...ecdsa, namedCurve: 'P-384', expires: -1 },
      'TypeError',
    ],
  ];
  for (const [what, algorithm, name] of cases) {
    await assert.rejects(RTCPeerConnection.generateCertificate(algorithm as never), { name }, what);
  }
  assert.deepEqual(generator.calls, []);
});

test('key parameters libwebrtc refuses reject with NotSupportedError', async (t) => {
  fakeGenerator(t);
  await assert.rejects(RTCPeerConnection.generateCertificate(rsa({ modulusLength: 512 })), {
    name: 'NotSupportedError',
    message:
      "Failed to execute 'generateCertificate' on 'RTCPeerConnection': The 1st argument provided is an AlgorithmIdentifier with a supported algorithm name, but the parameters are not supported.",
  });
});

test('a failed generation rejects with OperationError', async (t) => {
  useFakeNative(t, {
    generateCertificate: () =>
      Promise.reject(nativeError('INTERNAL_ERROR', 'certificate generation failed')),
  });
  await assert.rejects(RTCPeerConnection.generateCertificate(ecdsa), {
    name: 'OperationError',
    message: 'certificate generation failed',
  });
});

test('no argument rejects with a TypeError; a detached reference works', async (t) => {
  fakeGenerator(t);
  await assert.rejects((RTCPeerConnection.generateCertificate as () => Promise<unknown>)(), {
    name: 'TypeError',
    message:
      "Failed to execute 'generateCertificate' on 'RTCPeerConnection': 1 argument required, but only 0 present.",
  });
  // rtcstats hands out the static itself through a getter, then calls it.
  const { generateCertificate } = RTCPeerConnection;
  assert.ok((await generateCertificate(ecdsa)) instanceof RTCCertificate);
});

test('an RTCCertificate shows expires and a new lower-case fingerprint list each call', async (t) => {
  fakeGenerator(t);
  const before = Date.now();
  const certificate = await RTCPeerConnection.generateCertificate({ ...ecdsa, expires: 60_000 });
  assert.ok(certificate.expires >= before + 60_000 && certificate.expires <= Date.now() + 60_000);
  const fingerprints = certificate.getFingerprints();
  assert.deepEqual(fingerprints, [
    {
      algorithm: 'sha-256',
      value: Array.from({ length: 32 }, (_, i) => (1 + i).toString(16).padStart(2, '0')).join(':'),
    },
  ]);
  Object.assign(fingerprints[0] ?? {}, { value: 'changed' });
  assert.notEqual(certificate.getFingerprints()[0]?.value, 'changed');
  assert.notEqual(certificate.getFingerprints(), certificate.getFingerprints());
  // Nothing about the key is reachable as a property.
  assert.deepEqual(Reflect.ownKeys(certificate), []);
  assert.equal(JSON.stringify(certificate), '{}');
  assert.equal(String(certificate), '[object RTCCertificate]');
});

test('RTCCertificate is not constructible', () => {
  assert.throws(() => new (RTCCertificate as unknown as new () => unknown)(), {
    name: 'TypeError',
    message: "Failed to construct 'RTCCertificate': Illegal constructor",
  });
});
