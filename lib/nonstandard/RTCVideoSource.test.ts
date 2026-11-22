import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { interfaceType } from '../internal/webidl.ts';
import { RTCVideoSource, toNativeVideoFrame } from './RTCVideoSource.ts';

const data4x4 = new Uint8Array(24);

/** `'<name>: <message>'` of what `fn` throws, or `'no error'`. */
function errorOf(fn: () => unknown): string {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

test('onFrame rejects bad frames (as wrtc does), naming the field, first failing member first', () => {
  const cases: [unknown, string][] = [
    [null, 'RTCVideoSource.onFrame: frame must be an object {width, height, data}, not null'],
    [
      {},
      'RTCVideoSource.onFrame: frame.width is missing: it must be a number from 0 to 2147483647',
    ],
    [
      { width: '4', height: 4, data: data4x4 },
      'RTCVideoSource.onFrame: frame.width must be a number from 0 to 2147483647, not the string "4"',
    ],
    [
      { width: 4, data: data4x4 },
      'RTCVideoSource.onFrame: frame.height is missing: it must be a number from 0 to 2147483647',
    ],
    [
      { width: 4, height: 4 },
      'RTCVideoSource.onFrame: frame.data is missing: it must be a TypedArray (such as a Uint8Array) or an ArrayBuffer',
    ],
    [
      { width: 4, height: 4, data: Array(24).fill(0) },
      'RTCVideoSource.onFrame: frame.data must be a TypedArray (such as a Uint8Array) or an ArrayBuffer, not an array',
    ],
    [
      { width: 4, height: 4, data: new Uint8Array(23) },
      'RTCVideoSource.onFrame: frame.data has 23 bytes, but a 4x4 I420 frame needs 24 (a 4x4 Y plane, then 2x2 U and V planes)',
    ],
    [
      { width: 3, height: 3, data: new Uint8Array(13) },
      'RTCVideoSource.onFrame: frame.data has 13 bytes, but a 3x3 I420 frame needs 17 (a 3x3 Y plane, then 2x2 U and V planes)',
    ],
    // wrtc threw for every negative size too (its C int length arithmetic
    // never matched, or matched and then the native side refused it).
    [
      { width: -4, height: 4, data: data4x4 },
      "RTCVideoSource.onFrame: frame.width is -4, but a frame's width and height can't be negative",
    ],
    [
      { width: -1, height: -1, data: new Uint8Array(1) },
      "RTCVideoSource.onFrame: frame.width is -1, but a frame's width and height can't be negative",
    ],
    // Past wrtc's int arithmetic: too large whatever the data (wrtc threw,
    // or crashed on data matching its wrapped length).
    [
      { width: 50000, height: 50000, data: data4x4 },
      'RTCVideoSource.onFrame: frame is 50000x50000, which is too large: an I420 frame can be at most 2147483647 bytes, ' +
        'and this one would need 3750000000',
    ],
  ];
  // One comparison of [input, error] pairs, so a failure names the input
  // and shows both the expected and the actual error.
  const label = (frame: unknown) => inspect(frame, { breakLength: Infinity, maxArrayLength: 2 });
  assert.deepEqual(
    cases.map(([frame]) => [label(frame), errorOf(() => toNativeVideoFrame(frame))]),
    cases.map(([frame, message]) => [label(frame), `TypeError: ${message}`]),
  );
});

test('onFrame reads width, height and data once each, in wrtc order, even after one fails', () => {
  const reads: string[] = [];
  const frame = new Proxy(
    { width: 'x', height: 4, data: 1 },
    {
      get(object, key, receiver) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.get(object, key, receiver);
      },
    },
  );
  assert.throws(() => toNativeVideoFrame(frame), {
    message: /^RTCVideoSource\.onFrame: frame\.width /,
  });
  assert.deepEqual(reads, ['width', 'height', 'data']);
});

test("onFrame rethrows a throwing getter's exception unchanged and stops reading (wrtc)", () => {
  const boom = new RangeError('boom');
  const reads: string[] = [];
  const frame = {
    get width() {
      reads.push('width');
      throw boom;
    },
    get height() {
      reads.push('height');
      return 4;
    },
    get data() {
      reads.push('data');
      return data4x4;
    },
  };
  assert.throws(
    () => toNativeVideoFrame(frame),
    (error) => error === boom,
  );
  assert.deepEqual(reads, ['width']);
});

test('onFrame honours rotation 90/180/270 and treats anything else as 0', () => {
  const rotations = [0, 90, 180, 270, 45, '90', undefined].map(
    (rotation) => toNativeVideoFrame({ width: 4, height: 4, data: data4x4, rotation }).rotation,
  );
  assert.deepEqual(rotations, [0, 90, 180, 270, 0, 0, 0]);
});

test('onFrame reads only the view, honouring byteOffset (wrtc reads the whole buffer)', () => {
  const whole = Uint8Array.from({ length: 30 }, (_, i) => i);
  const frame = toNativeVideoFrame({ width: 4, height: 4, data: whole.subarray(3, 27) });
  assert.deepEqual(Array.from(frame.data), Array.from(whole.subarray(3, 27)));
});

test('init: isScreencast defaults to false, needsDenoising to null, both via ToBoolean', () => {
  const read = (source: RTCVideoSource) => [source.isScreencast, source.needsDenoising];
  assert.deepEqual(read(new RTCVideoSource()), [false, null]);
  assert.deepEqual(read(new RTCVideoSource({})), [false, null]);
  assert.deepEqual(read(new RTCVideoSource({ isScreencast: 1, needsDenoising: null } as never)), [
    true,
    false,
  ]);
});

test('init: isScreencast and needsDenoising are read once each, in that order (wrtc)', () => {
  const reads: string[] = [];
  const init = new Proxy(
    { isScreencast: true, needsDenoising: false },
    {
      get(object, key, receiver) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.get(object, key, receiver);
      },
    },
  );
  new RTCVideoSource(init);
  assert.deepEqual(reads, ['isScreencast', 'needsDenoising']);
});

test('init other than undefined must be an object (a TypeError, as in wrtc)', () => {
  assert.throws(() => new RTCVideoSource(null as never), {
    name: 'TypeError',
    message:
      'RTCVideoSource: init must be an object such as {isScreencast: true}, or undefined, not null',
  });
});

test('RTCVideoSource is a registered WebIDL interface with a real brand check', () => {
  const convert = interfaceType('RTCVideoSource');
  assert.doesNotThrow(() => convert(new RTCVideoSource(), 'source'));
  assert.throws(() => convert(Object.create(RTCVideoSource.prototype), 'source'), {
    name: 'TypeError',
    message: 'source: is not a RTCVideoSource',
  });
});

test('a frame with a zero width or height is empty, whatever the sign of the other (wrtc)', () => {
  const empty = new Uint8Array(0);
  for (const [width, height] of [
    [0, -3],
    [-3, 0],
  ]) {
    const frame = toNativeVideoFrame({ width, height, data: empty });
    assert.deepEqual([frame.width, frame.height], [0, 0]);
  }
  assert.throws(() => toNativeVideoFrame({ width: 0, height: -3, data: data4x4 }), {
    name: 'TypeError',
    message:
      'RTCVideoSource.onFrame: frame.data has 24 bytes, but a 0x-3 frame is empty and needs 0',
  });
});

test('values that are hard to describe change neither reads, the winner nor the error type', () => {
  const { proxy: revoked, revoke } = Proxy.revocable({}, {});
  revoke();
  let trapped = 0;
  const trap = () => {
    trapped++;
    throw new Error('trap ran');
  };
  // An object whose prototype is a proxy; an object whose constructor has a
  // throwing static name getter; one whose constructor is a proxy.
  const proxyProto = Object.create(new Proxy({}, { getOwnPropertyDescriptor: trap, get: trap }));
  class Named {
    static get name(): string {
      return trap();
    }
    readonly instance = true;
  }
  const proto = {};
  Object.defineProperty(proto, 'constructor', { value: new Proxy(function F() {}, { get: trap }) });
  const proxyCtor = Object.create(proto);
  for (const bad of [revoked, proxyProto, new Named(), proxyCtor]) {
    const reads: string[] = [];
    const frame = {
      get width() {
        reads.push('width');
        return bad;
      },
      get height() {
        reads.push('height');
        return 4;
      },
      get data() {
        reads.push('data');
        return data4x4;
      },
    };
    assert.throws(() => toNativeVideoFrame(frame), {
      name: 'TypeError',
      message:
        'RTCVideoSource.onFrame: frame.width must be a number from 0 to 2147483647, not an object',
    });
    assert.deepEqual(reads, ['width', 'height', 'data']);
  }
  assert.equal(trapped, 0);
});
