#include "media_track.h"
#include "napi_safe.h"

#include <string>

#include "addon.h"
#include "event_sink.h"
#include "rtc_base/crypto_random.h"
#include "runtime.h"
#include "util.h"

namespace wrtc {
namespace {

struct TrackHandle {
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track;
};

}  // namespace

void Track::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function ctor = DefineClass(
      env, "Track",
      {
          InstanceAccessor<&Track::Id>("id"),
          InstanceAccessor<&Track::Kind>("kind"),
          InstanceAccessor<&Track::Enabled, &Track::SetEnabled>("enabled"),
          InstanceMethod<&Track::Clone>("clone"),
      });
  AddonData* data = env.GetInstanceData<AddonData>();
  data->tracks = std::make_shared<TrackRegistry>();
  data->tracks->ctor = Napi::Persistent(ctor);
  exports.Set("Track", ctor);
}

Napi::Object Track::ToJs(
    Napi::Env env,
    webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track) {
  TrackRegistry& registry = *env.GetInstanceData<AddonData>()->tracks;
  auto it = registry.handles.find(track.get());
  if (it != registry.handles.end()) {
    Napi::Value existing = it->second.Value();
    if (!existing.IsEmpty() && existing.IsObject()) {
      return existing.As<Napi::Object>();
    }
    // Collected but not yet finalized; the new handle replaces it.
    registry.handles.erase(it);
  }
  TrackHandle handle{std::move(track)};
  // The constructor copies out of `handle` and registers itself. Undefined
  // if JS can't run any more (see NewHandle).
  return Napi::Object(env, NewHandle(env, registry.ctor, &handle));
}

webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> Track::FromJs(
    Napi::Value value) {
  Napi::Env env = value.Env();
  TrackRegistry& registry = *env.GetInstanceData<AddonData>()->tracks;
  if (value.IsObject() &&
      SafeInstanceOf(value.As<Napi::Object>(), registry.ctor.Value())) {
    // instanceof also accepts Object.create(Track.prototype), which has no
    // native object behind it.
    Track* track = TryUnwrap(value.As<Napi::Object>());
    if (track != nullptr && track->track_) {
      return track->track_;
    }
    if (env.IsExceptionPending()) {
      env.GetAndClearPendingException();
    }
  }
  ThrowTypeError(env, "expected a native Track handle");
  return nullptr;
}

Track::Track(const Napi::CallbackInfo& info) : SafeObjectWrap<Track>(info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsExternal()) {
    ThrowTypeError(env, "Track is not constructible");
    return;
  }
  track_ = info[0].As<Napi::External<TrackHandle>>().Data()->track;
  registry_ = env.GetInstanceData<AddonData>()->tracks;
  registry_->handles[track_.get()] = Napi::Weak(info.This().As<Napi::Object>());
}

Track::~Track() {
  if (!registry_ || !track_) {
    return;
  }
  // Only remove the entry if it still refers to this handle; ToJs may have
  // replaced it after this object was collected.
  auto it = registry_->handles.find(track_.get());
  if (it != registry_->handles.end()) {
    Napi::Value current = it->second.Value();
    if (current.IsEmpty() || TryUnwrap(current.As<Napi::Object>()) == this) {
      registry_->handles.erase(it);
    }
  }
}

Napi::Value Track::Id(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), track_->id());
}

Napi::Value Track::Kind(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), track_->kind());
}

Napi::Value Track::Enabled(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), track_->enabled());
}

void Track::SetEnabled(const Napi::CallbackInfo& info,
                       const Napi::Value& value) {
  track_->set_enabled(SafeToBool(value));
}

Napi::Value Track::Clone(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // For a received track the source is the receiver's RemoteAudioSource or
  // VideoRtpTrackSource, so the clone gets the same remote media.
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> clone;
  if (track_->kind() == webrtc::MediaStreamTrackInterface::kAudioKind) {
    auto* audio = static_cast<webrtc::AudioTrackInterface*>(track_.get());
    clone = Factory()->CreateAudioTrack(webrtc::CreateRandomUuid(),
                                        audio->GetSource());
  } else {
    auto* video = static_cast<webrtc::VideoTrackInterface*>(track_.get());
    clone = Factory()->CreateVideoTrack(
        webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface>(
            video->GetSource()),
        webrtc::CreateRandomUuid());
  }
  if (!clone) {
    ToJsError(env, webrtc::RTCError(webrtc::RTCErrorType::INTERNAL_ERROR,
                                    "could not clone the track"))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return ToJs(env, clone);
}

}  // namespace wrtc
