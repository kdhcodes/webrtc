// A playout-only audio device module for a process with no audio hardware.
//
// Part of @kdh.codes/webrtc (MIT, see LICENSE). The project's own
// implementation, written from a behavioural spec.
//
// Why it exists: remote audio reaches RTCAudioSinks only when something
// pulls playout. Each 10 ms pull (AudioTransport::NeedMorePlayData) runs
// libwebrtc's mixer, which drains every receive stream's NetEq and calls
// its raw audio sinks; it also feeds the receivers' RtpSource trackers
// (getSynchronizationSources). libwebrtc's dummy device never pulls.
//
// What it does: while playout runs (StartPlayout to StopPlayout), it pulls
// 10 ms of 48 kHz mono every 10 ms of real time on its own high-priority
// task queue, and discards the audio. It never records: local audio goes to
// senders through external sources (RTCAudioSource), and captured audio,
// even silence, would be mixed into every send stream in the process. It
// touches no OS audio device, so it works headless and prompts for nothing.
#pragma once

#include "api/audio/audio_device.h"
#include "api/environment/environment.h"
#include "api/scoped_refptr.h"

namespace wrtc {

// Called once per process by src/runtime.cc. The module keeps its own copy
// of `env` (its task queue factory and clock).
webrtc::scoped_refptr<webrtc::AudioDeviceModule> CreatePlayoutAdm(
    const webrtc::Environment& env);

}  // namespace wrtc
