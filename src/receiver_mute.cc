// Chrome unmutes a remote track on the same signal
// (third_party/blink/renderer/modules/peerconnection/rtc_rtp_receiver_impl.cc,
// RTCRtpReceiverInternal::OnFirstPacketReceivedAfterReceptiveChange).
// libwebrtc sends it once per [[Receptive]] period (pc/rtp_transceiver.cc,
// RtpTransceiver::OnPacketReceived and set_receptive, M150 05e02da), so a
// track muted by a renegotiation unmutes again when media resumes after the
// next one, and not before. OnFirstPacketReceived, by contrast, fires once per
// receiver lifetime.
#include "receiver_mute.h"

#include <algorithm>
#include <utility>
#include <vector>

#include "api/media_types.h"
#include "api/rtp_receiver_interface.h"
#include "api/scoped_refptr.h"
#include "event_sink.h"
#include "peer_connection.h"

namespace wrtc {

class ReceiverObserver : public webrtc::RtpReceiverObserverInterface {
 public:
  ReceiverObserver(std::shared_ptr<EventSink> sink,
                   const PcRef* pc,
                   webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver)
      : sink_(std::move(sink)), pc_(pc), receiver_(std::move(receiver)) {}

  const webrtc::scoped_refptr<webrtc::RtpReceiverInterface>& receiver() const {
    return receiver_;
  }

  // Replayed by SetObserver when packets already arrived; not used.
  void OnFirstPacketReceived(webrtc::MediaType) override {}

  // Signaling thread.
  void OnFirstPacketReceivedAfterReceptiveChange(webrtc::MediaType) override {
    if (pc_->closed.load()) {
      return;
    }
    auto ev = std::make_unique<NativeEvent>();
    ev->kind = "receiver:unmute";
    ev->receiver = receiver_;
    sink_->Emit(std::move(ev));
  }

 private:
  std::shared_ptr<EventSink> sink_;
  // Owns this observer (through ReceiverObservers), so outlives it.
  const PcRef* pc_;
  webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver_;
};

struct ReceiverObservers {
  std::vector<std::unique_ptr<ReceiverObserver>> list;
};

void ObserveReceivers(const std::shared_ptr<EventSink>& sink, PcRef& pc) {
  if (pc.pc == nullptr || pc.closed.load()) {
    return;
  }
  if (!pc.receiver_observers) {
    pc.receiver_observers = std::make_shared<ReceiverObservers>();
  }
  auto& list = pc.receiver_observers->list;
  std::vector<std::unique_ptr<ReceiverObserver>> next;
  for (const auto& transceiver : pc.pc->GetTransceivers()) {
    webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver =
        transceiver->receiver();
    auto it = std::find_if(list.begin(), list.end(), [&](const auto& o) {
      return o && o->receiver() == receiver;
    });
    if (it != list.end()) {
      next.push_back(std::move(*it));
      continue;
    }
    auto observer = std::make_unique<ReceiverObserver>(sink, &pc, receiver);
    // The proxy calls straight through on the signaling thread.
    receiver->SetObserver(observer.get());
    next.push_back(std::move(observer));
  }
  // Receivers of removed transceivers.
  for (auto& observer : list) {
    if (observer) {
      observer->receiver()->SetObserver(nullptr);
    }
  }
  list = std::move(next);
}

void UnobserveReceivers(PcRef& pc) {
  if (!pc.receiver_observers) {
    return;
  }
  for (auto& observer : pc.receiver_observers->list) {
    observer->receiver()->SetObserver(nullptr);
  }
  pc.receiver_observers.reset();
}

}  // namespace wrtc
