// RTCRtpTransceiver / RTCRtpSender / RTCRtpReceiver handles.
//
// The RtpRegistry interface is fixed contract (src/event_sink.cc uses it);
// everything else here belongs to WP-R.
#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <napi.h>

#include "napi_safe.h"

#include "api/peer_connection_interface.h"
#include "api/rtp_parameters.h"
#include "api/rtp_receiver_interface.h"
#include "api/rtp_sender_interface.h"
#include "api/rtp_transceiver_interface.h"
#include "api/scoped_refptr.h"

namespace wrtc {

class EventSink;

// Starts an RTP snapshot: returns an epoch to put in the RtpLiveSet built from
// a transceiver list read *after* this call. Any thread (snapshots are
// captured on the signaling thread).
uint64_t BeginRtpSnapshot();

// Every RTP object a PeerConnection still has, as listed by a snapshot or
// getTransceivers(). Handles created after `epoch` may belong to objects the
// list predates (e.g. a transceiver JS added while an SRD was completing),
// so Retain() leaves them alone.
struct RtpLiveSet {
  uint64_t epoch = 0;
  std::vector<const void*> transceivers;
  std::vector<const void*> senders;
  std::vector<const void*> receivers;
};

// Per-PC map from libwebrtc RTP objects to their JS handles, giving them
// stable identity (the same native object always yields the same JS
// object). Owned by the PeerConnection and lent to its EventSink. Created,
// used and destroyed only on the JS thread while the env is alive, so it may
// hold Napi references. Constructor refs for the handles are in AddonData
// (transceiver_ctor, sender_ctor, receiver_ctor). `sink` is weak: use it to
// start ops (BeginOp) and emit their completions, e.g. for setParameters.
class RtpRegistry {
 public:
  static std::unique_ptr<RtpRegistry> Create(std::weak_ptr<EventSink> sink);
  virtual ~RtpRegistry() = default;

  virtual Napi::Value WrapTransceiver(
      Napi::Env env,
      webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) = 0;
  virtual Napi::Value WrapSender(
      Napi::Env env,
      webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender) = 0;
  virtual Napi::Value WrapReceiver(
      Napi::Env env,
      webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver) = 0;

  // Called with each full snapshot (SLD/SRD completion) and by
  // getTransceivers(): the handles of objects the PC has removed stop being
  // held strongly (contract decision 3).
  virtual void Retain(const RtpLiveSet& live) = 0;
};

// State shared by a PC's registry and every handle it created. Defined in
// rtp.cc; JS thread only.
struct RtpCore;

// The registry implementation, with the extra hooks PeerConnection needs.
//
// Handles are held strongly while their transceiver is in the open PC's
// transceiver list, so JS-side state attached to them (e.g. the spec layer's
// wrapper objects) survives without JS holding them. They are demoted to weak
// references, and handles created later for the same objects start weak,
// once:
// - the transceiver is removed (after stop() and negotiation; see Retain()),
// - or the PC is closed (Close()), so handles that reference their PC can't
//   keep a closed PC alive (contract decision 2).
// A weak handle is still returned while JS holds it, so identity holds, and
// its entry goes away when it is collected.
class PcRtpRegistry : public RtpRegistry {
 public:
  explicit PcRtpRegistry(std::weak_ptr<EventSink> sink);
  ~PcRtpRegistry() override;

  // Lets handles reach the PC (getStats(selector)). Called once the PC
  // exists.
  void SetPeerConnection(
      webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc);
  // The PC was closed: every handle becomes weak.
  void Close();
  // Drops the handles' PC reference so the PeerConnection controls when the
  // PC is destroyed (it must outlive its observer). Handle methods that need
  // the PC then fail with INVALID_STATE.
  void Detach();

  void Retain(const RtpLiveSet& live) override;

  Napi::Value WrapTransceiver(
      Napi::Env env,
      webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver)
      override;
  Napi::Value WrapSender(
      Napi::Env env,
      webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender) override;
  Napi::Value WrapReceiver(
      Napi::Env env,
      webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver) override;

 private:
  std::shared_ptr<RtpCore> core_;
};

class Transceiver : public SafeObjectWrap<Transceiver> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit Transceiver(const Napi::CallbackInfo& info);
  ~Transceiver() override;

 private:
  Napi::Value Mid(const Napi::CallbackInfo& info);
  Napi::Value Direction(const Napi::CallbackInfo& info);
  void SetDirection(const Napi::CallbackInfo& info, const Napi::Value& value);
  Napi::Value CurrentDirection(const Napi::CallbackInfo& info);
  Napi::Value Stopped(const Napi::CallbackInfo& info);
  Napi::Value Stopping(const Napi::CallbackInfo& info);
  Napi::Value Stop(const Napi::CallbackInfo& info);
  Napi::Value Sender(const Napi::CallbackInfo& info);
  Napi::Value Receiver(const Napi::CallbackInfo& info);
  Napi::Value SetCodecPreferences(const Napi::CallbackInfo& info);
  bool HeldStrongly() const;

  std::shared_ptr<RtpCore> core_;
  webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver_;
};

class Sender : public SafeObjectWrap<Sender> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit Sender(const Napi::CallbackInfo& info);
  ~Sender() override;

  // Returns the sender behind a JS handle, or null without throwing if
  // `value` is not a Sender handle.
  static webrtc::scoped_refptr<webrtc::RtpSenderInterface> FromJs(
      Napi::Value value);

 private:
  Napi::Value Track(const Napi::CallbackInfo& info);
  Napi::Value ReplaceTrack(const Napi::CallbackInfo& info);
  Napi::Value GetParameters(const Napi::CallbackInfo& info);
  Napi::Value SetParameters(const Napi::CallbackInfo& info);
  Napi::Value SetDefaultDegradation(const Napi::CallbackInfo& info);
  Napi::Value SetStreams(const Napi::CallbackInfo& info);
  Napi::Value GetStats(const Napi::CallbackInfo& info);

  std::shared_ptr<RtpCore> core_;
  webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender_;
};

class Receiver : public SafeObjectWrap<Receiver> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit Receiver(const Napi::CallbackInfo& info);
  ~Receiver() override;

  // Returns the receiver behind a JS handle, or null without throwing if
  // `value` is not a Receiver handle.
  static webrtc::scoped_refptr<webrtc::RtpReceiverInterface> FromJs(
      Napi::Value value);

 private:
  Napi::Value Track(const Napi::CallbackInfo& info);
  Napi::Value GetParameters(const Napi::CallbackInfo& info);
  Napi::Value SetJitterBufferMinimumDelay(const Napi::CallbackInfo& info);
  Napi::Value GetStats(const Napi::CallbackInfo& info);
  Napi::Value GetSources(const Napi::CallbackInfo& info);

  std::shared_ptr<RtpCore> core_;
  webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver_;
};

// getRtpCapabilities(side: "sender" | "receiver", kind: "audio" | "video")
Napi::Value GetRtpCapabilities(const Napi::CallbackInfo& info);

// "sendrecv" etc.
const char* DirectionToString(webrtc::RtpTransceiverDirection direction);
std::optional<webrtc::RtpTransceiverDirection> DirectionFromString(
    const std::string& direction);

// Reads RTCRtpEncodingParameters dictionaries (sendEncodings). On failure a
// JS exception is pending and false is returned.
bool EncodingsFromJs(Napi::Env env,
                     Napi::Value value,
                     std::vector<webrtc::RtpEncodingParameters>* out);

}  // namespace wrtc
