#include "data_channel.h"
#include "napi_safe.h"

#include <atomic>
#include <optional>
#include <string>

#include "addon.h"
#include "event_sink.h"
#include "peer_connection.h"
#include "rtc_base/copy_on_write_buffer.h"
#include "runtime.h"

namespace wrtc {
namespace {

std::atomic<uint32_t> next_channel_key{1};

struct ChannelHandle {
  webrtc::scoped_refptr<webrtc::DataChannelInterface> channel;
  uint32_t key;
};

const char* SctpStateString(webrtc::SctpTransportState state) {
  switch (state) {
    case webrtc::SctpTransportState::kNew:
      return "new";
    case webrtc::SctpTransportState::kConnecting:
      return "connecting";
    case webrtc::SctpTransportState::kConnected:
      return "connected";
    case webrtc::SctpTransportState::kClosed:
    case webrtc::SctpTransportState::kNumValues:
      break;
  }
  return "closed";
}

}  // namespace

SctpWatcher::SctpWatcher(
    std::shared_ptr<EventSink> sink,
    webrtc::scoped_refptr<webrtc::SctpTransportInterface> sctp,
    uint32_t key)
    : sink_(sink), sctp_(std::move(sctp)), key_(key) {}

void SctpWatcher::Register() {
  sctp_->RegisterObserver(this);
  // Read in the same network-thread task as the registration, where every
  // observer callback also runs, so no change is missed.
  OnStateChange(sctp_->Information());
}

void SctpWatcher::Unregister() {
  sctp_->UnregisterObserver();
}

void SctpWatcher::OnStateChange(webrtc::SctpTransportInformation info) {
  auto sink = sink_.lock();
  if (!sink) {
    return;
  }
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "sctp:state";
  ev->transport_key = key_;
  ev->state = SctpStateString(info.state());
  ev->max_message_size = info.MaxMessageSize();
  ev->max_channels = info.MaxChannels();
  sink->QueueTransportEvent(std::move(ev));
}

ChannelObserver::ChannelObserver(
    std::shared_ptr<EventSink> sink,
    webrtc::scoped_refptr<webrtc::DataChannelInterface> channel,
    uint32_t key)
    : sink_(sink), channel_(std::move(channel)), key_(key) {}

void ChannelObserver::OnStateChange() {
  auto sink = sink_.lock();
  if (!sink) {
    return;
  }
  webrtc::DataChannelInterface::DataState state = channel_->state();
  if (state == last_state_) {
    return;
  }
  last_state_ = state;
  auto ev = std::make_unique<NativeEvent>();
  ev->kind = "dc:state";
  ev->channel_key = key_;
  ev->state = webrtc::DataChannelInterface::DataStateString(state);
  if (state == webrtc::DataChannelInterface::kClosed) {
    // Set when the channel was closed abruptly rather than by the closing
    // procedure (e.g. the SCTP association went away).
    ev->error = channel_->error();
  }
  sink->Emit(std::move(ev));

  if (state == webrtc::DataChannelInterface::kClosed) {
    // A closed channel never calls back again, so drop its observer (and the
    // channel reference it holds). Not from inside this callback, though:
    // that would destroy `this` while libwebrtc is still calling it.
    SignalingThread()->PostTask([weak = sink_, key = key_] {
      if (auto sink = weak.lock()) {
        sink->RemoveChannel(key);
      }
    });
  }
}

void ChannelObserver::OnMessage(const webrtc::DataBuffer& buffer) {
  if (auto sink = sink_.lock()) {
    auto ev = std::make_unique<NativeEvent>();
    ev->kind = "dc:message";
    ev->channel_key = key_;
    ev->data.assign(buffer.data.cdata(), buffer.data.cdata() + buffer.size());
    ev->binary = buffer.binary;
    sink->Emit(std::move(ev));
  }
}

void ChannelObserver::OnBufferedAmountChange(uint64_t sent_data_size) {
  if (auto sink = sink_.lock()) {
    auto ev = std::make_unique<NativeEvent>();
    ev->kind = "dc:bufferedamount";
    ev->channel_key = key_;
    // Only the size. Reading channel_->buffered_amount() here too would be a
    // blocking hop to the network thread for every message sent.
    ev->sent = static_cast<double>(sent_data_size);
    sink->Emit(std::move(ev));
  }
}

void ChannelObserver::Unregister() {
  channel_->UnregisterObserver();
}

uint32_t WireChannel(
    const std::shared_ptr<EventSink>& sink,
    webrtc::scoped_refptr<webrtc::DataChannelInterface> channel,
    const std::function<void(uint32_t key)>& announce) {
  uint32_t key = next_channel_key++;
  auto observer = std::make_unique<ChannelObserver>(sink, channel, key);
  ChannelObserver* raw = observer.get();
  sink->Adopt(std::move(observer));
  // A channel created on an already-connected SCTP transport is open before
  // CreateDataChannelOrError returns, so its only state change happened
  // before we could observe it. Registering and reading the initial state in
  // one signaling-thread task (where every observer callback also runs)
  // reports it exactly once. Runs inline when already on that thread.
  SignalingThread()->BlockingCall([&] {
    channel->RegisterObserver(raw);
    if (announce) {
      announce(key);
    }
    if (channel->state() != webrtc::DataChannelInterface::kConnecting) {
      raw->OnStateChange();
    }
  });
  return key;
}

void DataChannel::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function ctor = DefineClass(
      env, "DataChannel",
      {
          InstanceAccessor<&DataChannel::Key>("key"),
          InstanceAccessor<&DataChannel::Label>("label"),
          InstanceAccessor<&DataChannel::Ordered>("ordered"),
          InstanceAccessor<&DataChannel::MaxPacketLifeTime>(
              "maxPacketLifeTime"),
          InstanceAccessor<&DataChannel::MaxRetransmits>("maxRetransmits"),
          InstanceAccessor<&DataChannel::Protocol>("protocol"),
          InstanceAccessor<&DataChannel::Negotiated>("negotiated"),
          InstanceAccessor<&DataChannel::Id>("id"),
          InstanceAccessor<&DataChannel::ReadyState>("readyState"),
          InstanceAccessor<&DataChannel::BufferedAmount>("bufferedAmount"),
          InstanceAccessor<&DataChannel::MaxSendQueueSize>("maxSendQueueSize"),
          InstanceMethod<&DataChannel::Send>("send"),
          InstanceMethod<&DataChannel::Close>("close"),
      });
  env.GetInstanceData<AddonData>()->data_channel_ctor = Napi::Persistent(ctor);
  exports.Set("DataChannel", ctor);
}

Napi::Object DataChannel::NewInstance(
    Napi::Env env,
    webrtc::scoped_refptr<webrtc::DataChannelInterface> channel,
    uint32_t key) {
  ChannelHandle handle{std::move(channel), key};
  // The constructor copies out of `handle` synchronously. Undefined if JS
  // can't run any more (see NewHandle); callers check for it.
  Napi::Value instance = NewHandle(
      env, env.GetInstanceData<AddonData>()->data_channel_ctor, &handle);
  return Napi::Object(env, instance);
}

DataChannel::DataChannel(const Napi::CallbackInfo& info)
    : SafeObjectWrap<DataChannel>(info) {
  if (info.Length() < 1 || !info[0].IsExternal()) {
    Napi::TypeError::New(info.Env(), "DataChannel is not constructible")
        .ThrowAsJavaScriptException();
    return;
  }
  auto* handle = info[0].As<Napi::External<ChannelHandle>>().Data();
  channel_ = handle->channel;
  key_ = handle->key;
}

Napi::Value DataChannel::Key(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), key_);
}

Napi::Value DataChannel::Label(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), channel_->label());
}

// The creation-time settings below bypass libwebrtc's proxy (no thread hop).
Napi::Value DataChannel::Ordered(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), channel_->ordered());
}

Napi::Value DataChannel::MaxPacketLifeTime(const Napi::CallbackInfo& info) {
  std::optional<int> value = channel_->maxPacketLifeTime();
  return value ? Napi::Number::New(info.Env(), *value) : info.Env().Null();
}

Napi::Value DataChannel::MaxRetransmits(const Napi::CallbackInfo& info) {
  std::optional<int> value = channel_->maxRetransmitsOpt();
  return value ? Napi::Number::New(info.Env(), *value) : info.Env().Null();
}

Napi::Value DataChannel::Protocol(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), channel_->protocol());
}

Napi::Value DataChannel::Negotiated(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), channel_->negotiated());
}

Napi::Value DataChannel::MaxSendQueueSize(const Napi::CallbackInfo& info) {
  return Napi::Number::New(
      info.Env(),
      static_cast<double>(webrtc::DataChannelInterface::MaxSendQueueSize()));
}

Napi::Value DataChannel::Id(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), channel_->id());
}

Napi::Value DataChannel::ReadyState(const Napi::CallbackInfo& info) {
  return Napi::String::New(
      info.Env(),
      webrtc::DataChannelInterface::DataStateString(channel_->state()));
}

Napi::Value DataChannel::BufferedAmount(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(),
                           static_cast<double>(channel_->buffered_amount()));
}

// send(data: Buffer | Uint8Array, binary: boolean): boolean
//
// The blocking Send (a round trip to the network thread), not SendAsync, on
// purpose: with SendAsync a burst of small messages outran the receiving
// process, overflowed its UDP socket and stalled on SCTP retransmission
// timeouts (PLAN.md, "Data channel throughput").
Napi::Value DataChannel::Send(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "send(data: Uint8Array, binary: boolean)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto bytes = info[0].As<Napi::Uint8Array>();
  webrtc::CopyOnWriteBuffer payload(bytes.Data(), bytes.ByteLength());
  bool ok = channel_->Send(webrtc::DataBuffer(payload, SafeToBool(info[1])));
  return Napi::Boolean::New(env, ok);
}

Napi::Value DataChannel::Close(const Napi::CallbackInfo& info) {
  channel_->Close();
  return info.Env().Undefined();
}

}  // namespace wrtc
