// Process-wide libwebrtc state: the three threads and the factory.
#pragma once

#include "api/peer_connection_interface.h"
#include "api/scoped_refptr.h"
#include "rtc_base/thread.h"

namespace wrtc {

// Created on first use and never destroyed. libwebrtc threads are still
// running when Node exits, and tearing them down from static destructors is
// riskier than letting the process exit with them.
webrtc::PeerConnectionFactoryInterface* Factory();

// The signaling thread the factory was created with; PC and DC observer
// callbacks run on it.
webrtc::Thread* SignalingThread();

// The network thread the factory was created with. libwebrtc's SCTP and DTLS
// transport objects live on it (they aren't proxied), so registering their
// observers has to happen there.
webrtc::Thread* NetworkThread();

// The factory's worker thread. Media channels live on it, and so does the
// worker-thread state of RTP receivers (src/sink_reassert.cc).
webrtc::Thread* WorkerThread();

}  // namespace wrtc
