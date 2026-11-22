import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { interfaceType } from '../internal/webidl.ts';
import { RTCAudioSource, toNativeAudioData } from './RTCAudioSource.ts';

const samples80 = new Int16Array(80);

/** `'<name>: <message>'` of what `fn` throws, or `'no error'`. */
function errorOf(fn: () => unknown): string {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

test('onData rejects bad data (as wrtc does), naming the field, first failing member first', () => {
  const cases: [unknown, string][] = [
    [
      undefined,
      'RTCAudioSource.onData: data is missing: it must be an object {samples, sampleRate, ...}',
    ],
    [
      'x',
      'RTCAudioSource.onData: data must be an object {samples, sampleRate, ...}, not the string "x"',
    ],
    [
      {},
      'RTCAudioSource.onData: data.samples is missing: it must be an Int16Array of 16-bit samples (or another TypedArray, or an ArrayBuffer)',
    ],
    [
      { samples: [0], sampleRate: 8000 },
      'RTCAudioSource.onData: data.samples must be an Int16Array of 16-bit samples (or another TypedArray, or an ArrayBuffer), not an array',
    ],
    [
      { samples: new DataView(new ArrayBuffer(160)), sampleRate: 8000 },
      'RTCAudioSource.onData: data.samples must be an Int16Array of 16-bit samples (or another TypedArray, or an ArrayBuffer), not a DataView',
    ],
    [
      { samples: samples80, bitsPerSample: 'x' },
      'RTCAudioSource.onData: data.bitsPerSample must be 16 (only 16-bit PCM is supported), not the string "x"',
    ],
    [
      { samples: samples80 },
      'RTCAudioSource.onData: data.sampleRate is missing: it must be a number from 0 to 65535',
    ],
    [
      { samples: samples80, sampleRate: '8000' },
      'RTCAudioSource.onData: data.sampleRate must be a number from 0 to 65535, not the string "8000"',
    ],
    [
      { samples: samples80, sampleRate: 65536 },
      'RTCAudioSource.onData: data.sampleRate must be a number from 0 to 65535, not 65536',
    ],
    [
      { samples: samples80, sampleRate: 8000, channelCount: 256 },
      'RTCAudioSource.onData: data.channelCount must be a number from 0 to 255, not 256',
    ],
    [
      { samples: samples80, sampleRate: 8000, numberOfFrames: null },
      'RTCAudioSource.onData: data.numberOfFrames must be a number from 0 to 65535, not null',
    ],
    [
      { samples: samples80, sampleRate: 8000, bitsPerSample: 8 },
      'RTCAudioSource.onData: data.bitsPerSample must be 16 (only 16-bit PCM is supported), not 8',
    ],
    [
      { samples: samples80, sampleRate: 8000, numberOfFrames: 160 },
      'RTCAudioSource.onData: data.numberOfFrames must be 80 (10 ms at 8000 Hz) or left out, not 160: ' +
        'each call takes exactly 10 ms of audio',
    ],
    [
      { samples: new Int16Array(79), sampleRate: 8000 },
      'RTCAudioSource.onData: data.samples has 158 bytes, but 10 ms of 1-channel 16-bit audio at 8000 Hz needs 160 ' +
        '(80 frames × 1 channel × 2 bytes)',
    ],
    [
      { samples: new Int16Array(1920), sampleRate: 48000, channelCount: 2 },
      'RTCAudioSource.onData: data.samples has 3840 bytes, but 10 ms of 2-channel 16-bit audio at 48000 Hz needs 1920 ' +
        '(480 frames × 2 channels × 2 bytes)',
    ],
  ];
  // One comparison of [input, error] pairs, so a failure names the input
  // and shows both the expected and the actual error.
  const label = (data: unknown) => inspect(data, { breakLength: Infinity, maxArrayLength: 2 });
  assert.deepEqual(
    cases.map(([data]) => [label(data), errorOf(() => toNativeAudioData(data))]),
    cases.map(([data, message]) => [label(data), `TypeError: ${message}`]),
  );
});

test('onData reads every member once, in wrtc order, even after one fails', () => {
  const reads: string[] = [];
  const data = new Proxy(
    { samples: 1, sampleRate: 'x' },
    {
      get(object, key, receiver) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.get(object, key, receiver);
      },
    },
  );
  assert.throws(() => toNativeAudioData(data), {
    message: /^RTCAudioSource\.onData: data\.samples /,
  });
  assert.deepEqual(reads, [
    'samples',
    'bitsPerSample',
    'sampleRate',
    'channelCount',
    'numberOfFrames',
  ]);
});

// wrtc lets a getter's exception propagate unchanged and reads no further
// members (checked against @roamhq/wrtc 0.10.0); so do we.
test("onData rethrows a throwing getter's exception unchanged and stops reading (wrtc)", () => {
  const boom = new RangeError('boom');
  const reads: string[] = [];
  const data = {
    get samples() {
      reads.push('samples');
      return samples80;
    },
    get bitsPerSample() {
      reads.push('bitsPerSample');
      throw boom;
    },
    get sampleRate() {
      reads.push('sampleRate');
      return 8000;
    },
  };
  assert.throws(
    () => toNativeAudioData(data),
    (error) => error === boom,
  );
  assert.deepEqual(reads, ['samples', 'bitsPerSample']);
});

test('onData fills in wrtc defaults and truncates a fractional sampleRate', () => {
  const data = toNativeAudioData({ samples: new Int16Array(441), sampleRate: 44100.9 });
  assert.equal(data.sampleRate, 44100);
  assert.equal(data.bitsPerSample, 16);
  assert.equal(data.channelCount, 1);
  assert.equal(data.numberOfFrames, 441);
});

test('onData reads only the view, honouring byteOffset (wrtc reads the whole buffer)', () => {
  const whole = Int16Array.from({ length: 100 }, (_, i) => i);
  const data = toNativeAudioData({ samples: whole.subarray(10, 90), sampleRate: 8000 });
  assert.deepEqual(Array.from(data.samples), Array.from(whole.subarray(10, 90)));
});

test('onData copies samples at an odd byteOffset into an aligned Int16Array', () => {
  const bytes = new Uint8Array(161);
  bytes[1] = 0x34;
  bytes[2] = 0x12;
  const data = toNativeAudioData({ samples: bytes.subarray(1), sampleRate: 8000 });
  assert.equal(data.samples.byteOffset % 2, 0);
  assert.equal(data.samples[0], 0x1234);
});

test('RTCAudioSource is a registered WebIDL interface with a real brand check', () => {
  const convert = interfaceType('RTCAudioSource');
  assert.doesNotThrow(() => convert(new RTCAudioSource(), 'source'));
  assert.throws(() => convert(Object.create(RTCAudioSource.prototype), 'source'), {
    name: 'TypeError',
    message: 'source: is not a RTCAudioSource',
  });
});

test('a value that is hard to describe (a revoked proxy) changes neither reads nor the winner', () => {
  // samples fails, then bitsPerSample's getter throws: the getter's error
  // wins, as for any other bad samples value. Describing the revoked proxy
  // (which throws on most operations) must not run first.
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const boom = new RangeError('boom');
  const reads: string[] = [];
  const data = {
    get samples() {
      reads.push('samples');
      return proxy;
    },
    get bitsPerSample() {
      reads.push('bitsPerSample');
      throw boom;
    },
  };
  assert.throws(
    () => toNativeAudioData(data),
    (error) => error === boom,
  );
  assert.deepEqual(reads, ['samples', 'bitsPerSample']);
  // On its own, it is the samples TypeError.
  assert.throws(() => toNativeAudioData({ samples: proxy, sampleRate: 8000 }), {
    name: 'TypeError',
    message: /^RTCAudioSource\.onData: data\.samples must be .*, not an object$/,
  });
});
