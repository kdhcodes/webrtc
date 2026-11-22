// generateCertificate() and configuration certificates against real
// libwebrtc, through the raw native API: what a generated certificate
// carries, that it's made off the JS thread, that a PC built from its PEM
// uses it, and worker termination mid-generation.
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { native } from '../../lib/internal/native.ts';
import type { NativeError } from '../../lib/internal/native-types.ts';

const DAY_MS = 24 * 3600 * 1000;

test('a certificate carries its PEM, expiry and the fingerprint of its DER', async () => {
  const before = Date.now();
  const generated = await native.generateCertificate({ type: 'ecdsa' });
  const x509 = new X509Certificate(generated.certificate);
  assert.equal(x509.publicKey.asymmetricKeyType, 'ec');
  assert.match(generated.privateKey, /^-----BEGIN PRIVATE KEY-----/);
  assert.equal(generated.fingerprint.algorithm, 'sha-256');
  assert.equal(generated.fingerprint.value, x509.fingerprint256);
  assert.equal(generated.expires, Date.parse(x509.validTo));
  // libwebrtc's default lifetime, in whole seconds.
  assert.ok(Math.abs(generated.expires - (before + 30 * DAY_MS)) < 2000);

  const rsa = await native.generateCertificate({
    type: 'rsa',
    modulusLength: 1024,
    publicExponent: 65537,
  });
  const rsaX509 = new X509Certificate(rsa.certificate);
  assert.equal(rsaX509.publicKey.asymmetricKeyType, 'rsa');
  assert.equal(rsaX509.publicKey.asymmetricKeyDetails?.modulusLength, 1024);
  assert.equal(rsa.fingerprint.value, rsaX509.fingerprint256, 'sha-256 for RSA too');
});

test('expires is capped at a year, and 0 makes a certificate that has already expired', async () => {
  const before = Date.now();
  const long = await native.generateCertificate({ type: 'ecdsa' }, 400 * DAY_MS);
  assert.ok(Math.abs(long.expires - (before + 365 * DAY_MS)) < 2000);
  const expired = await native.generateCertificate({ type: 'ecdsa' }, 0);
  assert.ok(expired.expires <= Date.now());
});

test('key parameters libwebrtc refuses reject at call time with INVALID_PARAMETER', async () => {
  for (const [modulusLength, publicExponent] of [
    [512, 65537],
    [8193, 65537],
    [2048, 3],
  ] as const) {
    let state = 'pending';
    const promise = native.generateCertificate({ type: 'rsa', modulusLength, publicExponent });
    promise.catch((error: NativeError) => {
      state = `${error.errorType}: ${error.message}`;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(state, 'INVALID_PARAMETER: unsupported key parameters', `${modulusLength}`);
  }
});

test('an RSA key is generated off the JS thread', async () => {
  // RSA-4096 takes about 200 ms here (seconds at worst). Generated on the
  // JS thread, the call itself would take that long and no timer could fire
  // until it returned. The bounds are loose so load and Docker don't flake.
  let ticks = 0;
  const interval = setInterval(() => ticks++, 5);
  try {
    const start = performance.now();
    const generating = native.generateCertificate({
      type: 'rsa',
      modulusLength: 4096,
      publicExponent: 65537,
    });
    const callMs = performance.now() - start;
    await generating;
    const totalMs = performance.now() - start;
    assert.ok(callMs < 20, `the call took ${callMs.toFixed(2)} ms`);
    assert.ok(ticks >= 3, `${ticks} ticks in ${totalMs.toFixed(0)} ms of generation`);
  } finally {
    clearInterval(interval);
  }
});

test('expires must be a non-negative safe integer', () => {
  for (const expires of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 64]) {
    assert.throws(() => native.generateCertificate({ type: 'ecdsa' }, expires), {
      name: 'TypeError',
      message: 'expires must be a non-negative safe integer',
    });
  }
});

test("a PC built from the PEM offers the first certificate's fingerprint", async () => {
  const [first, second] = await Promise.all([
    native.generateCertificate({ type: 'ecdsa' }),
    native.generateCertificate({ type: 'ecdsa' }),
  ]);
  const pc = new native.PeerConnection({ certificates: [first, second] }, () => {});
  try {
    pc.createDataChannel('x', {});
    const { sdp } = await pc.createOffer();
    // libwebrtc uses only the first, as in Chrome.
    assert.deepEqual(sdp.match(/a=fingerprint:.*/g), [
      `a=fingerprint:sha-256 ${first.fingerprint.value}`,
    ]);
  } finally {
    pc.close();
  }
});

test('PEM libwebrtc cannot parse throws INVALID_PARAMETER', () => {
  assert.throws(
    () =>
      new native.PeerConnection(
        { certificates: [{ privateKey: 'not a key', certificate: 'not a certificate' }] },
        () => {},
      ),
    { errorType: 'INVALID_PARAMETER', message: 'invalid certificate PEM' },
  );
});

test('terminating a worker while it generates a key is clean', async () => {
  // A FATAL error in the worker's teardown aborts this whole process.
  // terminate() takes about as long as the RSA key (Node lets threadpool
  // work finish).
  const code = `
    const { createRequire } = require('node:module');
    const { parentPort } = require('node:worker_threads');
    const native = createRequire(${JSON.stringify(import.meta.url)})('../../build/Release/wrtc.node');
    globalThis.keep = [
      native.generateCertificate({ type: 'rsa', modulusLength: 4096, publicExponent: 65537 }),
      native.generateCertificate({ type: 'ecdsa' }),
    ];
    parentPort.postMessage('generating');
  `;
  const worker = new Worker(code, { eval: true });
  const errors: Error[] = [];
  worker.on('error', (e) => errors.push(e));
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve());
    worker.once('exit', (c) => reject(new Error(`worker exited early (${c})`)));
  });
  assert.equal(await worker.terminate(), 1);
  assert.deepEqual(errors, []);
});
