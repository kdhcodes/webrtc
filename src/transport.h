// The peer connection's DTLS and ICE transports, for the spec layer's
// RTCDtlsTransport and RTCIceTransport objects.
//
// Each DTLS transport a sender, receiver or the SCTP transport uses gets a
// TransportWatcher and a per-PC key (1, 2, ...), which snapshots carry and
// the "dtls:state", "dtls:error" and "ice:state" events name, so the JS
// layer can keep one object per transport. Everything here runs on the
// network thread, where libwebrtc's transports live and call back.
#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>

#include "api/dtls_transport_interface.h"
#include "api/rtc_error.h"
#include "api/scoped_refptr.h"

namespace webrtc {
class IceTransportInternal;
}

namespace wrtc {

class EventSink;
struct DescriptionSnapshot;
struct PcRef;

// Observes one DTLS transport and the ICE transport under it. Created,
// registered, unregistered and destroyed on the network thread; owned by the
// EventSink.
class TransportWatcher : public webrtc::DtlsTransportObserverInterface {
 public:
  TransportWatcher(std::shared_ptr<EventSink> sink,
                   webrtc::scoped_refptr<webrtc::DtlsTransportInterface> dtls,
                   uint32_t key);
  ~TransportWatcher() override;

  // Registers the observers and emits the current DTLS and ICE states.
  void Register();
  // Emits "dtls:state" and "ice:state" if the state (or the ICE role or
  // selected pair) changed since the last ones. What the ICE callbacks
  // (state, network route, role conflict) call.
  void Refresh();
  void Unregister();

  uint32_t key() const { return key_; }
  // The ICE transport's role, or the last one reported once it's gone.
  std::string IceRole();
  // Its state as libwebrtc has it now ("closed" once dropped).
  std::string IceState();
  // Emits the ICE transport's "closed" if libwebrtc dropped it without a
  // DTLS state change saying so (DtlsTransport::Clear() notifies only when
  // DTLS wasn't closed already, e.g. by the remote).
  void CheckDropped();
  webrtc::DtlsTransportInterface* dtls() const { return dtls_.get(); }

  void OnStateChange(webrtc::DtlsTransportInformation info) override;
  void OnError(webrtc::RTCError error) override;

 private:
  struct IceInfo {
    std::string state;
    std::string gathering;
    std::string role;
    std::optional<std::string> local;
    std::optional<std::string> remote;
    bool operator==(const IceInfo&) const = default;
  };

  // The ICE transport, or null once libwebrtc dropped it: DtlsTransport::
  // Clear() (its JsepTransport is being destroyed: bundled away, rolled back
  // or the PC closed) unsets it before the ICE transport is destroyed, in
  // the same network-thread task.
  webrtc::IceTransportInternal* Ice();
  void EmitIce();

  // Weak so the sink -> watcher -> sink cycle doesn't leak.
  std::weak_ptr<EventSink> sink_;
  webrtc::scoped_refptr<webrtc::DtlsTransportInterface> dtls_;
  uint32_t key_;
  // The ICE transport's name: the mid of the m-section that created it.
  std::string name_;
  // What the ICE callbacks hold: libwebrtc has no way to unsubscribe from
  // some of them, so they may outlive the watcher, and then do nothing.
  std::shared_ptr<TransportWatcher*> self_;
  // The ICE transport the callbacks are subscribed on, while it exists.
  webrtc::IceTransportInternal* subscribed_ = nullptr;
  std::optional<IceInfo> last_;
  // The last "dtls:state" emitted.
  std::string last_dtls_;
};

// Signaling thread, after an SLD/SRD completed and `snapshot` (a full one)
// was captured, before its completion is emitted. In one blocking call to
// the network thread: starts watching the PC's SCTP transport and every DTLS
// transport the snapshot's senders and receivers use, and fills in the
// snapshot's transport keys and ICE roles (libwebrtc sets a role without a
// callback). Then emits the new watchers' first reports, so they precede the
// completion. Changes of transports watched already stay queued: a
// connection state change they cause carries them.
void WatchTransports(const std::shared_ptr<EventSink>& sink,
                     const PcRef& pc,
                     DescriptionSnapshot* snapshot);

}  // namespace wrtc
