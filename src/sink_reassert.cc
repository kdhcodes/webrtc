// The libwebrtc bug (upstream M150, 05e02da, branch-heads/7871; PLAN.md
// "Gotchas"; upstream report draft in
// docs/upstream/libwebrtc-default-sink-nulled.md):
//
// 1. An SLD/SRD that changes a video m-section's decoders (e.g. sendrecv to
//    recvonly after removeTrack: a recvonly offer lists decoder-only
//    formats) makes WebRtcVideoReceiveStream::RecreateReceiveStream destroy
//    and recreate the receive stream (media/engine/webrtc_video_engine.cc:
//    3718-3752).
// 2. An RTP packet the network thread had already resolved to the old
//    stream (call/call.cc:1447-1453) reaches the worker after that, finds
//    its sink gone and goes to the undemuxable handler (call/call.cc:
//    1493-1501), which treats it as unsignaled.
// 3. ReCreateDefaultReceiveStream (webrtc_video_engine.cc:3381-3412) can't
//    add a default stream for that SSRC ("already exists": it's signaled),
//    but still calls SetSink(ssrc, default_sink_) (:3411), and with no
//    unsignaled receiver default_sink_ is nullptr. That nulls the signaled
//    stream's sink: it keeps decoding, and no frame reaches the track.
// 4. Nothing restores it: VideoRtpReceiver only sets its sink on setup or
//    an SSRC change (pc/video_rtp_receiver.cc:140-141 returns early when
//    the SSRC is unchanged).
//
// The workaround: after every successful SLD/SRD, set each video receiver's
// sink again, on the worker, exactly as the receiver itself does when it is
// set up (VideoRtpReceiver::GetRestartFunctionForMediaChannel_w): the
// receiver's signaled SSRC to its VideoRtpTrackSource's sink. The task hops
// through the network thread first. The SLD/SRD posted its demuxer changes
// there before it completed, so by the time the hop runs, every packet
// resolved against the old demuxer state has had its worker task posted,
// and ours lands after all of them. It's idempotent: re-setting the sink the
// receiver already has changes nothing.
//
// Assumptions, from libwebrtc's own headers (pc/, media/; not its public
// API), each checked where it's used and skipped silently when it fails:
// - a video receiver is an RtpReceiverProxyWithInternal<RtpReceiverInternal>
//   over a VideoRtpReceiver, whose track's source is a
//   VideoTrackSourceProxyWithInternal<VideoTrackSourceInterface> over a
//   VideoRtpTrackSource (dynamic_cast: libwebrtc is built with use_rtti; a
//   build without would lack the typeinfo symbols this needs, which
//   scripts/check-undefined.sh turns into a build failure)
// - RtpReceiverInternal::media_channel() and ssrc() are worker-thread state;
//   media_channel() is nullptr once the channel is gone, and ssrc() falls
//   back to the unsignaled stream's SSRC, which the default sink serves
//   (skipped)
// - VideoRtpTrackSource::sink() is the pointer the receiver passes to
//   SetSink, and lives as long as the source (we hold a reference)
// The references are dropped on the signaling thread, where libwebrtc
// destroys receivers and sources. Nothing here touches Node-API.
//
// Not covered, since nothing we expose reaches them yet (recheck if they get
// wired to native):
// - StopReceiveStream (reached from SetReceive(false)) also recreates the
//   stream (webrtc_video_engine.cc:3774-3779), outside any SLD/SRD, so
//   nothing re-asserts after it.
// - ReCreateDefaultReceiveStream also resets the stream's base minimum
//   playout delay (:3405-3410); only the sink is restored here.
//
// Remove this when a libwebrtc upgrade no longer has RecreateReceiveStream
// (upstream removed it in 6ded798, main@{#48423}, 2026-08-25: the
// static_assert below fails then) or upstream fixes ReCreateDefaultReceive-
// Stream's SetSink(nullptr) (still there after 6ded798). Re-check the line
// references and assumptions above on every libwebrtc upgrade.
#include "sink_reassert.h"

#include <cstdint>
#include <optional>
#include <utility>
#include <vector>

#include "api/media_stream_interface.h"
#include "api/media_types.h"
#include "api/rtp_receiver_interface.h"
#include "api/rtp_transceiver_interface.h"
#include "api/scoped_refptr.h"
#include "call/video_receive_stream.h"
#include "media/base/media_channel.h"
#include "pc/rtp_receiver.h"
#include "pc/rtp_receiver_proxy.h"
#include "pc/video_rtp_receiver.h"
#include "pc/video_rtp_track_source.h"
#include "pc/video_track_source_proxy.h"
#include "peer_connection.h"
#include "runtime.h"

namespace wrtc {
namespace {

// webrtc 6ded798 ("Avoid recreating VideoReceiveStream on decoder updates")
// added VideoReceiveStreamInterface::SetDecoders and removed
// RecreateReceiveStream, the trigger this works around.
template <typename Stream>
concept HasSetDecoders = requires(Stream& stream) {
  stream.SetDecoders(std::vector<typename Stream::Decoder>());
};
struct WithSetDecoders {
  struct Decoder {};
  void SetDecoders(std::vector<Decoder>);
};
static_assert(HasSetDecoders<WithSetDecoders>);
static_assert(!HasSetDecoders<webrtc::VideoReceiveStreamInterface>,
              "This libwebrtc no longer recreates video receive streams on "
              "decoder changes (webrtc 6ded798). Check whether "
              "src/sink_reassert.cc is still needed (see its header).");

struct Target {
  webrtc::scoped_refptr<webrtc::RtpReceiverInternal> receiver;
  webrtc::scoped_refptr<webrtc::VideoRtpTrackSource> source;
};

using ReceiverProxy =
    webrtc::RtpReceiverProxyWithInternal<webrtc::RtpReceiverInternal>;
using SourceProxy = webrtc::VideoTrackSourceProxyWithInternal<
    webrtc::VideoTrackSourceInterface>;

// Signaling thread. The receiver and source behind a video receiver, or
// nothing if it isn't the kind of receiver this was written against.
std::optional<Target> VideoTarget(
    const webrtc::scoped_refptr<webrtc::RtpReceiverInterface>& receiver) {
  if (!receiver || receiver->media_type() != webrtc::MediaType::VIDEO) {
    return std::nullopt;
  }
  auto* proxy = dynamic_cast<ReceiverProxy*>(receiver.get());
  if (proxy == nullptr ||
      dynamic_cast<webrtc::VideoRtpReceiver*>(proxy->internal()) == nullptr) {
    return std::nullopt;
  }
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track =
      receiver->track();
  auto* video = dynamic_cast<webrtc::VideoTrackInterface*>(track.get());
  if (video == nullptr) {
    return std::nullopt;
  }
  auto* source_proxy = dynamic_cast<SourceProxy*>(video->GetSource());
  if (source_proxy == nullptr) {
    return std::nullopt;
  }
  auto* source =
      dynamic_cast<webrtc::VideoRtpTrackSource*>(source_proxy->internal());
  if (source == nullptr) {
    return std::nullopt;
  }
  return Target{
      webrtc::scoped_refptr<webrtc::RtpReceiverInternal>(proxy->internal()),
      webrtc::scoped_refptr<webrtc::VideoRtpTrackSource>(source)};
}

// Worker thread: what VideoRtpReceiver::GetRestartFunctionForMediaChannel_w
// sets for a signaled SSRC.
void Reassert(const Target& target) {
  webrtc::MediaReceiveChannelInterface* channel =
      target.receiver->media_channel();
  if (channel == nullptr || channel->media_type() != webrtc::MediaType::VIDEO) {
    return;
  }
  auto* video =
      dynamic_cast<webrtc::VideoMediaReceiveChannelInterface*>(channel);
  if (video == nullptr) {
    return;
  }
  std::optional<uint32_t> ssrc = target.receiver->ssrc();
  if (!ssrc || channel->GetUnsignaledSsrc() == ssrc) {
    return;
  }
  video->SetSink(*ssrc, target.source->sink());
}

}  // namespace

void ReassertVideoSinks(const std::shared_ptr<PcRef>& pc) {
  if (pc->pc == nullptr || pc->closed.load()) {
    return;
  }
  std::vector<Target> targets;
  for (const auto& transceiver : pc->pc->GetTransceivers()) {
    if (transceiver->media_type() != webrtc::MediaType::VIDEO ||
        transceiver->stopped()) {
      continue;
    }
    if (std::optional<Target> target = VideoTarget(transceiver->receiver())) {
      targets.push_back(std::move(*target));
    }
  }
  if (targets.empty()) {
    return;
  }
  NetworkThread()->PostTask([pc, targets = std::move(targets)]() mutable {
    WorkerThread()->PostTask(
        [pc = std::move(pc), targets = std::move(targets)]() mutable {
          // A close() that started since is still serialized with this on
          // the worker (channels are cleared there); this only skips work.
          if (!pc->closed.load()) {
            for (const Target& target : targets) {
              Reassert(target);
            }
          }
          SignalingThread()->PostTask([targets = std::move(targets)] {});
        });
  });
}

}  // namespace wrtc
