#include "yuv.h"

#include <cstdint>
#include <cstring>
#include <string>

#include "libyuv/convert_argb.h"
#include "util.h"

namespace wrtc {

namespace {

// A frame argument: its size and its `data` TypedArray, then (once both
// frames have been read) the bytes of that view, honouring its byteOffset,
// written to in place when it is the destination.
struct Frame {
  int width = 0;
  int height = 0;
  Napi::Value array;
  uint8_t* data = nullptr;
  size_t size = 0;
};

// Reads {width, height, data}: whole non-negative int32 sizes and a
// TypedArray. Returns false with an exception pending otherwise (a getter's
// own, or a TypeError). Doesn't touch the data yet: a later getter (the
// other frame's) could still detach or shrink its buffer.
bool ReadFrame(Napi::Env env, Napi::Value value, Frame* out) {
  if (!value.IsObject()) {
    ThrowTypeError(env, "expected a frame object");
    return false;
  }
  Napi::Object object = value.As<Napi::Object>();
  int* sizes[] = {&out->width, &out->height};
  const char* keys[] = {"width", "height"};
  for (int i = 0; i < 2; ++i) {
    Napi::Value size = SafeGet(object, keys[i]);
    if (env.IsExceptionPending()) {
      return false;
    }
    double number =
        size.IsNumber() ? size.As<Napi::Number>().DoubleValue() : -1;
    if (!(number >= 0 && number <= INT32_MAX) ||
        number != static_cast<int>(number)) {
      ThrowTypeError(env, std::string("invalid frame .") + keys[i]);
      return false;
    }
    *sizes[i] = static_cast<int>(number);
  }
  out->array = SafeGet(object, "data");
  if (env.IsExceptionPending()) {
    return false;
  }
  if (!out->array.IsTypedArray()) {
    ThrowTypeError(env, "expected frame .data to be a TypedArray");
    return false;
  }
  return true;
}

// The view's bytes as they are now. Runs no JS, so they stay valid for the
// rest of the call. A detached buffer has neither data nor length.
void ResolveData(Frame* frame) {
  auto array = frame->array.As<Napi::TypedArray>();
  auto* base = static_cast<uint8_t*>(array.ArrayBuffer().Data());
  frame->data = base == nullptr ? nullptr : base + array.ByteOffset();
  frame->size = base == nullptr ? 0 : array.ByteLength();
}

size_t I420Size(const Frame& frame) {
  const size_t chroma_w = (static_cast<size_t>(frame.width) + 1) / 2;
  const size_t chroma_h = (static_cast<size_t>(frame.height) + 1) / 2;
  return static_cast<size_t>(frame.width) * frame.height +
         2 * chroma_w * chroma_h;
}

size_t RgbaSize(const Frame& frame) {
  return static_cast<size_t>(frame.width) * frame.height * 4;
}

// Reads both frames and checks that their sizes agree with each other and
// with their data. Returns false with an exception pending otherwise.
bool GetFrames(const Napi::CallbackInfo& info,
               bool i420_first,
               Frame* i420,
               Frame* rgba) {
  Napi::Env env = info.Env();
  Frame* first = i420_first ? i420 : rgba;
  Frame* second = i420_first ? rgba : i420;
  // Every getter runs before any data pointer is taken.
  if (!ReadFrame(env, info[0], first) || !ReadFrame(env, info[1], second)) {
    return false;
  }
  ResolveData(first);
  ResolveData(second);
  if (i420->width != rgba->width || i420->height != rgba->height) {
    ThrowTypeError(env, "frame sizes differ");
    return false;
  }
  // The RGBA stride (width * 4) must fit libyuv's int.
  if (rgba->width > INT32_MAX / 4) {
    ThrowTypeError(env, "frame too wide");
    return false;
  }
  if (i420->size != I420Size(*i420) || rgba->size != RgbaSize(*rgba)) {
    ThrowTypeError(env, "frame data has the wrong byteLength");
    return false;
  }
  // Empty frames have nothing to convert (libyuv rejects them, and their
  // data pointer may be null). Callers get undefined, as from wrtc.
  return i420->width > 0 && i420->height > 0 && i420->data != nullptr &&
         rgba->data != nullptr;
}

// RGBA to I420 as wrtc 0.10.0 computes it: libyuv 1839 (libwebrtc M106)
// ABGRToI420, whose chroma rounding differs by architecture, so wrtc's
// output does too. Today's libyuv rounds chroma differently again (off by
// one in about a third of samples), so these reproduce the old row
// functions (row_common.cc's C versions, which its SIMD matched) instead.
// Luma is the same everywhere: BT.601 limited range, rounded.
//
// Pixels are read as 32-bit words (R in the low byte: every supported
// platform is little-endian), which lets the compiler vectorize the loops.
static_assert(__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__);

inline uint32_t Pixel(const uint8_t* rgba) {
  uint32_t pixel;
  std::memcpy(&pixel, rgba, sizeof pixel);
  return pixel;
}
inline int R(uint32_t pixel) {
  return pixel & 0xff;
}
inline int G(uint32_t pixel) {
  return (pixel >> 8) & 0xff;
}
inline int B(uint32_t pixel) {
  return (pixel >> 16) & 0xff;
}

void YRow(const uint8_t* rgba, uint8_t* y, int width) {
  for (int x = 0; x < width; ++x) {
    const uint32_t p = Pixel(rgba + 4 * x);
    y[x] = static_cast<uint8_t>((66 * R(p) + 129 * G(p) + 25 * B(p) + 0x1080) >>
                                8);
  }
}

#if defined(__x86_64__) || defined(__i386__)
// x86 (LIBYUV_ARGBTOUV_PAVGB and LIBYUV_RGBTOU_TRUNCATE): two rounding pair
// averages, vertical then horizontal, as pavgb does, then full coefficients
// without the +0.5.
inline int Average(int a, int b) {
  return (a + b + 1) >> 1;
}

// The chroma of a 2x2 block: `a`, `b` on the top row, `c`, `d` below.
inline void Chroma(uint32_t a,
                   uint32_t b,
                   uint32_t c,
                   uint32_t d,
                   uint8_t* u,
                   uint8_t* v) {
  const int r = Average(Average(R(a), R(c)), Average(R(b), R(d)));
  const int g = Average(Average(G(a), G(c)), Average(G(b), G(d)));
  const int bl = Average(Average(B(a), B(c)), Average(B(b), B(d)));
  *u = static_cast<uint8_t>((112 * bl - 74 * g - 38 * r + 0x8000) >> 8);
  *v = static_cast<uint8_t>((112 * r - 94 * g - 18 * bl + 0x8000) >> 8);
}
#else
// Arm: the rounded half sum of the block (twice its average), times half
// coefficients, rounded.
inline void Chroma(uint32_t a,
                   uint32_t b,
                   uint32_t c,
                   uint32_t d,
                   uint8_t* u,
                   uint8_t* v) {
  const int r = (R(a) + R(b) + R(c) + R(d) + 1) >> 1;
  const int g = (G(a) + G(b) + G(c) + G(d) + 1) >> 1;
  const int bl = (B(a) + B(b) + B(c) + B(d) + 1) >> 1;
  *u = static_cast<uint8_t>((56 * bl - 37 * g - 19 * r + 0x8080) >> 8);
  *v = static_cast<uint8_t>((56 * r - 47 * g - 9 * bl + 0x8080) >> 8);
}
#endif

// One row of chroma from two rows of pixels. An odd last column is a block
// with its pixels repeated, which gives exactly libyuv's edge formulas.
void UVRow(const uint8_t* row0,
           const uint8_t* row1,
           uint8_t* u,
           uint8_t* v,
           int width) {
  const int pairs = width / 2;
  for (int x = 0; x < pairs; ++x) {
    Chroma(Pixel(row0 + 8 * x), Pixel(row0 + 8 * x + 4), Pixel(row1 + 8 * x),
           Pixel(row1 + 8 * x + 4), u + x, v + x);
  }
  if (width & 1) {
    const uint32_t a = Pixel(row0 + 8 * pairs);
    const uint32_t c = Pixel(row1 + 8 * pairs);
    Chroma(a, a, c, c, u + pairs, v + pairs);
  }
}

}  // namespace

Napi::Value I420ToRgba(const Napi::CallbackInfo& info) {
  Frame i420;
  Frame rgba;
  if (!GetFrames(info, /*i420_first=*/true, &i420, &rgba)) {
    return info.Env().Undefined();
  }
  // The height may be INT32_MAX; the width is at most INT32_MAX / 4.
  const int chroma_w = (i420.width + 1) / 2;
  const size_t chroma_h = (static_cast<size_t>(i420.height) + 1) / 2;
  uint8_t* u = i420.data + static_cast<size_t>(i420.width) * i420.height;
  uint8_t* v = u + chroma_w * chroma_h;
  libyuv::I420ToABGR(i420.data, i420.width, u, chroma_w, v, chroma_w, rgba.data,
                     rgba.width * 4, i420.width, i420.height);
  return info.Env().Undefined();
}

Napi::Value RgbaToI420(const Napi::CallbackInfo& info) {
  Frame i420;
  Frame rgba;
  if (!GetFrames(info, /*i420_first=*/false, &i420, &rgba)) {
    return info.Env().Undefined();
  }
  // Rows and offsets in size_t: the height may be INT32_MAX. The width is
  // at most INT32_MAX / 4, so the per-row int arithmetic can't overflow.
  const int width = rgba.width;
  const size_t height = static_cast<size_t>(rgba.height);
  const size_t stride = static_cast<size_t>(width) * 4;
  const size_t chroma_w = (static_cast<size_t>(width) + 1) / 2;
  const size_t chroma_h = (height + 1) / 2;
  uint8_t* y = i420.data;
  uint8_t* u = y + static_cast<size_t>(width) * height;
  uint8_t* v = u + chroma_w * chroma_h;
  for (size_t row = 0; row < height; row += 2) {
    const uint8_t* row0 = rgba.data + stride * row;
    // ABGRToI420 subsamples the last row of an odd height with itself.
    const uint8_t* row1 = row + 1 < height ? row0 + stride : row0;
    YRow(row0, y + static_cast<size_t>(width) * row, width);
    if (row + 1 < height) {
      YRow(row1, y + static_cast<size_t>(width) * (row + 1), width);
    }
    const size_t chroma_row = chroma_w * (row / 2);
    UVRow(row0, row1, u + chroma_row, v + chroma_row, width);
  }
  return info.Env().Undefined();
}

}  // namespace wrtc
