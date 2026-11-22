// The raw native i420ToRgba / rgbaToI420. The JS layer validates first
// (lib/nonstandard/i420.ts); the native checks only have to keep a bad call
// from writing outside the caller's views.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { native } from '../../lib/internal/native.ts';
import type { NativeFrameBuffer } from '../../lib/internal/native-types.ts';

const i420 = (w: number, h: number, size = w * h + 2 * Math.ceil(w / 2) * Math.ceil(h / 2)) => ({
  width: w,
  height: h,
  data: new Uint8Array(size).fill(128),
});
const rgba = (w: number, h: number, size = w * h * 4) => ({
  width: w,
  height: h,
  data: new Uint8Array(size).fill(7),
});

test('converts into the destination view, leaving the bytes around it alone', () => {
  const backing = new Uint8Array(4 + 3 * 3 * 4 + 4).fill(7);
  const dest = { width: 3, height: 3, data: backing.subarray(4, 4 + 36) };
  native.i420ToRgba(i420(3, 3), dest);
  assert.deepEqual(Array.from(backing.subarray(0, 4)), [7, 7, 7, 7]);
  assert.deepEqual(Array.from(backing.subarray(40)), [7, 7, 7, 7]);
  assert.deepEqual(Array.from(dest.data.subarray(32)), [130, 130, 130, 255]);
});

test('rejects calls that would read or write outside the views, writing nothing', () => {
  const cases: [string, NativeFrameBuffer, NativeFrameBuffer][] = [
    ['short I420', i420(4, 4, 23), rgba(4, 4)],
    ['long RGBA', i420(4, 4), rgba(4, 4, 65)],
    ['sizes differ', i420(2, 8), rgba(4, 4)],
    ['negative size', { ...i420(4, 4), width: -4 }, { ...rgba(4, 4), width: -4 }],
    ['fractional size', { ...i420(4, 4), height: 4.5 }, { ...rgba(4, 4), height: 4.5 }],
    ['data not a TypedArray', { ...i420(2, 2), data: [0, 0, 0, 0, 0, 0] as never }, rgba(2, 2)],
    ['RGBA stride overflows int', i420(2 ** 29, 1, 0), rgba(2 ** 29, 1, 0)],
  ];
  for (const [name, yuv, pixels] of cases) {
    assert.throws(() => native.i420ToRgba(yuv, pixels), TypeError, `i420ToRgba: ${name}`);
    assert.throws(() => native.rgbaToI420(pixels, yuv), TypeError, `rgbaToI420: ${name}`);
    if (ArrayBuffer.isView(pixels.data)) {
      assert.ok(
        pixels.data.every((byte) => byte === 7),
        `i420ToRgba wrote for ${name}`,
      );
    }
    if (ArrayBuffer.isView(yuv.data)) {
      assert.ok(
        yuv.data.every((byte) => byte === 128),
        `rgbaToI420 wrote for ${name}`,
      );
    }
  }
});

test("a getter that detaches the other frame's buffer is seen before any data is touched", () => {
  // The second frame's getters run after the first frame's data was read;
  // its pointer must not be taken until then (it would point at freed
  // memory, and the old length would still pass the size check).
  const size = 1024;
  const rgbaBuffer = new ArrayBuffer(size * size * 4);
  const i420Data = new Uint8Array(i420(size, size).data.length).fill(128);
  assert.throws(
    () =>
      native.rgbaToI420(
        { width: size, height: size, data: new Uint8Array(rgbaBuffer) },
        {
          width: size,
          get height() {
            rgbaBuffer.transfer(16);
            return size;
          },
          data: i420Data,
        },
      ),
    { name: 'TypeError', message: 'frame data has the wrong byteLength' },
  );
  assert.ok(
    i420Data.every((byte) => byte === 128),
    'the I420 destination was written',
  );

  const i420Buffer = new ArrayBuffer(i420Data.length);
  const rgbaData = new Uint8Array(size * size * 4).fill(7);
  assert.throws(
    () =>
      native.i420ToRgba(
        { width: size, height: size, data: new Uint8Array(i420Buffer) },
        {
          width: size,
          height: size,
          get data() {
            i420Buffer.transfer(16);
            return rgbaData;
          },
        },
      ),
    { name: 'TypeError', message: 'frame data has the wrong byteLength' },
  );
  assert.ok(
    rgbaData.every((byte) => byte === 7),
    'the RGBA destination was written',
  );
});

test('an empty frame is a no-op', () => {
  assert.equal(native.i420ToRgba(i420(0, 3), rgba(0, 3)), undefined);
  assert.equal(native.rgbaToI420(rgba(5, 0), i420(5, 0)), undefined);
});
