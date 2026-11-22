#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <napi.h>

#include "napi_safe.h"

#include "api/peer_connection_interface.h"
#include "api/rtc_error.h"
#include "api/scoped_refptr.h"
#include "api/stats/rtc_stats_collector_callback.h"

namespace wrtc {

class EventSink;
class PcRtpRegistry;
struct NativeEvent;
struct ReceiverObservers;

// An "op" event completing async operation `op_id`.
std::unique_ptr<NativeEvent> OpEvent(uint32_t op_id, webrtc::RTCError error);

// A stats callback that completes op `op_id` with the report as JSON.
webrtc::scoped_refptr<webrtc::RTCStatsCollectorCallback> MakeStatsCallback(
    std::shared_ptr<EventSink> sink,
    uint32_t op_id);

// The PC as libwebrtc callbacks see it; they need it to capture description
// snapshots. Signaling thread only: set after the PC is created and cleared
// before it is released, both with blocking calls, so a callback never sees
// a dangling pointer. Callbacks don't hold a reference, because the last
// reference being dropped inside one of the PC's own callbacks would destroy
// it mid-call.
struct PcRef {
  webrtc::PeerConnectionInterface* pc = nullptr;
  // Any thread. Set on the JS thread before the PC is closed, so work queued
  // on libwebrtc's threads can skip a closing PC (src/sink_reassert.cc).
  std::atomic<bool> closed{false};

  // Signaling thread only. The SDP of every description the last snapshot
  // serialized, so the next one only serializes what changed (see
  // CaptureSnapshot in peer_connection.cc).
  struct SerializedDescription {
    const webrtc::SessionDescriptionInterface* desc = nullptr;
    uint64_t fingerprint = 0;
    std::string sdp;
  };
  std::vector<SerializedDescription> serialized;

  // Signaling thread only. The receivers' unmute observers
  // (src/receiver_mute.cc), unregistered before the PC is released.
  std::shared_ptr<ReceiverObservers> receiver_observers;
};

// Forwards PeerConnectionObserver callbacks into the sink. Runs on the
// signaling thread.
class PcObserver : public webrtc::PeerConnectionObserver {
 public:
  PcObserver(std::shared_ptr<EventSink> sink, std::shared_ptr<PcRef> pc);

  void OnSignalingChange(
      webrtc::PeerConnectionInterface::SignalingState state) override;
  void OnDataChannel(
      webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) override;
  void OnNegotiationNeededEvent(uint32_t event_id) override;
  void OnStandardizedIceConnectionChange(
      webrtc::PeerConnectionInterface::IceConnectionState state) override;
  void OnConnectionChange(
      webrtc::PeerConnectionInterface::PeerConnectionState state) override;
  void OnIceGatheringChange(
      webrtc::PeerConnectionInterface::IceGatheringState state) override;
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override;
  void OnIceCandidateError(const std::string& address,
                           int port,
                           const std::string& url,
                           int error_code,
                           const std::string& error_text) override;
  void OnTrack(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>
                   transceiver) override;
  void OnRemoveTrack(
      webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver) override;

 private:
  std::shared_ptr<EventSink> sink_;
  std::shared_ptr<PcRef> pc_;
};

// new PeerConnection(config, onEvent)
class PeerConnection : public SafeObjectWrap<PeerConnection> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);

  explicit PeerConnection(const Napi::CallbackInfo& info);
  ~PeerConnection() override;

 private:
  Napi::Value CreateOffer(const Napi::CallbackInfo& info);
  Napi::Value CreateAnswer(const Napi::CallbackInfo& info);
  Napi::Value SetLocalDescription(const Napi::CallbackInfo& info);
  Napi::Value SetRemoteDescription(const Napi::CallbackInfo& info);
  Napi::Value AddIceCandidate(const Napi::CallbackInfo& info);
  Napi::Value CreateDataChannel(const Napi::CallbackInfo& info);
  Napi::Value GetStats(const Napi::CallbackInfo& info);
  Napi::Value SignalingState(const Napi::CallbackInfo& info);
  Napi::Value ConnectionState(const Napi::CallbackInfo& info);
  Napi::Value IceConnectionState(const Napi::CallbackInfo& info);
  Napi::Value IceGatheringState(const Napi::CallbackInfo& info);
  Napi::Value Close(const Napi::CallbackInfo& info);
  Napi::Value SetConfiguration(const Napi::CallbackInfo& info);
  Napi::Value RestartIce(const Napi::CallbackInfo& info);
  Napi::Value AddTrack(const Napi::CallbackInfo& info);
  Napi::Value RemoveTrack(const Napi::CallbackInfo& info);
  Napi::Value AddTransceiver(const Napi::CallbackInfo& info);
  Napi::Value GetTransceivers(const Napi::CallbackInfo& info);
  Napi::Value ShouldFireNegotiationNeededEvent(const Napi::CallbackInfo& info);
  Napi::Value QueueTask(const Napi::CallbackInfo& info);

  // Closes the PC, unregisters channel observers, stops the event stream
  // from keeping the process alive and weakens the RTP handles. Idempotent.
  // With `release` (destructor, env cleanup) also releases the event stream.
  // The cleanup hook is needed because on env teardown (e.g.
  // worker.terminate()) Node finalizes the event TSFN before this object's
  // destructor runs.
  void DoClose(bool release);
  static void OnEnvCleanup(void* self);

  bool closed_ = false;
  bool cleanup_hook_registered_ = false;
  std::shared_ptr<EventSink> sink_;
  std::shared_ptr<PcRef> pc_ref_;
  // Owned here, on the JS thread, and lent to sink_ (see EventSink::rtp()).
  // Outlives close() because getTransceivers() must keep working after it.
  std::unique_ptr<PcRtpRegistry> rtp_;
  // Declared before pc_ so it is destroyed after it; libwebrtc requires the
  // observer to outlive the connection.
  std::unique_ptr<PcObserver> observer_;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc_;
};

}  // namespace wrtc
