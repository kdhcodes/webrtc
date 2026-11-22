// JS handles for libwebrtc media tracks, with process-wide identity.
#pragma once

#include <memory>
#include <unordered_map>

#include <napi.h>

#include "napi_safe.h"

#include "api/media_stream_interface.h"
#include "api/scoped_refptr.h"

namespace wrtc {

// Maps libwebrtc tracks to their JS handles, per env. Entries are weak: the
// same libwebrtc track yields the same JS object for as long as JS holds it,
// which is what `sender.track`, `receiver.track` and `track` events need.
// Shared-owned by every Track so it outlives them regardless of the order in
// which Node finalizes things at env teardown.
struct TrackRegistry {
  Napi::FunctionReference ctor;
  std::unordered_map<webrtc::MediaStreamTrackInterface*, Napi::ObjectReference>
      handles;
};

// CONTRACT (WP0): Track::ToJs, Track::FromJs and the registry semantics
// (one JS handle per libwebrtc track while JS holds it) are shared by WP-M
// and WP-R. Don't change their signatures or semantics without the
// coordinator.
//
// Native track handle: `id`, `kind`, `enabled` (get/set). Everything else
// (readyState, muted, stop) is JS-side; see SPEC-LAYER-PLAN.md "Media".
// Not constructible from JS; created by sources (createTrack) and by the RTP
// objects through Track::ToJs.
class Track : public SafeObjectWrap<Track> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);

  // Returns the JS handle for `track`, creating it if needed.
  static Napi::Object ToJs(
      Napi::Env env,
      webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track);

  // Returns the libwebrtc track behind a JS handle. If `value` is not a
  // Track handle, throws a TypeError and returns null. (Not named Unwrap:
  // that would hide ObjectWrap::Unwrap, which node-addon-api calls.)
  static webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> FromJs(
      Napi::Value value);

  explicit Track(const Napi::CallbackInfo& info);
  ~Track() override;

  const webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface>& track()
      const {
    return track_;
  }

 private:
  Napi::Value Id(const Napi::CallbackInfo& info);
  Napi::Value Kind(const Napi::CallbackInfo& info);
  Napi::Value Enabled(const Napi::CallbackInfo& info);
  void SetEnabled(const Napi::CallbackInfo& info, const Napi::Value& value);
  // A new track (new id) on the same source, local or remote, as wrtc's
  // MediaStreamTrack::Clone does. `enabled` is not copied.
  Napi::Value Clone(const Napi::CallbackInfo& info);

  std::shared_ptr<TrackRegistry> registry_;
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track_;
};

}  // namespace wrtc
