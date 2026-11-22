// Runs nonstandard.i420ToRgba / rgbaToI420 against one implementation and
// prints the results as JSON. i420.test.ts runs it once per implementation,
// each in its own process: never load @roamhq/wrtc and our addon into the
// same process.
//
//   node i420-scenario.mjs wrtc|ours
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { errorName } from './errors.mjs';

/** Writes `text` to stdout synchronously (see nonstandard-scenario.mjs). */
function writeAll(text) {
  const bytes = Buffer.from(text);
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(1, bytes, written);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
    }
  }
}

const impl = process.argv[2];
const w =
  impl === 'wrtc'
    ? createRequire(import.meta.url)('@roamhq/wrtc')
    : await import('../../lib/index.ts');
const { i420ToRgba, rgbaToI420 } = w.nonstandard;

function outcome(fn) {
  try {
    const value = fn();
    return { ok: value === undefined ? null : value };
  } catch (error) {
    return { name: errorName(error) };
  }
}

const i420Size = (width, height) =>
  width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);

/** Deterministic noise (xorshift32), so every byte value and SIMD lane is hit. */
function noise(length, seed) {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/** Small outputs in full (a readable diff), large ones as a hash. */
const summary = (data) =>
  data.length <= 4096
    ? Array.from(data)
    : createHash('sha256')
        .update(Buffer.from(data.buffer, data.byteOffset, data.length))
        .digest('hex');

const out = {};

// --- Known colours: RGBA -> I420 -> RGBA on a 2x2 frame --------------------
const colours = {
  red: [255, 0, 0, 255],
  green: [0, 255, 0, 255],
  blue: [0, 0, 255, 255],
  white: [255, 255, 255, 255],
  black: [0, 0, 0, 255],
  'grey, alpha 0': [128, 128, 128, 0],
  'orange, alpha 77': [255, 165, 0, 77],
};
out.colours = {};
for (const [name, rgba] of Object.entries(colours)) {
  const pixels = new Uint8ClampedArray(16);
  for (let i = 0; i < 4; i++) pixels.set(rgba, i * 4);
  const i420 = new Uint8ClampedArray(6);
  rgbaToI420({ width: 2, height: 2, data: pixels }, { width: 2, height: 2, data: i420 });
  const back = new Uint8ClampedArray(16);
  i420ToRgba({ width: 2, height: 2, data: i420 }, { width: 2, height: 2, data: back });
  out.colours[name] = { i420: Array.from(i420), rgba: Array.from(back.subarray(0, 4)) };
}

// --- Every Y value at neutral chroma, and the chroma extremes --------------
out.lumaRamp = (() => {
  const width = 256;
  const i420 = new Uint8Array(i420Size(width, 1)).fill(128);
  for (let y = 0; y < width; y++) i420[y] = y;
  const rgba = new Uint8Array(width * 4);
  i420ToRgba({ width, height: 1, data: i420 }, { width, height: 1, data: rgba });
  return Array.from(rgba);
})();
out.chromaGrid = (() => {
  // 32x32 chroma samples: U and V each in steps of 8 (0..248), Y 128.
  const width = 64;
  const height = 64;
  const i420 = new Uint8Array(i420Size(width, height)).fill(128);
  const u = i420.subarray(width * height, width * height + 32 * 32);
  const v = i420.subarray(width * height + 32 * 32);
  for (let row = 0; row < 32; row++) {
    for (let col = 0; col < 32; col++) {
      u[row * 32 + col] = col * 8;
      v[row * 32 + col] = row * 8;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  i420ToRgba({ width, height, data: i420 }, { width, height, data: rgba });
  return summary(rgba);
})();

// --- Noise at even, odd and HD sizes, both directions ----------------------
const sizes = [
  [1, 1],
  [2, 2],
  [3, 3],
  [5, 7],
  [17, 9],
  [33, 31],
  [64, 48],
  [319, 241],
  [1280, 720],
];
out.noise = {};
for (const [width, height] of sizes) {
  const seed = width * 65537 + height;
  const i420 = noise(i420Size(width, height), seed);
  const rgba = new Uint8ClampedArray(width * height * 4).fill(1);
  i420ToRgba({ width, height, data: i420 }, { width, height, data: rgba });
  const pixels = noise(width * height * 4, seed + 1);
  const yuv = new Uint8Array(i420Size(width, height)).fill(1);
  rgbaToI420({ width, height, data: pixels }, { width, height, data: yuv });
  out.noise[`${width}x${height}`] = { toRgba: summary(rgba), toI420: summary(yuv) };
}

// --- Calling convention ----------------------------------------------------
out.convention = (() => {
  const data = new Uint8ClampedArray(16).fill(9);
  const dest = { width: 2, height: 2, data };
  const source = { width: 2, height: 2, data: Uint8Array.from([81, 82, 83, 84, 90, 240]) };
  const result = i420ToRgba(source, dest);
  return {
    returns: result === undefined ? 'undefined' : typeof result,
    sameDataObject: dest.data === data,
    sameDest: Object.keys(dest),
    written: Array.from(data),
    sourceUntouched: Array.from(source.data),
  };
})();

// --- Accepted data types ---------------------------------------------------
const four = () => Uint8Array.from([16, 82, 145, 235, 90, 240]);
const dataTypes = {
  Uint8Array: () => new Uint8Array(16),
  Uint8ClampedArray: () => new Uint8ClampedArray(16),
  ArrayBuffer: () => new ArrayBuffer(16),
  Int16Array: () => new Int16Array(8),
  Float32Array: () => new Float32Array(4),
  DataView: () => new DataView(new ArrayBuffer(16)),
  Array: () => Array(16).fill(0),
};
out.destTypes = {};
for (const [name, make] of Object.entries(dataTypes)) {
  const data = make();
  const result = outcome(() =>
    i420ToRgba({ width: 2, height: 2, data: four() }, { width: 2, height: 2, data }),
  );
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : null;
  out.destTypes[name] = { result, written: bytes && Array.from(bytes) };
}
out.sourceTypes = {};
for (const [name, make] of Object.entries(dataTypes)) {
  const data = make();
  const view = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : null;
  view?.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 0]);
  const i420 = new Uint8Array(6);
  const result = outcome(() =>
    rgbaToI420({ width: 2, height: 2, data }, { width: 2, height: 2, data: i420 }),
  );
  out.sourceTypes[name] = { result, written: Array.from(i420) };
}

// --- Errors ----------------------------------------------------------------
const rgba4 = () => new Uint8Array(4 * 4 * 4);
const yuv4 = () => new Uint8Array(24);
const frameCases = (layout) => {
  const ok = layout === 'i420' ? yuv4 : rgba4;
  const len = layout === 'i420' ? 24 : 64;
  return {
    undefined: undefined,
    null: null,
    string: 'frame',
    'empty object': {},
    'width string': { width: '4', height: 4, data: ok() },
    'no height': { width: 4, data: ok() },
    'no data': { width: 4, height: 4 },
    'data array': { width: 4, height: 4, data: Array(len).fill(0) },
    'data DataView': { width: 4, height: 4, data: new DataView(new ArrayBuffer(len)) },
    'width fractional': { width: 4.5, height: 4, data: ok() },
    'width NaN': { width: Number.NaN, height: 4, data: ok() },
    'width 2^31': { width: 2 ** 31, height: 4, data: ok() },
    'short data': { width: 4, height: 4, data: new Uint8Array(len - 1) },
    'long data': { width: 4, height: 4, data: new Uint8Array(len + 1) },
    'negative width': { width: -4, height: 4, data: ok() },
    'negative height': { width: 4, height: -3, data: ok() },
    'huge size': { width: 50000, height: 50000, data: ok() },
    'width and height errors': { width: 'x', height: null, data: 5 },
  };
};
const goodI420 = () => ({ width: 4, height: 4, data: yuv4() });
const goodRgba = () => ({ width: 4, height: 4, data: rgba4() });
out.errors = {};
for (const [name, frame] of Object.entries(frameCases('i420'))) {
  out.errors[`i420ToRgba source ${name}`] = outcome(() => i420ToRgba(frame, goodRgba()));
  out.errors[`rgbaToI420 dest ${name}`] = outcome(() => rgbaToI420(goodRgba(), frame));
}
for (const [name, frame] of Object.entries(frameCases('rgba'))) {
  out.errors[`i420ToRgba dest ${name}`] = outcome(() => i420ToRgba(goodI420(), frame));
  out.errors[`rgbaToI420 source ${name}`] = outcome(() => rgbaToI420(frame, goodI420()));
}
Object.assign(out.errors, {
  'no arguments': outcome(() => i420ToRgba()),
  'one argument': outcome(() => i420ToRgba(goodI420())),
  'both invalid: the first is reported': outcome(() =>
    i420ToRgba({ width: 4, height: 4, data: new Uint8Array(1) }, {}),
  ),
  'dimensions differ': outcome(() =>
    i420ToRgba({ width: 2, height: 8, data: yuv4() }, { width: 4, height: 4, data: rgba4() }),
  ),
  'dimensions differ, rgbaToI420': outcome(() =>
    rgbaToI420({ width: 4, height: 4, data: rgba4() }, { width: 8, height: 2, data: yuv4() }),
  ),
  'swapped arguments': outcome(() => i420ToRgba(goodRgba(), goodI420())),
  'zero size': outcome(() =>
    i420ToRgba(
      { width: 0, height: 0, data: new Uint8Array(0) },
      {
        width: 0,
        height: 0,
        data: new Uint8Array(0),
      },
    ),
  ),
  'zero width': outcome(() =>
    rgbaToI420(
      { width: 0, height: 5, data: new Uint8Array(0) },
      {
        width: 0,
        height: 5,
        data: new Uint8Array(0),
      },
    ),
  ),
  // A zero size makes a frame empty whatever the other size's sign.
  'zero by negative': outcome(() =>
    rgbaToI420(
      { width: 0, height: -3, data: new Uint8Array(0) },
      { width: 0, height: -3, data: new Uint8Array(0) },
    ),
  ),
  'negative by zero': outcome(() =>
    i420ToRgba(
      { width: -3, height: 0, data: new Uint8Array(0) },
      { width: -3, height: 0, data: new Uint8Array(0) },
    ),
  ),
  'zero by negative, with data': outcome(() =>
    i420ToRgba(
      { width: 0, height: -3, data: new Uint8Array(4) },
      { width: 0, height: -3, data: new Uint8Array(0) },
    ),
  ),
});

// Divergence: -1 x -1 wraps in wrtc's int arithmetic to 1 byte of I420 and
// 4 of RGBA, which then pass, and libyuv writes nothing. Ours throws.
out.negativeWrapped = (() => {
  const rgba = new Uint8Array(4).fill(7);
  const result = outcome(() =>
    i420ToRgba(
      { width: -1, height: -1, data: new Uint8Array(1) },
      {
        width: -1,
        height: -1,
        data: rgba,
      },
    ),
  );
  return { result, untouched: Array.from(rgba) };
})();

// Lengths at the int32 extremes, where wrtc's int products overflow (and
// its arm64 and x64 builds disagree). The data lengths (3 and 7) match no
// expected length: one that matched would make wrtc convert a huge frame
// and crash.
const M = 2 ** 31;
for (const [width, height] of [
  [-M, -M],
  [-M, M - 1],
  [M - 1, M - 1],
  [M - 1, -M],
  [-M, 1],
  [65536, 65536],
  [-65536, 65536],
]) {
  out.errors[`rgba ${width}x${height}`] = outcome(() =>
    rgbaToI420(
      { width, height, data: new Uint8Array(3) },
      { width, height, data: new Uint8Array(7) },
    ),
  );
  out.errors[`i420 ${width}x${height}`] = outcome(() =>
    i420ToRgba(
      { width, height, data: new Uint8Array(7) },
      { width, height, data: new Uint8Array(3) },
    ),
  );
}

// Detached buffers read as empty in wrtc: a byteLength error for a real
// frame, a no-op for an empty one.
const detachedBuffer = () => {
  const buffer = new ArrayBuffer(16);
  buffer.transfer();
  return buffer;
};
const detachedView = (length) => {
  const view = new Uint8Array(length);
  view.buffer.transfer();
  return view;
};
out.detached = {
  'view, 2x2': outcome(() =>
    i420ToRgba({ width: 2, height: 2, data: detachedView(6) }, goodRgba2()),
  ),
  'ArrayBuffer, 2x2': outcome(() =>
    i420ToRgba(
      { width: 2, height: 2, data: new Uint8Array(6) },
      {
        width: 2,
        height: 2,
        data: detachedBuffer(),
      },
    ),
  ),
  'view, 0x0': outcome(() =>
    i420ToRgba(
      { width: 0, height: 0, data: detachedView(6) },
      {
        width: 0,
        height: 0,
        data: new Uint8Array(0),
      },
    ),
  ),
  'ArrayBuffer, 0x0': outcome(() =>
    rgbaToI420(
      { width: 0, height: 0, data: detachedBuffer() },
      {
        width: 0,
        height: 0,
        data: new Uint8Array(0),
      },
    ),
  ),
};
function goodRgba2() {
  return { width: 2, height: 2, data: new Uint8Array(16) };
}

// wrtc reads a view's buffer, offset and length natively, ignoring
// overriding own properties.
out.overriddenView = (() => {
  const data = Uint8Array.from([235, 235, 235, 235, 128, 128]);
  Object.defineProperty(data, 'buffer', { value: new ArrayBuffer(99) });
  Object.defineProperty(data, 'byteOffset', { value: 3 });
  Object.defineProperty(data, 'byteLength', { value: 99 });
  const rgba = new Uint8Array(16);
  const result = outcome(() =>
    i420ToRgba({ width: 2, height: 2, data }, { width: 2, height: 2, data: rgba }),
  );
  return { result, written: Array.from(rgba) };
})();

// A getter on the second argument runs even when the first is invalid: wrtc
// converts both before reporting.
out.readOrder = (() => {
  const reads = [];
  const spy = (label, frame) =>
    new Proxy(frame, {
      get(target, key) {
        reads.push(`${label}.${String(key)}`);
        return target[key];
      },
    });
  const result = outcome(() =>
    i420ToRgba(spy('a', { width: 'x', height: 4, data: yuv4() }), spy('b', goodRgba())),
  );
  return { result, reads };
})();

// --- Divergence: views with a byteOffset -----------------------------------
// wrtc checks and converts the whole underlying ArrayBuffer from offset 0.
out.offsetView = (() => {
  const backing = new Uint8Array(30).fill(128);
  const source = backing.subarray(3, 27); // a 4x4 I420 frame
  const rgba = new Uint8Array(64);
  const result = outcome(() =>
    i420ToRgba({ width: 4, height: 4, data: source }, { width: 4, height: 4, data: rgba }),
  );
  return { result, written: Array.from(rgba.subarray(0, 4)) };
})();

writeAll(JSON.stringify(out));
// wrtc's own threads keep its process alive.
if (impl === 'wrtc') process.exit(0);
