// One ordered event stream per environment.
//
// Every native callback for a peer connection, and for each of its data
// channels, is queued through its ThreadsafeFunction, as are completions of
// async operations (createOffer etc.) and the tasks the JS layer queues
// (queueTask), and all of an environment's peer connections share one order
// (EventOrder). JS therefore sees events and promise resolutions in the order
// libwebrtc produced them, within a PC and across PCs, which is what the
// spec's event/promise ordering has to be built on. Each is delivered by a
// TSFN call of its own, which Node runs in its own callback scope: the
// reactions to a promise settled there run at that scope's microtask
// checkpoint, before the next event is delivered.
#pragma once

#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include <napi.h>

#include "api/data_channel_interface.h"
#include "api/dtls_transport_interface.h"
#include "api/rtc_error.h"
#include "api/rtp_receiver_interface.h"
#include "api/rtp_sender_interface.h"
#include "api/rtp_transceiver_interface.h"
#include "api/scoped_refptr.h"
#include "api/sctp_transport_interface.h"

namespace wrtc {

class RtpRegistry;

struct DescriptionData {
  std::string type;
  std::string sdp;
};

struct TransceiverState {
  webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver;
  std::optional<std::string> mid;
  std::string direction;  // "sendrecv" | "sendonly" | "recvonly" | ...
  std::optional<std::string> current_direction;
  std::optional<std::string> fired_direction;
  bool stopped = false;
  bool stopping = false;
  // receiver()->stream_ids(): needed to update remote MediaStream membership
  // for every transceiver, not just those that fire `track`.
  std::vector<std::string> receiver_stream_ids;
  // Read with the rest so RtpRegistry::Retain() needs no proxy calls.
  webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender;
  webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver;
  // dtls_transport() of each, read with the rest and swapped for their
  // TransportWatcher keys (0: none) by WatchTransports().
  webrtc::scoped_refptr<webrtc::DtlsTransportInterface> sender_dtls;
  webrtc::scoped_refptr<webrtc::DtlsTransportInterface> receiver_dtls;
  uint32_t sender_transport = 0;
  uint32_t receiver_transport = 0;
};

// State captured on the signaling thread at the moment an operation
// completes, so JS can apply it atomically (SPEC-LAYER-PLAN.md, "Description
// snapshots"). SLD/SRD completions fill everything; icecandidate and
// icegatheringstatechange events fill only the descriptions, so the cached
// localDescription can include newly gathered candidates.
struct DescriptionSnapshot {
  std::string signaling_state;  // empty when not captured
  std::optional<DescriptionData> local;
  std::optional<DescriptionData> current_local;
  std::optional<DescriptionData> pending_local;
  std::optional<DescriptionData> remote;
  std::optional<DescriptionData> current_remote;
  std::optional<DescriptionData> pending_remote;
  bool has_transceivers = false;
  std::vector<TransceiverState> transceivers;
  // BeginRtpSnapshot() at capture; see RtpLiveSet.
  uint64_t rtp_epoch = 0;
  // Full snapshots: the SCTP transport's key and its DTLS transport's (0:
  // the PC has no SCTP transport), and the ICE role of each transport key
  // named. Filled in by WatchTransports().
  uint32_t sctp_key = 0;
  uint32_t sctp_transport = 0;
  std::vector<std::pair<uint32_t, std::string>> ice_roles;
};

struct NativeEvent {
  // PC events: connectionstatechange, iceconnectionstatechange,
  // icegatheringstatechange, signalingstatechange (state), icecandidate
  // (candidate), negotiationneeded, datachannel (channel).
  // DC events, all with channel_key: dc:state (state; error once closed
  // abruptly), dc:message (data), dc:bufferedamount (sent = bytes just
  // handed to SCTP).
  // sctp:state (transport_key, state, max_message_size, max_channels): the
  // PC's SCTP transport. dtls:state (transport_key, state, certificates),
  // dtls:error (transport_key, error), ice:state (transport_key, state,
  // ice_role, ice_name, pair_*): a DTLS transport and the ICE transport
  // under it (src/transport.h).
  // track (receiver, transceiver, stream_ids), removetrack (receiver),
  // icecandidateerror (ice_error_*), negotiationneeded (event_id).
  // "op": completion of async operation op_id; never reaches the JS callback.
  // "task" (task_id): a task the JS layer queued (PeerConnection.queueTask).
  // Any event may also carry a snapshot.
  std::string kind;
  std::string state;

  bool has_candidate = false;
  std::string candidate;
  std::string sdp_mid;
  int sdp_mline_index = 0;

  uint32_t channel_key = 0;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> channel;
  std::vector<uint8_t> data;
  bool binary = false;
  double sent = 0;

  std::optional<double> max_message_size;
  std::optional<int> max_channels;
  // DER, one per certificate of the remote chain.
  std::vector<std::vector<uint8_t>> certificates;
  uint32_t transport_key = 0;
  std::string ice_role;
  std::string ice_name;
  std::string ice_gathering;
  // iceconnectionstatechange: every watched ICE transport's state as
  // libwebrtc had it then, by key (EventSink::IceStates).
  std::vector<std::pair<uint32_t, std::string>> ice_states;
  // The selected candidate pair's candidate-attributes.
  std::optional<std::string> pair_local;
  std::optional<std::string> pair_remote;

  uint32_t op_id = 0;
  webrtc::RTCError error;
  bool has_description = false;
  std::string sdp_type;
  std::string sdp;
  bool has_json = false;
  std::string json;

  webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver;
  webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver;
  std::vector<std::string> stream_ids;

  bool has_ice_error = false;
  std::string ice_error_address;
  int ice_error_port = 0;
  std::string ice_error_url;
  int ice_error_code = 0;
  std::string ice_error_text;

  uint32_t event_id = 0;
  uint32_t task_id = 0;

  std::unique_ptr<DescriptionSnapshot> snapshot;
};

class ChannelObserver;
class EventSink;
class SctpWatcher;
class TransportWatcher;

// Every peer connection's events in one environment (one per env:
// AddonData::event_order), in the order EventSink::Emit() queued them (a
// `next` one ahead of the rest). Each
// event still wakes its own sink's TSFN, but a wake delivers whichever event
// is oldest, so JS sees all of the env's PCs' events as one FIFO, the way a
// browser's single event loop does. Without it two PCs' events crossed (a
// data channel message reaching JS before the sender's bufferedAmount
// decrease that libwebrtc reported first), depending on which TSFN libuv
// polled first. Each queued event holds an Acquire() on its own sink's TSFN,
// so a sink can't finalize (rejecting its pending ops) while one of its
// events is still queued behind another sink's.
struct EventOrder {
  std::mutex mutex;
  std::deque<
      std::pair<std::shared_ptr<EventSink>, std::unique_ptr<NativeEvent>>>
      queue;
  // While an event's JS callback runs (CallJs), `next` events go here, in
  // the order they are emitted: ahead of everything queued before, after
  // the `next` ones emitted earlier in the same callback. Reset for each
  // event delivered.
  bool delivering = false;
  size_t next_insert = 0;
};

// A TSFN item: "deliver the oldest event". It holds the order rather than
// reaching it through the TSFN's context, which may already be finalized
// when Node empties a TSFN's queue at env teardown.
struct EventWake {
  std::shared_ptr<EventOrder> order;
};

void CallJs(Napi::Env env,
            Napi::Function callback,
            EventSink* waker,
            EventWake* wake);
// Settles the op an "op" event completes. JS thread.
void ResolveOp(Napi::Env env, EventSink* sink, NativeEvent* event);
using EventTsfn = Napi::TypedThreadSafeFunction<EventSink, EventWake, CallJs>;

class EventSink : public std::enable_shared_from_this<EventSink> {
 public:
  EventSink();
  ~EventSink();

  void Start(Napi::Env env, Napi::Function callback);

  // Any thread. Dropped silently after Release(). With `next`, if called
  // (on the JS thread) from an event's JS callback, it goes ahead of every
  // event queued before, after any other `next` one that callback emitted:
  // delivered right after the current event, before anything libwebrtc
  // reported meanwhile. Called anywhere else, even from a microtask of that
  // event's task, `next` is ignored and it goes to the back.
  void Emit(std::unique_ptr<NativeEvent> event, bool next = false);

  // JS thread. Registers a pending async op and returns its promise. Rejected
  // immediately (INVALID_STATE, op_id 0) once the sink is released, or once
  // it is closed unless `allowed_after_close` (getStats).
  std::pair<uint32_t, Napi::Promise> BeginOp(Napi::Env env,
                                             bool allowed_after_close = false);

  // JS thread. The peer connection was closed. Events keep being delivered
  // (the JS layer drops them), but the TSFN no longer keeps the event loop
  // alive, except while ops are pending: they complete normally, and getStats
  // may still start new ones (contract decision 1). The callback is now held
  // weakly; see callback_.
  void Close(Napi::Env env);

  // JS thread (~PeerConnection or env cleanup). Stops accepting events and
  // lets the TSFN finalize once its queue drains; ops still pending are then
  // rejected. Idempotent.
  void Release();
  bool Released();

  // Data channel observers are owned by the sink so they outlive the channels
  // they're registered on. Each is removed once its channel closes.
  void Adopt(std::unique_ptr<ChannelObserver> observer);
  void RemoveChannel(uint32_t key);
  void UnregisterChannels();

  // Network thread. Starts watching `sctp` (and stops watching the previous
  // transport) unless it is null or already watched. Returns its key (0 for
  // none) and its DTLS transport.
  std::pair<uint32_t, webrtc::scoped_refptr<webrtc::DtlsTransportInterface>>
  WatchSctp(webrtc::scoped_refptr<webrtc::SctpTransportInterface> sctp);
  // Network thread. Starts watching `dtls` unless it is null or already
  // watched. Returns its key, 0 for null or once unwatched.
  uint32_t WatchTransport(
      webrtc::scoped_refptr<webrtc::DtlsTransportInterface> dtls);
  // Network thread. The ICE role libwebrtc gave transport `key` ("unknown"
  // for an unknown key).
  std::string IceRole(uint32_t key);
  // Network thread. While set, QueueTransportEvent() appends to `events`
  // instead: what WatchTransports() emits ahead of a description's
  // completion.
  void CollectTransportEvents(
      std::vector<std::unique_ptr<NativeEvent>>* events) {
    collect_ = events;
  }
  // Network thread. A transport's report: "sctp:state" and "dtls:*" are
  // emitted at once, "ice:state" goes through the signaling thread, like
  // libwebrtc's connection-level state changes, so an ICE change and the
  // iceconnectionstatechange it causes (posted first, by
  // JsepTransportController) reach JS in a fixed order, the connection's
  // first, as in Chrome. Queues it and posts a FlushTransportEvents().
  void QueueTransportEvent(std::unique_ptr<NativeEvent> event);
  // Signaling thread. Emits the queued transport events up to number `upto`
  // (later ones are behind tasks this one mustn't overtake).
  void FlushTransportEvents(uint64_t upto);
  // Network thread. CheckDropped() on every watcher.
  void CheckDroppedTransports();
  // Signaling thread, with a blocking call to the network thread: every
  // watched ICE transport's current state, for an iceconnectionstatechange
  // to carry (the JS layer applies one only when it is the truth already).
  std::vector<std::pair<uint32_t, std::string>> IceStates();
  // Signaling thread, with a blocking call to the network thread: has every
  // watcher report what changed. DTLS changes are emitted at once, so they
  // precede a connectionstatechange emitted next.
  void RefreshTransports();
  // JS thread (PC close and teardown). Unregisters the SCTP and transport
  // watchers, with a blocking call to the network thread. Idempotent.
  void UnwatchTransports();

  // JS thread only. Stable JS handles for this PC's RTP objects. Owned by the
  // PeerConnection (which lives on the JS thread); the sink only borrows it,
  // because the sink itself is shared with libwebrtc observers and may be
  // destroyed on the signaling thread or after the env is gone. Null once the
  // PeerConnection is destroyed; CallJs then omits RTP fields.
  RtpRegistry* rtp() { return rtp_; }
  void set_rtp(RtpRegistry* rtp) { rtp_ = rtp; }

 private:
  friend void CallJs(Napi::Env, Napi::Function, EventSink*, EventWake*);
  friend void FinalizeSink(Napi::Env, void*, EventSink*);
  friend void ResolveOp(Napi::Env, EventSink*, NativeEvent*);

  // JS thread. Delivers one of this sink's events, then releases the TSFN
  // reference Emit() took for it.
  void Deliver(Napi::Env env, std::unique_ptr<NativeEvent> event);
  void DeliverToJs(Napi::Env env, NativeEvent* event);

  // JS thread. Called whenever an op settles: a closed sink stops keeping
  // the event loop alive once none are left.
  void OpSettled(Napi::Env env);
  // JS thread. Refs or unrefs the TSFN unless it is released.
  void SetRef(Napi::Env env, bool ref);

  std::mutex mutex_;
  bool released_ = true;
  EventTsfn tsfn_;
  std::shared_ptr<EventSink> self_while_started_;
  std::shared_ptr<EventOrder> order_;
  // JS thread only. Set by FinalizeSink: the TSFN is gone (at env teardown,
  // possibly with events of this sink still queued).
  bool finalized_ = false;

  // JS thread only. The onEvent callback. Held here rather than by the TSFN,
  // which can only hold it strongly until it is released (~PeerConnection):
  // a callback that references its PeerConnection (as the spec layer's does,
  // through its wrapper) would then keep a closed PC alive forever. Strong
  // until Close(), weak after; events arriving once it is collected are
  // dropped. Reset in FinalizeSink, on the JS thread.
  Napi::FunctionReference callback_;
  bool closed_ = false;
  // JS thread only. Ordered so pending ops are rejected in the order they
  // were started.
  uint32_t next_op_ = 1;
  // Raw deferreds: settling goes through SafeSettle (napi_safe.h).
  std::map<uint32_t, napi_deferred> ops_;

  std::mutex channels_mutex_;
  std::vector<std::unique_ptr<ChannelObserver>> observers_;

  // Network thread only. Once unwatched (PC closed), an SLD/SRD that still
  // completes must not start watching again: nothing would unregister it.
  // Transport watchers stay until then (a dropped transport's is small),
  // holding their transports so keys can't be reused by a new transport at
  // the same address.
  std::mutex transport_events_mutex_;
  std::deque<std::pair<uint64_t, std::unique_ptr<NativeEvent>>>
      transport_events_;
  uint64_t transport_events_seq_ = 0;
  std::vector<std::unique_ptr<NativeEvent>>* collect_ = nullptr;
  std::unique_ptr<SctpWatcher> sctp_watcher_;
  uint32_t sctp_key_ = 0;
  std::vector<std::unique_ptr<TransportWatcher>> transport_watchers_;
  bool transports_unwatched_ = false;

  RtpRegistry* rtp_ = nullptr;
};

// Native errors (contract decision 4, `NativeError` in
// lib/internal/native-types.ts): every rejection or throw for a runtime
// condition is a plain Error whose `errorType` is libwebrtc's RTCErrorType
// name ("INVALID_STATE", ...). TypeError is reserved for arguments of the
// wrong type, which only a JS-layer bug can pass.
Napi::Error ToJsError(Napi::Env env, const webrtc::RTCError& error);
Napi::Error ToJsError(Napi::Env env,
                      webrtc::RTCErrorType type,
                      const std::string& message);
// SYNTAX_ERROR for an SDP or candidate that libwebrtc couldn't parse, with
// the offending line as `sdpLine`.
Napi::Error ParseError(Napi::Env env,
                       const std::string& message,
                       const std::string& sdp_line);
// A promise already rejected with `error`.
Napi::Promise RejectedPromise(Napi::Env env, const Napi::Error& error);

// Creates a native handle (Track, DataChannel, Transceiver, ...) from native
// code: `new ctor(External(data))`. Uses raw N-API calls and returns
// undefined on failure without touching node-addon-api's error helpers.
// While a worker is being terminated JS can't run, so creating the instance
// fails, and node-addon-api's error path then aborts the process ("Error::New
// napi_get_last_error_info"). Callers drop whatever they were building.
Napi::Value NewHandle(Napi::Env env,
                      const Napi::FunctionReference& ctor,
                      void* data);

}  // namespace wrtc
