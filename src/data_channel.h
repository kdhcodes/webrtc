#pragma once

#include <cstdint>
#include <functional>
#include <memory>

#include <napi.h>

#include "napi_safe.h"

#include "api/data_channel_interface.h"
#include "api/dtls_transport_interface.h"
#include "api/peer_connection_interface.h"
#include "api/scoped_refptr.h"
#include "api/sctp_transport_interface.h"

namespace wrtc {

class EventSink;

// Forwards one channel's callbacks into its peer connection's sink. Registered
// as soon as the channel exists (on the signaling thread for remote channels),
// because libwebrtc only buffers incoming messages until an observer is set.
class ChannelObserver : public webrtc::DataChannelObserver {
 public:
  ChannelObserver(std::shared_ptr<EventSink> sink,
                  webrtc::scoped_refptr<webrtc::DataChannelInterface> channel,
                  uint32_t key);

  void OnStateChange() override;
  void OnMessage(const webrtc::DataBuffer& buffer) override;
  void OnBufferedAmountChange(uint64_t sent_data_size) override;

  void Unregister();
  uint32_t key() const { return key_; }

 private:
  // Weak so the sink -> observer -> sink cycle doesn't leak.
  std::weak_ptr<EventSink> sink_;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> channel_;
  uint32_t key_;
  // Signaling thread only. WireChannel's initial-state read and a queued
  // OnStateChange can both observe the same transition; report it once.
  webrtc::DataChannelInterface::DataState last_state_ =
      webrtc::DataChannelInterface::kConnecting;
};

// Registers a ChannelObserver for `channel` and returns its key. If the
// channel is already past "connecting", a dc:state event for its current
// state is emitted. `announce`, if given, runs first on the signaling thread,
// so an event it emits (e.g. "datachannel") precedes that dc:state.
uint32_t WireChannel(
    const std::shared_ptr<EventSink>& sink,
    webrtc::scoped_refptr<webrtc::DataChannelInterface> channel,
    const std::function<void(uint32_t key)>& announce = nullptr);

class DataChannel : public SafeObjectWrap<DataChannel> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  static Napi::Object NewInstance(
      Napi::Env env,
      webrtc::scoped_refptr<webrtc::DataChannelInterface> channel,
      uint32_t key);

  explicit DataChannel(const Napi::CallbackInfo& info);

 private:
  Napi::Value Key(const Napi::CallbackInfo& info);
  Napi::Value Label(const Napi::CallbackInfo& info);
  Napi::Value Ordered(const Napi::CallbackInfo& info);
  Napi::Value MaxPacketLifeTime(const Napi::CallbackInfo& info);
  Napi::Value MaxRetransmits(const Napi::CallbackInfo& info);
  Napi::Value Protocol(const Napi::CallbackInfo& info);
  Napi::Value Negotiated(const Napi::CallbackInfo& info);
  Napi::Value Id(const Napi::CallbackInfo& info);
  Napi::Value ReadyState(const Napi::CallbackInfo& info);
  Napi::Value BufferedAmount(const Napi::CallbackInfo& info);
  Napi::Value MaxSendQueueSize(const Napi::CallbackInfo& info);
  Napi::Value Send(const Napi::CallbackInfo& info);
  Napi::Value Close(const Napi::CallbackInfo& info);

  webrtc::scoped_refptr<webrtc::DataChannelInterface> channel_;
  uint32_t key_ = 0;
};

// Observes a PC's SCTP transport, emitting "sctp:state" (with its key) into
// the sink; the DTLS transport under it has a TransportWatcher like any
// other (src/transport.h). Created, registered, unregistered and destroyed
// on the network thread (where libwebrtc calls it); owned by the EventSink.
class SctpWatcher : public webrtc::SctpTransportObserverInterface {
 public:
  SctpWatcher(std::shared_ptr<EventSink> sink,
              webrtc::scoped_refptr<webrtc::SctpTransportInterface> sctp,
              uint32_t key);

  // Registers the observer and emits the current state. Network thread.
  void Register();
  // Network thread.
  void Unregister();
  webrtc::SctpTransportInterface* sctp() const { return sctp_.get(); }

  void OnStateChange(webrtc::SctpTransportInformation info) override;

 private:
  // Weak so the sink -> watcher -> sink cycle doesn't leak.
  std::weak_ptr<EventSink> sink_;
  webrtc::scoped_refptr<webrtc::SctpTransportInterface> sctp_;
  uint32_t key_;
};

}  // namespace wrtc
