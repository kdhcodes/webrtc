#include "event_sink.h"
#include "napi_safe.h"

#include <cstring>
#include <optional>
#include <string>

#include "addon.h"
#include "data_channel.h"
#include "rtp.h"
#include "runtime.h"
#include "transport.h"

namespace wrtc {

void FinalizeSink(Napi::Env env, void*, EventSink* sink) {
  // Node deletes the TSFN right after this returns (and also finalizes it on
  // env teardown without Release() having been called), so make sure no
  // other thread calls into it again.
  {
    std::lock_guard<std::mutex> lock(sink->mutex_);
    sink->released_ = true;
  }
  sink->finalized_ = true;
  // Operations whose callbacks never arrived (e.g. the PC was destroyed
  // mid-flight) would otherwise leave their promises pending forever.
  for (auto& [id, deferred] : sink->ops_) {
    SafeSettle(env, deferred, false,
               ToJsError(env, webrtc::RTCErrorType::INVALID_STATE,
                         "peer connection closed")
                   .Value());
  }
  sink->ops_.clear();
  sink->callback_.Reset();
  // May destroy the sink; nothing touches it after this.
  std::shared_ptr<EventSink> keep = std::move(sink->self_while_started_);
}

EventSink::EventSink() = default;
EventSink::~EventSink() = default;

void EventSink::Start(Napi::Env env, Napi::Function callback) {
  std::shared_ptr<EventOrder>& order =
      env.GetInstanceData<AddonData>()->event_order;
  if (!order) {
    order = std::make_shared<EventOrder>();
  }
  std::lock_guard<std::mutex> lock(mutex_);
  order_ = order;
  self_while_started_ = shared_from_this();
  callback_ = Napi::Persistent(callback);
  tsfn_ = EventTsfn::New(env, "wrtc:events", 0, 1, this, FinalizeSink,
                         static_cast<void*>(nullptr));
  released_ = false;
}

void EventSink::Emit(std::unique_ptr<NativeEvent> event, bool next) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (released_) {
    return;
  }
  // Released by Deliver(): until then the TSFN can't finalize.
  if (tsfn_.Acquire() != napi_ok) {
    return;
  }
  // The wake and the event are queued under the order's lock, so a wake
  // never runs before its event is queued: there is an event for every wake.
  std::lock_guard<std::mutex> order_lock(order_->mutex);
  auto* wake = new EventWake{order_};
  napi_status status = tsfn_.NonBlockingCall(wake);
  if (status != napi_ok) {
    delete wake;
    // On napi_closing Node has already dropped this thread's reference (the
    // one Acquire() took), and no further calls are allowed; on any other
    // failure the reference is still ours to give back.
    if (status != napi_closing) {
      tsfn_.Release();
    }
    return;
  }
  // A wake delivers the oldest event, whichever sink's it is, so the front
  // is the next one delivered. Only the JS thread emits `next` ones
  // (queueTask), and only it sets `delivering`, around an event's callback.
  if (next && order_->delivering) {
    auto at = order_->queue.begin() +
              static_cast<std::ptrdiff_t>(order_->next_insert++);
    order_->queue.emplace(at, shared_from_this(), std::move(event));
  } else {
    order_->queue.emplace_back(shared_from_this(), std::move(event));
  }
}

std::pair<uint32_t, Napi::Promise> EventSink::BeginOp(
    Napi::Env env,
    bool allowed_after_close) {
  napi_deferred deferred = nullptr;
  Napi::Promise promise = SafeNewPromise(env, &deferred);
  if (deferred == nullptr) {
    // JS can't run any more (worker termination): start nothing.
    return {0, promise};
  }
  if (Released() || (closed_ && !allowed_after_close)) {
    SafeSettle(env, deferred, false,
               ToJsError(env, webrtc::RTCErrorType::INVALID_STATE,
                         "peer connection is closed")
                   .Value());
    return {0, promise};
  }
  if (closed_ && ops_.empty()) {
    // Keep the process alive until this op completes.
    SetRef(env, true);
  }
  uint32_t id = next_op_++;
  ops_.emplace(id, deferred);
  return {id, promise};
}

void EventSink::Close(Napi::Env env) {
  if (closed_) {
    return;
  }
  closed_ = true;
  if (!callback_.IsEmpty()) {
    callback_.Unref();
  }
  if (ops_.empty()) {
    SetRef(env, false);
  }
}

void EventSink::OpSettled(Napi::Env env) {
  if (closed_ && ops_.empty()) {
    SetRef(env, false);
  }
}

void EventSink::SetRef(Napi::Env env, bool ref) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (released_) {
    return;
  }
  if (ref) {
    tsfn_.Ref(env);
  } else {
    tsfn_.Unref(env);
  }
}

void EventSink::Release() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (released_) {
    return;
  }
  released_ = true;
  tsfn_.Release();
}

bool EventSink::Released() {
  std::lock_guard<std::mutex> lock(mutex_);
  return released_;
}

void EventSink::Adopt(std::unique_ptr<ChannelObserver> observer) {
  std::lock_guard<std::mutex> lock(channels_mutex_);
  observers_.push_back(std::move(observer));
}

// Both of these unregister outside channels_mutex_: UnregisterObserver blocks
// on the signaling thread, which may itself be waiting for the mutex in a
// posted RemoveChannel.
void EventSink::RemoveChannel(uint32_t key) {
  std::unique_ptr<ChannelObserver> removed;
  {
    std::lock_guard<std::mutex> lock(channels_mutex_);
    for (auto it = observers_.begin(); it != observers_.end(); ++it) {
      if ((*it)->key() == key) {
        removed = std::move(*it);
        observers_.erase(it);
        break;
      }
    }
  }
  if (removed) {
    removed->Unregister();
  }
}

void EventSink::UnregisterChannels() {
  std::vector<std::unique_ptr<ChannelObserver>> observers;
  {
    std::lock_guard<std::mutex> lock(channels_mutex_);
    observers.swap(observers_);
  }
  for (auto& observer : observers) {
    observer->Unregister();
  }
}

std::pair<uint32_t, webrtc::scoped_refptr<webrtc::DtlsTransportInterface>>
EventSink::WatchSctp(
    webrtc::scoped_refptr<webrtc::SctpTransportInterface> sctp) {
  if (transports_unwatched_ || !sctp) {
    // A description without data channels (or a rollback) leaves none; the
    // old watcher stays until close, as for transports.
    return {0, nullptr};
  }
  if (!sctp_watcher_ || sctp_watcher_->sctp() != sctp.get()) {
    if (sctp_watcher_) {
      sctp_watcher_->Unregister();
    }
    sctp_watcher_ =
        std::make_unique<SctpWatcher>(shared_from_this(), sctp, ++sctp_key_);
    sctp_watcher_->Register();
  }
  return {sctp_key_, sctp->dtls_transport()};
}

uint32_t EventSink::WatchTransport(
    webrtc::scoped_refptr<webrtc::DtlsTransportInterface> dtls) {
  if (transports_unwatched_ || !dtls) {
    return 0;
  }
  for (auto& watcher : transport_watchers_) {
    if (watcher->dtls() == dtls.get()) {
      return watcher->key();
    }
  }
  uint32_t key = static_cast<uint32_t>(transport_watchers_.size()) + 1;
  transport_watchers_.push_back(
      std::make_unique<TransportWatcher>(shared_from_this(), dtls, key));
  transport_watchers_.back()->Register();
  return key;
}

std::string EventSink::IceRole(uint32_t key) {
  if (key == 0 || key > transport_watchers_.size()) {
    return "unknown";
  }
  return transport_watchers_[key - 1]->IceRole();
}

void EventSink::QueueTransportEvent(std::unique_ptr<NativeEvent> event) {
  if (collect_ != nullptr) {
    collect_->push_back(std::move(event));
    return;
  }
  if (event->kind != "ice:state") {
    // DTLS and SCTP reports go straight to JS, ahead of the connection
    // state they cause, as in Chrome (and as before ICE transports were
    // reported).
    Emit(std::move(event));
    return;
  }
  uint64_t seq = 0;
  {
    std::lock_guard<std::mutex> lock(transport_events_mutex_);
    seq = ++transport_events_seq_;
    transport_events_.emplace_back(seq, std::move(event));
  }
  SignalingThread()->PostTask([weak = weak_from_this(), seq] {
    if (auto sink = weak.lock()) {
      sink->FlushTransportEvents(seq);
    }
  });
}

void EventSink::FlushTransportEvents(uint64_t upto) {
  // Only up to its own event: a later one may be the cause of a connection
  // state change whose task is queued behind this one, and should ride it.
  std::vector<std::unique_ptr<NativeEvent>> events;
  {
    std::lock_guard<std::mutex> lock(transport_events_mutex_);
    while (!transport_events_.empty() &&
           transport_events_.front().first <= upto) {
      events.push_back(std::move(transport_events_.front().second));
      transport_events_.pop_front();
    }
  }
  for (auto& event : events) {
    Emit(std::move(event));
  }
}

void EventSink::CheckDroppedTransports() {
  for (auto& watcher : transport_watchers_) {
    watcher->CheckDropped();
  }
}

std::vector<std::pair<uint32_t, std::string>> EventSink::IceStates() {
  std::vector<std::pair<uint32_t, std::string>> states;
  NetworkThread()->BlockingCall([&] {
    for (auto& watcher : transport_watchers_) {
      states.emplace_back(watcher->key(), watcher->IceState());
    }
  });
  return states;
}

void EventSink::RefreshTransports() {
  NetworkThread()->BlockingCall([this] {
    for (auto& watcher : transport_watchers_) {
      watcher->Refresh();
    }
  });
}

void EventSink::UnwatchTransports() {
  NetworkThread()->BlockingCall([this] {
    transports_unwatched_ = true;
    if (sctp_watcher_) {
      sctp_watcher_->Unregister();
    }
    for (auto& watcher : transport_watchers_) {
      watcher->Unregister();
    }
    // Destroyed here: they may hold the last references to the transports,
    // which libwebrtc destroys on the network thread.
    sctp_watcher_.reset();
    transport_watchers_.clear();
  });
}

Napi::Error ToJsError(Napi::Env env,
                      webrtc::RTCErrorType type,
                      const std::string& message) {
  Napi::Error err = Napi::Error::New(env, message);
  SafeSet(err.Value(), "errorType", std::string(webrtc::ToString(type)));
  return err;
}

Napi::Error ToJsError(Napi::Env env, const webrtc::RTCError& error) {
  return ToJsError(env, error.type(), std::string(error.message()));
}

Napi::Error ParseError(Napi::Env env,
                       const std::string& message,
                       const std::string& sdp_line) {
  Napi::Error err = ToJsError(env, webrtc::RTCErrorType::SYNTAX_ERROR, message);
  SafeSet(err.Value(), "sdpLine", sdp_line);
  return err;
}

Napi::Promise RejectedPromise(Napi::Env env, const Napi::Error& error) {
  napi_deferred deferred = nullptr;
  Napi::Promise promise = SafeNewPromise(env, &deferred);
  SafeSettle(env, deferred, false, error.Value());
  return promise;
}

Napi::Value NewHandle(Napi::Env env,
                      const Napi::FunctionReference& ctor,
                      void* data) {
  napi_value fn = nullptr;
  napi_value external = nullptr;
  napi_value instance = nullptr;
  if (napi_get_reference_value(env, ctor, &fn) != napi_ok || fn == nullptr ||
      napi_create_external(env, data, nullptr, nullptr, &external) != napi_ok ||
      napi_new_instance(env, fn, 1, &external, &instance) != napi_ok) {
    return env.Undefined();
  }
  return Napi::Value(env, instance);
}

namespace {

Napi::Value DescriptionToJs(Napi::Env env,
                            const std::optional<DescriptionData>& desc) {
  if (!desc) {
    return env.Null();
  }
  Napi::Object obj = Napi::Object::New(env);
  SafeSet(obj, "type", desc->type);
  SafeSet(obj, "sdp", desc->sdp);
  return obj;
}

Napi::Value OptionalString(Napi::Env env,
                           const std::optional<std::string>& value) {
  return value ? Napi::String::New(env, *value) : env.Null();
}

// An abruptly closed data channel's or a DTLS transport's error.
Napi::Object ErrorInfoToJs(Napi::Env env, const webrtc::RTCError& error) {
  Napi::Object obj = Napi::Object::New(env);
  SafeSet(obj, "errorType", std::string(webrtc::ToString(error.type())));
  SafeSet(obj, "message", std::string(error.message()));
  if (error.error_detail() == webrtc::RTCErrorDetailType::NONE) {
    SafeSet(obj, "errorDetail", env.Null());
  } else {
    SafeSet(obj, "errorDetail",
            std::string(webrtc::ToString(error.error_detail())));
  }
  if (auto code = error.sctp_cause_code()) {
    SafeSet(obj, "sctpCauseCode", static_cast<double>(*code));
  } else {
    SafeSet(obj, "sctpCauseCode", env.Null());
  }
  return obj;
}

Napi::Value OptionalNumber(Napi::Env env, std::optional<double> value) {
  return value ? Napi::Number::New(env, *value) : env.Null();
}

Napi::Array StringsToJs(Napi::Env env, const std::vector<std::string>& v) {
  Napi::Array arr = Napi::Array::New(env, v.size());
  for (size_t i = 0; i < v.size(); i++) {
    SafeSet(arr, static_cast<uint32_t>(i), v[i]);
  }
  return arr;
}

// A TransportWatcher key; 0 (none) is null.
Napi::Value TransportKeyToJs(Napi::Env env, uint32_t key) {
  return key == 0 ? env.Null() : Napi::Number::New(env, key);
}

// RTP fields are omitted (undefined) once the PeerConnection, which owns the
// registry, has been destroyed. An empty value means the handle couldn't be
// created because JS can't run any more (env teardown); the caller then drops
// what it was building.
Napi::Value TransceiverToJs(
    Napi::Env env,
    EventSink* sink,
    const webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>& t) {
  if (!sink->rtp()) {
    return env.Undefined();
  }
  Napi::Value v = sink->rtp()->WrapTransceiver(env, t);
  return v.IsUndefined() ? Napi::Value() : v;
}

Napi::Value ReceiverToJs(
    Napi::Env env,
    EventSink* sink,
    const webrtc::scoped_refptr<webrtc::RtpReceiverInterface>& r) {
  if (!sink->rtp()) {
    return env.Undefined();
  }
  Napi::Value v = sink->rtp()->WrapReceiver(env, r);
  return v.IsUndefined() ? Napi::Value() : v;
}

// Empty if a handle couldn't be created (see TransceiverToJs).
Napi::Value SnapshotToJs(Napi::Env env,
                         EventSink* sink,
                         const DescriptionSnapshot& snap) {
  Napi::Object obj = Napi::Object::New(env);
  if (!snap.signaling_state.empty()) {
    SafeSet(obj, "signalingState", snap.signaling_state);
  }
  SafeSet(obj, "localDescription", DescriptionToJs(env, snap.local));
  SafeSet(obj, "currentLocalDescription",
          DescriptionToJs(env, snap.current_local));
  SafeSet(obj, "pendingLocalDescription",
          DescriptionToJs(env, snap.pending_local));
  SafeSet(obj, "remoteDescription", DescriptionToJs(env, snap.remote));
  SafeSet(obj, "currentRemoteDescription",
          DescriptionToJs(env, snap.current_remote));
  SafeSet(obj, "pendingRemoteDescription",
          DescriptionToJs(env, snap.pending_remote));
  if (snap.has_transceivers) {
    // The snapshot lists every transceiver the PC still has, so the handles
    // of removed ones can stop being held (contract decision 3).
    if (sink->rtp()) {
      RtpLiveSet live;
      live.epoch = snap.rtp_epoch;
      for (const TransceiverState& t : snap.transceivers) {
        live.transceivers.push_back(t.transceiver.get());
        live.senders.push_back(t.sender.get());
        live.receivers.push_back(t.receiver.get());
      }
      sink->rtp()->Retain(live);
    }
    Napi::Array list = Napi::Array::New(env, snap.transceivers.size());
    for (size_t i = 0; i < snap.transceivers.size(); i++) {
      const TransceiverState& t = snap.transceivers[i];
      Napi::Value handle = TransceiverToJs(env, sink, t.transceiver);
      if (handle.IsEmpty()) {
        return Napi::Value();
      }
      Napi::Object state = Napi::Object::New(env);
      SafeSet(state, "transceiver", handle);
      SafeSet(state, "mid", OptionalString(env, t.mid));
      SafeSet(state, "direction", t.direction);
      SafeSet(state, "currentDirection",
              OptionalString(env, t.current_direction));
      SafeSet(state, "firedDirection", OptionalString(env, t.fired_direction));
      SafeSet(state, "stopped", t.stopped);
      SafeSet(state, "stopping", t.stopping);
      SafeSet(state, "receiverStreamIds",
              StringsToJs(env, t.receiver_stream_ids));
      SafeSet(state, "senderTransport",
              TransportKeyToJs(env, t.sender_transport));
      SafeSet(state, "receiverTransport",
              TransportKeyToJs(env, t.receiver_transport));
      SafeSet(list, static_cast<uint32_t>(i), state);
    }
    SafeSet(obj, "transceivers", list);
    if (snap.sctp_key == 0) {
      SafeSet(obj, "sctp", env.Null());
    } else {
      Napi::Object sctp = Napi::Object::New(env);
      SafeSet(sctp, "key", snap.sctp_key);
      SafeSet(sctp, "transport", TransportKeyToJs(env, snap.sctp_transport));
      SafeSet(obj, "sctp", sctp);
    }
    Napi::Object roles = Napi::Object::New(env);
    for (const auto& [key, role] : snap.ice_roles) {
      SafeSet(roles, std::to_string(key), role);
    }
    SafeSet(obj, "iceRoles", roles);
  }
  return obj;
}

}  // namespace

namespace {

// The JS object for a non-op event. Empty if a handle or buffer couldn't be
// created because JS can't run any more (env teardown): the event is dropped.
Napi::Value EventToJs(Napi::Env env, EventSink* sink, NativeEvent* ev) {
  Napi::Object obj = Napi::Object::New(env);
  SafeSet(obj, "kind", ev->kind);
  if (!ev->state.empty()) {
    SafeSet(obj, "state", ev->state);
  }
  if (ev->has_candidate) {
    Napi::Object c = Napi::Object::New(env);
    SafeSet(c, "candidate", ev->candidate);
    SafeSet(c, "sdpMid", ev->sdp_mid);
    SafeSet(c, "sdpMLineIndex", ev->sdp_mline_index);
    SafeSet(obj, "candidate", c);
  }
  if (ev->channel_key != 0) {
    SafeSet(obj, "channelKey", ev->channel_key);
  }
  // An empty or undefined handle or snapshot means JS can't run any more
  // (env teardown): drop the event.
  if (ev->channel) {
    Napi::Object channel =
        DataChannel::NewInstance(env, ev->channel, ev->channel_key);
    if (channel.IsUndefined()) {
      return Napi::Value();
    }
    SafeSet(obj, "channel", channel);
  }
  if (ev->kind == "dc:message") {
    napi_value data = SafeBufferCopy(env, ev->data.data(), ev->data.size());
    if (data == nullptr) {
      return Napi::Value();
    }
    SafeSet(obj, "data", data);
    SafeSet(obj, "binary", ev->binary);
  }
  if (ev->kind == "dc:bufferedamount") {
    SafeSet(obj, "sent", ev->sent);
  }
  if ((ev->kind == "dc:state" || ev->kind == "dtls:error") && !ev->error.ok()) {
    SafeSet(obj, "error", ErrorInfoToJs(env, ev->error));
  }
  if (ev->transport_key != 0) {
    SafeSet(obj, "transport", ev->transport_key);
  }
  if (ev->kind == "ice:state") {
    SafeSet(obj, "role", ev->ice_role);
    SafeSet(obj, "mid", ev->ice_name);
    SafeSet(obj, "gathering", ev->ice_gathering);
    if (ev->pair_local && ev->pair_remote) {
      Napi::Object pair = Napi::Object::New(env);
      SafeSet(pair, "local", *ev->pair_local);
      SafeSet(pair, "remote", *ev->pair_remote);
      SafeSet(obj, "selectedPair", pair);
    } else {
      SafeSet(obj, "selectedPair", env.Null());
    }
  }
  if (ev->kind == "iceconnectionstatechange") {
    Napi::Object states = Napi::Object::New(env);
    for (const auto& [key, state] : ev->ice_states) {
      SafeSet(states, std::to_string(key), state);
    }
    SafeSet(obj, "transportStates", states);
  }
  if (ev->kind == "sctp:state") {
    SafeSet(obj, "maxMessageSize", OptionalNumber(env, ev->max_message_size));
    SafeSet(obj, "maxChannels",
            OptionalNumber(env, ev->max_channels
                                    ? std::optional<double>(*ev->max_channels)
                                    : std::nullopt));
  }
  if (ev->kind == "dtls:state") {
    Napi::Array certs = Napi::Array::New(env, ev->certificates.size());
    for (size_t i = 0; i < ev->certificates.size(); i++) {
      const std::vector<uint8_t>& der = ev->certificates[i];
      napi_value buffer = SafeArrayBufferCopy(env, der.data(), der.size());
      if (buffer == nullptr) {
        return Napi::Value();
      }
      SafeSet(certs, static_cast<uint32_t>(i), buffer);
    }
    SafeSet(obj, "remoteCertificates", certs);
  }
  if (ev->receiver) {
    Napi::Value receiver = ReceiverToJs(env, sink, ev->receiver);
    if (receiver.IsEmpty()) {
      return Napi::Value();
    }
    SafeSet(obj, "receiver", receiver);
  }
  if (ev->transceiver) {
    Napi::Value transceiver = TransceiverToJs(env, sink, ev->transceiver);
    if (transceiver.IsEmpty()) {
      return Napi::Value();
    }
    SafeSet(obj, "transceiver", transceiver);
  }
  if (ev->kind == "track") {
    SafeSet(obj, "streamIds", StringsToJs(env, ev->stream_ids));
  }
  if (ev->has_ice_error) {
    SafeSet(obj, "address", ev->ice_error_address);
    SafeSet(obj, "port", ev->ice_error_port);
    SafeSet(obj, "url", ev->ice_error_url);
    SafeSet(obj, "errorCode", ev->ice_error_code);
    SafeSet(obj, "errorText", ev->ice_error_text);
  }
  if (ev->kind == "negotiationneeded") {
    SafeSet(obj, "eventId", ev->event_id);
  }
  if (ev->kind == "task") {
    SafeSet(obj, "id", ev->task_id);
  }
  if (ev->snapshot) {
    Napi::Value snapshot = SnapshotToJs(env, sink, *ev->snapshot);
    if (snapshot.IsEmpty()) {
      return Napi::Value();
    }
    SafeSet(obj, "snapshot", snapshot);
  }
  return obj;
}

}  // namespace

void ResolveOp(Napi::Env env, EventSink* sink, NativeEvent* ev) {
  auto& ops = sink->ops_;
  auto it = ops.find(ev->op_id);
  if (it == ops.end()) {
    return;
  }
  napi_deferred deferred = it->second;
  ops.erase(it);

  if (!ev->error.ok()) {
    SafeSettle(env, deferred, false, ToJsError(env, ev->error).Value());
  } else if (ev->has_description) {
    Napi::Object desc = Napi::Object::New(env);
    SafeSet(desc, "type", ev->sdp_type);
    SafeSet(desc, "sdp", ev->sdp);
    SafeSettle(env, deferred, true, desc);
  } else if (ev->has_json) {
    SafeSettle(env, deferred, true, ToNapi(env, ev->json));
  } else if (ev->snapshot) {
    Napi::Value snapshot = SnapshotToJs(env, sink, *ev->snapshot);
    if (env.IsExceptionPending()) {
      // A conversion failed; settle the promise with that error rather than
      // leaving it pending forever.
      SafeSettle(env, deferred, false,
                 env.GetAndClearPendingException().Value());
    } else if (!snapshot.IsEmpty()) {
      SafeSettle(env, deferred, true, snapshot);
    }
    // Otherwise JS can't run any more (env teardown): drop the op.
  } else {
    SafeSettle(env, deferred, true, nullptr);
  }
  sink->OpSettled(env);
}

void CallJs(Napi::Env env, Napi::Function, EventSink*, EventWake* raw) {
  // Not the waking sink's context: it may be finalized already when Node
  // empties a TSFN's queue at env teardown.
  std::unique_ptr<EventWake> wake(raw);
  std::shared_ptr<EventSink> sink;
  std::unique_ptr<NativeEvent> ev;
  {
    std::lock_guard<std::mutex> lock(wake->order->mutex);
    auto& queue = wake->order->queue;
    if (queue.empty()) {
      return;  // Can't happen: every wake has its event.
    }
    sink = std::move(queue.front().first);
    ev = std::move(queue.front().second);
    queue.pop_front();
  }
  if (env == nullptr) {
    // Env teardown: TSFNs are being destroyed, so leave the reference
    // Emit() took; dropping the event is all that's left to do.
    return;
  }
  // `next` events its callback emits go right after it, in emission order.
  // Not across the microtasks after it: Node drains those once this
  // returns.
  EventOrder& order = *wake->order;
  {
    std::lock_guard<std::mutex> lock(order.mutex);
    order.delivering = true;
    order.next_insert = 0;
  }
  sink->Deliver(env, std::move(ev));
  std::lock_guard<std::mutex> lock(order.mutex);
  order.delivering = false;
}

void EventSink::Deliver(Napi::Env env, std::unique_ptr<NativeEvent> ev) {
  DeliverToJs(env, ev.get());
  ev.reset();
  // A sink force-finalized at env teardown has no TSFN left to release.
  if (!finalized_) {
    tsfn_.Release();
  }
}

void EventSink::DeliverToJs(Napi::Env env, NativeEvent* ev) {
  EventSink* sink = this;
  // Everything below may run while a worker is being terminated, when any
  // call that could run JS fails: it only uses napi_safe.h's helpers and
  // calls that can't fail, and drops the event if the call into JS fails.
  napi_handle_scope scope = nullptr;
  if (napi_open_handle_scope(env, &scope) != napi_ok) {
    return;
  }
  struct CloseScope {
    napi_env env;
    napi_handle_scope scope;
    ~CloseScope() { napi_close_handle_scope(env, scope); }
  } close_scope{env, scope};

  if (ev->kind == "op") {
    ResolveOp(env, sink, ev);
    return;
  }
  // Empty once a closed PC's callback has been collected.
  Napi::Value callback =
      sink->callback_.IsEmpty() ? Napi::Value() : sink->callback_.Value();
  if (callback.IsEmpty() || !callback.IsFunction()) {
    return;
  }

  Napi::Value obj = EventToJs(env, sink, ev);
  if (obj.IsEmpty()) {
    return;
  }
  if (env.IsExceptionPending()) {
    // A conversion failed (e.g. a WP0 stub). Surface it as an uncaught
    // exception rather than calling into JS with a half-built event.
    return;
  }
  napi_value recv = nullptr;
  napi_value arg = obj;
  napi_value result = nullptr;
  if (napi_get_undefined(env, &recv) == napi_ok) {
    // Fails once JS can't run; an exception the callback throws stays
    // pending and is reported as uncaught by Node, as before.
    napi_call_function(env, recv, callback, 1, &arg, &result);
  }
}

}  // namespace wrtc
