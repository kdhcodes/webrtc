#include "rtp.h"
#include "napi_safe.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <climits>
#include <span>
#include <unordered_map>

#include "addon.h"
#include "event_sink.h"
#include "media_track.h"
#include "peer_connection.h"
#include "runtime.h"
#include "util.h"

#include "api/transport/rtp/rtp_source.h"
#include "system_wrappers/include/clock.h"

namespace wrtc {

namespace {
std::atomic<uint64_t> rtp_epoch{0};
}  // namespace

uint64_t BeginRtpSnapshot() {
  return rtp_epoch.fetch_add(1);
}

// One map entry: the handle for a libwebrtc object, held strongly while the
// object belongs to a live transceiver of an open PC, weakly otherwise.
template <typename T>
struct HandleEntry {
  webrtc::scoped_refptr<T> object;
  const void* handle = nullptr;  // the ObjectWrap, to match in its destructor
  Napi::ObjectReference ref;
  bool strong = false;
  // Set by Retain(): the PC no longer has this object, so a handle created
  // again for it (after this one is collected) starts weak too.
  bool removed = false;
  // rtp_epoch when the entry was created; see RtpLiveSet.
  uint64_t epoch = 0;
};

template <typename T>
using HandleMap = std::unordered_map<const T*, HandleEntry<T>>;

struct RtpCore {
  std::weak_ptr<EventSink> sink;
  // Null once the PeerConnection is destroyed. libwebrtc's transceivers keep
  // raw pointers into their PC, so methods that reach it check this first.
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc;
  // False once the PC is closed (or the registry is gone). New entries are
  // then weak: identity still holds while JS holds a handle, but nothing may
  // keep a closed PC's handles (and whatever JS attached to them) alive.
  bool open = true;
  HandleMap<webrtc::RtpTransceiverInterface> transceivers;
  HandleMap<webrtc::RtpSenderInterface> senders;
  HandleMap<webrtc::RtpReceiverInterface> receivers;
};

namespace {

// Passed to a handle constructor through a Napi::External; JS can't create
// one, which is what makes the handles non-constructible from JS.
template <typename T>
struct HandleInit {
  std::shared_ptr<RtpCore> core;
  webrtc::scoped_refptr<T> object;
};

// Returns the handle for `object`, creating it if needed: null for no
// object, undefined if the handle couldn't be created (JS can't run any more;
// see NewHandle). A new handle is strong only if `may_be_strong`, the PC is
// open and the object hasn't been removed from it.
template <typename Handle, typename T>
Napi::Value Wrap(Napi::Env env,
                 const std::shared_ptr<RtpCore>& core,
                 HandleMap<T>& map,
                 const Napi::FunctionReference& ctor,
                 webrtc::scoped_refptr<T> object,
                 bool may_be_strong = true) {
  if (!object) {
    return env.Null();
  }
  bool removed = false;
  auto it = map.find(object.get());
  if (it != map.end()) {
    Napi::Value existing = it->second.ref.Value();
    if (!existing.IsEmpty() && existing.IsObject()) {
      return existing;
    }
    // Collected but not yet finalized; the new handle replaces it.
    removed = it->second.removed;
    map.erase(it);
  }
  HandleInit<T> init{core, object};
  // The constructor copies out of `init` synchronously.
  Napi::Value value = NewHandle(env, ctor, &init);
  if (value.IsUndefined()) {
    return value;
  }
  Napi::Object handle = value.As<Napi::Object>();
  bool strong = may_be_strong && core->open && !removed;
  HandleEntry<T>& entry = map[object.get()];
  entry.object = object;
  entry.handle = Handle::TryUnwrap(handle);
  entry.ref = strong ? Napi::Persistent(handle) : Napi::Weak(handle);
  entry.strong = strong;
  entry.removed = removed;
  entry.epoch = rtp_epoch.load();
  return handle;
}

// Called from a handle's destructor: drops its entry, unless a newer handle
// for the same object has replaced it.
template <typename T>
void Forget(HandleMap<T>& map, const T* object, const void* handle) {
  auto it = map.find(object);
  if (it != map.end() && it->second.handle == handle) {
    map.erase(it);
  }
}

template <typename T>
void Demote(HandleEntry<T>& entry) {
  if (entry.strong) {
    entry.ref.Unref();
    entry.strong = false;
  }
}

// Demotes the entries for objects not in `live`, except those created after
// the list was read.
template <typename T>
void Retain(HandleMap<T>& map,
            const std::vector<const void*>& live,
            uint64_t epoch) {
  for (auto& [ptr, entry] : map) {
    if (entry.epoch <= epoch &&
        std::find(live.begin(), live.end(), ptr) == live.end()) {
      Demote(entry);
      entry.removed = true;
    }
  }
}

template <typename T>
void DemoteAll(HandleMap<T>& map) {
  for (auto& [ptr, entry] : map) {
    Demote(entry);
  }
}

Napi::Value ThrowRtcError(Napi::Env env, const webrtc::RTCError& error) {
  if (!env.IsExceptionPending()) {
    ToJsError(env, error).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Value ThrowRtcError(Napi::Env env,
                          webrtc::RTCErrorType type,
                          const char* message) {
  return ThrowRtcError(env, webrtc::RTCError(type, message));
}

Napi::Value RejectClosed(Napi::Env env) {
  return RejectedPromise(env,
                         ToJsError(env, webrtc::RTCErrorType::INVALID_STATE,
                                   "peer connection is closed"));
}

// ---------------------------------------------------------------------------
// Reading plain JS dictionaries. Getters may throw; callers check
// env.IsExceptionPending() before acting on the result.

std::optional<double> OptNumber(Napi::Object obj, const char* key) {
  Napi::Value v = SafeGet(obj, key);
  if (v.IsNumber()) {
    return v.As<Napi::Number>().DoubleValue();
  }
  return std::nullopt;
}

std::optional<std::string> OptString(Napi::Object obj, const char* key) {
  Napi::Value v = SafeGet(obj, key);
  if (v.IsString()) {
    return v.As<Napi::String>().Utf8Value();
  }
  return std::nullopt;
}

std::optional<bool> OptBool(Napi::Object obj, const char* key) {
  Napi::Value v = SafeGet(obj, key);
  if (v.IsBoolean()) {
    return v.As<Napi::Boolean>().Value();
  }
  return std::nullopt;
}

// Returns false (with a TypeError pending) unless `value` is an array of
// strings.
bool StringsFromJs(Napi::Env env,
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

std::string ToLower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  return s;
}

std::string Trim(const std::string& s) {
  size_t begin = s.find_first_not_of(' ');
  size_t end = s.find_last_not_of(' ');
  return begin == std::string::npos ? std::string()
                                    : s.substr(begin, end - begin + 1);
}

// ---------------------------------------------------------------------------
// Codecs. sdpFmtpLine is the codec's fmtp parameters in SDP syntax, as
// Chrome reports them.

std::string FormatFmtp(const std::map<std::string, std::string>& params) {
  std::string line;
  for (const auto& [key, value] : params) {
    if (!line.empty()) {
      line += ';';
    }
    line += key.empty() ? value : key + "=" + value;
  }
  return line;
}

std::map<std::string, std::string> ParseFmtp(const std::string& line) {
  std::map<std::string, std::string> params;
  size_t start = 0;
  while (start <= line.size()) {
    size_t end = line.find(';', start);
    if (end == std::string::npos) {
      end = line.size();
    }
    std::string item = Trim(line.substr(start, end - start));
    if (!item.empty()) {
      size_t eq = item.find('=');
      if (eq == std::string::npos) {
        params[""] = item;
      } else {
        params[Trim(item.substr(0, eq))] = Trim(item.substr(eq + 1));
      }
    }
    start = end + 1;
  }
  return params;
}

void SetCodecFields(Napi::Object obj, const webrtc::RtpCodec& codec) {
  SafeSet(obj, "mimeType", codec.mime_type());
  SafeSet(obj, "clockRate", codec.clock_rate.value_or(0));
  if (codec.num_channels) {
    SafeSet(obj, "channels", *codec.num_channels);
  }
  std::string fmtp = FormatFmtp(codec.parameters);
  if (!fmtp.empty()) {
    SafeSet(obj, "sdpFmtpLine", fmtp);
  }
}

Napi::Object CodecToJs(Napi::Env env, const webrtc::RtpCodec& codec) {
  Napi::Object obj = Napi::Object::New(env);
  SetCodecFields(obj, codec);
  return obj;
}

// An RTCRtpCodec dictionary, as read from JS.
struct JsCodec {
  std::string mime_type;
  int clock_rate = 0;
  std::optional<int> channels;
  std::string fmtp;
};

bool CodecFromJs(Napi::Env env, Napi::Value value, JsCodec* out) {
  if (!value.IsObject()) {
    ThrowTypeError(env, "codec must be an object");
    return false;
  }
  Napi::Object obj = value.As<Napi::Object>();
  std::optional<std::string> mime = OptString(obj, "mimeType");
  std::optional<double> clock = OptNumber(obj, "clockRate");
  std::optional<double> channels = OptNumber(obj, "channels");
  std::optional<std::string> fmtp = OptString(obj, "sdpFmtpLine");
  if (env.IsExceptionPending()) {
    return false;
  }
  if (!mime || !clock) {
    ThrowTypeError(env, "codec needs mimeType and clockRate");
    return false;
  }
  out->mime_type = *mime;
  out->clock_rate = static_cast<int>(*clock);
  if (channels) {
    out->channels = static_cast<int>(*channels);
  }
  out->fmtp = fmtp.value_or("");
  return true;
}

bool Matches(const JsCodec& js, const webrtc::RtpCodec& codec) {
  return ToLower(js.mime_type) == ToLower(codec.mime_type()) &&
         js.clock_rate == codec.clock_rate.value_or(0) &&
         js.channels == codec.num_channels &&
         js.fmtp == FormatFmtp(codec.parameters);
}

std::optional<webrtc::MediaType> KindOfMime(const std::string& mime) {
  std::string type = ToLower(mime.substr(0, mime.find('/')));
  if (type == "audio") {
    return webrtc::MediaType::AUDIO;
  }
  if (type == "video") {
    return webrtc::MediaType::VIDEO;
  }
  return std::nullopt;
}

// Fills the RtpCodec fields from a JS codec that matched nothing libwebrtc
// knows; libwebrtc then rejects it with its own error.
void FillCodec(const JsCodec& js,
               webrtc::MediaType fallback_kind,
               webrtc::RtpCodec* codec) {
  size_t slash = js.mime_type.find('/');
  codec->name = slash == std::string::npos ? js.mime_type
                                           : js.mime_type.substr(slash + 1);
  codec->kind = KindOfMime(js.mime_type).value_or(fallback_kind);
  codec->clock_rate = js.clock_rate;
  codec->num_channels = js.channels;
  codec->parameters = ParseFmtp(js.fmtp);
}

std::vector<webrtc::RtpCodecCapability> KnownCodecs(webrtc::MediaType kind) {
  std::vector<webrtc::RtpCodecCapability> codecs =
      Factory()->GetRtpSenderCapabilities(kind).codecs;
  for (auto& codec : Factory()->GetRtpReceiverCapabilities(kind).codecs) {
    if (std::find(codecs.begin(), codecs.end(), codec) == codecs.end()) {
      codecs.push_back(codec);
    }
  }
  return codecs;
}

// ---------------------------------------------------------------------------
// Encodings

// Chrome's mapping between RTCPriorityType and bitrate_priority.
const char* PriorityToString(double bitrate_priority) {
  if (bitrate_priority <= 0.75) {
    return "very-low";
  }
  if (bitrate_priority <= 1.5) {
    return "low";
  }
  if (bitrate_priority <= 3) {
    return "medium";
  }
  return "high";
}

std::optional<double> BitratePriorityFromString(const std::string& s) {
  if (s == "very-low") {
    return 0.5;
  }
  if (s == "low") {
    return 1.0;
  }
  if (s == "medium") {
    return 2.0;
  }
  if (s == "high") {
    return 4.0;
  }
  return std::nullopt;
}

const char* NetworkPriorityToString(webrtc::Priority p) {
  switch (p) {
    case webrtc::Priority::kVeryLow:
      return "very-low";
    case webrtc::Priority::kLow:
      return "low";
    case webrtc::Priority::kMedium:
      return "medium";
    case webrtc::Priority::kHigh:
      return "high";
  }
  return "low";
}

std::optional<webrtc::Priority> NetworkPriorityFromString(
    const std::string& s) {
  if (s == "very-low") {
    return webrtc::Priority::kVeryLow;
  }
  if (s == "low") {
    return webrtc::Priority::kLow;
  }
  if (s == "medium") {
    return webrtc::Priority::kMedium;
  }
  if (s == "high") {
    return webrtc::Priority::kHigh;
  }
  return std::nullopt;
}

Napi::Object EncodingToJs(Napi::Env env,
                          const webrtc::RtpEncodingParameters& e) {
  Napi::Object obj = Napi::Object::New(env);
  if (!e.rid.empty()) {
    SafeSet(obj, "rid", e.rid);
  }
  SafeSet(obj, "active", e.active);
  if (e.max_bitrate_bps) {
    SafeSet(obj, "maxBitrate", *e.max_bitrate_bps);
  }
  if (e.max_framerate) {
    SafeSet(obj, "maxFramerate", *e.max_framerate);
  }
  if (e.scale_resolution_down_by) {
    SafeSet(obj, "scaleResolutionDownBy", *e.scale_resolution_down_by);
  }
  if (e.scale_resolution_down_to) {
    Napi::Object to = Napi::Object::New(env);
    SafeSet(to, "maxWidth", e.scale_resolution_down_to->width);
    SafeSet(to, "maxHeight", e.scale_resolution_down_to->height);
    SafeSet(obj, "scaleResolutionDownTo", to);
  }
  SafeSet(obj, "priority", PriorityToString(e.bitrate_priority));
  SafeSet(obj, "networkPriority", NetworkPriorityToString(e.network_priority));
  if (e.scalability_mode) {
    SafeSet(obj, "scalabilityMode", *e.scalability_mode);
  }
  if (e.codec) {
    SafeSet(obj, "codec", CodecToJs(env, *e.codec));
  }
  SafeSet(obj, "adaptivePtime", e.adaptive_ptime);
  return obj;
}

// The writable members of one RTCRtpEncodingParameters dictionary, read on
// the JS thread so they can be applied off it: setParameters() merges them
// into the sender's current parameters on the signaling thread. Absent
// members hold their WebIDL defaults; rid (read-only after creation) is
// only applied when present.
struct EncodingUpdate {
  std::optional<std::string> rid;
  bool active = true;
  std::optional<int> max_bitrate_bps;
  std::optional<double> max_framerate;
  std::optional<double> scale_resolution_down_by;
  std::optional<webrtc::Resolution> scale_resolution_down_to;
  double bitrate_priority = webrtc::kDefaultBitratePriority;
  webrtc::Priority network_priority = webrtc::Priority::kLow;
  std::optional<std::string> scalability_mode;
  std::optional<webrtc::RtpCodec> codec;
  bool adaptive_ptime = false;
};

bool EncodingUpdateFromJs(Napi::Env env,
                          Napi::Value value,
                          EncodingUpdate* out) {
  if (!value.IsObject()) {
    ThrowTypeError(env, "encodings must be objects");
    return false;
  }
  Napi::Object obj = value.As<Napi::Object>();
  std::optional<std::string> rid = OptString(obj, "rid");
  std::optional<bool> active = OptBool(obj, "active");
  std::optional<double> max_bitrate = OptNumber(obj, "maxBitrate");
  std::optional<double> max_framerate = OptNumber(obj, "maxFramerate");
  std::optional<double> scale_by = OptNumber(obj, "scaleResolutionDownBy");
  Napi::Value scale_to = SafeGet(obj, "scaleResolutionDownTo");
  std::optional<std::string> priority = OptString(obj, "priority");
  std::optional<std::string> network = OptString(obj, "networkPriority");
  std::optional<std::string> scalability = OptString(obj, "scalabilityMode");
  Napi::Value codec = SafeGet(obj, "codec");
  std::optional<bool> adaptive_ptime = OptBool(obj, "adaptivePtime");
  if (env.IsExceptionPending()) {
    return false;
  }

  out->rid = rid;
  out->active = active.value_or(true);
  if (max_bitrate) {
    // RTCRtpEncodingParameters.maxBitrate is an unsigned long; libwebrtc
    // stores an int.
    if (*max_bitrate > INT_MAX) {
      ThrowRtcError(env, webrtc::RTCErrorType::INVALID_RANGE,
                    "maxBitrate is larger than libwebrtc supports");
      return false;
    }
    out->max_bitrate_bps = static_cast<int>(*max_bitrate);
  }
  out->max_framerate = max_framerate;
  out->scale_resolution_down_by = scale_by;
  if (scale_to.IsObject()) {
    Napi::Object to = scale_to.As<Napi::Object>();
    std::optional<double> w = OptNumber(to, "maxWidth");
    std::optional<double> h = OptNumber(to, "maxHeight");
    if (env.IsExceptionPending()) {
      return false;
    }
    webrtc::Resolution res;
    res.width = static_cast<int>(w.value_or(0));
    res.height = static_cast<int>(h.value_or(0));
    out->scale_resolution_down_to = res;
  }
  if (priority) {
    std::optional<double> p = BitratePriorityFromString(*priority);
    if (!p) {
      ThrowTypeError(env, "invalid priority");
      return false;
    }
    out->bitrate_priority = *p;
  }
  if (network) {
    std::optional<webrtc::Priority> p = NetworkPriorityFromString(*network);
    if (!p) {
      ThrowTypeError(env, "invalid networkPriority");
      return false;
    }
    out->network_priority = *p;
  }
  out->scalability_mode = scalability;
  if (!codec.IsUndefined()) {
    JsCodec js;
    if (!CodecFromJs(env, codec, &js)) {
      return false;
    }
    webrtc::RtpCodec native;
    std::optional<webrtc::MediaType> kind = KindOfMime(js.mime_type);
    bool found = false;
    if (kind) {
      for (const auto& known : KnownCodecs(*kind)) {
        if (Matches(js, known)) {
          native = known;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      FillCodec(js, kind.value_or(webrtc::MediaType::AUDIO), &native);
    }
    out->codec = native;
  }
  out->adaptive_ptime = adaptive_ptime.value_or(false);
  return true;
}

bool EncodingUpdatesFromJs(Napi::Env env,
                           Napi::Value value,
                           std::vector<EncodingUpdate>* out) {
  if (!value.IsArray()) {
    ThrowTypeError(env, "encodings must be an array");
    return false;
  }
  Napi::Array arr = value.As<Napi::Array>();
  const uint32_t length = SafeLength(arr);
  out->resize(length);
  for (uint32_t i = 0; i < length; i++) {
    Napi::Value e = SafeGet(arr, i);
    if (env.IsExceptionPending() || !EncodingUpdateFromJs(env, e, &(*out)[i])) {
      return false;
    }
  }
  return true;
}

// Applies an encoding update to `e`. Members WebIDL doesn't expose (ssrc,
// ...) are untouched.
void ApplyEncoding(const EncodingUpdate& u, webrtc::RtpEncodingParameters* e) {
  if (u.rid) {
    e->rid = *u.rid;
  }
  e->active = u.active;
  e->max_bitrate_bps = u.max_bitrate_bps;
  e->max_framerate = u.max_framerate;
  e->scale_resolution_down_by = u.scale_resolution_down_by;
  e->scale_resolution_down_to = u.scale_resolution_down_to;
  e->bitrate_priority = u.bitrate_priority;
  e->network_priority = u.network_priority;
  e->scalability_mode = u.scalability_mode;
  e->codec = u.codec;
  e->adaptive_ptime = u.adaptive_ptime;
}

// Applies `updates` to `encodings`. When every encoding and every update
// has a rid, they are matched by rid: negotiation may have removed layers
// (a remote description narrowing the simulcast envelope) since the caller
// read the parameters, and updates for removed layers no longer apply.
// Otherwise they are matched by index, after resizing to the updates'
// length (new entries start from libwebrtc's defaults; for setParameters,
// libwebrtc then rejects the change in the number of encodings).
void ApplyEncodings(const std::vector<EncodingUpdate>& updates,
                    std::vector<webrtc::RtpEncodingParameters>* encodings) {
  const bool by_rid =
      !encodings->empty() &&
      std::all_of(encodings->begin(), encodings->end(),
                  [](const auto& e) { return !e.rid.empty(); }) &&
      std::all_of(updates.begin(), updates.end(),
                  [](const auto& u) { return u.rid && !u.rid->empty(); });
  if (by_rid) {
    for (webrtc::RtpEncodingParameters& e : *encodings) {
      auto it = std::find_if(updates.begin(), updates.end(),
                             [&e](const auto& u) { return *u.rid == e.rid; });
      if (it != updates.end()) {
        ApplyEncoding(*it, &e);
      }
    }
    return;
  }
  encodings->resize(updates.size());
  for (size_t i = 0; i < updates.size(); i++) {
    ApplyEncoding(updates[i], &(*encodings)[i]);
  }
}

// ---------------------------------------------------------------------------
// RtpParameters

std::optional<std::string> DegradationToString(
    webrtc::DegradationPreference p) {
  switch (p) {
    case webrtc::DegradationPreference::MAINTAIN_FRAMERATE_AND_RESOLUTION:
      return "maintain-framerate-and-resolution";
    case webrtc::DegradationPreference::MAINTAIN_FRAMERATE:
      return "maintain-framerate";
    case webrtc::DegradationPreference::MAINTAIN_RESOLUTION:
      return "maintain-resolution";
    case webrtc::DegradationPreference::BALANCED:
      return "balanced";
  }
  return std::nullopt;
}

std::optional<webrtc::DegradationPreference> DegradationFromString(
    const std::string& s) {
  if (s == "maintain-framerate-and-resolution") {
    return webrtc::DegradationPreference::MAINTAIN_FRAMERATE_AND_RESOLUTION;
  }
  if (s == "maintain-framerate") {
    return webrtc::DegradationPreference::MAINTAIN_FRAMERATE;
  }
  if (s == "maintain-resolution") {
    return webrtc::DegradationPreference::MAINTAIN_RESOLUTION;
  }
  if (s == "balanced") {
    return webrtc::DegradationPreference::BALANCED;
  }
  return std::nullopt;
}

// RTCRtpSendParameters (send) or RTCRtpReceiveParameters.
Napi::Object ParametersToJs(Napi::Env env,
                            const webrtc::RtpParameters& p,
                            bool send) {
  Napi::Object obj = Napi::Object::New(env);
  if (send) {
    SafeSet(obj, "transactionId", p.transaction_id);
    Napi::Array encodings = Napi::Array::New(env, p.encodings.size());
    for (size_t i = 0; i < p.encodings.size(); i++) {
      SafeSet(encodings, static_cast<uint32_t>(i),
              EncodingToJs(env, p.encodings[i]));
    }
    SafeSet(obj, "encodings", encodings);
  }
  Napi::Array extensions = Napi::Array::New(env, p.header_extensions.size());
  for (size_t i = 0; i < p.header_extensions.size(); i++) {
    const webrtc::RtpExtension& ext = p.header_extensions[i];
    Napi::Object e = Napi::Object::New(env);
    SafeSet(e, "uri", ext.uri);
    SafeSet(e, "id", ext.id.value());
    SafeSet(e, "encrypted", ext.encrypt);
    SafeSet(extensions, static_cast<uint32_t>(i), e);
  }
  SafeSet(obj, "headerExtensions", extensions);
  Napi::Object rtcp = Napi::Object::New(env);
  // A receiver's cname is left out (the spec; libwebrtc reports "").
  if (send) {
    SafeSet(rtcp, "cname", p.rtcp.cname);
  }
  SafeSet(rtcp, "reducedSize", p.rtcp.reduced_size);
  SafeSet(obj, "rtcp", rtcp);
  Napi::Array codecs = Napi::Array::New(env, p.codecs.size());
  for (size_t i = 0; i < p.codecs.size(); i++) {
    Napi::Object c = Napi::Object::New(env);
    SafeSet(c, "payloadType", p.codecs[i].payload_type);
    SetCodecFields(c, p.codecs[i]);
    SafeSet(codecs, static_cast<uint32_t>(i), c);
  }
  SafeSet(obj, "codecs", codecs);
  if (send && p.degradation_preference) {
    std::optional<std::string> d =
        DegradationToString(*p.degradation_preference);
    if (d) {
      SafeSet(obj, "degradationPreference", *d);
    }
  }
  return obj;
}

// The writable members of an RTCRtpSendParameters dictionary (encodings,
// degradationPreference), read on the JS thread. transactionId isn't kept:
// the JS layer checks it against what its getParameters() returned.
struct SendParametersUpdate {
  std::optional<std::vector<EncodingUpdate>> encodings;
  std::optional<webrtc::DegradationPreference> degradation_preference;
};

bool SendParametersUpdateFromJs(Napi::Env env,
                                Napi::Value value,
                                SendParametersUpdate* out) {
  if (!value.IsObject()) {
    ThrowTypeError(env, "parameters must be an object");
    return false;
  }
  Napi::Object obj = value.As<Napi::Object>();
  Napi::Value encodings = SafeGet(obj, "encodings");
  std::optional<std::string> degradation =
      OptString(obj, "degradationPreference");
  if (env.IsExceptionPending()) {
    return false;
  }
  if (!encodings.IsUndefined()) {
    out->encodings.emplace();
    if (!EncodingUpdatesFromJs(env, encodings, &*out->encodings)) {
      return false;
    }
  }
  if (degradation) {
    out->degradation_preference = DegradationFromString(*degradation);
    if (!out->degradation_preference) {
      ThrowTypeError(env, "invalid degradationPreference");
      return false;
    }
  }
  return true;
}

void ApplySendParameters(const SendParametersUpdate& u,
                         webrtc::RtpParameters* p) {
  if (u.encodings) {
    ApplyEncodings(*u.encodings, &p->encodings);
  }
  p->degradation_preference = u.degradation_preference;
}

// Starts an async op on the PC's event stream for a stats query. Allowed
// after close() (contract decision 1); rejects once the PC is destroyed.
template <typename T>
Napi::Value SelectorStats(Napi::Env env,
                          const std::shared_ptr<RtpCore>& core,
                          webrtc::scoped_refptr<T> selector) {
  std::shared_ptr<EventSink> sink = core ? core->sink.lock() : nullptr;
  if (!sink || !core->pc) {
    return RejectClosed(env);
  }
  auto [op_id, promise] = sink->BeginOp(env, /*allowed_after_close=*/true);
  if (op_id == 0) {
    return promise;
  }
  core->pc->GetStats(selector, MakeStatsCallback(sink, op_id));
  return promise;
}

}  // namespace

const char* DirectionToString(webrtc::RtpTransceiverDirection direction) {
  switch (direction) {
    case webrtc::RtpTransceiverDirection::kSendRecv:
      return "sendrecv";
    case webrtc::RtpTransceiverDirection::kSendOnly:
      return "sendonly";
    case webrtc::RtpTransceiverDirection::kRecvOnly:
      return "recvonly";
    case webrtc::RtpTransceiverDirection::kInactive:
      return "inactive";
    case webrtc::RtpTransceiverDirection::kStopped:
      return "stopped";
  }
  return "inactive";
}

std::optional<webrtc::RtpTransceiverDirection> DirectionFromString(
    const std::string& s) {
  if (s == "sendrecv") {
    return webrtc::RtpTransceiverDirection::kSendRecv;
  }
  if (s == "sendonly") {
    return webrtc::RtpTransceiverDirection::kSendOnly;
  }
  if (s == "recvonly") {
    return webrtc::RtpTransceiverDirection::kRecvOnly;
  }
  if (s == "inactive") {
    return webrtc::RtpTransceiverDirection::kInactive;
  }
  if (s == "stopped") {
    return webrtc::RtpTransceiverDirection::kStopped;
  }
  return std::nullopt;
}

// Reads RTCRtpEncodingParameters dictionaries into `out` (empty for
// addTransceiver's sendEncodings), one entry per dictionary.
bool EncodingsFromJs(Napi::Env env,
                     Napi::Value value,
                     std::vector<webrtc::RtpEncodingParameters>* out) {
  std::vector<EncodingUpdate> updates;
  if (!EncodingUpdatesFromJs(env, value, &updates)) {
    return false;
  }
  ApplyEncodings(updates, out);
  return true;
}

// ---------------------------------------------------------------------------
// Registry

std::unique_ptr<RtpRegistry> RtpRegistry::Create(
    std::weak_ptr<EventSink> sink) {
  return std::make_unique<PcRtpRegistry>(std::move(sink));
}

PcRtpRegistry::PcRtpRegistry(std::weak_ptr<EventSink> sink)
    : core_(std::make_shared<RtpCore>()) {
  core_->sink = std::move(sink);
}

// Handles may outlive the PC. Demoting their entries to weak references lets
// them be collected, while those JS still holds keep their identity.
PcRtpRegistry::~PcRtpRegistry() {
  Close();
  core_->pc = nullptr;
}

void PcRtpRegistry::SetPeerConnection(
    webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc) {
  core_->pc = std::move(pc);
}

void PcRtpRegistry::Close() {
  core_->open = false;
  DemoteAll(core_->transceivers);
  DemoteAll(core_->senders);
  DemoteAll(core_->receivers);
}

void PcRtpRegistry::Detach() {
  core_->pc = nullptr;
}

void PcRtpRegistry::Retain(const RtpLiveSet& live) {
  wrtc::Retain(core_->transceivers, live.transceivers, live.epoch);
  wrtc::Retain(core_->senders, live.senders, live.epoch);
  wrtc::Retain(core_->receivers, live.receivers, live.epoch);
}

Napi::Value PcRtpRegistry::WrapTransceiver(
    Napi::Env env,
    webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) {
  return Wrap<Transceiver>(env, core_, core_->transceivers,
                           env.GetInstanceData<AddonData>()->transceiver_ctor,
                           std::move(transceiver));
}

Napi::Value PcRtpRegistry::WrapSender(
    Napi::Env env,
    webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender) {
  return Wrap<Sender>(env, core_, core_->senders,
                      env.GetInstanceData<AddonData>()->sender_ctor,
                      std::move(sender));
}

Napi::Value PcRtpRegistry::WrapReceiver(
    Napi::Env env,
    webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver) {
  return Wrap<Receiver>(env, core_, core_->receivers,
                        env.GetInstanceData<AddonData>()->receiver_ctor,
                        std::move(receiver));
}

// ---------------------------------------------------------------------------
// Transceiver

void Transceiver::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function ctor = DefineClass(
      env, "Transceiver",
      {
          InstanceAccessor<&Transceiver::Mid>("mid"),
          InstanceAccessor<&Transceiver::Direction, &Transceiver::SetDirection>(
              "direction"),
          InstanceAccessor<&Transceiver::CurrentDirection>("currentDirection"),
          InstanceAccessor<&Transceiver::Stopped>("stopped"),
          InstanceAccessor<&Transceiver::Stopping>("stopping"),
          InstanceMethod<&Transceiver::Stop>("stop"),
          InstanceAccessor<&Transceiver::Sender>("sender"),
          InstanceAccessor<&Transceiver::Receiver>("receiver"),
          InstanceMethod<&Transceiver::SetCodecPreferences>(
              "setCodecPreferences"),
      });
  env.GetInstanceData<AddonData>()->transceiver_ctor = Napi::Persistent(ctor);
  exports.Set("Transceiver", ctor);
}

Transceiver::Transceiver(const Napi::CallbackInfo& info)
    : SafeObjectWrap<Transceiver>(info) {
  if (info.Length() < 1 || !info[0].IsExternal()) {
    ThrowTypeError(info.Env(), "Transceiver is not constructible");
    return;
  }
  auto* init =
      info[0]
          .As<Napi::External<HandleInit<webrtc::RtpTransceiverInterface>>>()
          .Data();
  core_ = init->core;
  transceiver_ = init->object;
}

Transceiver::~Transceiver() {
  if (core_) {
    Forget(core_->transceivers, transceiver_.get(), this);
  }
}

Napi::Value Transceiver::Mid(const Napi::CallbackInfo& info) {
  std::optional<std::string> mid = transceiver_->mid();
  return mid ? Napi::String::New(info.Env(), *mid) : info.Env().Null();
}

Napi::Value Transceiver::Direction(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(),
                           DirectionToString(transceiver_->direction()));
}

void Transceiver::SetDirection(const Napi::CallbackInfo& info,
                               const Napi::Value& value) {
  Napi::Env env = info.Env();
  std::optional<webrtc::RtpTransceiverDirection> direction;
  if (value.IsString()) {
    direction = DirectionFromString(value.As<Napi::String>().Utf8Value());
  }
  if (!direction) {
    ThrowTypeError(env, "invalid direction");
    return;
  }
  webrtc::RTCError error = transceiver_->SetDirectionWithError(*direction);
  if (!error.ok()) {
    ThrowRtcError(env, error);
  }
}

Napi::Value Transceiver::CurrentDirection(const Napi::CallbackInfo& info) {
  std::optional<webrtc::RtpTransceiverDirection> d =
      transceiver_->current_direction();
  return d ? Napi::String::New(info.Env(), DirectionToString(*d))
           : info.Env().Null();
}

Napi::Value Transceiver::Stopped(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), transceiver_->stopped());
}

Napi::Value Transceiver::Stopping(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), transceiver_->stopping());
}

Napi::Value Transceiver::Stop(const Napi::CallbackInfo& info) {
  webrtc::RTCError error = transceiver_->StopStandard();
  if (!error.ok()) {
    return ThrowRtcError(info.Env(), error);
  }
  return info.Env().Undefined();
}

// A sender or receiver handle may only be strong while its transceiver's is,
// so one created for a removed transceiver starts weak.
bool Transceiver::HeldStrongly() const {
  auto it = core_->transceivers.find(transceiver_.get());
  return it != core_->transceivers.end() && it->second.handle == this &&
         it->second.strong;
}

Napi::Value Transceiver::Sender(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  return Wrap<wrtc::Sender>(env, core_, core_->senders,
                            env.GetInstanceData<AddonData>()->sender_ctor,
                            transceiver_->sender(), HeldStrongly());
}

Napi::Value Transceiver::Receiver(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  return Wrap<wrtc::Receiver>(env, core_, core_->receivers,
                              env.GetInstanceData<AddonData>()->receiver_ctor,
                              transceiver_->receiver(), HeldStrongly());
}

// setCodecPreferences(codecs: RTCRtpCodec[]). Each codec is replaced by the
// matching capability (so libwebrtc sees its RTCP feedback and preferred
// payload type); one that matches nothing is passed as-is and libwebrtc
// rejects it (InvalidModificationError).
Napi::Value Transceiver::SetCodecPreferences(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsArray()) {
    return ThrowTypeError(env, "setCodecPreferences(codecs)");
  }
  // libwebrtc's transceiver resolves codecs through a raw pointer into its
  // PeerConnection (pc/rtp_transceiver.h, codec_lookup_helper_), which
  // dangles once the PC is destroyed. Every other handle method only touches
  // the transceiver, sender or receiver themselves, which the handles keep
  // alive.
  if (!core_->pc) {
    return ThrowRtcError(env, webrtc::RTCErrorType::INVALID_STATE,
                         "peer connection is closed");
  }
  webrtc::MediaType kind = transceiver_->media_type();
  std::vector<webrtc::RtpCodecCapability> known = KnownCodecs(kind);
  std::vector<webrtc::RtpCodecCapability> codecs;
  Napi::Array arr = info[0].As<Napi::Array>();
  for (uint32_t i = 0; i < SafeLength(arr); i++) {
    Napi::Value v = SafeGet(arr, i);
    JsCodec js;
    if (env.IsExceptionPending() || !CodecFromJs(env, v, &js)) {
      return env.Undefined();
    }
    auto it = std::find_if(known.begin(), known.end(),
                           [&](const auto& c) { return Matches(js, c); });
    if (it != known.end()) {
      codecs.push_back(*it);
    } else {
      webrtc::RtpCodecCapability codec;
      FillCodec(js, kind, &codec);
      codecs.push_back(codec);
    }
  }
  webrtc::RTCError error = transceiver_->SetCodecPreferences(
      std::span<webrtc::RtpCodecCapability>(codecs));
  if (!error.ok()) {
    return ThrowRtcError(env, error);
  }
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// Sender

void Sender::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function ctor =
      DefineClass(env, "Sender",
                  {
                      InstanceAccessor<&Sender::Track>("track"),
                      InstanceMethod<&Sender::ReplaceTrack>("replaceTrack"),
                      InstanceMethod<&Sender::GetParameters>("getParameters"),
                      InstanceMethod<&Sender::SetParameters>("setParameters"),
                      InstanceMethod<&Sender::SetDefaultDegradation>(
                          "setDefaultDegradationPreference"),
                      InstanceMethod<&Sender::SetStreams>("setStreams"),
                      InstanceMethod<&Sender::GetStats>("getStats"),
                  });
  env.GetInstanceData<AddonData>()->sender_ctor = Napi::Persistent(ctor);
  exports.Set("Sender", ctor);
}

Sender::Sender(const Napi::CallbackInfo& info) : SafeObjectWrap<Sender>(info) {
  if (info.Length() < 1 || !info[0].IsExternal()) {
    ThrowTypeError(info.Env(), "Sender is not constructible");
    return;
  }
  auto* init = info[0]
                   .As<Napi::External<HandleInit<webrtc::RtpSenderInterface>>>()
                   .Data();
  core_ = init->core;
  sender_ = init->object;
}

Sender::~Sender() {
  if (core_) {
    Forget(core_->senders, sender_.get(), this);
  }
}

webrtc::scoped_refptr<webrtc::RtpSenderInterface> Sender::FromJs(
    Napi::Value value) {
  Napi::Env env = value.Env();
  if (!value.IsObject() ||
      !SafeInstanceOf(value.As<Napi::Object>(),
                      env.GetInstanceData<AddonData>()->sender_ctor.Value())) {
    return nullptr;
  }
  // instanceof also accepts Object.create(Sender.prototype), which has no
  // native object behind it.
  Sender* sender = TryUnwrap(value.As<Napi::Object>());
  if (env.IsExceptionPending()) {
    env.GetAndClearPendingException();
  }
  return sender ? sender->sender_ : nullptr;
}

Napi::Value Sender::Track(const Napi::CallbackInfo& info) {
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track =
      sender_->track();
  return track ? wrtc::Track::ToJs(info.Env(), track) : info.Env().Null();
}

// replaceTrack(track | null). Synchronous; the JS layer chains it and checks
// the kind.
Napi::Value Sender::ReplaceTrack(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track;
  if (info.Length() > 0 && !info[0].IsNull() && !info[0].IsUndefined()) {
    track = wrtc::Track::FromJs(info[0]);
    if (!track) {
      return env.Undefined();
    }
  }
  if (!sender_->SetTrack(track.get())) {
    return ThrowRtcError(env, webrtc::RTCErrorType::INVALID_STATE,
                         "failed to replace the sender's track");
  }
  return env.Undefined();
}

Napi::Value Sender::GetParameters(const Napi::CallbackInfo& info) {
  return ParametersToJs(info.Env(), sender_->GetParameters(), true);
}

// setParameters(parameters): resolves through the PC's event stream. Rejects
// with INVALID_STATE once the PC is closed.
//
// The writable members are applied on top of the sender's parameters as they
// are now, not as an earlier getParameters() returned them: libwebrtc
// invalidates its transaction whenever negotiation changes the parameters,
// while the spec lets setParameters() race a description that changes them
// (the JS layer checks the transaction instead). Reading and applying
// happen in one signaling-thread task, so no SLD/SRD lands in between. The
// members WebIDL doesn't expose (ssrcs, RTCP feedback) round-trip unchanged.
Napi::Value Sender::SetParameters(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  SendParametersUpdate update;
  if (!SendParametersUpdateFromJs(env, info[0], &update)) {
    return RejectedPromise(env, env.GetAndClearPendingException());
  }
  std::shared_ptr<EventSink> sink = core_->sink.lock();
  if (!sink || !core_->pc) {
    return RejectClosed(env);
  }
  auto [op_id, promise] = sink->BeginOp(env);
  if (op_id == 0) {
    return promise;
  }
  SignalingThread()->BlockingCall([this, &update, sink, id = op_id] {
    webrtc::RtpParameters parameters = sender_->GetParameters();
    ApplySendParameters(update, &parameters);
    sender_->SetParametersAsync(parameters, [sink, id](webrtc::RTCError error) {
      sink->Emit(OpEvent(id, std::move(error)));
    });
  });
  return promise;
}

// setDefaultDegradationPreference(preference): sets the sender's degradation
// preference only if it has none, synchronously (one blocking signaling-
// thread call, so no app setParameters() can come first), with no
// result event (a failure, e.g. on a stopped sender, is ignored). Before
// negotiation libwebrtc keeps it and applies it when the sender gets its
// SSRC. The JS layer decides when to call it.
Napi::Value Sender::SetDefaultDegradation(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::optional<webrtc::DegradationPreference> preference;
  if (info.Length() > 0 && info[0].IsString()) {
    preference = DegradationFromString(info[0].As<Napi::String>().Utf8Value());
  }
  if (!preference) {
    return ThrowTypeError(env, "invalid degradationPreference");
  }
  if (!core_ || !core_->pc) {
    return env.Undefined();
  }
  SignalingThread()->BlockingCall([this, &preference] {
    webrtc::RtpParameters parameters = sender_->GetParameters();
    if (parameters.degradation_preference) {
      return;
    }
    parameters.degradation_preference = preference;
    sender_->SetParametersAsync(parameters, [](webrtc::RTCError) {});
  });
  return env.Undefined();
}

Napi::Value Sender::SetStreams(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<std::string> ids;
  if (!StringsFromJs(env, info[0], "streamIds", &ids)) {
    return env.Undefined();
  }
  sender_->SetStreams(ids);
  return env.Undefined();
}

Napi::Value Sender::GetStats(const Napi::CallbackInfo& info) {
  return SelectorStats(info.Env(), core_, sender_);
}

// ---------------------------------------------------------------------------
// Receiver

void Receiver::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function ctor =
      DefineClass(env, "Receiver",
                  {
                      InstanceAccessor<&Receiver::Track>("track"),
                      InstanceMethod<&Receiver::GetParameters>("getParameters"),
                      InstanceMethod<&Receiver::SetJitterBufferMinimumDelay>(
                          "setJitterBufferMinimumDelay"),
                      InstanceMethod<&Receiver::GetStats>("getStats"),
                      InstanceMethod<&Receiver::GetSources>("getSources"),
                  });
  env.GetInstanceData<AddonData>()->receiver_ctor = Napi::Persistent(ctor);
  exports.Set("Receiver", ctor);
}

Receiver::Receiver(const Napi::CallbackInfo& info)
    : SafeObjectWrap<Receiver>(info) {
  if (info.Length() < 1 || !info[0].IsExternal()) {
    ThrowTypeError(info.Env(), "Receiver is not constructible");
    return;
  }
  auto* init =
      info[0]
          .As<Napi::External<HandleInit<webrtc::RtpReceiverInterface>>>()
          .Data();
  core_ = init->core;
  receiver_ = init->object;
}

Receiver::~Receiver() {
  if (core_) {
    Forget(core_->receivers, receiver_.get(), this);
  }
}

webrtc::scoped_refptr<webrtc::RtpReceiverInterface> Receiver::FromJs(
    Napi::Value value) {
  Napi::Env env = value.Env();
  if (!value.IsObject() ||
      !SafeInstanceOf(
          value.As<Napi::Object>(),
          env.GetInstanceData<AddonData>()->receiver_ctor.Value())) {
    return nullptr;
  }
  Receiver* receiver = TryUnwrap(value.As<Napi::Object>());
  if (env.IsExceptionPending()) {
    env.GetAndClearPendingException();
  }
  return receiver ? receiver->receiver_ : nullptr;
}

Napi::Value Receiver::Track(const Napi::CallbackInfo& info) {
  return wrtc::Track::ToJs(info.Env(), receiver_->track());
}

Napi::Value Receiver::GetParameters(const Napi::CallbackInfo& info) {
  return ParametersToJs(info.Env(), receiver_->GetParameters(), false);
}

// setJitterBufferMinimumDelay(seconds: number | null). A blocking proxy call
// to the worker thread, like getParameters(); libwebrtc caches the value
// until the receiver has a media channel and an SSRC, and keeps it across
// them. Works after close() (it then does nothing).
Napi::Value Receiver::SetJitterBufferMinimumDelay(
    const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::optional<double> seconds;
  if (info.Length() >= 1 && info[0].IsNumber()) {
    double value = info[0].As<Napi::Number>().DoubleValue();
    if (!(value >= 0)) {
      return ThrowTypeError(env, "seconds must be a non-negative number");
    }
    seconds = value;
  } else if (info.Length() < 1 || !info[0].IsNull()) {
    return ThrowTypeError(env, "seconds must be a number or null");
  }
  receiver_->SetJitterBufferMinimumDelay(seconds);
  return env.Undefined();
}

Napi::Value Receiver::GetStats(const Napi::CallbackInfo& info) {
  return SelectorStats(info.Env(), core_, receiver_);
}

Napi::Value Receiver::GetSources(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // A blocking call to the worker thread, as GetParameters() is.
  std::vector<webrtc::RtpSource> sources = receiver_->GetSources();
  // RtpSource timestamps are on the receive path's clock: the default
  // environment's real-time clock.
  const webrtc::Timestamp now =
      webrtc::Clock::GetRealTimeClock()->CurrentTime();
  Napi::Array out = Napi::Array::New(env, sources.size());
  uint32_t i = 0;
  for (const webrtc::RtpSource& source : sources) {
    Napi::Object entry = Napi::Object::New(env);
    entry.Set("source", static_cast<double>(source.source_id()));
    entry.Set("type", source.source_type() == webrtc::RtpSourceType::SSRC
                          ? "ssrc"
                          : "csrc");
    entry.Set("age", (now - source.timestamp()).us() / 1000.0);
    entry.Set("rtpTimestamp", static_cast<double>(source.rtp_timestamp()));
    if (source.audio_level()) {
      entry.Set("audioLevel", static_cast<double>(*source.audio_level()));
    }
    out.Set(i++, entry);
  }
  return out;
}

// ---------------------------------------------------------------------------

Napi::Value GetRtpCapabilities(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    return ThrowTypeError(env, "getRtpCapabilities(side, kind)");
  }
  std::string side = info[0].As<Napi::String>().Utf8Value();
  std::string kind = info[1].As<Napi::String>().Utf8Value();
  if (side != "sender" && side != "receiver") {
    return ThrowTypeError(env, "side must be 'sender' or 'receiver'");
  }
  webrtc::MediaType type;
  if (kind == "audio") {
    type = webrtc::MediaType::AUDIO;
  } else if (kind == "video") {
    type = webrtc::MediaType::VIDEO;
  } else {
    return env.Null();
  }
  webrtc::RtpCapabilities caps =
      side == "sender" ? Factory()->GetRtpSenderCapabilities(type)
                       : Factory()->GetRtpReceiverCapabilities(type);
  Napi::Object obj = Napi::Object::New(env);
  Napi::Array codecs = Napi::Array::New(env, caps.codecs.size());
  for (size_t i = 0; i < caps.codecs.size(); i++) {
    SafeSet(codecs, static_cast<uint32_t>(i), CodecToJs(env, caps.codecs[i]));
  }
  SafeSet(obj, "codecs", codecs);
  Napi::Array extensions = Napi::Array::New(env, caps.header_extensions.size());
  for (size_t i = 0; i < caps.header_extensions.size(); i++) {
    Napi::Object e = Napi::Object::New(env);
    SafeSet(e, "uri", caps.header_extensions[i].uri);
    SafeSet(extensions, static_cast<uint32_t>(i), e);
  }
  SafeSet(obj, "headerExtensions", extensions);
  return obj;
}

}  // namespace wrtc
