#include "runtime.h"

#include <memory>

#include "api/audio/builtin_audio_processing_builder.h"
#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/create_modular_peer_connection_factory.h"
#include "api/enable_media.h"
#include "api/environment/environment_factory.h"
#include "api/rtc_event_log/rtc_event_log_factory.h"
#include "api/video_codecs/video_decoder_factory_template.h"
#include "api/video_codecs/video_decoder_factory_template_dav1d_adapter.h"
#include "api/video_codecs/video_decoder_factory_template_libvpx_vp8_adapter.h"
#include "api/video_codecs/video_decoder_factory_template_libvpx_vp9_adapter.h"
#include "playout_adm.h"
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/thread.h"
#include "video_encoder_factory.h"

namespace wrtc {
namespace {

struct Runtime {
  std::unique_ptr<webrtc::Thread> network;
  std::unique_ptr<webrtc::Thread> worker;
  std::unique_ptr<webrtc::Thread> signaling;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;

  Runtime() {
    webrtc::InitializeSSL();

    network = webrtc::Thread::CreateWithSocketServer();
    network->SetName("wrtc-network", nullptr);
    network->Start();
    worker = webrtc::Thread::Create();
    worker->SetName("wrtc-worker", nullptr);
    worker->Start();
    signaling = webrtc::Thread::Create();
    signaling->SetName("wrtc-signaling", nullptr);
    signaling->Start();

    webrtc::Environment env = webrtc::CreateEnvironment();

    webrtc::PeerConnectionFactoryDependencies deps;
    deps.network_thread = network.get();
    deps.worker_thread = worker.get();
    deps.signaling_thread = signaling.get();
    deps.socket_factory = network->socketserver();
    deps.event_log_factory = std::make_unique<webrtc::RtcEventLogFactory>();
    deps.env = env;
    // Node has no audio devices to speak of; media comes from the
    // nonstandard sources. The playout-only ADM keeps libwebrtc off the
    // real hardware (no mic permission prompts, works headless) and pulls
    // playout every 10 ms, which is what delivers remote audio to sinks.
    // It never records; local audio goes through external sources.
    deps.adm = worker->BlockingCall([&] { return CreatePlayoutAdm(env); });
    deps.audio_encoder_factory = webrtc::CreateBuiltinAudioEncoderFactory();
    deps.audio_decoder_factory = webrtc::CreateBuiltinAudioDecoderFactory();
    deps.audio_processing_builder =
        std::make_unique<webrtc::BuiltinAudioProcessingBuilder>();
    // CreateBuiltinVideo{En,De}coderFactory aren't part of libwebrtc's
    // static library target, so assemble the codecs from the header-only
    // templates (encoders with simulcast: video_encoder_factory.h). VP8, VP9
    // and AV1 only: no H264 or H265 (user decision, 2026-11-22). A format no
    // adapter lists is never offered or accepted.
    deps.video_encoder_factory = CreateVideoEncoderFactory();
    deps.video_decoder_factory =
        std::make_unique<webrtc::VideoDecoderFactoryTemplate<
            webrtc::LibvpxVp8DecoderTemplateAdapter,
            webrtc::LibvpxVp9DecoderTemplateAdapter,
            webrtc::Dav1dDecoderTemplateAdapter>>();
    webrtc::EnableMedia(deps);

    factory = webrtc::CreateModularPeerConnectionFactory(std::move(deps));
  }
};

Runtime* GetRuntime() {
  static Runtime* runtime = new Runtime();
  return runtime;
}

}  // namespace

webrtc::PeerConnectionFactoryInterface* Factory() {
  return GetRuntime()->factory.get();
}

webrtc::Thread* SignalingThread() {
  return GetRuntime()->signaling.get();
}

webrtc::Thread* NetworkThread() {
  return GetRuntime()->network.get();
}

webrtc::Thread* WorkerThread() {
  return GetRuntime()->worker.get();
}

}  // namespace wrtc
