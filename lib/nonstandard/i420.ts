import { mustBe } from '../internal/errors.ts';
import { native } from '../internal/native.ts';
import type { NativeFrameBuffer } from '../internal/native-types.ts';
import {
  bytes,
  type Converted,
  type FrameLayout,
  frameError,
  frameSize,
  isObjectLike,
  member,
  memberValue,
  throwFirstError,
} from './convert.ts';

/**
 * A frame for the conversion helpers: I420 (tightly packed, chroma planes
 * `ceil(width / 2)` by `ceil(height / 2)`) or RGBA (4 bytes per pixel, R,
 * G, B, A in memory). Like wrtc, `data` may be any TypedArray or an
 * ArrayBuffer at runtime.
 */
export interface RTCFrameBuffer {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/**
 * Converts one argument as wrtc's ImageData converter does: the object's
 * `width`, `height` and `data`, the first failure's message, then the size
 * and byte length checks. Unlike wrtc, the view's byteOffset and
 * byteLength are honoured (as in `onFrame`). `name` is e.g.
 * "i420ToRgba: rgba".
 */
function frame(value: unknown, name: string, layout: FrameLayout): Converted<NativeFrameBuffer> {
  if (!isObjectLike(value)) {
    return { ok: false, message: () => mustBe(name, 'an object {width, height, data}', value) };
  }
  const width = member(value, name, 'width', frameSize);
  const height = member(value, name, 'height', frameSize);
  const data = member(value, name, 'data', bytes);
  for (const m of [width, height, data]) {
    if (!m.ok) return { ok: false, message: m.message };
  }
  const w = memberValue(width);
  const h = memberValue(height);
  const view = memberValue(data);
  const error = frameError(name, layout, w, h, view);
  if (error) return { ok: false, message: () => error };
  return { ok: true, value: { width: w, height: h, data: view } };
}

/**
 * Validates both arguments as wrtc does: each is converted in full, then
 * the first error is thrown (a TypeError), then the sizes must match.
 * Returns false when there is nothing to convert (an empty frame), as wrtc
 * hands that to libyuv, which does nothing.
 */
function convertible(
  api: string,
  [sourceName, source]: [string, Converted<NativeFrameBuffer>],
  [destName, dest]: [string, Converted<NativeFrameBuffer>],
) {
  throwFirstError(source, dest);
  const { width, height } = memberValue(source);
  const out = memberValue(dest);
  if (width !== out.width || height !== out.height) {
    throw new TypeError(
      `${api}: ${sourceName} is ${width}x${height} but ${destName} is ${out.width}x${out.height}; ` +
        'both frames must be the same size',
    );
  }
  return width > 0 && height > 0;
}

/**
 * Converts an I420 frame to RGBA (libyuv I420ToABGR: BT.601, limited range;
 * alpha 255), writing into `rgba.data`. Synchronous; returns undefined.
 */
export function i420ToRgba(i420: RTCFrameBuffer, rgba: RTCFrameBuffer): void {
  const source = frame(i420, 'i420ToRgba: i420', 'I420');
  const dest = frame(rgba, 'i420ToRgba: rgba', 'RGBA');
  if (convertible('i420ToRgba', ['i420', source], ['rgba', dest])) {
    native.i420ToRgba(memberValue(source), memberValue(dest));
  }
}

/**
 * Converts an RGBA frame to I420 (BT.601, limited range; alpha ignored;
 * each chroma sample averages its 2x2 block, or the 1 or 2 pixels at an
 * odd edge), writing into `i420.data`. Synchronous; returns undefined. The
 * bytes are wrtc's: its libyuv ABGRToI420's chroma rounding, which differs
 * between arm and x86, reproduced natively (src/yuv.cc).
 */
export function rgbaToI420(rgba: RTCFrameBuffer, i420: RTCFrameBuffer): void {
  const source = frame(rgba, 'rgbaToI420: rgba', 'RGBA');
  const dest = frame(i420, 'rgbaToI420: i420', 'I420');
  if (convertible('rgbaToI420', ['rgba', source], ['i420', dest])) {
    native.rgbaToI420(memberValue(source), memberValue(dest));
  }
}
