// i420ToRgba / rgbaToI420, for wrtc's nonstandard helpers. BT.601 limited
// range; "RGBA" is R, G, B, A in memory, and the RGBA output's alpha is 255.
//
// i420ToRgba is libyuv I420ToABGR, as in wrtc (libyuv names are reversed
// relative to memory byte order, so the RGBA-named functions would scramble
// channels). rgbaToI420 is our own loops reproducing wrtc's libyuv
// ABGRToI420, whose chroma rounding today's libyuv no longer matches (see
// yuv.cc).
#pragma once

#include <napi.h>

namespace wrtc {

// i420ToRgba({width, height, data}, {width, height, data}): converts into
// the second frame's data, synchronously, and returns undefined. The JS
// layer validates with wrtc's messages first. These checks keep any call
// from touching memory outside the views: every getter of both frames runs
// before either view's data pointer is taken, so a getter that detaches or
// shrinks a buffer is seen.
Napi::Value I420ToRgba(const Napi::CallbackInfo& info);
// rgbaToI420({width, height, data}, {width, height, data}): likewise.
Napi::Value RgbaToI420(const Napi::CallbackInfo& info);

}  // namespace wrtc
