// Works around a libwebrtc race that leaves a remote video track without
// frames for good after a renegotiation. See sink_reassert.cc for the bug,
// the workaround's assumptions and when to remove it.
#pragma once

#include <memory>

namespace wrtc {

struct PcRef;

// Signaling thread, when an SLD or SRD has succeeded. Re-sets each video
// receiver's sink on the worker thread, after any RTP packet already in
// flight there. Does nothing once the PC is closed.
void ReassertVideoSinks(const std::shared_ptr<PcRef>& pc);

}  // namespace wrtc
