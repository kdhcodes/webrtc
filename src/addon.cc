#include <napi.h>

#include "addon.h"
#include "certificate.h"
#include "data_channel.h"
#include "log_hook.h"
#include "media_sink.h"
#include "media_source.h"
#include "media_track.h"
#include "peer_connection.h"
#include "rtp.h"
#include "yuv.h"

namespace wrtc {

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  InstallLogHookFromEnv();
  env.SetInstanceData(new AddonData());
  DataChannel::Init(env, exports);
  PeerConnection::Init(env, exports);
  Track::Init(env, exports);
  Transceiver::Init(env, exports);
  Sender::Init(env, exports);
  Receiver::Init(env, exports);
  AudioSource::Init(env, exports);
  VideoSource::Init(env, exports);
  AudioSink::Init(env, exports);
  VideoSink::Init(env, exports);
  exports.Set("getRtpCapabilities", Napi::Function::New<GetRtpCapabilities>(
                                        env, "getRtpCapabilities"));
  exports.Set("generateCertificate", Napi::Function::New<GenerateCertificate>(
                                         env, "generateCertificate"));
  exports.Set("i420ToRgba", Napi::Function::New<I420ToRgba>(env, "i420ToRgba"));
  exports.Set("rgbaToI420", Napi::Function::New<RgbaToI420>(env, "rgbaToI420"));
  return exports;
}

NODE_API_MODULE(wrtc, Init)

}  // namespace wrtc
