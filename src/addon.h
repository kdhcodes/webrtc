#pragma once

#include <memory>

#include <napi.h>

namespace wrtc {

struct TrackRegistry;
struct EventOrder;

// Per-environment state (env.GetInstanceData), so the addon works in workers.
// Constructor references for classes that native code instantiates go here.
struct AddonData {
  Napi::FunctionReference data_channel_ctor;
  std::shared_ptr<TrackRegistry> tracks;
  // The delivery order of every peer connection's events (event_sink.h).
  std::shared_ptr<EventOrder> event_order;
  // Set by Transceiver/Sender/Receiver::Init; used by WP-R's RtpRegistry to
  // create handles from native code.
  Napi::FunctionReference transceiver_ctor;
  Napi::FunctionReference sender_ctor;
  Napi::FunctionReference receiver_ctor;
};

}  // namespace wrtc
