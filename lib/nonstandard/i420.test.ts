// i420ToRgba / rgbaToI420: validation (wrtc's rules, our messages) and the
// conversions themselves (native). test/compat/i420.test.ts compares the
// output with @roamhq/wrtc byte for byte; these pin known values.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { i420ToRgba, rgbaToI420 } from './i420.ts';

/** wrtc's chroma rounding differs by architecture (see src/yuv.cc). */
const arm = process.arch === 'arm64' || process.arch === 'arm';

const i420Size = (w: number, h: number) => w * h + 2 * Math.ceil(w / 2) * Math.ceil(h / 2);

/** A w x h RGBA frame filled with one colour. */
function solid(w: number, h: number, rgba: number[]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}

/** `'<name>: <message>'` of what `fn` throws, or `'no error'`. */
function errorOf(fn: () => unknown): string {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

test('rgbaToI420 converts known colours to BT.601 limited range, as wrtc does', () => {
  const cases: [string, number[], number[]][] = [
    ['red', [255, 0, 0, 255], [82, 90, arm ? 240 : 239]],
    ['green', [0, 255, 0, 255], [144, 54, 34]],
    ['blue', [0, 0, 255, 255], [41, arm ? 240 : 239, 110]],
    ['white', [255, 255, 255, 255], [235, 128, 128]],
    ['black', [0, 0, 0, 255], [16, 128, 128]],
    ['grey, alpha ignored', [128, 128, 128, 0], [126, 128, 128]],
  ];
  const actual = cases.map(([name, rgba]) => {
    const i420 = new Uint8Array(6);
    rgbaToI420(solid(2, 2, rgba), { width: 2, height: 2, data: i420 });
    return [name, Array.from(i420)];
  });
  const expected = cases.map(([name, , [y, u, v]]) => [name, [y, y, y, y, u, v]]);
  assert.deepEqual(actual, expected);
});

test('i420ToRgba maps luma 16..235 to 0..255 with opaque alpha, in R, G, B, A order', () => {
  const levels = [0, 16, 128, 235, 255];
  const actual = levels.map((y) => {
    const rgba = new Uint8Array(16);
    i420ToRgba(
      { width: 2, height: 2, data: Uint8Array.from([y, y, y, y, 128, 128]) },
      {
        width: 2,
        height: 2,
        data: rgba,
      },
    );
    return Array.from(rgba.subarray(0, 4));
  });
  assert.deepEqual(actual, [
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [130, 130, 130, 255],
    [255, 255, 255, 255],
    [255, 255, 255, 255],
  ]);
});

// wrtc's x64 build itself loses 4 levels of pure blue.
test('known colours survive a round trip within 4 levels per channel', () => {
  for (const colour of [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
    [0, 0, 0],
    [200, 120, 40],
  ]) {
    const i420 = { width: 2, height: 2, data: new Uint8Array(6) };
    rgbaToI420(solid(2, 2, [...colour, 255]), i420);
    const back = new Uint8ClampedArray(16);
    i420ToRgba(i420, { width: 2, height: 2, data: back });
    const pixel = Array.from(back.subarray(0, 4));
    assert.equal(pixel[3], 255, `${colour}: alpha`);
    for (let c = 0; c < 3; c++) {
      assert.ok(
        Math.abs((pixel[c] as number) - (colour[c] as number)) <= 4,
        `${colour} -> ${pixel}`,
      );
    }
  }
});

test('odd sizes: the last chroma column and row come from their own pixels', () => {
  // 3x3: white everywhere except a black last column and a red last row.
  // The red corner is in both.
  const frame = solid(3, 3, [255, 255, 255, 255]);
  for (const i of [2, 5]) frame.data.set([0, 0, 0, 255], i * 4);
  for (const i of [6, 7, 8]) frame.data.set([255, 0, 0, 255], i * 4);
  const i420 = new Uint8Array(i420Size(3, 3));
  rgbaToI420(frame, { width: 3, height: 3, data: i420 });
  const u = Array.from(i420.subarray(9, 13));
  const v = Array.from(i420.subarray(13, 17));
  // Chroma 2x2 grid: [white, black] over [red, red].
  assert.deepEqual(u, [128, 128, 90, 90]);
  assert.deepEqual(v, [128, 128, arm ? 240 : 239, arm ? 240 : 239]);
  assert.deepEqual(Array.from(i420.subarray(0, 9)), [235, 235, 16, 235, 235, 16, 82, 82, 82]);
});

test('converts in place into the destination data and returns undefined', () => {
  const source = Uint8Array.from([81, 82, 83, 84, 90, 240]);
  const data = new Uint8ClampedArray(16).fill(9);
  const dest = { width: 2, height: 2, data };
  assert.equal(i420ToRgba({ width: 2, height: 2, data: source }, dest), undefined);
  assert.equal(dest.data, data);
  assert.ok(
    Array.from(data).every((byte, i) => (i % 4 === 3 ? byte === 255 : byte !== 9)),
    `every byte written: ${data}`,
  );
  assert.deepEqual(Array.from(source), [81, 82, 83, 84, 90, 240]);
});

test('data may be any TypedArray or an ArrayBuffer, as in wrtc', () => {
  const dest = new ArrayBuffer(16);
  i420ToRgba(
    { width: 2, height: 2, data: Uint8Array.from([235, 235, 235, 235, 128, 128]) },
    {
      width: 2,
      height: 2,
      data: dest as unknown as Uint8Array,
    },
  );
  assert.deepEqual(Array.from(new Uint8Array(dest, 0, 4)), [255, 255, 255, 255]);
  const i420 = new Int16Array(3);
  rgbaToI420(solid(2, 2, [0, 0, 0, 255]), { width: 2, height: 2, data: i420 as never });
  assert.deepEqual(Array.from(new Uint8Array(i420.buffer)), [16, 16, 16, 16, 128, 128]);
});

test("a view's byteOffset is honoured: only the view is read and written (wrtc: the whole buffer)", () => {
  const backing = new Uint8Array(30).fill(7);
  const i420 = backing.subarray(3, 27);
  rgbaToI420(solid(4, 4, [255, 255, 255, 255]), { width: 4, height: 4, data: i420 });
  assert.deepEqual(Array.from(backing.subarray(0, 3)), [7, 7, 7]);
  assert.deepEqual(Array.from(backing.subarray(27)), [7, 7, 7]);
  assert.ok(i420.subarray(0, 16).every((y) => y === 235));
});

test('empty frames are no-ops, whatever the sign of the other size (as in wrtc)', () => {
  const empty = { width: 0, height: 0, data: new Uint8Array(0) };
  assert.equal(i420ToRgba(empty, { ...empty }), undefined);
  const negative = { width: 0, height: -3, data: new Uint8Array(0) };
  assert.equal(rgbaToI420(negative, { ...negative }), undefined);
  assert.equal(
    i420ToRgba({ ...negative, width: -3, height: 0 }, { ...negative, width: -3, height: 0 }),
    undefined,
  );
  assert.equal(
    rgbaToI420(
      { width: 0, height: 5, data: new Uint8Array(0) },
      {
        width: 0,
        height: 5,
        data: new Uint8Array(0),
      },
    ),
    undefined,
  );
});

// A divergence: in wrtc's C int arithmetic -1 x -1 is 1 byte of I420 and 4
// of RGBA, which it accepted and did nothing with. Any negative width or
// height of a non-empty frame is now a TypeError.
test('negative sizes are TypeErrors, even ones whose length wrapped to match in wrtc', () => {
  const rgba = new Uint8Array(4).fill(7);
  assert.throws(
    () =>
      i420ToRgba(
        { width: -1, height: -1, data: new Uint8Array(1) },
        { width: -1, height: -1, data: rgba },
      ),
    {
      name: 'TypeError',
      message: "i420ToRgba: i420.width is -1, but a frame's width and height can't be negative",
    },
  );
  assert.deepEqual(Array.from(rgba), [7, 7, 7, 7]);
});

test('a detached buffer reads as empty, as in wrtc: an error for a real frame, a no-op for an empty one', () => {
  const detached = (length: number) => {
    const view = new Uint8Array(length);
    view.buffer.transfer();
    return view;
  };
  assert.throws(
    () =>
      i420ToRgba(
        { width: 2, height: 2, data: detached(6) },
        {
          width: 2,
          height: 2,
          data: new Uint8Array(16),
        },
      ),
    {
      name: 'TypeError',
      message:
        'i420ToRgba: i420.data is detached (0 bytes), but a 2x2 I420 frame needs 6 ' +
        '(a 2x2 Y plane, then 1x1 U and V planes)',
    },
  );
  assert.equal(
    rgbaToI420(
      { width: 0, height: 0, data: detached(4) },
      {
        width: 0,
        height: 0,
        data: new Uint8Array(0),
      },
    ),
    undefined,
  );
});

test('bad frames throw TypeErrors (as in wrtc) that name the function and the field', () => {
  const rgba4 = () => ({ width: 4, height: 4, data: new Uint8Array(64) });
  const i4204 = () => ({ width: 4, height: 4, data: new Uint8Array(24) });
  const cases: [string, () => unknown, string][] = [
    [
      'no arguments',
      () => (i420ToRgba as () => void)(),
      'i420ToRgba: i420 is missing: it must be an object {width, height, data}',
    ],
    [
      'null source',
      () => i420ToRgba(null as never, rgba4()),
      'i420ToRgba: i420 must be an object {width, height, data}, not null',
    ],
    [
      'width string',
      () => i420ToRgba({ ...i4204(), width: '4' as never }, rgba4()),
      'i420ToRgba: i420.width must be a number from 0 to 2147483647, not the string "4"',
    ],
    [
      'width 2^31',
      () => rgbaToI420({ ...rgba4(), width: 2 ** 31 }, i4204()),
      'rgbaToI420: rgba.width must be a number from 0 to 2147483647, not 2147483648',
    ],
    [
      'no data',
      () => rgbaToI420(rgba4(), { width: 4, height: 4 } as never),
      'rgbaToI420: i420.data is missing: it must be a TypedArray (such as a Uint8Array) or an ArrayBuffer',
    ],
    [
      'DataView data',
      () => i420ToRgba({ ...i4204(), data: new DataView(new ArrayBuffer(24)) as never }, rgba4()),
      'i420ToRgba: i420.data must be a TypedArray (such as a Uint8Array) or an ArrayBuffer, not a DataView',
    ],
    [
      'short I420',
      () => i420ToRgba({ ...i4204(), data: new Uint8Array(23) }, rgba4()),
      'i420ToRgba: i420.data has 23 bytes, but a 4x4 I420 frame needs 24 (a 4x4 Y plane, then 2x2 U and V planes)',
    ],
    [
      'odd I420',
      () => i420ToRgba({ width: 3, height: 3, data: new Uint8Array(13) }, rgba4()),
      'i420ToRgba: i420.data has 13 bytes, but a 3x3 I420 frame needs 17 ' +
        '(a 3x3 Y plane, then 2x2 U and V planes)',
    ],
    [
      'long RGBA',
      () => rgbaToI420({ ...rgba4(), data: new Uint8Array(65) }, i4204()),
      'rgbaToI420: rgba.data has 65 bytes, but a 4x4 RGBA frame needs 64 (4 bytes per pixel)',
    ],
    [
      'negative I420',
      () => i420ToRgba({ ...i4204(), width: -4 }, rgba4()),
      "i420ToRgba: i420.width is -4, but a frame's width and height can't be negative",
    ],
    [
      'negative RGBA',
      () => i420ToRgba(i4204(), { ...rgba4(), height: -3 }),
      "i420ToRgba: rgba.height is -3, but a frame's width and height can't be negative",
    ],
    // Past wrtc's int arithmetic (whose result differed between its arm64
    // and x64 builds): wrtc threw too, for any data except a buffer that
    // matched its wrapped length, which crashed it.
    [
      'too large RGBA',
      () => rgbaToI420({ ...rgba4(), width: 50000, height: 50000 }, i4204()),
      'rgbaToI420: rgba is 50000x50000, which is too large: an RGBA frame can have at most ' +
        '2147483647 pixels',
    ],
    [
      'too large, with data matching wrtc arm64 wrapped lengths',
      () =>
        rgbaToI420(
          { width: 2147483647, height: 2147483647, data: new Uint8Array(4) },
          { width: 2147483647, height: 2147483647, data: new Uint8Array(1) },
        ),
      'rgbaToI420: rgba is 2147483647x2147483647, which is too large: an RGBA frame can have ' +
        'at most 2147483647 pixels',
    ],
    [
      'swapped arguments',
      () => i420ToRgba(rgba4(), i4204()),
      'i420ToRgba: i420.data has 64 bytes, but a 4x4 I420 frame needs 24 (a 4x4 Y plane, then 2x2 U and V planes)',
    ],
    [
      'both bad: the first argument wins',
      () => i420ToRgba({ ...i4204(), data: new Uint8Array(1) }, {} as never),
      'i420ToRgba: i420.data has 1 byte, but a 4x4 I420 frame needs 24 (a 4x4 Y plane, then 2x2 U and V planes)',
    ],
    [
      'sizes differ',
      () => rgbaToI420(rgba4(), { width: 8, height: 2, data: new Uint8Array(24) }),
      'rgbaToI420: rgba is 4x4 but i420 is 8x2; both frames must be the same size',
    ],
  ];
  const label = (name: string) => inspect(name);
  assert.deepEqual(
    cases.map(([name, fn]) => [label(name), errorOf(fn)]),
    cases.map(([name, , message]) => [label(name), `TypeError: ${message}`]),
  );
});

test('both arguments are read in full before the first error is thrown, as in wrtc', () => {
  const reads: string[] = [];
  const spy = (label: string, frame: object) =>
    new Proxy(frame, {
      get(target, key) {
        reads.push(`${label}.${String(key)}`);
        return Reflect.get(target, key);
      },
    }) as never;
  assert.throws(
    () =>
      i420ToRgba(
        spy('a', { width: 'x', height: 4, data: new Uint8Array(24) }),
        spy('b', {
          width: 4,
          height: 4,
          data: new Uint8Array(64),
        }),
      ),
    { name: 'TypeError', message: /^i420ToRgba: i420\.width / },
  );
  assert.deepEqual(reads, ['a.width', 'a.height', 'a.data', 'b.width', 'b.height', 'b.data']);
});

test('a throwing getter propagates its own exception', () => {
  const boom = new Error('boom');
  const frame = {
    width: 2,
    get height(): number {
      throw boom;
    },
    data: new Uint8Array(6),
  };
  assert.throws(() => i420ToRgba(frame, { width: 2, height: 2, data: new Uint8Array(16) }), boom);
});
