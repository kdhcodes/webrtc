/**
 * Argument conversion for the nonstandard API, with wrtc's rules (node-webrtc
 * `src/converters/napi.cc`, `src/converters/object.hh`): what is accepted,
 * what throws, and the order members are read in. Dictionaries read every
 * member in order and report the first member's error, as wrtc's
 * applicative validation does. All errors are TypeErrors.
 *
 * The messages are ours, not wrtc's (SPEC-LAYER-PLAN.md, "wrtc
 * compatibility spec"): each names the API and the field, says what was
 * expected and what was given, e.g. "RTCVideoSource.onFrame: frame.width
 * must be a number from 0 to 2147483647, not the string "640"".
 */
import { article, describe, mustBe } from '../internal/errors.ts';
import type { NativeTrack } from '../internal/native-types.ts';
import { nativeTrackOf } from '../MediaStreamTrack.ts';

// Not an import, for import time (see lib/internal/addon-path.ts).
const { isArrayBuffer, isTypedArray } = process.getBuiltinModule('node:util/types');

/**
 * A member's converted value, or why it failed. The message is built only
 * when it's thrown, after every member has been read, so building it can
 * never change what a call reads (and describe() runs no user code anyway).
 */
export type Converted<T> = { ok: true; value: T } | { ok: false; message: () => string };

/** A member converter: the value, or what the value should have been. */
export type Converter<T> = (
  value: unknown,
) => { ok: true; value: T } | { ok: false; expected: string };

/** The largest C `int`: libwebrtc and libyuv size frames and rows with it. */
export const INT_MAX = 0x7fffffff;

/** "1 byte", "2 bytes". */
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** Throws unless `value` is an object (functions count, as in wrtc). */
export function expectObject(
  value: unknown,
  name: string,
  expected: string,
): Record<string, unknown> {
  if (!isObjectLike(value)) throw new TypeError(mustBe(name, expected, value));
  return value;
}

/**
 * Reads `object[key]` once and converts it; a throwing getter propagates.
 * `name` is the object's, e.g. "RTCVideoSource.onFrame: frame".
 */
export function member<T>(
  object: Record<string, unknown>,
  name: string,
  key: string,
  convert: Converter<T>,
): Converted<T> {
  // A throwing getter propagates unchanged and stops the read, as in wrtc
  // (its converters rethrow the getter's own exception).
  const value = object[key];
  const result = convert(value);
  if (result.ok) return result;
  const { expected } = result;
  return { ok: false, message: () => mustBe(`${name}.${key}`, expected, value) };
}

/** `convert`, saying `expected` when it fails. */
export function expecting<T>(convert: Converter<T>, expected: string): Converter<T> {
  return (value) => {
    const result = convert(value);
    return result.ok ? result : { ok: false, expected };
  };
}

/** Like member(), but `undefined` gives `fallback`. */
export function optional<T, F>(
  object: Record<string, unknown>,
  name: string,
  key: string,
  convert: Converter<T>,
  fallback: F,
): Converted<T | F> {
  return member<T | F>(object, name, key, (value) =>
    value === undefined ? { ok: true, value: fallback } : convert(value),
  );
}

/** Throws the first failed member's message, in argument order. */
export function throwFirstError(...members: Converted<unknown>[]): void {
  for (const m of members) {
    if (!m.ok) throw new TypeError(m.message());
  }
}

/** The value of a member already checked by throwFirstError(). */
export function memberValue<T>(m: Converted<T>): T {
  if (!m.ok) throw new TypeError(m.message());
  return m.value;
}

// wrtc checks `typeof === number` and the range on the double, then
// truncates (so 8000.7 is 8000 and NaN is 0).
function unsigned(max: number): Converter<number> {
  const expected = `a number from 0 to ${max}`;
  return (value) =>
    typeof value !== 'number' || value < 0 || value > max
      ? { ok: false, expected }
      : { ok: true, value: value >>> 0 };
}

export const uint8: Converter<number> = unsigned(0xff);
export const uint16: Converter<number> = unsigned(0xffff);

/**
 * A frame's width or height: wrtc's int32 conversion (a number in the int32
 * range, truncated toward zero; NaN is 0). A negative size passes here, as
 * in wrtc; frameError() decides what it means.
 */
export const frameSize: Converter<number> = (value) =>
  // Written so that NaN passes the range check, as in wrtc.
  typeof value !== 'number' || value < -0x80000000 || value > INT_MAX
    ? { ok: false, expected: `a number from 0 to ${INT_MAX}` }
    : { ok: true, value: value | 0 };

// The built-in accessors, captured at load time: like wrtc (which reads
// them natively), a view's own or inherited `buffer`, `byteOffset` and
// `byteLength` overrides are ignored.
const accessor = (proto: object, name: string) =>
  Object.getOwnPropertyDescriptor(proto, name)?.get as (this: unknown) => never;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const viewBuffer: (this: unknown) => ArrayBufferLike = accessor(typedArrayPrototype, 'buffer');
const viewByteOffset: (this: unknown) => number = accessor(typedArrayPrototype, 'byteOffset');
const viewByteLength: (this: unknown) => number = accessor(typedArrayPrototype, 'byteLength');
const bufferByteLength: (this: unknown) => number = accessor(ArrayBuffer.prototype, 'byteLength');
const bufferDetached: (this: unknown) => boolean = accessor(ArrayBuffer.prototype, 'detached');

/** What the messages need of a view: its length (bytes() views, or a stand-in in tests). */
type ByteLength = Pick<Uint8Array, 'byteLength'>;

/** What bytes() gives for a detached buffer: empty, and recognisable for messages. */
const DETACHED = new Uint8Array(0);

/** Whether bytes() found this view's buffer detached. */
export const isDetached = (view: ByteLength): boolean => view === DETACHED;

/** "has 3 bytes", or "is detached (0 bytes)". */
export function hasBytes(view: ByteLength): string {
  return isDetached(view) ? 'is detached (0 bytes)' : `has ${count(view.byteLength, 'byte')}`;
}

/**
 * wrtc accepts any TypedArray (not a DataView) or an ArrayBuffer. It then
 * reads the whole underlying buffer from offset 0; we honour the view's
 * byteOffset and byteLength instead (an accepted divergence). A detached
 * buffer (or a view now out of its buffer's bounds) is empty, so a
 * non-empty frame fails its byte length check and an empty one is
 * accepted, as in wrtc.
 */
export const bytes: Converter<Uint8Array> = (value) => {
  if (isTypedArray(value)) {
    const length = viewByteLength.call(value);
    const buffer = viewBuffer.call(value);
    if (length === 0) return { ok: true, value: emptyView(buffer) };
    return { ok: true, value: new Uint8Array(buffer, viewByteOffset.call(value), length) };
  }
  if (isArrayBuffer(value)) {
    if (bufferByteLength.call(value) === 0) return { ok: true, value: emptyView(value) };
    return { ok: true, value: new Uint8Array(value) };
  }
  return { ok: false, expected: 'a TypedArray (such as a Uint8Array) or an ArrayBuffer' };
};

const emptyView = (buffer: ArrayBufferLike): Uint8Array =>
  isArrayBuffer(buffer) && bufferDetached.call(buffer) ? DETACHED : new Uint8Array(0);

export type FrameLayout = 'I420' | 'RGBA';

/**
 * The byte length of a w x h frame, for sizes frameSize() accepted: I420
 * is tightly packed (chroma planes `ceil(w / 2)` x `ceil(h / 2)`), RGBA 4
 * bytes per pixel. Exact up to 2^53, so for every frame frameError() lets
 * past its size check.
 */
export function frameLength(layout: FrameLayout, width: number, height: number): number {
  return layout === 'I420'
    ? width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2)
    : width * height * 4;
}

/**
 * Why a w x h frame with `data` can't be used, or undefined. `name` is the
 * frame's, e.g. "RTCVideoSource.onFrame: frame".
 *
 * - A frame with a zero width or height is empty, whatever the sign of the
 *   other: its data must be empty, and it does nothing (wrtc's int length
 *   arithmetic gave such frames a length of 0 too).
 * - Otherwise a negative width or height is a TypeError. wrtc ran negative
 *   sizes through its C `int` arithmetic and threw for nearly all of them;
 *   the few whose wrapped lengths matched (-1 x -1 with 1 byte of I420 and
 *   4 of RGBA) it accepted and did nothing with. A recorded divergence.
 * - Then the size: wrtc computed lengths in C `int`, so its length check
 *   only ever accepted a buffer of the true size when the I420 length (for
 *   RGBA, the pixel count) fits an int. Past that its arithmetic wrapped,
 *   and it threw for every buffer except one whose size happened to match
 *   the wrapped length, which it then overran and crashed. Rejecting those
 *   sizes up front changes no outcome except the crashes. The same goes for
 *   an RGBA frame whose row (width × 4 bytes) overflows libyuv's int
 *   stride: wrtc passed it on and overflowed it.
 * - Then the length, e.g. "RTCVideoSource.onFrame: frame.data has 1000
 *   bytes, but a 640x480 I420 frame needs 460800 (a 640x480 Y plane, then
 *   320x240 U and V planes)".
 *
 * Builds no message from user values, only from numbers.
 */
export function frameError(
  name: string,
  layout: FrameLayout,
  width: number,
  height: number,
  data: ByteLength,
): string | undefined {
  if (width === 0 || height === 0) {
    if (data.byteLength === 0) return undefined;
    return `${name}.data ${hasBytes(data)}, but a ${width}x${height} frame is empty and needs 0`;
  }
  if (width < 0 || height < 0) {
    const [key, size] = width < 0 ? ['width', width] : ['height', height];
    return `${name}.${key} is ${size}, but a frame's width and height can't be negative`;
  }
  const tooLarge = `${name} is ${width}x${height}, which is too large`;
  if (layout === 'I420' && frameLength(layout, width, height) > INT_MAX) {
    const [w, h] = [BigInt(width), BigInt(height)];
    const exact = w * h + 2n * ((w + 1n) / 2n) * ((h + 1n) / 2n);
    return `${tooLarge}: an I420 frame can be at most ${INT_MAX} bytes, and this one would need ${exact}`;
  }
  if (layout === 'RGBA' && width * height > INT_MAX) {
    return `${tooLarge}: an RGBA frame can have at most ${INT_MAX} pixels`;
  }
  const maxRgbaWidth = Math.floor(INT_MAX / 4);
  if (layout === 'RGBA' && width > maxRgbaWidth) {
    return (
      `${tooLarge}: an RGBA frame can be at most ${maxRgbaWidth} pixels wide (a row, ` +
      `width × 4 bytes, must fit in ${INT_MAX})`
    );
  }
  const expected = frameLength(layout, width, height);
  if (data.byteLength === expected) return undefined;
  const layoutOf =
    layout === 'I420'
      ? `a ${width}x${height} Y plane, then ${Math.ceil(width / 2)}x${Math.ceil(height / 2)} U and V planes`
      : '4 bytes per pixel';
  return (
    `${name}.data ${hasBytes(data)}, but a ${width}x${height} ${layout} frame needs ` +
    `${expected} (${layoutOf})`
  );
}

/**
 * A sink's track argument (`api` is "RTCAudioSink" or "RTCVideoSink"). Not
 * an object and not one of our tracks are both TypeErrors, as in wrtc.
 */
export function sinkTrack(track: unknown, kind: 'audio' | 'video', api: string): NativeTrack {
  const handle = isObjectLike(track) ? nativeTrackOf(track) : undefined;
  if (!handle) {
    const ours =
      "this library (getUserMedia(), a source's createTrack(), or a peer connection's track event)";
    // Another library's track (wrtc's, say), or one of ours faked.
    if (describe(track) === 'a MediaStreamTrack') {
      throw new TypeError(
        `${api}: track is a MediaStreamTrack from another library; it must come from ${ours}`,
      );
    }
    throw new TypeError(mustBe(`${api}: track`, `a MediaStreamTrack from ${ours}`, track));
  }
  if (handle.kind !== kind) {
    const other = kind === 'audio' ? 'RTCVideoSink' : 'RTCAudioSink';
    throw new TypeError(
      `${api}: track is ${article(handle.kind)} track, but ${api} needs ${article(kind)} ` +
        `track (use ${other} for ${handle.kind})`,
    );
  }
  return handle;
}
