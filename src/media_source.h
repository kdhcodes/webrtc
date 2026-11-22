// Nonstandard media sources: AudioSource / VideoSource.
//
// Contract: SPEC-LAYER-PLAN.md, "Media". The JS layer validates arguments
// with wrtc's exact rules; these only re-check what memory safety needs.
// Sources have no TSFN: pushes fan out synchronously, on the calling (JS)
// thread, to whatever sinks libwebrtc registered (RTP senders, our sinks).
#pragma once

#include <napi.h>

#include "napi_safe.h"

#include "api/scoped_refptr.h"
#include "api/video/video_frame.h"
#include "api/video/video_sink_interface.h"

namespace wrtc {

class PushedAudioSource;
class PushedVideoSource;

// Marks (or unmarks) one of our RTCVideoSinks' adapters. A pushed video
// source delivers frames to marked sinks as pushed, and adapts frames only
// for libwebrtc's sinks (the senders' encoders). Mark before the sink is
// added to a track; unmark after it is removed.
void SetUnadaptedVideoSink(
    const webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink,
    bool unadapted);

// new AudioSource(); createTrack(); pushData({samples, sampleRate,
// bitsPerSample, channelCount, numberOfFrames})
class AudioSource : public SafeObjectWrap<AudioSource> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit AudioSource(const Napi::CallbackInfo& info);
  ~AudioSource() override;

 private:
  Napi::Value CreateTrack(const Napi::CallbackInfo& info);
  Napi::Value PushData(const Napi::CallbackInfo& info);

  webrtc::scoped_refptr<PushedAudioSource> source_;
};

// new VideoSource({isScreencast, needsDenoising}); createTrack();
// pushFrame({width, height, data, rotation})
class VideoSource : public SafeObjectWrap<VideoSource> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit VideoSource(const Napi::CallbackInfo& info);
  ~VideoSource() override;

 private:
  Napi::Value CreateTrack(const Napi::CallbackInfo& info);
  Napi::Value PushFrame(const Napi::CallbackInfo& info);

  webrtc::scoped_refptr<PushedVideoSource> source_;
};

}  // namespace wrtc
