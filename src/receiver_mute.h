// Tells JS when media starts arriving for a receiver, so it can unmute the
// receiver's track (SPEC-LAYER-PLAN.md, "MediaStreamTrack"). Mechanical: the
// muted state itself lives in JS.
#pragma once

#include <memory>

namespace wrtc {

class EventSink;
struct PcRef;

// Signaling thread, in a successful SLD's or SRD's completion callback.
// Observes every receiver the PC has that isn't observed yet, and stops
// observing those it no longer has. Each observer emits a "receiver:unmute"
// event (with the receiver) on libwebrtc's
// OnFirstPacketReceivedAfterReceptiveChange: the first RTP packet after the
// transceiver's [[Receptive]] became true. Does nothing once the PC is
// closed or released.
//
// [[Receptive]] only becomes true while an SLD or SRD is applied, and the
// network thread posts the notification to the signaling thread, so it can
// only run after the completion callback that registered the observer.
void ObserveReceivers(const std::shared_ptr<EventSink>& sink, PcRef& pc);

// Signaling thread. Unregisters every observer. Called before the PC is
// released: libwebrtc requires SetObserver(nullptr) before an observer is
// destroyed, and a receiver JS still holds can outlive the PC.
void UnobserveReceivers(PcRef& pc);

}  // namespace wrtc
