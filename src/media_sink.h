// Nonstandard media sinks: AudioSink / VideoSink.
//
// Contract: SPEC-LAYER-PLAN.md, "Media". Each sink registers itself on a
// track (AddSink / AddOrUpdateSink) and delivers a copy of every buffer to
// its JS callback through its own TSFN: every audio buffer, and of video
// frames at most the newest kMaxQueuedFrames waiting for the JS thread
// (older ones are dropped and counted in `framesDropped`).
//
// Threading: libwebrtc calls the sink under its broadcaster's sink lock, on
// the JS thread for local tracks (inside pushData/pushFrame) and on a media
// thread for remote ones. RemoveSink is a blocking proxy call (signaling
// thread for audio, worker thread for video). So delivery only ever uses
// NonBlockingCall on an unbounded TSFN (the video bound is on our own queue,
// and drops rather than blocks), and no lock of ours is held across
// RemoveSink.
//
// Lifetime: the TSFN is ref'd until stop(), so an unstopped sink keeps the
// process alive (wrtc parity). The JS object is strongly referenced until
// stop() too, so an unreferenced sink isn't collected (its destructor would
// stop it) and keeps delivering. An env cleanup hook stops the sink on env
// teardown (worker termination), and the TSFN may be finalized before the
// sink's destructor runs.
#pragma once

#include <memory>

#include <napi.h>

#include "napi_safe.h"

#include "api/media_stream_interface.h"
#include "api/scoped_refptr.h"

namespace wrtc {

class Delivery;
class AudioSinkAdapter;
class VideoSinkAdapter;

// Plumbing shared by both sinks: the delivery TSFN, the env cleanup hook and
// an idempotent stop that detaches from the track before releasing the TSFN.
class SinkBase {
 protected:
  SinkBase();
  virtual ~SinkBase();

  // JS thread. Creates the TSFN for `callback`, registers the cleanup hook
  // and takes a strong reference on `wrapper` (the sink's own ObjectWrap
  // reference) until stop. Call after validating arguments, before
  // attaching to the track. `max_queued`: payloads that may wait for the JS
  // thread before the oldest is dropped; 0 for no bound.
  void Start(Napi::Env env,
             Napi::Function callback,
             napi_ref wrapper,
             size_t max_queued);
  // JS thread (or the env cleanup hook). Idempotent.
  void DoStop();
  // For the subclass destructors: the wrapper reference is being deleted,
  // so stop without touching it.
  void StopFromDestructor();
  // Removes the libwebrtc sink from its track. Called at most once.
  virtual void Detach() = 0;

  std::shared_ptr<Delivery> delivery_;

 private:
  static void OnEnvCleanup(void* self);

  napi_env env_ = nullptr;
  // Set while we hold a strong count on the sink's ObjectWrap reference.
  napi_ref wrapper_ = nullptr;
  bool cleanup_hook_registered_ = false;
  bool stopped_ = false;
};

// new AudioSink(track, onData); stop()
class AudioSink : public SafeObjectWrap<AudioSink>, public SinkBase {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit AudioSink(const Napi::CallbackInfo& info);
  ~AudioSink() override;

 private:
  Napi::Value Stop(const Napi::CallbackInfo& info);
  void Detach() override;

  webrtc::scoped_refptr<webrtc::AudioTrackInterface> track_;
  std::unique_ptr<AudioSinkAdapter> adapter_;
};

// new VideoSink(track, onFrame); stop(); framesDropped
class VideoSink : public SafeObjectWrap<VideoSink>, public SinkBase {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit VideoSink(const Napi::CallbackInfo& info);
  ~VideoSink() override;

 private:
  Napi::Value Stop(const Napi::CallbackInfo& info);
  Napi::Value FramesDropped(const Napi::CallbackInfo& info);
  void Detach() override;

  webrtc::scoped_refptr<webrtc::VideoTrackInterface> track_;
  std::unique_ptr<VideoSinkAdapter> adapter_;
};

}  // namespace wrtc
