#include "transport.h"

#include <utility>

#include "api/jsep.h"
#include "api/peer_connection_interface.h"
#include "api/sctp_transport_interface.h"
#include "api/transport/enums.h"
#include "event_sink.h"
#include "p2p/base/ice_transport_internal.h"
#include "p2p/base/transport_description.h"
#include "peer_connection.h"
#include "rtc_base/buffer.h"
#include "rtc_base/ssl_certificate.h"
#include "runtime.h"

namespace wrtc {
namespace {

const char* DtlsStateString(webrtc::DtlsTransportState state) {
  switch (state) {
    case webrtc::DtlsTransportState::kNew:
      return "new";
    case webrtc::DtlsTransportState::kConnecting:
      return "connecting";
    case webrtc::DtlsTransportState::kConnected:
      return "connected";
    case webrtc::DtlsTransportState::kClosed:
      return "closed";
    case webrtc::DtlsTransportState::kFailed:
    case webrtc::DtlsTransportState::kNumValues:
      break;
  }
  return "failed";
}

const char* IceStateString(webrtc::IceTransportState state) {
  switch (state) {
    case webrtc::IceTransportState::kNew:
      return "new";
    case webrtc::IceTransportState::kChecking:
      return "checking";
    case webrtc::IceTransportState::kConnected:
      return "connected";
    case webrtc::IceTransportState::kCompleted:
      return "completed";
    case webrtc::IceTransportState::kFailed:
      return "failed";
    case webrtc::IceTransportState::kDisconnected:
      return "disconnected";
    case webrtc::IceTransportState::kClosed:
      break;
  }
  return "closed";
}

const char* GatheringString(webrtc::IceGatheringState state) {
  switch (state) {
    case webrtc::kIceGatheringNew:
      return "new";
    case webrtc::kIceGatheringGathering:
      return "gathering";
    case webrtc::kIceGatheringComplete:
      break;
  }
  return "complete";
}

const char* IceRoleString(webrtc::IceRole role) {
  switch (role) {
    case webrtc::ICEROLE_CONTROLLING:
      return "controlling";
    case webrtc::ICEROLE_CONTROLLED:
      return "controlled";
    case webrtc::ICEROLE_UNKNOWN:
      break;
  }
  return "unknown";
}

}  // namespace

TransportWatcher::TransportWatcher(
    std::shared_ptr<EventSink> sink,
    webrtc::scoped_refptr<webrtc::DtlsTransportInterface> dtls,
    uint32_t key)
    : sink_(sink),
      dtls_(std::move(dtls)),
      key_(key),
      self_(std::make_shared<TransportWatcher*>(this)) {}

TransportWatcher::~TransportWatcher() = default;

webrtc::IceTransportInternal* TransportWatcher::Ice() {
  auto ice = dtls_->ice_transport();
  return ice ? ice->internal() : nullptr;
}

void TransportWatcher::Register() {
  dtls_->RegisterObserver(this);
  webrtc::IceTransportInternal* ice = Ice();
  if (ice != nullptr) {
    name_ = ice->transport_name();
    subscribed_ = ice;
    std::weak_ptr<TransportWatcher*> weak = self_;
    auto refresh = [weak] {
      if (auto self = weak.lock()) {
        (*self)->Refresh();
      }
    };
    ice->SubscribeIceTransportStateChanged(
        this, [refresh](webrtc::IceTransportInternal*) { refresh(); });
    // The selected candidate pair changes with the network route (as in
    // Chrome's IceTransportAdapterImpl). The pair-change callback itself
    // takes a single receiver, which JsepTransportController already is.
    ice->SubscribeNetworkRouteChanged(
        this, [refresh](std::optional<webrtc::NetworkRoute>) { refresh(); });
    // A role conflict flips the role (the controller's receiver, subscribed
    // earlier, has done so by the time this one runs).
    ice->SubscribeRoleConflict(
        this, [refresh](webrtc::IceTransportInternal*) { refresh(); });
    ice->AddGatheringStateCallback(
        this, [refresh](webrtc::IceTransportInternal*) { refresh(); });
  }
  // Read in the same network-thread task as the registrations, where every
  // callback also runs, so no change is missed.
  OnStateChange(dtls_->Information());
}

void TransportWatcher::Unregister() {
  dtls_->UnregisterObserver();
  // The state and role callbacks can't be removed; resetting self_ makes
  // them no-ops.
  if (subscribed_ != nullptr && Ice() == subscribed_) {
    subscribed_->UnsubscribeNetworkRouteChanged(this);
    subscribed_->RemoveGatheringStateCallback(this);
  }
  subscribed_ = nullptr;
  self_.reset();
}

std::string TransportWatcher::IceRole() {
  webrtc::IceTransportInternal* ice = Ice();
  if (ice != nullptr) {
    return IceRoleString(ice->GetIceRole());
  }
  return last_ ? last_->role : "unknown";
}

std::string TransportWatcher::IceState() {
  webrtc::IceTransportInternal* ice = Ice();
  return ice != nullptr ? IceStateString(ice->GetIceTransportState())
                        : "closed";
}

void TransportWatcher::CheckDropped() {
  if (self_ && last_ && last_->state != "closed" && Ice() == nullptr) {
    EmitIce();
  }
}

void TransportWatcher::Refresh() {
  if (!self_) {
    return;
  }
  OnStateChange(dtls_->Information());
}

void TransportWatcher::EmitIce() {
  auto sink = sink_.lock();
  if (!sink) {
    return;
  }
  IceInfo info;
  webrtc::IceTransportInternal* ice = Ice();
  if (ice == nullptr) {
    // Dropped by libwebrtc: the spec's "closed".
    subscribed_ = nullptr;
    info.state = "closed";
    info.role = last_ ? last_->role : "unknown";
    info.gathering = last_ ? last_->gathering : "new";
  } else {
    info.state = IceStateString(ice->GetIceTransportState());
    info.role = IceRoleString(ice->GetIceRole());
    info.gathering = GatheringString(ice->gathering_state());
    if (auto pair = ice->GetSelectedCandidatePair()) {
      info.local =
          webrtc::IceCandidate(name_, 0, pair->local_candidate()).ToString();
      info.remote =
          webrtc::IceCandidate(name_, 0, pair->remote_candidate()).ToString();
    }
  }
  if (last_ && *last_ == info) {
    return;
  }
  last_ = info;
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "ice:state";
  ev->transport_key = key_;
  ev->state = info.state;
  ev->ice_role = info.role;
  ev->ice_gathering = info.gathering;
  ev->ice_name = name_;
  ev->pair_local = info.local;
  ev->pair_remote = info.remote;
  sink->QueueTransportEvent(std::move(ev));
}

void TransportWatcher::OnStateChange(webrtc::DtlsTransportInformation info) {
  auto sink = sink_.lock();
  if (!sink) {
    return;
  }
  std::string state = DtlsStateString(info.state());
  if (state == last_dtls_) {
    // A Refresh() reported it already; the ICE state may still have moved.
    EmitIce();
    return;
  }
  last_dtls_ = state;
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "dtls:state";
  ev->transport_key = key_;
  ev->state = state;
  if (const webrtc::SSLCertChain* chain = info.remote_ssl_certificates()) {
    for (size_t i = 0; i < chain->GetSize(); i++) {
      webrtc::Buffer der;
      chain->Get(i).ToDER(&der);
      ev->certificates.emplace_back(der.data(), der.data() + der.size());
    }
  }
  sink->QueueTransportEvent(std::move(ev));
  // Clear() reports "closed" once it has dropped the ICE transport.
  EmitIce();
}

void TransportWatcher::OnError(webrtc::RTCError error) {
  if (auto sink = sink_.lock()) {
    auto ev = std::make_unique<NativeEvent>();
    ev->kind = "dtls:error";
    ev->transport_key = key_;
    ev->error = std::move(error);
    sink->QueueTransportEvent(std::move(ev));
  }
}

void WatchTransports(const std::shared_ptr<EventSink>& sink,
                     const PcRef& pc,
                     DescriptionSnapshot* snapshot) {
  webrtc::PeerConnectionInterface* raw = pc.pc;
  if (raw == nullptr || snapshot == nullptr) {
    return;
  }
  // GetSctpTransport() is a network-thread method of the PC proxy, so it
  // runs inline here. Blocking the signaling thread on the network thread
  // is the direction libwebrtc itself uses.
  std::vector<std::unique_ptr<NativeEvent>> first_reports;
  NetworkThread()->BlockingCall([&] {
    sink->CollectTransportEvents(&first_reports);
    auto [sctp_key, sctp_dtls] = sink->WatchSctp(raw->GetSctpTransport());
    snapshot->sctp_key = sctp_key;
    snapshot->sctp_transport = sink->WatchTransport(sctp_dtls);
    for (TransceiverState& t : snapshot->transceivers) {
      t.sender_transport = sink->WatchTransport(t.sender_dtls);
      t.receiver_transport = sink->WatchTransport(t.receiver_dtls);
      // Released here, where the watchers hold theirs: the snapshot is
      // destroyed on the JS thread, and libwebrtc's transports belong to
      // this one.
      t.sender_dtls = nullptr;
      t.receiver_dtls = nullptr;
    }
    sink->CollectTransportEvents(nullptr);
    // A transport this description dropped while its DTLS was closed
    // already reported nothing; its ICE "closed" goes in the queue.
    sink->CheckDroppedTransports();
    std::vector<uint32_t> keys = {snapshot->sctp_transport};
    for (const TransceiverState& t : snapshot->transceivers) {
      keys.push_back(t.sender_transport);
      keys.push_back(t.receiver_transport);
    }
    for (uint32_t key : keys) {
      bool seen = key == 0;
      for (const auto& entry : snapshot->ice_roles) {
        seen = seen || entry.first == key;
      }
      if (!seen) {
        snapshot->ice_roles.emplace_back(key, sink->IceRole(key));
      }
    }
  });
  // The new watchers' first reports, ahead of the completion.
  for (auto& event : first_reports) {
    sink->Emit(std::move(event));
  }
}

}  // namespace wrtc
