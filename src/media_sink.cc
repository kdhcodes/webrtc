#include "media_sink.h"

#include <atomic>
#include <cstdint>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "api/video/i420_buffer.h"
#include "api/video/video_frame.h"
#include "api/video/video_frame_buffer.h"
#include "api/video/video_sink_interface.h"
#include "api/video/video_source_interface.h"
#include "media_source.h"
#include "media_track.h"
#include "util.h"

namespace wrtc {

// One event's data, taken on the producing thread (a copy, or for video a
// reference to libwebrtc's buffer) and converted to JS on the JS thread.
struct Payload {
  virtual ~Payload() = default;
  // Empty if the env can no longer create JS values; never throws.
  virtual Napi::Value ToJs(Napi::Env env) = 0;
};

void DeliverToJs(Napi::Env env,
                 Napi::Function callback,
                 Delivery* delivery,
                 void*);
void FinalizeDelivery(Napi::Env env, void*, Delivery* delivery);
using DeliveryTsfn = Napi::TypedThreadSafeFunction<Delivery, void, DeliverToJs>;
using PayloadQueue = std::deque<std::unique_ptr<Payload>>;

// Owns one sink's TSFN and the payloads waiting for the JS thread. Shared by
// the sink adapter (any thread) and kept alive by itself until Node
// finalizes the TSFN, so DeliverToJs and FinalizeDelivery always have a live
// context.
//
// Payloads wait in our own queue, not the TSFN's. The TSFN carries at most
// one wake at a time; a wake delivers the oldest payload and, if more are
// waiting, posts the next wake before calling into JS. So the callback still
// runs once per payload, in order, in its own TSFN dispatch (Node reports
// an exception it throws before the next one runs), and bounding our queue
// bounds everything held for JS. With `max_queued` set (video), a payload
// posted while that many wait drops the oldest at once, releasing its
// buffer on the posting thread, and counts it. 0 (audio) never drops.
class Delivery : public std::enable_shared_from_this<Delivery> {
 public:
  explicit Delivery(size_t max_queued) : max_queued_(max_queued) {}

  void Start(Napi::Env env, Napi::Function callback) {
    std::lock_guard<std::mutex> lock(mutex_);
    self_while_started_ = shared_from_this();
    tsfn_ = DeliveryTsfn::New(env, callback, "wrtc:sink", 0, 1, this,
                              FinalizeDelivery, static_cast<void*>(nullptr));
    released_ = false;
  }

  // Any thread, including the JS thread inside pushData/pushFrame. Never
  // blocks: the TSFN is unbounded (and holds at most one wake). Dropped
  // once released.
  void Post(std::unique_ptr<Payload> payload) {
    // Declared before the lock, so destroyed after it is released.
    std::unique_ptr<Payload> evicted;
    PayloadQueue abandoned;
    std::lock_guard<std::mutex> lock(mutex_);
    if (released_) {
      return;
    }
    if (max_queued_ != 0 && queue_.size() >= max_queued_) {
      evicted = std::move(queue_.front());
      queue_.pop_front();
      dropped_.fetch_add(1, std::memory_order_relaxed);
    }
    queue_.push_back(std::move(payload));
    if (!wake_pending_) {
      wake_pending_ = tsfn_.NonBlockingCall() == napi_ok;
      if (!wake_pending_) {
        abandoned.swap(queue_);
      }
    }
  }

  // Payloads still waiting are released at once; a wake already queued
  // finds nothing to deliver.
  void Stop() {
    stopped_.store(true);
    PayloadQueue abandoned;
    std::lock_guard<std::mutex> lock(mutex_);
    if (released_) {
      return;
    }
    released_ = true;
    abandoned.swap(queue_);
    tsfn_.Release();
  }

  // Payloads dropped because `max_queued` were already waiting.
  uint64_t dropped() const { return dropped_.load(std::memory_order_relaxed); }

 private:
  friend void DeliverToJs(Napi::Env, Napi::Function, Delivery*, void*);
  friend void FinalizeDelivery(Napi::Env, void*, Delivery*);

  // JS thread, for a wake. Returns the oldest payload (null if there is
  // none, or if `deliverable` is false, when every waiting payload is
  // released), and posts the next wake if more are waiting.
  std::unique_ptr<Payload> TakeNext(bool deliverable) {
    PayloadQueue abandoned;
    std::unique_ptr<Payload> next;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!deliverable) {
      abandoned.swap(queue_);
    } else if (!queue_.empty()) {
      next = std::move(queue_.front());
      queue_.pop_front();
    }
    wake_pending_ =
        !queue_.empty() && !released_ && tsfn_.NonBlockingCall() == napi_ok;
    if (!wake_pending_) {
      abandoned.swap(queue_);
    }
    return next;
  }

  const size_t max_queued_;
  std::mutex mutex_;
  bool released_ = true;
  // A wake is queued on the TSFN; it will take the oldest payload.
  bool wake_pending_ = false;
  PayloadQueue queue_;
  std::atomic<uint64_t> dropped_{0};
  std::atomic<bool> stopped_{false};
  DeliveryTsfn tsfn_;
  std::shared_ptr<Delivery> self_while_started_;
};

void DeliverToJs(Napi::Env env,
                 Napi::Function callback,
                 Delivery* delivery,
                 void*) {
  // env is null when the TSFN is torn down with the wake still queued. Don't
  // touch `delivery` then: Node 22 and older run the finalizer (which may
  // drop the last reference) before emptying the queue. The finalizer
  // releases the waiting frames either way.
  if (env == nullptr) {
    return;
  }
  bool live = !delivery->stopped_.load();
  std::unique_ptr<Payload> payload = delivery->TakeNext(live);
  if (!payload) {
    return;
  }
  // Raw N-API from here on; see "Delivery on a dying env" below.
  napi_handle_scope scope = nullptr;
  if (napi_open_handle_scope(env, &scope) != napi_ok) {
    return;
  }
  Napi::Value value = payload->ToJs(env);
  // The JS value holds a copy: let libwebrtc's buffer go before the
  // callback runs, however long that takes.
  payload.reset();
  napi_value recv = nullptr;
  if (!value.IsEmpty() && napi_get_undefined(env, &recv) == napi_ok) {
    napi_value arg = value;
    napi_value result = nullptr;
    // An exception from the callback stays pending and Node reports it as
    // uncaught, as for any other callback.
    napi_call_function(env, recv, callback, 1, &arg, &result);
  }
  napi_close_handle_scope(env, scope);
}

void FinalizeDelivery(Napi::Env, void*, Delivery* delivery) {
  // Node deletes the TSFN right after this returns (also on env teardown
  // without Release()), so nothing may call into it again.
  std::shared_ptr<Delivery> keep;
  PayloadQueue abandoned;
  {
    std::lock_guard<std::mutex> lock(delivery->mutex_);
    delivery->released_ = true;
    delivery->wake_pending_ = false;
    abandoned.swap(delivery->queue_);
    keep = std::move(delivery->self_while_started_);
  }
  // `abandoned`, then `keep` (which may destroy the delivery), go here,
  // after the lock is gone.
}

namespace {

// Delivery on a dying env: after worker.terminate(), Node still dispatches
// queued TSFN items while it closes the worker's handles, before our env
// cleanup hook stops the sink. Every N-API call that needs JS then fails,
// and with NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS no exception is left
// pending, so node-addon-api's wrappers return empty values (a typed array
// whose Data() is null), and its error helpers can abort the process. So
// delivery uses the raw C API, and any failure drops the event silently:
// ToJs returns an empty Napi::Value and DeliverToJs skips it.

// A new ArrayBuffer of `size` bytes whose contents are left for the caller
// to fill, and a typed array of `length` elements over all of it. Every byte
// must be written before JS can see it.
//
// napi_create_arraybuffer zero-fills (calloc): allocating and filling a
// frame-sized buffer takes 30-40% less time without it on macOS, 10% less
// on Linux (bench/RESULTS.md). napi_create_buffer doesn't (it is
// node::Buffer::New, whose backing store is uninitialised), so the
// ArrayBuffer comes from a Buffer and the Buffer object itself is dropped:
// JS still gets a plain typed array over a plain, exactly sized ArrayBuffer
// of its own, as before. Not napi_create_external_arraybuffer: V8 sandbox
// builds (Electron) refuse it, and handing out libwebrtc's own frame memory
// would let one sink's writes reach other sinks and the encoder.
bool NewUninitializedTypedArray(napi_env env,
                                napi_typedarray_type type,
                                size_t size,
                                size_t length,
                                void** data,
                                napi_value* out) {
  napi_value array_buffer = nullptr;
  napi_value buffer = nullptr;
  size_t offset = 0;
  size_t buffer_size = 0;
  bool fast =
      size > 0 && napi_create_buffer(env, size, data, &buffer) == napi_ok &&
      napi_get_typedarray_info(env, buffer, nullptr, nullptr, nullptr,
                               &array_buffer, &offset) == napi_ok &&
      napi_get_arraybuffer_info(env, array_buffer, nullptr, &buffer_size) ==
          napi_ok &&
      offset == 0 && buffer_size == size;
  if (!fast &&
      napi_create_arraybuffer(env, size, data, &array_buffer) != napi_ok) {
    return false;
  }
  if (size > 0 && *data == nullptr) {
    return false;
  }
  return napi_create_typedarray(env, type, length, array_buffer, 0, out) ==
         napi_ok;
}

bool SetValue(napi_env env,
              napi_value object,
              const char* key,
              napi_value value) {
  return napi_set_named_property(env, object, key, value) == napi_ok;
}

bool SetNumber(napi_env env, napi_value object, const char* key, double n) {
  napi_value value = nullptr;
  return napi_create_double(env, n, &value) == napi_ok &&
         SetValue(env, object, key, value);
}

struct AudioPayload : Payload {
  std::vector<int16_t> samples;
  int bits_per_sample = 16;
  int sample_rate = 0;
  size_t channels = 0;
  size_t frames = 0;

  Napi::Value ToJs(Napi::Env env) override {
    napi_value array = nullptr;
    napi_value data = nullptr;
    void* bytes = nullptr;
    size_t size = samples.size() * sizeof(int16_t);
    if (!NewUninitializedTypedArray(env, napi_int16_array, size, samples.size(),
                                    &bytes, &array)) {
      return Napi::Value();
    }
    if (size > 0) {
      std::memcpy(bytes, samples.data(), size);
    }
    // Same property order as wrtc's event.
    if (napi_create_object(env, &data) != napi_ok ||
        !SetValue(env, data, "samples", array) ||
        !SetNumber(env, data, "bitsPerSample", bits_per_sample) ||
        !SetNumber(env, data, "sampleRate", sample_rate) ||
        !SetNumber(env, data, "channelCount", static_cast<double>(channels)) ||
        !SetNumber(env, data, "numberOfFrames", static_cast<double>(frames))) {
      return Napi::Value();
    }
    return Napi::Value(env, data);
  }
};

void CopyPlane(const uint8_t* src,
               int src_stride,
               uint8_t* dst,
               int width,
               int height) {
  if (src_stride == width) {
    std::memcpy(dst, src, static_cast<size_t>(width) * height);
    return;
  }
  for (int row = 0; row < height; ++row) {
    std::memcpy(dst + static_cast<size_t>(row) * width,
                src + static_cast<ptrdiff_t>(row) * src_stride, width);
  }
}

// Frames per video sink waiting for the JS thread. A frame arriving while
// this many wait drops the oldest (latest frame wins, as video pipelines
// do), so a stalled event loop (GC, CPU load, a slow handler) holds at most
// this many frames per sink, plus the one being copied into JS, instead of
// every frame since the stall began. 3 frames are 100 ms at 30 fps: a
// stall that short still loses nothing. At 1080p they are 9 MB per sink.
constexpr size_t kMaxQueuedFrames = 3;

// The frame's I420 buffer, copied once on the JS thread straight into the
// frame's ArrayBuffer. It is libwebrtc's own buffer, held by reference:
// immutable once in a VideoFrame, so the copy is the frame as delivered,
// and there is one copy in all (wrtc holds every frame this way). A held
// buffer can't return to the decoder's pool, and the pools don't bound
// that (H264's is uncapped, VP9's only warns, VP8's drops frames past 300,
// and none shrinks), but kMaxQueuedFrames does: a sink holds at most that
// many plus the one being copied. (Before the bound, OnFrame copied every
// frame past the third queued into a buffer of its own for this reason.)
struct VideoPayload : Payload {
  int rotation = 0;
  webrtc::scoped_refptr<webrtc::I420BufferInterface> i420;

  Napi::Value ToJs(Napi::Env env) override {
    int width = i420->width();
    int height = i420->height();
    int chroma_width = i420->ChromaWidth();
    int chroma_height = i420->ChromaHeight();
    size_t luma = static_cast<size_t>(width) * height;
    size_t chroma = static_cast<size_t>(chroma_width) * chroma_height;
    size_t size = luma + 2 * chroma;

    napi_value array = nullptr;
    napi_value frame = nullptr;
    void* data = nullptr;
    if (!NewUninitializedTypedArray(env, napi_uint8_array, size, size, &data,
                                    &array)) {
      return Napi::Value();
    }
    auto* out = static_cast<uint8_t*>(data);
    CopyPlane(i420->DataY(), i420->StrideY(), out, width, height);
    CopyPlane(i420->DataU(), i420->StrideU(), out + luma, chroma_width,
              chroma_height);
    CopyPlane(i420->DataV(), i420->StrideV(), out + luma + chroma, chroma_width,
              chroma_height);
    if (napi_create_object(env, &frame) != napi_ok ||
        !SetNumber(env, frame, "width", width) ||
        !SetNumber(env, frame, "height", height) ||
        !SetNumber(env, frame, "rotation", rotation) ||
        !SetValue(env, frame, "data", array)) {
      return Napi::Value();
    }
    return Napi::Value(env, frame);
  }
};

}  // namespace

class AudioSinkAdapter : public webrtc::AudioTrackSinkInterface {
 public:
  explicit AudioSinkAdapter(std::shared_ptr<Delivery> delivery)
      : delivery_(std::move(delivery)) {}

  using webrtc::AudioTrackSinkInterface::OnData;
  void OnData(const void* audio_data,
              int bits_per_sample,
              int sample_rate,
              size_t number_of_channels,
              size_t number_of_frames) override {
    if (bits_per_sample != 16 || audio_data == nullptr) {
      return;
    }
    auto payload = std::make_unique<AudioPayload>();
    const auto* samples = static_cast<const int16_t*>(audio_data);
    payload->samples.assign(samples,
                            samples + number_of_channels * number_of_frames);
    payload->sample_rate = sample_rate;
    payload->channels = number_of_channels;
    payload->frames = number_of_frames;
    delivery_->Post(std::move(payload));
  }

 private:
  std::shared_ptr<Delivery> delivery_;
};

class VideoSinkAdapter : public webrtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  // Marked so that a pushed source gives it frames as pushed, never adapted
  // for an encoder (media_source.h). Remote tracks ignore the mark.
  explicit VideoSinkAdapter(std::shared_ptr<Delivery> delivery)
      : delivery_(std::move(delivery)) {
    SetUnadaptedVideoSink(this, true);
  }
  ~VideoSinkAdapter() override { SetUnadaptedVideoSink(this, false); }

  void OnFrame(const webrtc::VideoFrame& frame) override {
    webrtc::scoped_refptr<webrtc::VideoFrameBuffer> buffer =
        frame.video_frame_buffer();
    if (!buffer) {
      return;
    }
    // Decoders and capturers may hand out native or NV12 buffers; wrtc
    // dropped those, we convert them. Here rather than on the JS thread,
    // even for a frame the queue may then drop: a native buffer may come
    // from a capturer's or hardware decoder's pool, which shouldn't wait on
    // JS.
    webrtc::scoped_refptr<webrtc::I420BufferInterface> i420 = buffer->ToI420();
    if (!i420) {
      return;
    }
    auto payload = std::make_unique<VideoPayload>();
    payload->rotation = static_cast<int>(frame.rotation());
    payload->i420 = std::move(i420);
    // libwebrtc's broadcaster calls OnFrame one frame at a time, so frames
    // are queued, and delivered, in order.
    delivery_->Post(std::move(payload));
  }

 private:
  std::shared_ptr<Delivery> delivery_;
};

SinkBase::SinkBase() = default;
SinkBase::~SinkBase() = default;

void SinkBase::Start(Napi::Env env,
                     Napi::Function callback,
                     napi_ref wrapper,
                     size_t max_queued) {
  env_ = env;
  delivery_ = std::make_shared<Delivery>(max_queued);
  delivery_->Start(env, callback);
  // Registered after the TSFN, and hooks run last-in first-out, so on env
  // teardown this runs while the TSFN is still alive.
  if (napi_add_env_cleanup_hook(env, OnEnvCleanup, this) == napi_ok) {
    cleanup_hook_registered_ = true;
  }
  // The TSFN only holds the callback, so without this an unreferenced sink
  // would be collected, and its destructor would stop it.
  if (napi_reference_ref(env, wrapper, nullptr) == napi_ok) {
    wrapper_ = wrapper;
  }
}

void SinkBase::DoStop() {
  if (cleanup_hook_registered_) {
    napi_remove_env_cleanup_hook(env_, OnEnvCleanup, this);
    cleanup_hook_registered_ = false;
  }
  if (stopped_ || !delivery_) {
    return;
  }
  stopped_ = true;
  // RemoveSink blocks on a libwebrtc thread and takes the broadcaster's
  // lock, so once it returns no adapter callback is running or will run.
  // No lock of ours is held here.
  Detach();
  delivery_->Stop();
  if (wrapper_ != nullptr) {
    napi_reference_unref(env_, wrapper_, nullptr);
    wrapper_ = nullptr;
  }
}

void SinkBase::StopFromDestructor() {
  // A sink still holding its reference can only be finalized on env
  // teardown, where Node deletes the reference regardless.
  wrapper_ = nullptr;
  DoStop();
}

void SinkBase::OnEnvCleanup(void* self) {
  auto* sink = static_cast<SinkBase*>(self);
  sink->cleanup_hook_registered_ = false;
  sink->DoStop();
}

namespace {

// Returns the track behind `value` if it is a Track handle of `kind`;
// otherwise throws a TypeError and returns null.
webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> TrackOfKind(
    const Napi::CallbackInfo& info,
    const std::string& kind) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[1].IsFunction()) {
    ThrowTypeError(env, "expected (track, callback)");
    return nullptr;
  }
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track =
      Track::FromJs(info[0]);
  if (!track) {
    return nullptr;
  }
  if (track->kind() != kind) {
    ThrowTypeError(env, "expected a native " + kind + " Track handle");
    return nullptr;
  }
  return track;
}

}  // namespace

void AudioSink::Init(Napi::Env env, Napi::Object exports) {
  exports.Set("AudioSink",
              DefineClass(env, "AudioSink",
                          {InstanceMethod<&AudioSink::Stop>("stop")}));
}

AudioSink::AudioSink(const Napi::CallbackInfo& info)
    : SafeObjectWrap<AudioSink>(info) {
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track =
      TrackOfKind(info, webrtc::MediaStreamTrackInterface::kAudioKind);
  if (!track) {
    return;
  }
  track_ = webrtc::scoped_refptr<webrtc::AudioTrackInterface>(
      static_cast<webrtc::AudioTrackInterface*>(track.get()));
  // Unbounded: dropped audio would corrupt transcription and recording.
  Start(info.Env(), info[1].As<Napi::Function>(), *this, 0);
  adapter_ = std::make_unique<AudioSinkAdapter>(delivery_);
  track_->AddSink(adapter_.get());
}

AudioSink::~AudioSink() {
  StopFromDestructor();
}

void AudioSink::Detach() {
  track_->RemoveSink(adapter_.get());
}

Napi::Value AudioSink::Stop(const Napi::CallbackInfo& info) {
  DoStop();
  return info.Env().Undefined();
}

void VideoSink::Init(Napi::Env env, Napi::Object exports) {
  exports.Set(
      "VideoSink",
      DefineClass(
          env, "VideoSink",
          {InstanceMethod<&VideoSink::Stop>("stop"),
           InstanceAccessor<&VideoSink::FramesDropped>("framesDropped")}));
}

VideoSink::VideoSink(const Napi::CallbackInfo& info)
    : SafeObjectWrap<VideoSink>(info) {
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track =
      TrackOfKind(info, webrtc::MediaStreamTrackInterface::kVideoKind);
  if (!track) {
    return;
  }
  track_ = webrtc::scoped_refptr<webrtc::VideoTrackInterface>(
      static_cast<webrtc::VideoTrackInterface*>(track.get()));
  Start(info.Env(), info[1].As<Napi::Function>(), *this, kMaxQueuedFrames);
  adapter_ = std::make_unique<VideoSinkAdapter>(delivery_);
  // Default wants: this sink never asks for rotation to be applied or for
  // resolution to be adapted. A pushed source keeps it apart from its
  // senders, so it gets frames as pushed, with rotation as metadata (see
  // PushedVideoSource).
  track_->AddOrUpdateSink(adapter_.get(), webrtc::VideoSinkWants());
}

VideoSink::~VideoSink() {
  StopFromDestructor();
}

void VideoSink::Detach() {
  track_->RemoveSink(adapter_.get());
}

Napi::Value VideoSink::Stop(const Napi::CallbackInfo& info) {
  DoStop();
  return info.Env().Undefined();
}

Napi::Value VideoSink::FramesDropped(const Napi::CallbackInfo& info) {
  // An atomic read; also after stop(), which drops no more.
  uint64_t dropped = delivery_ ? delivery_->dropped() : 0;
  return Napi::Number::New(info.Env(), static_cast<double>(dropped));
}

}  // namespace wrtc
