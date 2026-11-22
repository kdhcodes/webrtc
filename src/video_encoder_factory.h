// The video encoder factory: VP8, VP9 and AV1 (no H264 or H265; see
// runtime.cc), each encoder wrapped in a SimulcastEncoderAdapter, as
// libwebrtc's CreateBuiltinVideoEncoderFactory() does (that function isn't
// in libwebrtc's static library target) and as Chrome's encoders are.
//
// Why: without the adapter, a codec that can't encode the requested simulcast
// in one encoder fails InitEncode with ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED
// and nothing falls back to one encoder per layer. That broke:
//   - AV1 simulcast with scalabilityMode (libaom has no native simulcast): no
//     frames on any layer;
//   - VP8 simulcast whose layers have different maxFramerate (libvpx's native
//     simulcast needs one frame rate): libwebrtc switched the sender to VP9
//     with a single layer.
// With it, the adapter passes through to the codec's native simulcast (or a
// single layer) when that works, and otherwise runs one encoder per layer.
#pragma once

#include <memory>

#include "api/video_codecs/video_encoder_factory.h"

namespace wrtc {

std::unique_ptr<webrtc::VideoEncoderFactory> CreateVideoEncoderFactory();

}  // namespace wrtc
