#include "video_encoder_factory.h"

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "api/environment/environment.h"
#include "api/video/resolution.h"
#include "api/video_codecs/sdp_video_format.h"
#include "api/video_codecs/video_encoder.h"
#include "api/video_codecs/video_encoder_factory_template.h"
#include "api/video_codecs/video_encoder_factory_template_libaom_av1_adapter.h"
#include "api/video_codecs/video_encoder_factory_template_libvpx_vp8_adapter.h"
#include "api/video_codecs/video_encoder_factory_template_libvpx_vp9_adapter.h"
#include "media/engine/simulcast_encoder_adapter.h"

namespace wrtc {
namespace {

// libwebrtc's BuiltinVideoEncoderFactory
// (api/video_codecs/builtin_video_encoder_factory.cc), over our codec set.
class SimulcastVideoEncoderFactory : public webrtc::VideoEncoderFactory {
 public:
  SimulcastVideoEncoderFactory()
      : internal_(std::make_unique<webrtc::VideoEncoderFactoryTemplate<
                      webrtc::LibvpxVp8EncoderTemplateAdapter,
                      webrtc::LibvpxVp9EncoderTemplateAdapter,
                      webrtc::LibaomAv1EncoderTemplateAdapter>>()) {}

  std::unique_ptr<webrtc::VideoEncoder> Create(
      const webrtc::Environment& env,
      const webrtc::SdpVideoFormat& format) override {
    // The adapter passes through when simulcast isn't used or the codec
    // does it natively, so every encoder can go through it.
    if (!format.IsCodecInList(internal_->GetSupportedFormats())) {
      return nullptr;
    }
    return std::make_unique<webrtc::SimulcastEncoderAdapter>(
        env, /*primary_factory=*/internal_.get(),
        /*fallback_factory=*/nullptr, format);
  }

  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return internal_->GetSupportedFormats();
  }

  CodecSupport QueryCodecSupport(
      const webrtc::SdpVideoFormat& format,
      std::optional<std::string> scalability_mode,
      std::optional<webrtc::Resolution> resolution) const override {
    return internal_->QueryCodecSupport(format, scalability_mode, resolution);
  }

 private:
  const std::unique_ptr<webrtc::VideoEncoderFactory> internal_;
};

}  // namespace

std::unique_ptr<webrtc::VideoEncoderFactory> CreateVideoEncoderFactory() {
  return std::make_unique<SimulcastVideoEncoderFactory>();
}

}  // namespace wrtc
