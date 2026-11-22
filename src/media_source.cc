#include "media_source.h"
#include "napi_safe.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <unordered_set>
#include <vector>

#include "api/audio_options.h"
#include "api/make_ref_counted.h"
#include "api/media_stream_interface.h"
#include "api/notifier.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_frame.h"
#include "api/video/video_rotation.h"
#include "api/video_track_source_constraints.h"
#include "libyuv/scale.h"
#include "media/base/video_adapter.h"
#include "media/base/video_broadcaster.h"
#include "media_track.h"
#include "rtc_base/crypto_random.h"
#include "rtc_base/synchronization/mutex.h"
#include "rtc_base/time_utils.h"
#include "runtime.h"
#include "util.h"

namespace wrtc {

// An audio source fed from JS. Senders take its audio through their sink
// adapter. Their send streams also register with AudioState for recorded
// audio, but our ADM never records, so only pushed audio reaches the
// encoder. Pushes fan out synchronously with no buffering, as in wrtc.
class PushedAudioSource
    : public webrtc::Notifier<webrtc::AudioSourceInterface> {
 public:
  SourceState state() const override { return kLive; }
  bool remote() const override { return false; }
  const webrtc::AudioOptions options() const override {
    return webrtc::AudioOptions();
  }

  void AddSink(webrtc::AudioTrackSinkInterface* sink) override {
    webrtc::MutexLock lock(&mutex_);
    sinks_.push_back(sink);
  }

  void RemoveSink(webrtc::AudioTrackSinkInterface* sink) override {
    webrtc::MutexLock lock(&mutex_);
    sinks_.erase(std::remove(sinks_.begin(), sinks_.end(), sink), sinks_.end());
  }

  // Sinks run under mutex_; RemoveSink (on the signaling thread) waits for a
  // push in progress, so a sink is never called after it was removed.
  void Push(const int16_t* samples,
            int sample_rate,
            size_t channels,
            size_t frames) {
    webrtc::MutexLock lock(&mutex_);
    for (webrtc::AudioTrackSinkInterface* sink : sinks_) {
      sink->OnData(samples, 16, sample_rate, channels, frames, std::nullopt);
    }
  }

 private:
  webrtc::Mutex mutex_;
  std::vector<webrtc::AudioTrackSinkInterface*> sinks_;
};

namespace {

// Our RTCVideoSinks' adapters (media_sink.cc), so a pushed source can tell
// them from libwebrtc's own sinks. Leaked on purpose: sinks may unregister
// during static destruction.
webrtc::Mutex& UnadaptedSinksMutex() {
  static auto* mutex = new webrtc::Mutex();
  return *mutex;
}
std::unordered_set<const void*>& UnadaptedSinks() {
  static auto* sinks = new std::unordered_set<const void*>();
  return *sinks;
}

}  // namespace

void SetUnadaptedVideoSink(
    const webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink,
    bool unadapted) {
  webrtc::MutexLock lock(&UnadaptedSinksMutex());
  if (unadapted) {
    UnadaptedSinks().insert(sink);
  } else {
    UnadaptedSinks().erase(sink);
  }
}

static bool IsUnadaptedVideoSink(
    const webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink) {
  webrtc::MutexLock lock(&UnadaptedSinksMutex());
  return UnadaptedSinks().count(sink) != 0;
}

// A video source fed from JS, adapted the way libwebrtc's capture sources are
// (AdaptedVideoTrackSource's VideoAdapter, as Chrome's WebRtcVideoTrackSource
// uses it). Frames for libwebrtc's sinks, i.e. the senders' encoders, follow
// their aggregated sink wants: max/target pixel count (CPU and quality
// adaptation under the degradation preference), max_framerate_fps
// (maxFramerate, framerate adaptation), resolution_alignment and
// requested_resolution (scaleResolutionDownTo). The adapter picks a centred
// crop and a scale, or drops the frame; scaling is libyuv's box filter, from
// the pushed memory.
//
// Our own RTCVideoSinks (SetUnadaptedVideoSink) are a separate group that
// gets every frame as pushed, as a local preview does in Chrome, and as
// every sink did before adaptation (wrtc never adapts). With no adaptation
// asked for, a frame is copied once and shared by both groups.
//
// Rotation, per group: the pixels are rotated (and rotation reported as 0)
// for a group as soon as one of its sinks wants rotation applied, e.g. a
// sender to a peer that didn't negotiate the CVO header extension. Our sinks
// never do, so they always get the rotation as metadata.
//
// AdaptedVideoTrackSource itself can't be used: its sink methods are
// private, so a subclass can't route some sinks around its adapter.
class PushedVideoSource
    : public webrtc::Notifier<webrtc::VideoTrackSourceInterface> {
 public:
  PushedVideoSource(bool is_screencast, std::optional<bool> needs_denoising)
      : is_screencast_(is_screencast), needs_denoising_(needs_denoising) {}

  SourceState state() const override { return kLive; }
  bool remote() const override { return false; }
  bool is_screencast() const override { return is_screencast_; }
  std::optional<bool> needs_denoising() const override {
    return needs_denoising_;
  }

  // A tightly packed or strided I420 image in caller memory, read only
  // during Push().
  struct Planes {
    const uint8_t* y;
    const uint8_t* u;
    const uint8_t* v;
    int stride_y;
    int stride_uv;
    int width;
    int height;
  };

  void Push(const Planes& in, webrtc::VideoRotation rotation) {
    const int64_t time_us = webrtc::TimeMicros();
    {
      webrtc::MutexLock lock(&stats_mutex_);
      stats_ = Stats{.input_width = in.width, .input_height = in.height};
    }
    webrtc::scoped_refptr<webrtc::I420Buffer> full;
    auto full_buffer = [&] {
      if (!full) {
        full = webrtc::I420Buffer::Copy(in.width, in.height, in.y, in.stride_y,
                                        in.u, in.stride_uv, in.v, in.stride_uv);
      }
      return full;
    };
    if (unadapted_.frame_wanted()) {
      Deliver(unadapted_, full_buffer(), rotation, time_us);
    }
    if (!adapted_.frame_wanted()) {
      return;
    }
    int crop_width = 0;
    int crop_height = 0;
    int out_width = 0;
    int out_height = 0;
    if (!adapter_.AdaptFrameResolution(
            in.width, in.height, time_us * webrtc::kNumNanosecsPerMicrosec,
            &crop_width, &crop_height, &out_width, &out_height)) {
      // Dropped for the frame rate (or a zero pixel limit).
      adapted_.OnDiscardedFrame();
      return;
    }
    // The output is never larger than the crop, nor the crop than the input.
    if (out_width == in.width && out_height == in.height) {
      Deliver(adapted_, full_buffer(), rotation, time_us);
      return;
    }
    // A centred crop at even offsets, so the chroma planes line up (as
    // I420Buffer::CropAndScaleFrom does).
    const int uv_x = (in.width - crop_width) / 4;
    const int uv_y = (in.height - crop_height) / 4;
    webrtc::scoped_refptr<webrtc::I420Buffer> scaled =
        webrtc::I420Buffer::Create(out_width, out_height);
    libyuv::I420Scale(
        in.y + static_cast<ptrdiff_t>(in.stride_y) * (2 * uv_y) + 2 * uv_x,
        in.stride_y, in.u + static_cast<ptrdiff_t>(in.stride_uv) * uv_y + uv_x,
        in.stride_uv, in.v + static_cast<ptrdiff_t>(in.stride_uv) * uv_y + uv_x,
        in.stride_uv, crop_width, crop_height, scaled->MutableDataY(),
        scaled->StrideY(), scaled->MutableDataU(), scaled->StrideU(),
        scaled->MutableDataV(), scaled->StrideV(), out_width, out_height,
        libyuv::kFilterBox);
    Deliver(adapted_, scaled, rotation, time_us);
  }

  // The media-source stats' width and height: the pushed size, before
  // adaptation (as in AdaptedVideoTrackSource).
  bool GetStats(Stats* stats) override {
    webrtc::MutexLock lock(&stats_mutex_);
    if (!stats_) {
      return false;
    }
    *stats = *stats_;
    return true;
  }

  // Sinks are added and removed on the worker thread (VideoTrack).
  void AddOrUpdateSink(webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink,
                       const webrtc::VideoSinkWants& wants) override {
    if (IsUnadaptedVideoSink(sink)) {
      unadapted_.AddOrUpdateSink(sink, wants);
      return;
    }
    adapted_.AddOrUpdateSink(sink, wants);
    adapter_.OnSinkWants(adapted_.wants());
  }

  void RemoveSink(
      webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink) override {
    if (IsUnadaptedVideoSink(sink)) {
      unadapted_.RemoveSink(sink);
      return;
    }
    adapted_.RemoveSink(sink);
    adapter_.OnSinkWants(adapted_.wants());
  }

  void ProcessConstraints(
      const webrtc::VideoTrackSourceConstraints& constraints) override {
    adapted_.ProcessConstraints(constraints);
  }

  // No encoded output, as in AdaptedVideoTrackSource.
  bool SupportsEncodedOutput() const override { return false; }
  void GenerateKeyFrame() override {}
  void AddEncodedSink(
      webrtc::VideoSinkInterface<webrtc::RecordableEncodedFrame>*) override {}
  void RemoveEncodedSink(
      webrtc::VideoSinkInterface<webrtc::RecordableEncodedFrame>*) override {}

 private:
  static void Deliver(webrtc::VideoBroadcaster& to,
                      webrtc::scoped_refptr<webrtc::VideoFrameBuffer> buffer,
                      webrtc::VideoRotation rotation,
                      int64_t time_us) {
    if (rotation != webrtc::kVideoRotation_0 && to.wants().rotation_applied) {
      buffer = webrtc::I420Buffer::Rotate(*buffer->GetI420(), rotation);
      rotation = webrtc::kVideoRotation_0;
    }
    to.OnFrame(webrtc::VideoFrame::Builder()
                   .set_video_frame_buffer(buffer)
                   .set_rotation(rotation)
                   .set_timestamp_us(time_us)
                   .build());
  }

  const bool is_screencast_;
  const std::optional<bool> needs_denoising_;
  webrtc::VideoAdapter adapter_;
  webrtc::VideoBroadcaster adapted_;
  webrtc::VideoBroadcaster unadapted_;
  webrtc::Mutex stats_mutex_;
  std::optional<Stats> stats_ RTC_GUARDED_BY(stats_mutex_);
};

namespace {

struct Bytes {
  const uint8_t* data = nullptr;
  size_t size = 0;
};

// Any TypedArray (honouring its byteOffset) or an ArrayBuffer.
bool GetBytes(Napi::Value value, Bytes* out) {
  if (value.IsTypedArray()) {
    auto array = value.As<Napi::TypedArray>();
    auto* base = static_cast<const uint8_t*>(array.ArrayBuffer().Data());
    out->data = base == nullptr ? nullptr : base + array.ByteOffset();
    out->size = array.ByteLength();
    return true;
  }
  if (value.IsArrayBuffer()) {
    auto buffer = value.As<Napi::ArrayBuffer>();
    out->data = static_cast<const uint8_t*>(buffer.Data());
    out->size = buffer.ByteLength();
    return true;
  }
  return false;
}

// Reads a numeric property. Returns false with a TypeError pending (or the
// getter's own exception) if it isn't a number.
bool GetNumber(Napi::Object object, const char* key, double* out) {
  Napi::Value value = SafeGet(object, key);
  if (object.Env().IsExceptionPending()) {
    return false;
  }
  if (!value.IsNumber()) {
    ThrowTypeError(object.Env(), std::string("expected a number .") + key);
    return false;
  }
  *out = value.As<Napi::Number>().DoubleValue();
  return true;
}

}  // namespace

void AudioSource::Init(Napi::Env env, Napi::Object exports) {
  exports.Set(
      "AudioSource",
      DefineClass(env, "AudioSource",
                  {
                      InstanceMethod<&AudioSource::CreateTrack>("createTrack"),
                      InstanceMethod<&AudioSource::PushData>("pushData"),
                  }));
}

AudioSource::AudioSource(const Napi::CallbackInfo& info)
    : SafeObjectWrap<AudioSource>(info),
      source_(webrtc::make_ref_counted<PushedAudioSource>()) {}

AudioSource::~AudioSource() = default;

Napi::Value AudioSource::CreateTrack(const Napi::CallbackInfo& info) {
  webrtc::scoped_refptr<webrtc::AudioTrackInterface> track =
      Factory()->CreateAudioTrack(webrtc::CreateRandomUuid(), source_.get());
  return Track::ToJs(info.Env(), track);
}

Napi::Value AudioSource::PushData(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    return ThrowTypeError(env, "pushData(data)");
  }
  Napi::Object data = info[0].As<Napi::Object>();
  Napi::Value samples_value = SafeGet(data, "samples");
  if (env.IsExceptionPending()) {
    return env.Undefined();
  }
  Bytes samples;
  if (!GetBytes(samples_value, &samples)) {
    return ThrowTypeError(env, "expected .samples to be a TypedArray");
  }
  double sample_rate = 0;
  double bits = 0;
  double channels = 0;
  double frames = 0;
  if (!GetNumber(data, "sampleRate", &sample_rate) ||
      !GetNumber(data, "bitsPerSample", &bits) ||
      !GetNumber(data, "channelCount", &channels) ||
      !GetNumber(data, "numberOfFrames", &frames)) {
    return env.Undefined();
  }
  // The JS layer has already applied wrtc's checks; these just keep the
  // read inside the buffer.
  if (bits != 16 || sample_rate < 0 || channels < 0 || frames < 0 ||
      channels > 255 || frames > 65535) {
    return ThrowTypeError(env, "invalid audio data");
  }
  // wrtc accepts empty data (sampleRate < 100 or channelCount 0). There is
  // nothing to deliver, and an empty chunk is not worth sending to encoders.
  if (sample_rate == 0 || channels == 0 || frames == 0) {
    return env.Undefined();
  }
  if (samples.data == nullptr ||
      samples.size < static_cast<size_t>(channels) *
                         static_cast<size_t>(frames) * sizeof(int16_t)) {
    return ThrowTypeError(env, "invalid audio data");
  }
  size_t count = static_cast<size_t>(channels) * static_cast<size_t>(frames);
  const auto* pcm = reinterpret_cast<const int16_t*>(samples.data);
  std::vector<int16_t> aligned;
  if (reinterpret_cast<uintptr_t>(samples.data) % alignof(int16_t) != 0) {
    aligned.resize(count);
    std::memcpy(aligned.data(), samples.data, count * sizeof(int16_t));
    pcm = aligned.data();
  }
  source_->Push(pcm, static_cast<int>(sample_rate),
                static_cast<size_t>(channels), static_cast<size_t>(frames));
  return env.Undefined();
}

void VideoSource::Init(Napi::Env env, Napi::Object exports) {
  exports.Set(
      "VideoSource",
      DefineClass(env, "VideoSource",
                  {
                      InstanceMethod<&VideoSource::CreateTrack>("createTrack"),
                      InstanceMethod<&VideoSource::PushFrame>("pushFrame"),
                  }));
}

VideoSource::VideoSource(const Napi::CallbackInfo& info)
    : SafeObjectWrap<VideoSource>(info) {
  Napi::Env env = info.Env();
  bool is_screencast = false;
  std::optional<bool> needs_denoising;
  if (info.Length() >= 1 && info[0].IsObject()) {
    Napi::Object init = info[0].As<Napi::Object>();
    Napi::Value screencast = SafeGet(init, "isScreencast");
    if (env.IsExceptionPending()) {
      return;
    }
    is_screencast = SafeToBool(screencast);
    Napi::Value denoising = SafeGet(init, "needsDenoising");
    if (env.IsExceptionPending()) {
      return;
    }
    if (denoising.IsBoolean()) {
      needs_denoising = denoising.As<Napi::Boolean>().Value();
    }
  }
  source_ = webrtc::make_ref_counted<PushedVideoSource>(is_screencast,
                                                        needs_denoising);
}

VideoSource::~VideoSource() = default;

Napi::Value VideoSource::CreateTrack(const Napi::CallbackInfo& info) {
  webrtc::scoped_refptr<webrtc::VideoTrackInterface> track =
      Factory()->CreateVideoTrack(source_, webrtc::CreateRandomUuid());
  return Track::ToJs(info.Env(), track);
}

Napi::Value VideoSource::PushFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    return ThrowTypeError(env, "pushFrame(frame)");
  }
  Napi::Object frame = info[0].As<Napi::Object>();
  double width = 0;
  double height = 0;
  double rotation = 0;
  if (!GetNumber(frame, "width", &width) ||
      !GetNumber(frame, "height", &height) ||
      !GetNumber(frame, "rotation", &rotation)) {
    return env.Undefined();
  }
  Napi::Value data_value = SafeGet(frame, "data");
  if (env.IsExceptionPending()) {
    return env.Undefined();
  }
  Bytes data;
  if (!GetBytes(data_value, &data)) {
    return ThrowTypeError(env, "expected .data to be a TypedArray");
  }
  if (!(width >= 1 && height >= 1 && width <= INT32_MAX &&
        height <= INT32_MAX)) {
    // wrtc accepts a 0x0 frame (empty data); there's nothing to deliver.
    if (width == 0 || height == 0) {
      return env.Undefined();
    }
    return ThrowTypeError(env, "invalid frame size");
  }
  int w = static_cast<int>(width);
  int h = static_cast<int>(height);
  int chroma_w = static_cast<int>((static_cast<int64_t>(w) + 1) / 2);
  int chroma_h = static_cast<int>((static_cast<int64_t>(h) + 1) / 2);
  size_t luma = static_cast<size_t>(w) * h;
  size_t chroma = static_cast<size_t>(chroma_w) * chroma_h;
  if (data.data == nullptr || data.size < luma + 2 * chroma) {
    return ThrowTypeError(env, "invalid frame data");
  }

  webrtc::VideoRotation video_rotation = webrtc::kVideoRotation_0;
  switch (static_cast<int>(rotation)) {
    case 90:
      video_rotation = webrtc::kVideoRotation_90;
      break;
    case 180:
      video_rotation = webrtc::kVideoRotation_180;
      break;
    case 270:
      video_rotation = webrtc::kVideoRotation_270;
      break;
    default:
      break;
  }

  source_->Push({.y = data.data,
                 .u = data.data + luma,
                 .v = data.data + luma + chroma,
                 .stride_y = w,
                 .stride_uv = chroma_w,
                 .width = w,
                 .height = h},
                video_rotation);
  return env.Undefined();
}

}  // namespace wrtc
