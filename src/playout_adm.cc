// Part of @kdh.codes/webrtc (MIT, see LICENSE). The project's own
// implementation; see playout_adm.h for what it is and why.
#include "playout_adm.h"

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <utility>

#include "api/make_ref_counted.h"
#include "api/task_queue/task_queue_base.h"
#include "api/task_queue/task_queue_factory.h"
#include "api/units/time_delta.h"
#include "api/units/timestamp.h"
#include "rtc_base/synchronization/mutex.h"
#include "rtc_base/thread_annotations.h"
#include "system_wrappers/include/clock.h"

namespace wrtc {
namespace {

using webrtc::AudioDeviceModule;
using webrtc::TimeDelta;
using webrtc::Timestamp;

// The pull format. 48 kHz is the mixer's natural rate for Opus, so the mix
// isn't resampled; mono avoids an up-mix nobody listens to. libwebrtc
// DCHECKs that one pull is exactly 10 ms of 16-bit samples.
constexpr uint32_t kSampleRate = 48000;
constexpr size_t kChannels = 1;
constexpr size_t kFramesPerPull = kSampleRate / 100;
constexpr size_t kBytesPerFrame = sizeof(int16_t) * kChannels;
constexpr TimeDelta kPullInterval = TimeDelta::Millis(10);

// Pulls are scheduled on an absolute timeline (pull n is due at start +
// n * 10 ms), so neither the time a pull takes nor timer lateness
// accumulates: the long-run pull rate is the rate NetEq is drained at and
// sinks get events at, and it must equal real time. A short delay (the
// thread starved, or a GC pause) is made up with back-to-back pulls, so
// sinks keep one event per 10 ms of real time: recorders that build their
// timeline by counting samples stay in step with the clock. (What those
// made-up pulls hold is NetEq's: likely mostly concealment, with the
// packets that queued during the stall arriving late into it.) Only once
// the loop is more than kMaxLag behind (the process was stopped for longer)
// does it drop the missed pulls and restart the timeline from now, rather
// than flood sinks with seconds of stale events. System sleep doesn't count:
// the monotonic clock libwebrtc uses doesn't advance during it. So at most
// about kMaxLag / kPullInterval + 1 pulls ever run back to back. 2 s covers
// every realistic GC or CPU stall (user decision, 2026-11-22).
constexpr TimeDelta kMaxLag = TimeDelta::Seconds(2);

template <typename T>
int32_t Put(T* out, T value) {
  if (out != nullptr) {
    *out = value;
  }
  return 0;
}

class PlayoutAdm : public AudioDeviceModule {
 public:
  explicit PlayoutAdm(const webrtc::Environment& env) : env_(env) {}

  // Nothing refers to the module once this returns: Terminate() waits out
  // an in-flight pull and deletes the queue, after which no pending pull
  // runs. Pulls hold no reference to the module, so the last reference is
  // never dropped on the playout queue itself.
  ~PlayoutAdm() override { Terminate(); }

  int32_t ActiveAudioLayer(AudioLayer* layer) const override {
    return Put(layer, kDummyAudio);
  }

  // Taking mutex_ waits out a pull in progress, so once this returns the
  // previous transport is neither being called nor ever called again.
  int32_t RegisterAudioCallback(webrtc::AudioTransport* transport) override {
    webrtc::MutexLock lock(&mutex_);
    transport_ = transport;
    return 0;
  }

  // libwebrtc RTC_CHECKs that this returns 0. It runs again after every
  // Terminate(): whenever the last peer connection in the process closes
  // and a new one is created.
  int32_t Init() override {
    webrtc::MutexLock lock(&mutex_);
    if (initialized_) {
      return 0;
    }
    // Not libwebrtc's network, worker or signaling thread, and never a JS
    // thread: the pull runs the mixer, NetEq and the sinks' OnData, and must
    // never wait on any of those.
    queue_ = env_.task_queue_factory().CreateTaskQueue(
        "wrtc-playout", webrtc::TaskQueueFactory::Priority::kHigh);
    initialized_ = true;
    return 0;
  }

  int32_t Terminate() override {
    std::unique_ptr<webrtc::TaskQueueBase, webrtc::TaskQueueDeleter> queue;
    {
      // Waits out a pull in progress; any pull that starts after this block
      // sees a stale loop id and returns without calling the transport.
      webrtc::MutexLock lock(&mutex_);
      if (!initialized_) {
        return 0;
      }
      initialized_ = false;
      playout_initialized_ = false;
      playing_ = false;
      ++loop_id_;
      queue = std::move(queue_);
    }
    // Outside the lock, because Delete() waits for a running task, which may
    // be a pull blocked on mutex_. Once it returns no task runs, and pending
    // ones are discarded.
    queue.reset();
    return 0;
  }

  bool Initialized() const override { return initialized_; }

  int16_t PlayoutDevices() override { return 0; }
  int16_t RecordingDevices() override { return 0; }
  int32_t PlayoutDeviceName(uint16_t,
                            char name[webrtc::kAdmMaxDeviceNameSize],
                            char guid[webrtc::kAdmMaxGuidSize]) override {
    return EmptyName(name, guid);
  }
  int32_t RecordingDeviceName(uint16_t,
                              char name[webrtc::kAdmMaxDeviceNameSize],
                              char guid[webrtc::kAdmMaxGuidSize]) override {
    return EmptyName(name, guid);
  }

  // libwebrtc's init helper skips the rest of the playout setup if
  // selecting a device fails, so these succeed.
  int32_t SetPlayoutDevice(uint16_t) override { return 0; }
  int32_t SetPlayoutDevice(WindowsDeviceType) override { return 0; }
  int32_t SetRecordingDevice(uint16_t) override { return 0; }
  int32_t SetRecordingDevice(WindowsDeviceType) override { return 0; }

  int32_t PlayoutIsAvailable(bool* available) override {
    return Put(available, true);
  }

  // libwebrtc only calls StartPlayout() when this returned 0.
  int32_t InitPlayout() override {
    webrtc::MutexLock lock(&mutex_);
    playout_initialized_ = true;
    return 0;
  }

  bool PlayoutIsInitialized() const override { return playout_initialized_; }

  // libwebrtc calls this (and StopPlayout) where blocking calls are
  // DCHECKed against, so it only takes mutex_ (held at most for one pull)
  // and posts; it never waits for the queue.
  int32_t StartPlayout() override {
    webrtc::MutexLock lock(&mutex_);
    if (!initialized_ || !playout_initialized_) {
      return -1;
    }
    if (playing_) {
      return 0;
    }
    playing_ = true;
    // A new loop id retires a loop stopped earlier whose next pull is still
    // pending, so a stop and start within one tick never leaves two loops.
    const uint64_t loop = ++loop_id_;
    next_pull_ = env_.clock().CurrentTime();
    queue_->PostTask([this, loop] { Pull(loop); });
    return 0;
  }

  // Taking mutex_ waits out a pull in progress, so once this returns no
  // transport call is running and none starts. The loop's pending pull
  // finds playing_ false and ends the loop; that's the one wakeup left.
  int32_t StopPlayout() override {
    webrtc::MutexLock lock(&mutex_);
    playing_ = false;
    playout_initialized_ = false;
    return 0;
  }

  // libwebrtc starts playout only while this is false, so it must never
  // read true while nothing pulls: remote audio would go silent for every
  // peer connection in the process.
  bool Playing() const override { return playing_; }

  // Never records (see playout_adm.h). libwebrtc calls InitRecording and
  // StartRecording whenever an audio send stream starts; both succeed and
  // do nothing.
  int32_t RecordingIsAvailable(bool* available) override {
    return Put(available, false);
  }
  int32_t InitRecording() override { return 0; }
  bool RecordingIsInitialized() const override { return false; }
  int32_t StartRecording() override { return 0; }
  int32_t StopRecording() override { return 0; }
  bool Recording() const override { return false; }

  int32_t InitSpeaker() override { return 0; }
  bool SpeakerIsInitialized() const override { return false; }
  int32_t InitMicrophone() override { return 0; }
  bool MicrophoneIsInitialized() const override { return false; }

  int32_t SpeakerVolumeIsAvailable(bool* available) override {
    return Put(available, false);
  }
  int32_t SetSpeakerVolume(uint32_t) override { return 0; }
  int32_t SpeakerVolume(uint32_t* volume) const override {
    return Put(volume, 0u);
  }
  int32_t MaxSpeakerVolume(uint32_t* volume) const override {
    return Put(volume, 0u);
  }
  int32_t MinSpeakerVolume(uint32_t* volume) const override {
    return Put(volume, 0u);
  }

  int32_t MicrophoneVolumeIsAvailable(bool* available) override {
    return Put(available, false);
  }
  int32_t SetMicrophoneVolume(uint32_t) override { return 0; }
  int32_t MicrophoneVolume(uint32_t* volume) const override {
    return Put(volume, 0u);
  }
  int32_t MaxMicrophoneVolume(uint32_t* volume) const override {
    return Put(volume, 0u);
  }
  int32_t MinMicrophoneVolume(uint32_t* volume) const override {
    return Put(volume, 0u);
  }

  int32_t SpeakerMuteIsAvailable(bool* available) override {
    return Put(available, false);
  }
  int32_t SetSpeakerMute(bool) override { return 0; }
  int32_t SpeakerMute(bool* enabled) const override {
    return Put(enabled, false);
  }

  int32_t MicrophoneMuteIsAvailable(bool* available) override {
    return Put(available, false);
  }
  int32_t SetMicrophoneMute(bool) override { return 0; }
  int32_t MicrophoneMute(bool* enabled) const override {
    return Put(enabled, false);
  }

  // Mono only, both ways. libwebrtc asks first and then sets what it was
  // told, i.e. false.
  int32_t StereoPlayoutIsAvailable(bool* available) const override {
    return Put(available, false);
  }
  int32_t SetStereoPlayout(bool enable) override { return enable ? -1 : 0; }
  int32_t StereoPlayout(bool* enabled) const override {
    return Put(enabled, false);
  }
  int32_t StereoRecordingIsAvailable(bool* available) const override {
    return Put(available, false);
  }
  int32_t SetStereoRecording(bool enable) override { return enable ? -1 : 0; }
  int32_t StereoRecording(bool* enabled) const override {
    return Put(enabled, false);
  }

  int32_t PlayoutDelay(uint16_t* delay_ms) const override {
    return Put(delay_ms, uint16_t{0});
  }

  bool BuiltInAECIsAvailable() const override { return false; }
  bool BuiltInAGCIsAvailable() const override { return false; }
  bool BuiltInNSIsAvailable() const override { return false; }
  int32_t EnableBuiltInAEC(bool) override { return -1; }
  int32_t EnableBuiltInAGC(bool) override { return -1; }
  int32_t EnableBuiltInNS(bool) override { return -1; }

  // GetPlayoutUnderrunCount() and GetStats() keep the base class's "not
  // supported": a GetStats() value would add a media-playout object to
  // getStats().

#if defined(WEBRTC_IOS)
  int GetPlayoutAudioParameters(webrtc::AudioParameters*) const override {
    return -1;
  }
  int GetRecordAudioParameters(webrtc::AudioParameters*) const override {
    return -1;
  }
#endif

 private:
  static int32_t EmptyName(char* name, char* guid) {
    if (name != nullptr) {
      name[0] = '\0';
    }
    if (guid != nullptr) {
      guid[0] = '\0';
    }
    return 0;
  }

  // One tick of loop `loop`, on queue_. Holds mutex_ across the transport
  // call: that is what lets StopPlayout, RegisterAudioCallback and
  // Terminate guarantee no call is in progress when they return. Safe
  // because a pull never waits on the threads that call those (worker) or
  // on JS, and callers of those hold nothing a pull needs.
  void Pull(uint64_t loop) {
    webrtc::MutexLock lock(&mutex_);
    if (loop != loop_id_ || !playing_) {
      return;  // Stopped, or superseded by a later StartPlayout().
    }
    if (transport_ != nullptr) {
      size_t pulled_frames = 0;
      int64_t elapsed_time_ms = 0;
      int64_t ntp_time_ms = 0;
      // The return value and outputs are of no use: the audio goes nowhere.
      transport_->NeedMorePlayData(kFramesPerPull, kBytesPerFrame, kChannels,
                                   kSampleRate, buffer_, pulled_frames,
                                   &elapsed_time_ms, &ntp_time_ms);
    }
    const Timestamp now = env_.clock().CurrentTime();
    next_pull_ += kPullInterval;
    if (now - next_pull_ > kMaxLag) {
      next_pull_ = now;
    }
    // High precision: low-precision delayed tasks may slip by up to 17 ms.
    queue_->PostDelayedHighPrecisionTask(
        [this, loop] { Pull(loop); },
        std::max(next_pull_ - now, TimeDelta::Zero()));
  }

  const webrtc::Environment env_;

  // Guards the control state and the transport, and is held for the
  // duration of each pull.
  mutable webrtc::Mutex mutex_;
  std::unique_ptr<webrtc::TaskQueueBase, webrtc::TaskQueueDeleter> queue_
      RTC_GUARDED_BY(mutex_);
  webrtc::AudioTransport* transport_ RTC_GUARDED_BY(mutex_) = nullptr;
  // Each StartPlayout() starts a loop with a new id; a pull whose id isn't
  // the current one ends its loop.
  uint64_t loop_id_ RTC_GUARDED_BY(mutex_) = 0;
  Timestamp next_pull_ RTC_GUARDED_BY(mutex_) = Timestamp::Zero();
  int16_t buffer_[kFramesPerPull * kChannels] RTC_GUARDED_BY(mutex_) = {};

  // Written only under mutex_, but read without it: the query methods are
  // called from other threads (and could be from inside a pull), and must
  // not wait for a pull to finish.
  std::atomic<bool> initialized_{false};
  std::atomic<bool> playout_initialized_{false};
  std::atomic<bool> playing_{false};
};

}  // namespace

webrtc::scoped_refptr<AudioDeviceModule> CreatePlayoutAdm(
    const webrtc::Environment& env) {
  return webrtc::make_ref_counted<PlayoutAdm>(env);
}

}  // namespace wrtc
