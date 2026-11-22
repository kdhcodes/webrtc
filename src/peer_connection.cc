#include "peer_connection.h"
#include "napi_safe.h"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/set_local_description_observer_interface.h"
#include "api/set_remote_description_observer_interface.h"
#include "api/stats/rtc_stats_collector_callback.h"
#include "api/stats/rtc_stats_report.h"
#include "certificate.h"
#include "data_channel.h"
#include "event_sink.h"
#include "media_track.h"
#include "receiver_mute.h"
#include "rtp.h"
#include "runtime.h"
#include "sink_reassert.h"
#include "transport.h"
#include "util.h"

namespace wrtc {

using PCI = webrtc::PeerConnectionInterface;

std::unique_ptr<NativeEvent> OpEvent(uint32_t op_id, webrtc::RTCError error) {
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "op";
  ev->op_id = op_id;
  ev->error = std::move(error);
  return ev;
}

namespace {

// FNV-1a, for the fingerprint below.
void Mix(uint64_t* hash, std::string_view bytes) {
  for (unsigned char c : bytes) {
    *hash = (*hash ^ c) * 0x100000001b3ULL;
  }
  *hash = (*hash ^ 0xff) * 0x100000001b3ULL;  // field separator
}

// What can change in a description that is already installed, without it
// being replaced by a new object: libwebrtc only edits installed
// descriptions to add or remove ICE candidates (AddLocalIceCandidate,
// RemoveLocalIceCandidates, AddIceCandidateInternal, RemoveIceCandidate and
// CopyCandidatesFromSessionDescription in pc/sdp_offer_answer.cc, M150
// 05e02da),
// so the candidates are part of the fingerprint. The rest guards against a
// new description reusing a freed one's address, which can't happen
// between two snapshots anyway: a new description is always allocated
// before the operation that frees the one it replaces, and every
// operation that replaces one ends in a snapshot or, if it failed, clears
// the cache (DescriptionOpEvent).
uint64_t Fingerprint(const webrtc::SessionDescriptionInterface* desc) {
  uint64_t hash = 0xcbf29ce484222325ULL;
  Mix(&hash, webrtc::SdpTypeToString(desc->GetType()));
  Mix(&hash, desc->id());
  Mix(&hash, desc->version());
  auto inner = reinterpret_cast<uintptr_t>(desc->description());
  Mix(&hash,
      std::string_view(reinterpret_cast<const char*>(&inner), sizeof(inner)));
  size_t sections = desc->number_of_mediasections();
  for (size_t i = 0; i < sections; i++) {
    const webrtc::IceCandidateCollection* candidates = desc->candidates(i);
    size_t count = candidates == nullptr ? 0 : candidates->count();
    Mix(&hash, std::to_string(count));
    for (size_t j = 0; j < count; j++) {
      Mix(&hash, candidates->at(j)->ToString());
    }
  }
  return hash;
}

// Serializing a description is most of a snapshot's cost (about 14-17% of
// the signaling thread during renegotiation, bench/RESULTS.md), and most
// of a snapshot's descriptions are unchanged since the previous one:
// local/remoteDescription is always the pending or current one, and an
// SLD/SRD replaces at most one or two of them. So each description is
// serialized once and reused from `ref.serialized` while it is the same,
// unchanged object. `next` collects what this snapshot saw.
std::optional<DescriptionData> CopyDescription(
    PcRef& ref,
    std::vector<PcRef::SerializedDescription>* next,
    const webrtc::SessionDescriptionInterface* desc) {
  if (desc == nullptr) {
    return std::nullopt;
  }
  DescriptionData data;
  data.type = webrtc::SdpTypeToString(desc->GetType());
  for (const auto& seen : *next) {
    if (seen.desc == desc) {
      data.sdp = seen.sdp;
      return data;
    }
  }
  uint64_t fingerprint = Fingerprint(desc);
  for (const auto& cached : ref.serialized) {
    if (cached.desc == desc && cached.fingerprint == fingerprint) {
      data.sdp = cached.sdp;
      break;
    }
  }
  if (data.sdp.empty()) {
    desc->ToString(&data.sdp);
  }
  next->push_back({desc, fingerprint, data.sdp});
  return data;
}

// Signaling thread only (the description getters bypass the proxy, and the
// transceiver reads must be atomic with the operation that just completed).
// `full` adds the signaling state and every transceiver's state, for SLD/SRD
// completions.
std::unique_ptr<DescriptionSnapshot> CaptureSnapshot(PcRef& ref, bool full) {
  PCI* pc = ref.pc;
  auto snap = std::make_unique<DescriptionSnapshot>();
  std::vector<PcRef::SerializedDescription> next;
  snap->local = CopyDescription(ref, &next, pc->local_description());
  snap->current_local =
      CopyDescription(ref, &next, pc->current_local_description());
  snap->pending_local =
      CopyDescription(ref, &next, pc->pending_local_description());
  snap->remote = CopyDescription(ref, &next, pc->remote_description());
  snap->current_remote =
      CopyDescription(ref, &next, pc->current_remote_description());
  snap->pending_remote =
      CopyDescription(ref, &next, pc->pending_remote_description());
  ref.serialized = std::move(next);
  if (!full) {
    return snap;
  }
  snap->signaling_state = std::string(PCI::AsString(pc->signaling_state()));
  snap->has_transceivers = true;
  snap->rtp_epoch = BeginRtpSnapshot();
  for (auto& t : pc->GetTransceivers()) {
    TransceiverState state;
    state.transceiver = t;
    state.mid = t->mid();
    state.direction = DirectionToString(t->direction());
    if (auto d = t->current_direction()) {
      state.current_direction = DirectionToString(*d);
    }
    if (auto d = t->fired_direction()) {
      state.fired_direction = DirectionToString(*d);
    }
    state.stopped = t->stopped();
    state.stopping = t->stopping();
    state.sender = t->sender();
    state.receiver = t->receiver();
    state.receiver_stream_ids = state.receiver->stream_ids();
    state.sender_dtls = state.sender->dtls_transport();
    state.receiver_dtls = state.receiver->dtls_transport();
    snap->transceivers.push_back(std::move(state));
  }
  return snap;
}

class CreateSdpObserver : public webrtc::CreateSessionDescriptionObserver {
 public:
  CreateSdpObserver(std::shared_ptr<EventSink> sink, uint32_t op_id)
      : sink_(std::move(sink)), op_id_(op_id) {}

  void OnSuccess(webrtc::SessionDescriptionInterface* raw) override {
    std::unique_ptr<webrtc::SessionDescriptionInterface> desc(raw);
    auto ev = OpEvent(op_id_, webrtc::RTCError::OK());
    ev->has_description = true;
    ev->sdp_type = webrtc::SdpTypeToString(desc->GetType());
    desc->ToString(&ev->sdp);
    sink_->Emit(std::move(ev));
  }

  void OnFailure(webrtc::RTCError error) override {
    sink_->Emit(OpEvent(op_id_, std::move(error)));
  }

 private:
  std::shared_ptr<EventSink> sink_;
  uint32_t op_id_;
};

// Completes an SLD/SRD op with a snapshot taken in the completion callback,
// on the signaling thread, before any later operation can change the state.
std::unique_ptr<NativeEvent> DescriptionOpEvent(PcRef& pc,
                                                uint32_t op_id,
                                                webrtc::RTCError error) {
  bool ok = error.ok();
  auto ev = OpEvent(op_id, std::move(error));
  if (ok && pc.pc != nullptr) {
    ev->snapshot = CaptureSnapshot(pc, true);
  } else if (!ok) {
    // A failed SLD/SRD can still have replaced (and freed) a description
    // (ApplyLocalDescription installs the new one before steps that can
    // fail), and nothing captured that. A later description at the freed
    // address must not match its cached SDP.
    pc.serialized.clear();
  }
  return ev;
}

class SetLocalObserver : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  SetLocalObserver(std::shared_ptr<EventSink> sink,
                   std::shared_ptr<PcRef> pc,
                   uint32_t op_id)
      : sink_(std::move(sink)), pc_(std::move(pc)), op_id_(op_id) {}

  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    bool ok = error.ok();
    if (ok) {
      ReassertVideoSinks(pc_);
      ObserveReceivers(sink_, *pc_);
    }
    auto ev = DescriptionOpEvent(*pc_, op_id_, std::move(error));
    if (ok) {
      WatchTransports(sink_, *pc_, ev->snapshot.get());
    }
    sink_->Emit(std::move(ev));
  }

 private:
  std::shared_ptr<EventSink> sink_;
  std::shared_ptr<PcRef> pc_;
  uint32_t op_id_;
};

class SetRemoteObserver : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  SetRemoteObserver(std::shared_ptr<EventSink> sink,
                    std::shared_ptr<PcRef> pc,
                    uint32_t op_id)
      : sink_(std::move(sink)), pc_(std::move(pc)), op_id_(op_id) {}

  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override {
    bool ok = error.ok();
    if (ok) {
      ReassertVideoSinks(pc_);
      ObserveReceivers(sink_, *pc_);
    }
    auto ev = DescriptionOpEvent(*pc_, op_id_, std::move(error));
    if (ok) {
      WatchTransports(sink_, *pc_, ev->snapshot.get());
    }
    sink_->Emit(std::move(ev));
  }

 private:
  std::shared_ptr<EventSink> sink_;
  std::shared_ptr<PcRef> pc_;
  uint32_t op_id_;
};

class StatsCallback : public webrtc::RTCStatsCollectorCallback {
 public:
  StatsCallback(std::shared_ptr<EventSink> sink, uint32_t op_id)
      : sink_(std::move(sink)), op_id_(op_id) {}

  void OnStatsDelivered(
      const webrtc::scoped_refptr<const webrtc::RTCStatsReport>& report)
      override {
    auto ev = OpEvent(op_id_, webrtc::RTCError::OK());
    ev->has_json = true;
    // ToJson() returns "" for an empty report (e.g. a receiver selector
    // before any packets arrived), which isn't JSON.
    ev->json = report->ToJson();
    if (ev->json.empty()) {
      ev->json = "{}";
    }
    sink_->Emit(std::move(ev));
  }

 private:
  std::shared_ptr<EventSink> sink_;
  uint32_t op_id_;
};

std::string GetString(Napi::Object obj, const char* key) {
  Napi::Value v = SafeGet(obj, key);
  return v.IsString() ? v.As<Napi::String>().Utf8Value() : std::string();
}

Napi::Promise RejectedType(Napi::Env env, const char* message) {
  return RejectedPromise(env, Napi::TypeError::New(env, message));
}

// {type, sdp} -> SessionDescriptionInterface. On failure returns null and
// sets `rejected`: a TypeError for a malformed argument (the JS layer
// validates those), SYNTAX_ERROR for SDP libwebrtc can't parse.
std::unique_ptr<webrtc::SessionDescriptionInterface> ParseDescription(
    Napi::Value value,
    Napi::Promise* rejected) {
  Napi::Env env = value.Env();
  if (!value.IsObject()) {
    *rejected = RejectedType(env, "description must be an object");
    return nullptr;
  }
  Napi::Object obj = value.As<Napi::Object>();
  std::string type_name = GetString(obj, "type");
  std::string sdp = GetString(obj, "sdp");
  if (env.IsExceptionPending()) {
    *rejected = RejectedPromise(env, env.GetAndClearPendingException());
    return nullptr;
  }
  std::optional<webrtc::SdpType> type = webrtc::SdpTypeFromString(type_name);
  if (!type) {
    *rejected = RejectedType(env, "invalid description type");
    return nullptr;
  }
  webrtc::SdpParseError parse_error;
  auto desc = webrtc::CreateSessionDescription(*type, sdp, &parse_error);
  if (!desc) {
    *rejected = RejectedPromise(
        env, ParseError(env, "failed to parse SDP: " + parse_error.description,
                        parse_error.line));
  }
  return desc;
}

bool ThrowType(Napi::Env env, const char* message) {
  if (!env.IsExceptionPending()) {
    Napi::TypeError::New(env, message).ThrowAsJavaScriptException();
  }
  return false;
}

// Reads config.iceServers. On failure a JS exception is pending.
bool ParseIceServers(Napi::Env env,
                     Napi::Object config,
                     std::vector<PCI::IceServer>* out) {
  Napi::Value servers = SafeGet(config, "iceServers");
  if (env.IsExceptionPending()) {
    return false;
  }
  if (servers.IsUndefined()) {
    return true;
  }
  if (!servers.IsArray()) {
    return ThrowType(env, "iceServers must be an array");
  }
  Napi::Array arr = servers.As<Napi::Array>();
  for (uint32_t i = 0; i < SafeLength(arr); i++) {
    Napi::Value entry = SafeGet(arr, i);
    if (env.IsExceptionPending()) {
      return false;
    }
    if (!entry.IsObject()) {
      return ThrowType(env, "iceServers entries must be objects");
    }
    Napi::Object s = entry.As<Napi::Object>();
    PCI::IceServer server;
    Napi::Value urls = SafeGet(s, "urls");
    if (urls.IsString()) {
      server.urls.push_back(urls.As<Napi::String>().Utf8Value());
    } else if (urls.IsArray()) {
      Napi::Array u = urls.As<Napi::Array>();
      for (uint32_t j = 0; j < SafeLength(u); j++) {
        Napi::Value url = SafeGet(u, j);
        if (!url.IsString()) {
          return ThrowType(env, "iceServers urls must be strings");
        }
        server.urls.push_back(url.As<Napi::String>().Utf8Value());
      }
    } else {
      return ThrowType(env, "iceServers entries need urls");
    }
    server.username = GetString(s, "username");
    server.password = GetString(s, "credential");
    if (env.IsExceptionPending()) {
      return false;
    }
    out->push_back(server);
  }
  return true;
}

// Reads every NativeConfiguration field into `out`. Absent fields keep
// whatever `out` already holds: libwebrtc's defaults (which match the spec's)
// at construction, the current configuration in setConfiguration(). The JS
// layer always passes the standard fields, defaulted. `certificates` only
// at construction: libwebrtc's SetConfiguration compares them by pointer, so
// ones parsed again from the same PEM would never compare equal (the JS
// layer checks that they didn't change). On failure a JS exception is
// pending.
bool ParseConfiguration(Napi::Env env,
                        Napi::Object config,
                        bool construction,
                        PCI::RTCConfiguration* out) {
  Napi::Value certificates = SafeGet(config, "certificates");
  if (env.IsExceptionPending()) {
    return false;
  }
  if (!certificates.IsUndefined()) {
    if (!construction) {
      return ThrowType(env, "certificates can only be set at construction");
    }
    if (!ParseCertificates(env, certificates, &out->certificates)) {
      return false;
    }
  }
  Napi::Value servers = SafeGet(config, "iceServers");
  Napi::Value transport = SafeGet(config, "iceTransportPolicy");
  Napi::Value bundle = SafeGet(config, "bundlePolicy");
  Napi::Value mux = SafeGet(config, "rtcpMuxPolicy");
  Napi::Value pool = SafeGet(config, "iceCandidatePoolSize");
  Napi::Value ports = SafeGet(config, "portRange");
  if (env.IsExceptionPending()) {
    return false;
  }
  if (!servers.IsUndefined()) {
    out->servers.clear();
    if (!ParseIceServers(env, config, &out->servers)) {
      return false;
    }
  }
  if (transport.IsString()) {
    std::string s = transport.As<Napi::String>().Utf8Value();
    if (s == "all") {
      out->type = PCI::kAll;
    } else if (s == "relay") {
      out->type = PCI::kRelay;
    } else {
      return ThrowType(env, "invalid iceTransportPolicy");
    }
  } else if (!transport.IsUndefined()) {
    return ThrowType(env, "invalid iceTransportPolicy");
  }
  if (bundle.IsString()) {
    std::string s = bundle.As<Napi::String>().Utf8Value();
    if (s == "balanced") {
      out->bundle_policy = PCI::kBundlePolicyBalanced;
    } else if (s == "max-compat") {
      out->bundle_policy = PCI::kBundlePolicyMaxCompat;
    } else if (s == "max-bundle") {
      out->bundle_policy = PCI::kBundlePolicyMaxBundle;
    } else {
      return ThrowType(env, "invalid bundlePolicy");
    }
  } else if (!bundle.IsUndefined()) {
    return ThrowType(env, "invalid bundlePolicy");
  }
  if (mux.IsString()) {
    std::string s = mux.As<Napi::String>().Utf8Value();
    if (s == "require") {
      out->rtcp_mux_policy = PCI::kRtcpMuxPolicyRequire;
    } else if (s == "negotiate") {
      out->rtcp_mux_policy = PCI::kRtcpMuxPolicyNegotiate;
    } else {
      return ThrowType(env, "invalid rtcpMuxPolicy");
    }
  } else if (!mux.IsUndefined()) {
    return ThrowType(env, "invalid rtcpMuxPolicy");
  }
  if (pool.IsNumber()) {
    out->ice_candidate_pool_size = pool.As<Napi::Number>().Int32Value();
  } else if (!pool.IsUndefined()) {
    return ThrowType(env, "invalid iceCandidatePoolSize");
  }
  // Nonstandard (wrtc): restricts the host ports ICE gathers on. Defaults as
  // in wrtc: {min: N} means N-65535. {max: M} alone means 0-M, which
  // libwebrtc treats as unrestricted (port 0 is tried first, and binding it
  // lets the OS pick), also as in wrtc. The JS layer checks min <= max.
  if (ports.IsObject()) {
    Napi::Object range = ports.As<Napi::Object>();
    Napi::Value min = SafeGet(range, "min");
    Napi::Value max = SafeGet(range, "max");
    if (env.IsExceptionPending()) {
      return false;
    }
    out->port_allocator_config.min_port =
        min.IsNumber() ? min.As<Napi::Number>().Int32Value() : 0;
    out->port_allocator_config.max_port =
        max.IsNumber() ? max.As<Napi::Number>().Int32Value() : 65535;
  } else if (!ports.IsUndefined()) {
    return ThrowType(env, "invalid portRange");
  }
  return true;
}

// createOffer options. Unset legacy offerToReceive* leave transceivers
// alone.
PCI::RTCOfferAnswerOptions ParseOfferOptions(Napi::Env env, Napi::Value value) {
  PCI::RTCOfferAnswerOptions options;
  if (!value.IsObject()) {
    return options;
  }
  Napi::Object obj = value.As<Napi::Object>();
  Napi::Value restart = SafeGet(obj, "iceRestart");
  Napi::Value audio = SafeGet(obj, "offerToReceiveAudio");
  Napi::Value video = SafeGet(obj, "offerToReceiveVideo");
  if (env.IsExceptionPending()) {
    return options;
  }
  options.ice_restart =
      restart.IsBoolean() && restart.As<Napi::Boolean>().Value();
  if (audio.IsBoolean()) {
    options.offer_to_receive_audio = audio.As<Napi::Boolean>().Value() ? 1 : 0;
  }
  if (video.IsBoolean()) {
    options.offer_to_receive_video = video.As<Napi::Boolean>().Value() ? 1 : 0;
  }
  return options;
}

Napi::Value ThrowRtcError(Napi::Env env, const webrtc::RTCError& error) {
  if (!env.IsExceptionPending()) {
    ToJsError(env, error).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

}  // namespace

webrtc::scoped_refptr<webrtc::RTCStatsCollectorCallback> MakeStatsCallback(
    std::shared_ptr<EventSink> sink,
    uint32_t op_id) {
  return webrtc::make_ref_counted<StatsCallback>(std::move(sink), op_id);
}

PcObserver::PcObserver(std::shared_ptr<EventSink> sink,
                       std::shared_ptr<PcRef> pc)
    : sink_(std::move(sink)), pc_(std::move(pc)) {}

void PcObserver::OnSignalingChange(PCI::SignalingState state) {
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "signalingstatechange";
  ev->state = std::string(PCI::AsString(state));
  sink_->Emit(std::move(ev));
}

void PcObserver::OnDataChannel(
    webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) {
  WireChannel(sink_, channel, [&](uint32_t key) {
    auto ev = std::make_unique<NativeEvent>();
    ev->kind = "datachannel";
    ev->channel_key = key;
    ev->channel = channel;
    sink_->Emit(std::move(ev));
  });
}

void PcObserver::OnNegotiationNeededEvent(uint32_t event_id) {
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "negotiationneeded";
  ev->event_id = event_id;
  sink_->Emit(std::move(ev));
}

void PcObserver::OnStandardizedIceConnectionChange(
    PCI::IceConnectionState state) {
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "iceconnectionstatechange";
  ev->state = std::string(PCI::AsString(state));
  ev->ice_states = sink_->IceStates();
  sink_->Emit(std::move(ev));
}

void PcObserver::OnConnectionChange(PCI::PeerConnectionState state) {
  // The DTLS states this one derives from come first (libwebrtc may call
  // this before the DTLS transports' own observers have run).
  sink_->RefreshTransports();
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "connectionstatechange";
  ev->state = std::string(PCI::AsString(state));
  sink_->Emit(std::move(ev));
}

// Carries the descriptions so JS can refresh its cached localDescription
// once gathering is complete.
void PcObserver::OnIceGatheringChange(PCI::IceGatheringState state) {
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "icegatheringstatechange";
  ev->state = std::string(PCI::AsString(state));
  if (pc_->pc != nullptr) {
    ev->snapshot = CaptureSnapshot(*pc_, false);
  }
  sink_->Emit(std::move(ev));
}

// libwebrtc adds the candidate to the local description before calling
// this, so the snapshot includes it.
void PcObserver::OnIceCandidate(const webrtc::IceCandidate* candidate) {
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "icecandidate";
  ev->has_candidate = true;
  ev->candidate = candidate->ToString();
  ev->sdp_mid = candidate->sdp_mid();
  ev->sdp_mline_index = candidate->sdp_mline_index();
  if (pc_->pc != nullptr) {
    ev->snapshot = CaptureSnapshot(*pc_, false);
  }
  sink_->Emit(std::move(ev));
}

void PcObserver::OnIceCandidateError(const std::string& address,
                                     int port,
                                     const std::string& url,
                                     int error_code,
                                     const std::string& error_text) {
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "icecandidateerror";
  ev->has_ice_error = true;
  ev->ice_error_address = address;
  ev->ice_error_port = port;
  ev->ice_error_url = url;
  ev->ice_error_code = error_code;
  ev->ice_error_text = error_text;
  sink_->Emit(std::move(ev));
}

// Fired during SRD processing, before its completion; JS buffers it until
// the SRD snapshot arrives.
void PcObserver::OnTrack(
    webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) {
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "track";
  ev->receiver = transceiver->receiver();
  ev->transceiver = transceiver;
  ev->stream_ids = ev->receiver->stream_ids();
  sink_->Emit(std::move(ev));
}

void PcObserver::OnRemoveTrack(
    webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver) {
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "removetrack";
  ev->receiver = receiver;
  sink_->Emit(std::move(ev));
}

void PeerConnection::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function ctor = DefineClass(
      env, "PeerConnection",
      {
          InstanceMethod<&PeerConnection::CreateOffer>("createOffer"),
          InstanceMethod<&PeerConnection::CreateAnswer>("createAnswer"),
          InstanceMethod<&PeerConnection::SetLocalDescription>(
              "setLocalDescription"),
          InstanceMethod<&PeerConnection::SetRemoteDescription>(
              "setRemoteDescription"),
          InstanceMethod<&PeerConnection::AddIceCandidate>("addIceCandidate"),
          InstanceMethod<&PeerConnection::CreateDataChannel>(
              "createDataChannel"),
          InstanceMethod<&PeerConnection::GetStats>("getStats"),
          InstanceAccessor<&PeerConnection::SignalingState>("signalingState"),
          InstanceAccessor<&PeerConnection::ConnectionState>("connectionState"),
          InstanceAccessor<&PeerConnection::IceConnectionState>(
              "iceConnectionState"),
          InstanceAccessor<&PeerConnection::IceGatheringState>(
              "iceGatheringState"),
          InstanceMethod<&PeerConnection::Close>("close"),
          InstanceMethod<&PeerConnection::SetConfiguration>("setConfiguration"),
          InstanceMethod<&PeerConnection::RestartIce>("restartIce"),
          InstanceMethod<&PeerConnection::AddTrack>("addTrack"),
          InstanceMethod<&PeerConnection::RemoveTrack>("removeTrack"),
          InstanceMethod<&PeerConnection::AddTransceiver>("addTransceiver"),
          InstanceMethod<&PeerConnection::GetTransceivers>("getTransceivers"),
          InstanceMethod<&PeerConnection::ShouldFireNegotiationNeededEvent>(
              "shouldFireNegotiationNeededEvent"),
          InstanceMethod<&PeerConnection::QueueTask>("queueTask"),
      });
  exports.Set("PeerConnection", ctor);
}

PeerConnection::PeerConnection(const Napi::CallbackInfo& info)
    : SafeObjectWrap<PeerConnection>(info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "new PeerConnection(config, onEvent)")
        .ThrowAsJavaScriptException();
    return;
  }

  PCI::RTCConfiguration config;
  if (!ParseConfiguration(env, info[0].As<Napi::Object>(),
                          /*construction=*/true, &config)) {
    return;
  }

  sink_ = std::make_shared<EventSink>();
  sink_->Start(env, info[1].As<Napi::Function>());
  rtp_ = std::make_unique<PcRtpRegistry>(sink_);
  sink_->set_rtp(rtp_.get());
  pc_ref_ = std::make_shared<PcRef>();
  observer_ = std::make_unique<PcObserver>(sink_, pc_ref_);

  webrtc::PeerConnectionDependencies deps(observer_.get());
  auto result = Factory()->CreatePeerConnectionOrError(config, std::move(deps));
  if (!result.ok()) {
    closed_ = true;
    sink_->Release();
    ToJsError(env, result.error()).ThrowAsJavaScriptException();
    return;
  }
  pc_ = result.MoveValue();
  rtp_->SetPeerConnection(pc_);
  SignalingThread()->BlockingCall([this] { pc_ref_->pc = pc_.get(); });

  // Registered after the TSFN, and hooks run last-in first-out, so this runs
  // while the TSFN is still alive.
  if (napi_add_env_cleanup_hook(env, OnEnvCleanup, this) == napi_ok) {
    cleanup_hook_registered_ = true;
  }
}

PeerConnection::~PeerConnection() {
  if (cleanup_hook_registered_) {
    napi_remove_env_cleanup_hook(Env(), OnEnvCleanup, this);
  }
  DoClose(/*release=*/true);
  if (rtp_) {
    rtp_->Detach();
  }
  if (pc_) {
    SignalingThread()->BlockingCall([this] {
      UnobserveReceivers(*pc_ref_);
      pc_ref_->pc = nullptr;
    });
  }
  pc_ = nullptr;
  // Events still queued on the TSFN may be delivered after this; CallJs then
  // sees no registry and omits RTP fields.
  if (sink_) {
    sink_->set_rtp(nullptr);
  }
}

void PeerConnection::OnEnvCleanup(void* self) {
  auto* pc = static_cast<PeerConnection*>(self);
  pc->cleanup_hook_registered_ = false;
  pc->DoClose(/*release=*/true);
}

void PeerConnection::DoClose(bool release) {
  if (!closed_ && pc_) {
    closed_ = true;
    pc_ref_->closed = true;
    pc_->Close();
    sink_->UnregisterChannels();
    sink_->UnwatchTransports();
    sink_->Close(Env());
    rtp_->Close();
  }
  if (release && sink_) {
    sink_->Release();
  }
}

// createOffer({iceRestart, offerToReceiveAudio, offerToReceiveVideo}?)
Napi::Value PeerConnection::CreateOffer(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  PCI::RTCOfferAnswerOptions options = ParseOfferOptions(env, info[0]);
  if (env.IsExceptionPending()) {
    return env.Undefined();
  }
  auto [op_id, promise] = sink_->BeginOp(env);
  if (op_id == 0) {
    return promise;
  }
  pc_->CreateOffer(
      webrtc::make_ref_counted<CreateSdpObserver>(sink_, op_id).get(), options);
  return promise;
}

Napi::Value PeerConnection::CreateAnswer(const Napi::CallbackInfo& info) {
  auto [op_id, promise] = sink_->BeginOp(info.Env());
  if (op_id == 0) {
    return promise;
  }
  pc_->CreateAnswer(
      webrtc::make_ref_counted<CreateSdpObserver>(sink_, op_id).get(),
      PCI::RTCOfferAnswerOptions());
  return promise;
}

// setLocalDescription(desc?). No argument (or undefined) is the implicit
// form: libwebrtc creates the offer or answer itself.
Napi::Value PeerConnection::SetLocalDescription(
    const Napi::CallbackInfo& info) {
  std::unique_ptr<webrtc::SessionDescriptionInterface> desc;
  if (info.Length() > 0 && !info[0].IsUndefined()) {
    Napi::Promise rejected;
    desc = ParseDescription(info[0], &rejected);
    if (!desc) {
      return rejected;
    }
  }
  auto [op_id, promise] = sink_->BeginOp(info.Env());
  if (op_id == 0) {
    return promise;
  }
  auto observer =
      webrtc::make_ref_counted<SetLocalObserver>(sink_, pc_ref_, op_id);
  if (desc) {
    pc_->SetLocalDescription(std::move(desc), observer);
  } else {
    pc_->SetLocalDescription(observer);
  }
  return promise;
}

Napi::Value PeerConnection::SetRemoteDescription(
    const Napi::CallbackInfo& info) {
  Napi::Promise rejected;
  auto desc = ParseDescription(info[0], &rejected);
  if (!desc) {
    return rejected;
  }
  auto [op_id, promise] = sink_->BeginOp(info.Env());
  if (op_id == 0) {
    return promise;
  }
  pc_->SetRemoteDescription(
      std::move(desc),
      webrtc::make_ref_counted<SetRemoteObserver>(sink_, pc_ref_, op_id));
  return promise;
}

// addIceCandidate({candidate, sdpMid, sdpMLineIndex})
Napi::Value PeerConnection::AddIceCandidate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    return RejectedType(env, "candidate must be an object");
  }
  Napi::Object obj = info[0].As<Napi::Object>();
  Napi::Value index = SafeGet(obj, "sdpMLineIndex");
  std::string mid = GetString(obj, "sdpMid");
  std::string line = GetString(obj, "candidate");
  if (env.IsExceptionPending()) {
    return RejectedPromise(env, env.GetAndClearPendingException());
  }
  webrtc::SdpParseError parse_error;
  auto candidate = webrtc::IceCandidate::Create(
      mid, index.IsNumber() ? index.As<Napi::Number>().Int32Value() : 0, line,
      &parse_error);
  if (!candidate) {
    return RejectedPromise(
        env,
        ParseError(env, "failed to parse candidate: " + parse_error.description,
                   parse_error.line));
  }
  auto [op_id, promise] = sink_->BeginOp(info.Env());
  if (op_id == 0) {
    return promise;
  }
  pc_->AddIceCandidate(std::move(candidate),
                       [sink = sink_, op_id](webrtc::RTCError error) {
                         sink->Emit(OpEvent(op_id, std::move(error)));
                       });
  return promise;
}

// createDataChannel(label, {ordered, maxPacketLifeTime, maxRetransmits,
//                           protocol, negotiated, id}?)
Napi::Value PeerConnection::CreateDataChannel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "createDataChannel(label, init?)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  webrtc::DataChannelInit init;
  if (info.Length() > 1 && info[1].IsObject()) {
    Napi::Object o = info[1].As<Napi::Object>();
    if (SafeGet(o, "ordered").IsBoolean()) {
      init.ordered = SafeGet(o, "ordered").As<Napi::Boolean>();
    }
    if (SafeGet(o, "maxPacketLifeTime").IsNumber()) {
      init.maxRetransmitTime =
          SafeGet(o, "maxPacketLifeTime").As<Napi::Number>().Int32Value();
    }
    if (SafeGet(o, "maxRetransmits").IsNumber()) {
      init.maxRetransmits =
          SafeGet(o, "maxRetransmits").As<Napi::Number>().Int32Value();
    }
    init.protocol = GetString(o, "protocol");
    if (SafeGet(o, "negotiated").IsBoolean()) {
      init.negotiated = SafeGet(o, "negotiated").As<Napi::Boolean>();
    }
    if (SafeGet(o, "id").IsNumber()) {
      init.id = SafeGet(o, "id").As<Napi::Number>().Int32Value();
    }
  }
  if (env.IsExceptionPending()) {
    return env.Undefined();
  }
  auto result = pc_->CreateDataChannelOrError(
      info[0].As<Napi::String>().Utf8Value(), &init);
  if (!result.ok()) {
    ToJsError(env, result.error()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto channel = result.MoveValue();
  uint32_t key = WireChannel(sink_, channel);
  return DataChannel::NewInstance(env, channel, key);
}

// getStats(selector?): Promise<string> -- libwebrtc's RTCStatsReport as
// JSON, optionally filtered by a Sender or Receiver handle. The only op
// allowed after close() (contract decision 1); libwebrtc still reports the
// closed PC's stats.
Napi::Value PeerConnection::GetStats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender;
  webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver;
  if (info.Length() > 0 && !info[0].IsUndefined() && !info[0].IsNull()) {
    sender = Sender::FromJs(info[0]);
    if (!sender) {
      receiver = Receiver::FromJs(info[0]);
    }
    if (!sender && !receiver) {
      return RejectedType(env, "selector must be a Sender or Receiver");
    }
  }
  auto [op_id, promise] = sink_->BeginOp(env, /*allowed_after_close=*/true);
  if (op_id == 0) {
    return promise;
  }
  if (sender) {
    pc_->GetStats(sender, MakeStatsCallback(sink_, op_id));
  } else if (receiver) {
    pc_->GetStats(receiver, MakeStatsCallback(sink_, op_id));
  } else {
    pc_->GetStats(MakeStatsCallback(sink_, op_id).get());
  }
  return promise;
}

Napi::Value PeerConnection::SignalingState(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(),
                           std::string(PCI::AsString(pc_->signaling_state())));
}

Napi::Value PeerConnection::ConnectionState(const Napi::CallbackInfo& info) {
  return Napi::String::New(
      info.Env(), std::string(PCI::AsString(pc_->peer_connection_state())));
}

Napi::Value PeerConnection::IceConnectionState(const Napi::CallbackInfo& info) {
  return Napi::String::New(
      info.Env(),
      std::string(PCI::AsString(pc_->standardized_ice_connection_state())));
}

Napi::Value PeerConnection::IceGatheringState(const Napi::CallbackInfo& info) {
  return Napi::String::New(
      info.Env(), std::string(PCI::AsString(pc_->ice_gathering_state())));
}

Napi::Value PeerConnection::RestartIce(const Napi::CallbackInfo& info) {
  if (!closed_) {
    pc_->RestartIce();
  }
  return info.Env().Undefined();
}

// setConfiguration(config). Starts from the current configuration, so
// fields the JS layer leaves out (portRange) stay as they are. libwebrtc's
// error type (INVALID_MODIFICATION, INVALID_RANGE, SYNTAX_ERROR,
// INVALID_PARAMETER) is in the thrown error's `errorType`.
Napi::Value PeerConnection::SetConfiguration(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    return ThrowTypeError(env, "setConfiguration(config)");
  }
  PCI::RTCConfiguration config = pc_->GetConfiguration();
  if (!ParseConfiguration(env, info[0].As<Napi::Object>(),
                          /*construction=*/false, &config)) {
    return env.Undefined();
  }
  webrtc::RTCError error = pc_->SetConfiguration(config);
  if (!error.ok()) {
    return ThrowRtcError(env, error);
  }
  return env.Undefined();
}

// Reads an array of strings; on failure a TypeError is pending.
static bool ReadStringArray(Napi::Env env,
                            Napi::Value value,
                            const char* what,
                            std::vector<std::string>* out) {
  if (!value.IsArray()) {
    ThrowTypeError(env, std::string(what) + " must be an array of strings");
    return false;
  }
  Napi::Array arr = value.As<Napi::Array>();
  for (uint32_t i = 0; i < SafeLength(arr); i++) {
    Napi::Value s = SafeGet(arr, i);
    if (env.IsExceptionPending()) {
      return false;
    }
    if (!s.IsString()) {
      ThrowTypeError(env, std::string(what) + " must be an array of strings");
      return false;
    }
    out->push_back(s.As<Napi::String>().Utf8Value());
  }
  return true;
}

// addTrack(track, streamIds) -> {sender, transceiver}
Napi::Value PeerConnection::AddTrack(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track =
      Track::FromJs(info[0]);
  if (!track) {
    return env.Undefined();
  }
  std::vector<std::string> stream_ids;
  if (info.Length() > 1 && !info[1].IsUndefined() &&
      !ReadStringArray(env, info[1], "streamIds", &stream_ids)) {
    return env.Undefined();
  }
  // One signaling-thread task, so the transceiver found is the one AddTrack
  // used (it may have reused an existing one).
  webrtc::RTCError error;
  webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender;
  webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver;
  SignalingThread()->BlockingCall([&] {
    auto result = pc_->AddTrack(track, stream_ids);
    if (!result.ok()) {
      error = result.MoveError();
      return;
    }
    sender = result.MoveValue();
    for (auto& t : pc_->GetTransceivers()) {
      if (t->sender() == sender) {
        transceiver = t;
        break;
      }
    }
  });
  if (!error.ok()) {
    return ThrowRtcError(env, error);
  }
  Napi::Object obj = Napi::Object::New(env);
  SafeSet(obj, "sender", rtp_->WrapSender(env, sender));
  SafeSet(obj, "transceiver", rtp_->WrapTransceiver(env, transceiver));
  return obj;
}

Napi::Value PeerConnection::RemoveTrack(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender =
      Sender::FromJs(info[0]);
  if (!sender) {
    return ThrowTypeError(env, "expected a native Sender handle");
  }
  webrtc::RTCError error = pc_->RemoveTrackOrError(sender);
  if (!error.ok()) {
    return ThrowRtcError(env, error);
  }
  return env.Undefined();
}

// addTransceiver(trackOrKind, {direction, streams, sendEncodings}?)
Napi::Value PeerConnection::AddTransceiver(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  webrtc::RtpTransceiverInit init;
  if (info.Length() > 1 && info[1].IsObject()) {
    Napi::Object o = info[1].As<Napi::Object>();
    Napi::Value direction = SafeGet(o, "direction");
    Napi::Value streams = SafeGet(o, "streams");
    Napi::Value encodings = SafeGet(o, "sendEncodings");
    if (env.IsExceptionPending()) {
      return env.Undefined();
    }
    if (!direction.IsUndefined()) {
      std::optional<webrtc::RtpTransceiverDirection> d;
      if (direction.IsString()) {
        d = DirectionFromString(direction.As<Napi::String>().Utf8Value());
      }
      if (!d) {
        return ThrowTypeError(env, "invalid direction");
      }
      init.direction = *d;
    }
    if (!streams.IsUndefined() &&
        !ReadStringArray(env, streams, "streams", &init.stream_ids)) {
      return env.Undefined();
    }
    if (!encodings.IsUndefined() &&
        !EncodingsFromJs(env, encodings, &init.send_encodings)) {
      return env.Undefined();
    }
  }

  webrtc::RTCErrorOr<webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>>
      result;
  if (info[0].IsString()) {
    std::string kind = info[0].As<Napi::String>().Utf8Value();
    if (kind == "audio") {
      result = pc_->AddTransceiver(webrtc::MediaType::AUDIO, init);
    } else if (kind == "video") {
      result = pc_->AddTransceiver(webrtc::MediaType::VIDEO, init);
    } else {
      return ThrowTypeError(env, "kind must be 'audio' or 'video'");
    }
  } else {
    webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track =
        Track::FromJs(info[0]);
    if (!track) {
      return env.Undefined();
    }
    result = pc_->AddTransceiver(track, init);
  }
  if (!result.ok()) {
    return ThrowRtcError(env, result.error());
  }
  return rtp_->WrapTransceiver(env, result.MoveValue());
}

// getTransceivers(): stable handles. Like every full snapshot, also demotes
// the handles of transceivers libwebrtc has removed to weak references.
Napi::Value PeerConnection::GetTransceivers(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>> list;
  RtpLiveSet live;
  SignalingThread()->BlockingCall([&] {
    live.epoch = BeginRtpSnapshot();
    list = pc_->GetTransceivers();
    for (auto& t : list) {
      live.transceivers.push_back(t.get());
      live.senders.push_back(t->sender().get());
      live.receivers.push_back(t->receiver().get());
    }
  });
  rtp_->Retain(live);
  Napi::Array arr = Napi::Array::New(env, list.size());
  for (size_t i = 0; i < list.size(); i++) {
    SafeSet(arr, static_cast<uint32_t>(i), rtp_->WrapTransceiver(env, list[i]));
  }
  return arr;
}

Napi::Value PeerConnection::ShouldFireNegotiationNeededEvent(
    const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    return ThrowTypeError(env, "shouldFireNegotiationNeededEvent(eventId)");
  }
  return Napi::Boolean::New(env, pc_->ShouldFireNegotiationNeededEvent(
                                     info[0].As<Napi::Number>().Uint32Value()));
}

// queueTask(id, next): a "task" event with `id`, in the environment's event
// order: after every event queued so far, or with `next` from an event's
// callback, right after that event (EventSink::Emit).
Napi::Value PeerConnection::QueueTask(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
    return ThrowTypeError(env, "queueTask(id, next)");
  }
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "task";
  ev->task_id = info[0].As<Napi::Number>().Uint32Value();
  sink_->Emit(std::move(ev), info[1].As<Napi::Boolean>().Value());
  return env.Undefined();
}

Napi::Value PeerConnection::Close(const Napi::CallbackInfo& info) {
  DoClose(/*release=*/false);
  return info.Env().Undefined();
}

}  // namespace wrtc
