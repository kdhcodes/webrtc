// The converters keep wrtc's rules (node-webrtc src/converters/napi.cc,
// checked against @roamhq/wrtc 0.10.0 in a separate process); the messages
// are ours. The dictionary-level rules (member order, defaults, byte
// lengths) are tested through toNativeAudioData / toNativeVideoFrame in the
// source tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import {
  bytes,
  type Converter,
  expectObject,
  frameError,
  frameSize,
  hasBytes,
  isDetached,
  member,
  optional,
  uint8,
  uint16,
} from './convert.ts';

/** A stand-in for a view of `byteLength` bytes. */
const len = (byteLength: number) => ({ byteLength });

/** A member's result, with a failure's message built. */
function built<T>(result: ReturnType<typeof member<T>>) {
  return result.ok ? result : { ok: false, message: result.message() };
}

/** Converts each value, giving its result or what it should have been. */
function convertAll(convert: Converter<number>, values: unknown[]) {
  return values.map((value) => {
    const result = convert(value);
    return result.ok ? result.value : result.expected;
  });
}

test('expectObject accepts objects and functions, and says what it got otherwise', () => {
  const fn = () => {};
  assert.equal(expectObject(fn, 'api: x', 'an object'), fn);
  assert.throws(() => expectObject(5, 'api: x', 'an object {a}'), {
    name: 'TypeError',
    message: 'api: x must be an object {a}, not 5',
  });
  for (const value of [null, undefined, 'x', true, Symbol('s'), 1n]) {
    assert.throws(() => expectObject(value, 'api: x', 'an object'), { name: 'TypeError' });
  }
});

test('uint8 takes a number in [0, 255] and truncates it; NaN is 0', () => {
  assert.deepEqual(convertAll(uint8, [0, -0, 254.9, 255, Number.NaN]), [0, 0, 254, 255, 0]);
});

test('uint8 checks the range before truncating, so 255.1 and -0.5 fail', () => {
  const values = [255.1, -0.5, 256, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  assert.deepEqual(
    convertAll(uint8, values),
    values.map(() => 'a number from 0 to 255'),
  );
});

test('uint16 takes a number in [0, 65535] and truncates it; 65535.5 fails', () => {
  assert.deepEqual(convertAll(uint16, [65534.5, 65535, 65535.5, -0.1]), [
    65534,
    65535,
    'a number from 0 to 65535',
    'a number from 0 to 65535',
  ]);
});

test("frameSize is wrtc's int32 conversion, truncating toward zero (negatives pass)", () => {
  const ok = [0, 2147483647, 2.9, -0.9, -2.9, -2147483648, Number.NaN];
  assert.deepEqual(convertAll(frameSize, ok), [0, 2147483647, 2, 0, -2, -2147483648, 0]);
  const fail = [2147483647.5, -2147483648.5, Number.POSITIVE_INFINITY];
  assert.deepEqual(
    convertAll(frameSize, fail),
    fail.map(() => 'a number from 0 to 2147483647'),
  );
});

test('the integer converters accept only number primitives, not coercible values', () => {
  const values = ['1', 1n, Object(1), true, null, undefined, {}];
  assert.deepEqual(
    {
      uint8: convertAll(uint8, values),
      uint16: convertAll(uint16, values),
      frameSize: convertAll(frameSize, values),
    },
    {
      uint8: values.map(() => 'a number from 0 to 255'),
      uint16: values.map(() => 'a number from 0 to 65535'),
      frameSize: values.map(() => 'a number from 0 to 2147483647'),
    },
  );
});

test("member() names the field, what it must be and what it got (or that it's missing)", () => {
  const object = { width: '640', n: undefined };
  assert.deepEqual(built(member(object, 'api: frame', 'width', frameSize)), {
    ok: false,
    message: 'api: frame.width must be a number from 0 to 2147483647, not the string "640"',
  });
  assert.deepEqual(built(member(object, 'api: frame', 'n', uint8)), {
    ok: false,
    message: 'api: frame.n is missing: it must be a number from 0 to 255',
  });
});

test('bytes views exactly the bytes of any TypedArray, sharing its memory', () => {
  const buffer = new ArrayBuffer(64);
  const floats = new Float64Array(buffer, 8, 3);
  const result = bytes(floats);
  assert.ok(result.ok);
  assert.equal(result.value.buffer, buffer);
  assert.deepEqual([result.value.byteOffset, result.value.byteLength], [8, 24]);
});

test('bytes views all of an ArrayBuffer', () => {
  const buffer = new ArrayBuffer(10);
  const result = bytes(buffer);
  assert.ok(result.ok);
  assert.equal(result.value.buffer, buffer);
  assert.equal(result.value.byteLength, 10);
});

test('bytes rejects DataViews, SharedArrayBuffers, arrays and primitives', () => {
  const values = [new DataView(new ArrayBuffer(4)), new SharedArrayBuffer(4), [1, 2], 'ab', null];
  const label = (value: unknown) => inspect(value, { breakLength: Infinity });
  assert.deepEqual(
    values.map((value) => [label(value), bytes(value)]),
    values.map((value) => [
      label(value),
      { ok: false, expected: 'a TypedArray (such as a Uint8Array) or an ArrayBuffer' },
    ]),
  );
});

test('bytes accepts a TypedArray over a SharedArrayBuffer, as wrtc does', () => {
  const shared = new SharedArrayBuffer(8);
  const result = bytes(new Uint8Array(shared, 2, 4));
  assert.ok(result.ok);
  assert.equal(result.value.buffer, shared);
  assert.deepEqual([result.value.byteOffset, result.value.byteLength], [2, 4]);
});

test('bytes reads a detached buffer or view as empty (wrtc: byteLength 0), never throwing', () => {
  const view = new Uint8Array(8);
  view.buffer.transfer();
  const buffer = new ArrayBuffer(8);
  buffer.transfer();
  for (const value of [view, buffer]) {
    const result = bytes(value);
    assert.ok(result.ok);
    assert.equal(result.value.byteLength, 0);
    // ... and says so in messages; a merely empty view doesn't.
    assert.ok(isDetached(result.value));
    assert.equal(hasBytes(result.value), 'is detached (0 bytes)');
  }
  const empty = bytes(new Uint8Array(0));
  assert.ok(empty.ok && !isDetached(empty.value));
  assert.equal(hasBytes(len(1)), 'has 1 byte');
});

test("bytes ignores a view's overridden buffer, byteOffset and byteLength, as wrtc does", () => {
  const real = new Uint8Array(6);
  for (const [key, value] of [
    ['buffer', new ArrayBuffer(99)],
    ['byteOffset', 3],
    ['byteLength', 99],
  ] as const) {
    Object.defineProperty(real, key, { value });
  }
  const result = bytes(real);
  assert.ok(result.ok);
  assert.notEqual(result.value.buffer.byteLength, 99);
  assert.deepEqual([result.value.byteOffset, result.value.byteLength], [0, 6]);
});

test('optional() gives the fallback only for undefined; null is converted', () => {
  assert.deepEqual(optional({}, 'x', 'n', uint8, 16), { ok: true, value: 16 });
  assert.deepEqual(optional({ n: undefined }, 'x', 'n', uint8, 16), { ok: true, value: 16 });
  assert.deepEqual(built(optional({ n: null }, 'x', 'n', uint8, 16)), {
    ok: false,
    message: 'x.n must be a number from 0 to 255, not null',
  });
});

test('frameError: the expected length, and how it is made up, for I420 and RGBA', () => {
  // Odd sizes round the chroma planes up: 3x3 is 9 + 2 * 2 * 2.
  assert.equal(frameError('api: f', 'I420', 3, 3, len(17)), undefined);
  assert.equal(frameError('api: f', 'RGBA', 3, 3, len(36)), undefined);
  assert.equal(frameError('api: f', 'I420', 0, 5, len(0)), undefined);
  assert.equal(
    frameError('api: f', 'I420', 0, 5, len(3)),
    'api: f.data has 3 bytes, but a 0x5 frame is empty and needs 0',
  );
  assert.equal(
    frameError('api: f', 'I420', 640, 480, len(1000)),
    'api: f.data has 1000 bytes, but a 640x480 I420 frame needs 460800 ' +
      '(a 640x480 Y plane, then 320x240 U and V planes)',
  );
  assert.equal(
    frameError('api: f', 'RGBA', 4, 4, len(65)),
    'api: f.data has 65 bytes, but a 4x4 RGBA frame needs 64 (4 bytes per pixel)',
  );
});

test("frameError: sizes past wrtc's C int arithmetic are too large, whatever the data", () => {
  // 1 x 715827882 is 1431655764 bytes of I420: it fits, so only the length is wrong.
  assert.match(frameError('api: f', 'I420', 1, 715827882, len(0)) ?? '', /has 0 bytes/);
  assert.equal(
    frameError('api: f', 'I420', 50000, 50000, len(3)),
    'api: f is 50000x50000, which is too large: an I420 frame can be at most 2147483647 ' +
      'bytes, and this one would need 3750000000',
  );
  // Exact past 2^53, where a double would round.
  assert.match(
    frameError('api: f', 'I420', 2147483647, 2147483647, len(1)) ?? '',
    /would need 6917529023346114561$/,
  );
  // RGBA: at most 2^31 - 1 pixels (46341 x 46340 is 2147441940).
  assert.match(frameError('api: f', 'RGBA', 46341, 46340, len(0)) ?? '', /has 0 bytes/);
  assert.equal(
    frameError('api: f', 'RGBA', 46341, 46341, len(4)),
    'api: f is 46341x46341, which is too large: an RGBA frame can have at most 2147483647 pixels',
  );
  // An RGBA row must fit libyuv's int stride, unless the frame is empty.
  assert.match(frameError('api: f', 'RGBA', 536870911, 1, len(0)) ?? '', /has 0 bytes/);
  assert.equal(
    frameError('api: f', 'RGBA', 536870912, 1, len(2147483648)),
    'api: f is 536870912x1, which is too large: an RGBA frame can be at most 536870911 pixels ' +
      'wide (a row, width × 4 bytes, must fit in 2147483647)',
  );
  assert.equal(frameError('api: f', 'RGBA', 536870912, 0, len(0)), undefined);
});

test('frameError: a zero-size frame is empty whatever the sign of the other size (wrtc)', () => {
  for (const [w, h] of [
    [0, -3],
    [-3, 0],
    [0, -2147483648],
  ] as const) {
    assert.equal(frameError('api: f', 'I420', w, h, len(0)), undefined, `${w}x${h}`);
    assert.equal(frameError('api: f', 'RGBA', w, h, len(0)), undefined, `${w}x${h}`);
  }
});

test('frameError: otherwise a negative width or height is an error, whatever the data', () => {
  assert.equal(
    frameError('api: f', 'I420', -1, -1, len(1)),
    "api: f.width is -1, but a frame's width and height can't be negative",
  );
  assert.equal(
    frameError('api: f', 'RGBA', 4, -3, len(48)),
    "api: f.height is -3, but a frame's width and height can't be negative",
  );
});
