// Assignability between our public types and lib.dom's, both ways. wrtc's
// types re-export the DOM's, so wrtc code freely mixes `wrtc.MediaStream`
// with the global MediaStream; as a drop-in replacement, ours must be
// assignable to the DOM's and the DOM's to ours. Never executed: it only
// has to compile. scripts/check-dom-types.mjs (part of `pnpm run typecheck`)
// compiles it against the published declarations (./.declarations, emitted
// by build:ts) with the current TypeScript's lib.dom and with TypeScript
// 5.8's, whose dictionaries differ in places.
//
// Where a direction can't hold, the assignment carries @ts-expect-error and
// says why, and a narrower assignment without the members at fault shows
// that everything else is compatible. TypeScript's lib.dom only has what at
// least two browser engines ship, so it lacks some spec members we (and
// Chrome) implement; a DOM-typed value doesn't promise those members, so it
// can't be assignable to our type, which does.
import type * as W from './.declarations/index.js';

// ---------------------------------------------------------------------------
// Interfaces: our class and lib.dom's interface of the same name

interface Classes {
  MediaDeviceInfo: [W.MediaDeviceInfo, MediaDeviceInfo];
  MediaDevices: [W.MediaDevices, MediaDevices];
  MediaStream: [W.MediaStream, MediaStream];
  MediaStreamTrack: [W.MediaStreamTrack, MediaStreamTrack];
  MediaStreamTrackEvent: [W.MediaStreamTrackEvent, MediaStreamTrackEvent];
  RTCCertificate: [W.RTCCertificate, RTCCertificate];
  RTCDataChannel: [W.RTCDataChannel, RTCDataChannel];
  RTCDataChannelEvent: [W.RTCDataChannelEvent, RTCDataChannelEvent];
  RTCDtlsTransport: [W.RTCDtlsTransport, RTCDtlsTransport];
  RTCError: [W.RTCError, RTCError];
  RTCErrorEvent: [W.RTCErrorEvent, RTCErrorEvent];
  RTCIceCandidate: [W.RTCIceCandidate, RTCIceCandidate];
  // A dictionary in lib.dom, an interface of getters in ours (and the spec).
  RTCIceCandidatePair: [W.RTCIceCandidatePair, RTCIceCandidatePair];
  RTCIceTransport: [W.RTCIceTransport, RTCIceTransport];
  RTCPeerConnection: [W.RTCPeerConnection, RTCPeerConnection];
  RTCPeerConnectionIceErrorEvent: [
    W.RTCPeerConnectionIceErrorEvent,
    RTCPeerConnectionIceErrorEvent,
  ];
  RTCPeerConnectionIceEvent: [W.RTCPeerConnectionIceEvent, RTCPeerConnectionIceEvent];
  RTCRtpReceiver: [W.RTCRtpReceiver, RTCRtpReceiver];
  RTCRtpSender: [W.RTCRtpSender, RTCRtpSender];
  RTCRtpTransceiver: [W.RTCRtpTransceiver, RTCRtpTransceiver];
  RTCSctpTransport: [W.RTCSctpTransport, RTCSctpTransport];
  RTCSessionDescription: [W.RTCSessionDescription, RTCSessionDescription];
  RTCStatsReport: [W.RTCStatsReport, RTCStatsReport];
  RTCTrackEvent: [W.RTCTrackEvent, RTCTrackEvent];
}
declare const ours: { [K in keyof Classes]: Classes[K][0] };
declare const dom: { [K in keyof Classes]: Classes[K][1] };

// Every class we export that lib.dom also declares (as a global) is listed.
type Unlisted = Exclude<Extract<keyof typeof W, keyof typeof globalThis>, keyof Classes>;
export const everyDomClassIsListed: [Unlisted] extends [never] ? true : Unlisted = true;

// Spec members of ours that lib.dom's types lack (see the header).
type IceTransportExtras =
  | 'role'
  | 'component'
  | 'getLocalCandidates'
  | 'getRemoteCandidates'
  | 'getLocalParameters'
  | 'getRemoteParameters';
type IceCandidateExtras = 'relayProtocol' | 'url';

export const o_MediaDeviceInfo: MediaDeviceInfo = ours.MediaDeviceInfo;
export const d_MediaDeviceInfo: W.MediaDeviceInfo = dom.MediaDeviceInfo;

// Ours has no `ondevicechange` (nor had wrtc's): the fake devices never
// change. addEventListener('devicechange', ...) works.
// @ts-expect-error
export const o_MediaDevices: MediaDevices = ours.MediaDevices;
export const o_MediaDevicesBut: Omit<MediaDevices, 'ondevicechange'> = ours.MediaDevices;
export const d_MediaDevices: W.MediaDevices = dom.MediaDevices;

export const o_MediaStream: MediaStream = ours.MediaStream;
export const d_MediaStream: W.MediaStream = dom.MediaStream;

export const o_MediaStreamTrack: MediaStreamTrack = ours.MediaStreamTrack;
export const d_MediaStreamTrack: W.MediaStreamTrack = dom.MediaStreamTrack;

export const o_MediaStreamTrackEvent: MediaStreamTrackEvent = ours.MediaStreamTrackEvent;
export const d_MediaStreamTrackEvent: W.MediaStreamTrackEvent = dom.MediaStreamTrackEvent;

export const o_RTCCertificate: RTCCertificate = ours.RTCCertificate;
export const d_RTCCertificate: W.RTCCertificate = dom.RTCCertificate;

export const o_RTCDataChannel: RTCDataChannel = ours.RTCDataChannel;
export const d_RTCDataChannel: W.RTCDataChannel = dom.RTCDataChannel;

export const o_RTCDataChannelEvent: RTCDataChannelEvent = ours.RTCDataChannelEvent;
export const d_RTCDataChannelEvent: W.RTCDataChannelEvent = dom.RTCDataChannelEvent;

export const o_RTCDtlsTransport: RTCDtlsTransport = ours.RTCDtlsTransport;
// Its iceTransport is an RTCIceTransport (below).
// @ts-expect-error
export const d_RTCDtlsTransport: W.RTCDtlsTransport = dom.RTCDtlsTransport;
export const d_RTCDtlsTransportBut: Omit<W.RTCDtlsTransport, 'iceTransport'> = dom.RTCDtlsTransport;

export const o_RTCError: RTCError = ours.RTCError;
export const d_RTCError: W.RTCError = dom.RTCError;

export const o_RTCErrorEvent: RTCErrorEvent = ours.RTCErrorEvent;
export const d_RTCErrorEvent: W.RTCErrorEvent = dom.RTCErrorEvent;

export const o_RTCIceCandidate: RTCIceCandidate = ours.RTCIceCandidate;
// lib.dom lacks relayProtocol and url (webrtc's RTCIceCandidate has both).
// @ts-expect-error
export const d_RTCIceCandidate: W.RTCIceCandidate = dom.RTCIceCandidate;
export const d_RTCIceCandidateBut: Omit<W.RTCIceCandidate, IceCandidateExtras> =
  dom.RTCIceCandidate;

export const o_RTCIceCandidatePair: RTCIceCandidatePair = ours.RTCIceCandidatePair;
// Its local and remote are RTCIceCandidates (above).
// @ts-expect-error
export const d_RTCIceCandidatePair: W.RTCIceCandidatePair = dom.RTCIceCandidatePair;

export const o_RTCIceTransport: RTCIceTransport = ours.RTCIceTransport;
// lib.dom lacks role, component, getLocalCandidates(), getRemoteCandidates(),
// getLocalParameters() and getRemoteParameters() (webrtc's RTCIceTransport),
// and getSelectedCandidatePair() returns an RTCIceCandidatePair (above).
// @ts-expect-error
export const d_RTCIceTransport: W.RTCIceTransport = dom.RTCIceTransport;
export const d_RTCIceTransportBut: Omit<
  W.RTCIceTransport,
  IceTransportExtras | 'getSelectedCandidatePair'
> = dom.RTCIceTransport;

export const o_RTCPeerConnection: RTCPeerConnection = ours.RTCPeerConnection;
// Through its transports (sctp, and each sender's and receiver's transport)
// to an RTCIceTransport (above). And getConfiguration() always reports wrtc's
// nonstandard portRange and sdpSemantics, which lib.dom's RTCConfiguration
// doesn't have.
// @ts-expect-error
export const d_RTCPeerConnection: W.RTCPeerConnection = dom.RTCPeerConnection;
export const d_RTCPeerConnectionBut: Omit<
  W.RTCPeerConnection,
  | 'sctp'
  | 'addTrack'
  | 'addTransceiver'
  | 'getReceivers'
  | 'getSenders'
  | 'getTransceivers'
  | 'getConfiguration'
> = dom.RTCPeerConnection;

export const o_RTCPeerConnectionIceErrorEvent: RTCPeerConnectionIceErrorEvent =
  ours.RTCPeerConnectionIceErrorEvent;
export const d_RTCPeerConnectionIceErrorEvent: W.RTCPeerConnectionIceErrorEvent =
  dom.RTCPeerConnectionIceErrorEvent;

export const o_RTCPeerConnectionIceEvent: RTCPeerConnectionIceEvent =
  ours.RTCPeerConnectionIceEvent;
// lib.dom lacks url (in webrtc, deprecated), and its candidate is an
// RTCIceCandidate (above).
// @ts-expect-error
export const d_RTCPeerConnectionIceEvent: W.RTCPeerConnectionIceEvent =
  dom.RTCPeerConnectionIceEvent;
export const d_RTCPeerConnectionIceEventBut: Omit<
  W.RTCPeerConnectionIceEvent,
  'url' | 'candidate'
> = dom.RTCPeerConnectionIceEvent;

export const o_RTCRtpReceiver: RTCRtpReceiver = ours.RTCRtpReceiver;
// Its transport is an RTCDtlsTransport (above), and its transform is always
// null: encoded transforms are out of scope (SPEC-LAYER-PLAN.md).
// @ts-expect-error
export const d_RTCRtpReceiver: W.RTCRtpReceiver = dom.RTCRtpReceiver;
export const d_RTCRtpReceiverBut: Omit<W.RTCRtpReceiver, 'transport' | 'transform'> =
  dom.RTCRtpReceiver;

export const o_RTCRtpSender: RTCRtpSender = ours.RTCRtpSender;
// Its transport is an RTCDtlsTransport (above), and its dtmf and transform
// are always null: DTMF and encoded transforms are out of scope
// (SPEC-LAYER-PLAN.md).
// @ts-expect-error
export const d_RTCRtpSender: W.RTCRtpSender = dom.RTCRtpSender;
export const d_RTCRtpSenderBut: Omit<W.RTCRtpSender, 'transport' | 'dtmf' | 'transform'> =
  dom.RTCRtpSender;

export const o_RTCRtpTransceiver: RTCRtpTransceiver = ours.RTCRtpTransceiver;
// lib.dom lacks stopped (dropped from webrtc; wrtc has it), and its sender
// and receiver have transports (above).
// @ts-expect-error
export const d_RTCRtpTransceiver: W.RTCRtpTransceiver = dom.RTCRtpTransceiver;
export const d_RTCRtpTransceiverBut: Omit<W.RTCRtpTransceiver, 'stopped' | 'sender' | 'receiver'> =
  dom.RTCRtpTransceiver;

export const o_RTCSctpTransport: RTCSctpTransport = ours.RTCSctpTransport;
// Its transport is an RTCDtlsTransport (above).
// @ts-expect-error
export const d_RTCSctpTransport: W.RTCSctpTransport = dom.RTCSctpTransport;
export const d_RTCSctpTransportBut: Omit<W.RTCSctpTransport, 'transport'> = dom.RTCSctpTransport;

export const o_RTCSessionDescription: RTCSessionDescription = ours.RTCSessionDescription;
export const d_RTCSessionDescription: W.RTCSessionDescription = dom.RTCSessionDescription;

export const o_RTCStatsReport: RTCStatsReport = ours.RTCStatsReport;
export const d_RTCStatsReport: W.RTCStatsReport = dom.RTCStatsReport;

export const o_RTCTrackEvent: RTCTrackEvent = ours.RTCTrackEvent;
// Its receiver and transceiver have transports (above).
// @ts-expect-error
export const d_RTCTrackEvent: W.RTCTrackEvent = dom.RTCTrackEvent;
export const d_RTCTrackEventBut: Omit<W.RTCTrackEvent, 'receiver' | 'transceiver'> =
  dom.RTCTrackEvent;

// ---------------------------------------------------------------------------
// on<event> setters stay strict. Only the getters' type takes part in the
// assignments above, and it takes any event (AnyEventHandler); a setter
// still takes only a handler of its own event, as lib.dom's do.

export function handlerSetters(
  pc: W.RTCPeerConnection,
  stream: W.MediaStream,
  channel: W.RTCDataChannel,
): void {
  // Handlers annotated with lib.dom's event types, and null.
  pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => void e.candidate;
  pc.ontrack = (e: RTCTrackEvent) => void e.track;
  stream.onaddtrack = (e: MediaStreamTrackEvent) => void e.track;
  channel.onmessage = (e: MessageEvent) => void e.data;
  pc.onicecandidate = null;

  // @ts-expect-error: a track event handler for icecandidate.
  pc.onicecandidate = (e: RTCTrackEvent) => void e.track;
  // @ts-expect-error: a message event handler for addtrack.
  stream.onaddtrack = (e: MessageEvent) => void e.data;
  // @ts-expect-error: an icecandidate event handler for message.
  channel.onmessage = (e: RTCPeerConnectionIceEvent) => void e.candidate;
  // @ts-expect-error: not a function.
  pc.onicecandidate = 42;
  // @ts-expect-error: not a function.
  stream.onremovetrack = 'handler';
}

// ---------------------------------------------------------------------------
// Constructors, ours to the DOM's: wrtc code polyfills the globals with them
// (`globalThis.RTCPeerConnection = wrtc.RTCPeerConnection`).

type Globals = Extract<keyof Classes, keyof typeof globalThis>;
declare const ctor: { [K in Globals]: (typeof W)[K] };

export const c_MediaDeviceInfo: typeof MediaDeviceInfo = ctor.MediaDeviceInfo;
// No ondevicechange (above).
// @ts-expect-error
export const c_MediaDevices: typeof MediaDevices = ctor.MediaDevices;
export const c_MediaStream: typeof MediaStream = ctor.MediaStream;
export const c_MediaStreamTrack: typeof MediaStreamTrack = ctor.MediaStreamTrack;
export const c_MediaStreamTrackEvent: typeof MediaStreamTrackEvent = ctor.MediaStreamTrackEvent;
export const c_RTCCertificate: typeof RTCCertificate = ctor.RTCCertificate;
export const c_RTCDataChannel: typeof RTCDataChannel = ctor.RTCDataChannel;
export const c_RTCDataChannelEvent: typeof RTCDataChannelEvent = ctor.RTCDataChannelEvent;
export const c_RTCDtlsTransport: typeof RTCDtlsTransport = ctor.RTCDtlsTransport;
export const c_RTCError: typeof RTCError = ctor.RTCError;
export const c_RTCErrorEvent: typeof RTCErrorEvent = ctor.RTCErrorEvent;
export const c_RTCIceCandidate: typeof RTCIceCandidate = ctor.RTCIceCandidate;
export const c_RTCIceTransport: typeof RTCIceTransport = ctor.RTCIceTransport;
export const c_RTCPeerConnection: typeof RTCPeerConnection = ctor.RTCPeerConnection;
export const c_RTCPeerConnectionIceErrorEvent: typeof RTCPeerConnectionIceErrorEvent =
  ctor.RTCPeerConnectionIceErrorEvent;
// Its init's candidate is our RTCIceCandidate, which lib.dom's isn't
// assignable to (above).
// @ts-expect-error
export const c_RTCPeerConnectionIceEvent: typeof RTCPeerConnectionIceEvent =
  ctor.RTCPeerConnectionIceEvent;
export const c_RTCRtpReceiver: typeof RTCRtpReceiver = ctor.RTCRtpReceiver;
export const c_RTCRtpSender: typeof RTCRtpSender = ctor.RTCRtpSender;
export const c_RTCRtpTransceiver: typeof RTCRtpTransceiver = ctor.RTCRtpTransceiver;
export const c_RTCSctpTransport: typeof RTCSctpTransport = ctor.RTCSctpTransport;
export const c_RTCSessionDescription: typeof RTCSessionDescription = ctor.RTCSessionDescription;
export const c_RTCStatsReport: typeof RTCStatsReport = ctor.RTCStatsReport;
// Its init's receiver and transceiver are ours, which lib.dom's aren't
// assignable to (above).
// @ts-expect-error
export const c_RTCTrackEvent: typeof RTCTrackEvent = ctor.RTCTrackEvent;

// ---------------------------------------------------------------------------
// Dictionaries, enums, callbacks and event maps we export that both
// lib.doms declare (dom-compat.current.ts has the ones only the current one
// does).

interface Types {
  AlgorithmIdentifier: [W.AlgorithmIdentifier, AlgorithmIdentifier];
  BinaryType: [W.BinaryType, BinaryType];
  MediaDeviceKind: [W.MediaDeviceKind, MediaDeviceKind];
  MediaStreamConstraints: [W.MediaStreamConstraints, MediaStreamConstraints];
  MediaStreamEventMap: [W.MediaStreamEventMap, MediaStreamEventMap];
  MediaStreamTrackEventInit: [W.MediaStreamTrackEventInit, MediaStreamTrackEventInit];
  MediaStreamTrackState: [W.MediaStreamTrackState, MediaStreamTrackState];
  RTCAnswerOptions: [W.RTCAnswerOptions, RTCAnswerOptions];
  RTCBundlePolicy: [W.RTCBundlePolicy, RTCBundlePolicy];
  RTCConfiguration: [W.RTCConfiguration, RTCConfiguration];
  RTCDataChannelEventInit: [W.RTCDataChannelEventInit, RTCDataChannelEventInit];
  RTCDataChannelEventMap: [W.RTCDataChannelEventMap, RTCDataChannelEventMap];
  RTCDataChannelInit: [W.RTCDataChannelInit, RTCDataChannelInit];
  RTCDataChannelState: [W.RTCDataChannelState, RTCDataChannelState];
  RTCDegradationPreference: [W.RTCDegradationPreference, RTCDegradationPreference];
  RTCDtlsFingerprint: [W.RTCDtlsFingerprint, RTCDtlsFingerprint];
  RTCDtlsTransportEventMap: [W.RTCDtlsTransportEventMap, RTCDtlsTransportEventMap];
  RTCDtlsTransportState: [W.RTCDtlsTransportState, RTCDtlsTransportState];
  RTCErrorDetailType: [W.RTCErrorDetailType, RTCErrorDetailType];
  RTCErrorEventInit: [W.RTCErrorEventInit, RTCErrorEventInit];
  RTCErrorInit: [W.RTCErrorInit, RTCErrorInit];
  RTCIceCandidateInit: [W.RTCIceCandidateInit, RTCIceCandidateInit];
  RTCIceCandidateType: [W.RTCIceCandidateType, RTCIceCandidateType];
  RTCIceComponent: [W.RTCIceComponent, RTCIceComponent];
  RTCIceConnectionState: [W.RTCIceConnectionState, RTCIceConnectionState];
  RTCIceGathererState: [W.RTCIceGathererState, RTCIceGathererState];
  RTCIceGatheringState: [W.RTCIceGatheringState, RTCIceGatheringState];
  RTCIceProtocol: [W.RTCIceProtocol, RTCIceProtocol];
  RTCIceRole: [W.RTCIceRole, RTCIceRole];
  RTCIceServer: [W.RTCIceServer, RTCIceServer];
  RTCIceTcpCandidateType: [W.RTCIceTcpCandidateType, RTCIceTcpCandidateType];
  RTCIceTransportEventMap: [W.RTCIceTransportEventMap, RTCIceTransportEventMap];
  RTCIceTransportPolicy: [W.RTCIceTransportPolicy, RTCIceTransportPolicy];
  RTCIceTransportState: [W.RTCIceTransportState, RTCIceTransportState];
  RTCLocalSessionDescriptionInit: [
    W.RTCLocalSessionDescriptionInit,
    RTCLocalSessionDescriptionInit,
  ];
  RTCOfferOptions: [W.RTCOfferOptions, RTCOfferOptions];
  RTCPeerConnectionErrorCallback: [
    W.RTCPeerConnectionErrorCallback,
    RTCPeerConnectionErrorCallback,
  ];
  RTCPeerConnectionEventMap: [W.RTCPeerConnectionEventMap, RTCPeerConnectionEventMap];
  RTCPeerConnectionIceErrorEventInit: [
    W.RTCPeerConnectionIceErrorEventInit,
    RTCPeerConnectionIceErrorEventInit,
  ];
  RTCPeerConnectionIceEventInit: [W.RTCPeerConnectionIceEventInit, RTCPeerConnectionIceEventInit];
  RTCPeerConnectionState: [W.RTCPeerConnectionState, RTCPeerConnectionState];
  RTCRtcpMuxPolicy: [W.RTCRtcpMuxPolicy, RTCRtcpMuxPolicy];
  RTCRtpCapabilities: [W.RTCRtpCapabilities, RTCRtpCapabilities];
  RTCRtpCodec: [W.RTCRtpCodec, RTCRtpCodec];
  RTCRtpEncodingParameters: [W.RTCRtpEncodingParameters, RTCRtpEncodingParameters];
  RTCRtpReceiveParameters: [W.RTCRtpReceiveParameters, RTCRtpReceiveParameters];
  RTCRtpSendParameters: [W.RTCRtpSendParameters, RTCRtpSendParameters];
  RTCRtpTransceiverDirection: [W.RTCRtpTransceiverDirection, RTCRtpTransceiverDirection];
  RTCRtpTransceiverInit: [W.RTCRtpTransceiverInit, RTCRtpTransceiverInit];
  RTCSctpTransportEventMap: [W.RTCSctpTransportEventMap, RTCSctpTransportEventMap];
  RTCSctpTransportState: [W.RTCSctpTransportState, RTCSctpTransportState];
  RTCSdpType: [W.RTCSdpType, RTCSdpType];
  RTCSessionDescriptionCallback: [W.RTCSessionDescriptionCallback, RTCSessionDescriptionCallback];
  RTCSessionDescriptionInit: [W.RTCSessionDescriptionInit, RTCSessionDescriptionInit];
  RTCSetParameterOptions: [W.RTCSetParameterOptions, RTCSetParameterOptions];
  RTCSignalingState: [W.RTCSignalingState, RTCSignalingState];
  RTCTrackEventInit: [W.RTCTrackEventInit, RTCTrackEventInit];
}
declare const oursT: { [K in keyof Types]: Types[K][0] };
declare const domT: { [K in keyof Types]: Types[K][1] };

// Ours is WebIDL's (object or DOMString), so a key generation dictionary
// literal with more members than `name` passes; lib.dom's object member is
// `{name: string}`. Only an argument (generateCertificate) takes it.
// @ts-expect-error
export const o_AlgorithmIdentifier: AlgorithmIdentifier = oursT.AlgorithmIdentifier;
export const d_AlgorithmIdentifier: W.AlgorithmIdentifier = domT.AlgorithmIdentifier;
export const o_BinaryType: BinaryType = oursT.BinaryType;
export const d_BinaryType: W.BinaryType = domT.BinaryType;
export const o_MediaDeviceKind: MediaDeviceKind = oursT.MediaDeviceKind;
export const d_MediaDeviceKind: W.MediaDeviceKind = domT.MediaDeviceKind;
export const o_MediaStreamConstraints: MediaStreamConstraints = oursT.MediaStreamConstraints;
export const d_MediaStreamConstraints: W.MediaStreamConstraints = domT.MediaStreamConstraints;
export const o_MediaStreamEventMap: MediaStreamEventMap = oursT.MediaStreamEventMap;
export const d_MediaStreamEventMap: W.MediaStreamEventMap = domT.MediaStreamEventMap;
// Its track is a MediaStreamTrackLike, so that a DOM-typed track can be
// passed; at runtime it has to be one of ours.
// @ts-expect-error
export const o_MediaStreamTrackEventInit: MediaStreamTrackEventInit =
  oursT.MediaStreamTrackEventInit;
export const d_MediaStreamTrackEventInit: W.MediaStreamTrackEventInit =
  domT.MediaStreamTrackEventInit;
export const o_MediaStreamTrackState: MediaStreamTrackState = oursT.MediaStreamTrackState;
export const d_MediaStreamTrackState: W.MediaStreamTrackState = domT.MediaStreamTrackState;
export const o_RTCAnswerOptions: RTCAnswerOptions = oursT.RTCAnswerOptions;
export const d_RTCAnswerOptions: W.RTCAnswerOptions = domT.RTCAnswerOptions;
export const o_RTCBundlePolicy: RTCBundlePolicy = oursT.RTCBundlePolicy;
export const d_RTCBundlePolicy: W.RTCBundlePolicy = domT.RTCBundlePolicy;
export const o_RTCConfiguration: RTCConfiguration = oursT.RTCConfiguration;
export const d_RTCConfiguration: W.RTCConfiguration = domT.RTCConfiguration;
export const o_RTCDataChannelEventInit: RTCDataChannelEventInit = oursT.RTCDataChannelEventInit;
export const d_RTCDataChannelEventInit: W.RTCDataChannelEventInit = domT.RTCDataChannelEventInit;
export const o_RTCDataChannelEventMap: RTCDataChannelEventMap = oursT.RTCDataChannelEventMap;
export const d_RTCDataChannelEventMap: W.RTCDataChannelEventMap = domT.RTCDataChannelEventMap;
export const o_RTCDataChannelInit: RTCDataChannelInit = oursT.RTCDataChannelInit;
export const d_RTCDataChannelInit: W.RTCDataChannelInit = domT.RTCDataChannelInit;
export const o_RTCDataChannelState: RTCDataChannelState = oursT.RTCDataChannelState;
export const d_RTCDataChannelState: W.RTCDataChannelState = domT.RTCDataChannelState;
export const o_RTCDegradationPreference: RTCDegradationPreference = oursT.RTCDegradationPreference;
export const d_RTCDegradationPreference: W.RTCDegradationPreference = domT.RTCDegradationPreference;
export const o_RTCDtlsFingerprint: RTCDtlsFingerprint = oursT.RTCDtlsFingerprint;
export const d_RTCDtlsFingerprint: W.RTCDtlsFingerprint = domT.RTCDtlsFingerprint;
export const o_RTCDtlsTransportEventMap: RTCDtlsTransportEventMap = oursT.RTCDtlsTransportEventMap;
export const d_RTCDtlsTransportEventMap: W.RTCDtlsTransportEventMap = domT.RTCDtlsTransportEventMap;
export const o_RTCDtlsTransportState: RTCDtlsTransportState = oursT.RTCDtlsTransportState;
export const d_RTCDtlsTransportState: W.RTCDtlsTransportState = domT.RTCDtlsTransportState;
export const o_RTCErrorDetailType: RTCErrorDetailType = oursT.RTCErrorDetailType;
export const d_RTCErrorDetailType: W.RTCErrorDetailType = domT.RTCErrorDetailType;
export const o_RTCErrorEventInit: RTCErrorEventInit = oursT.RTCErrorEventInit;
export const d_RTCErrorEventInit: W.RTCErrorEventInit = domT.RTCErrorEventInit;
export const o_RTCErrorInit: RTCErrorInit = oursT.RTCErrorInit;
export const d_RTCErrorInit: W.RTCErrorInit = domT.RTCErrorInit;
export const o_RTCIceCandidateInit: RTCIceCandidateInit = oursT.RTCIceCandidateInit;
export const d_RTCIceCandidateInit: W.RTCIceCandidateInit = domT.RTCIceCandidateInit;
export const o_RTCIceCandidateType: RTCIceCandidateType = oursT.RTCIceCandidateType;
export const d_RTCIceCandidateType: W.RTCIceCandidateType = domT.RTCIceCandidateType;
export const o_RTCIceComponent: RTCIceComponent = oursT.RTCIceComponent;
export const d_RTCIceComponent: W.RTCIceComponent = domT.RTCIceComponent;
export const o_RTCIceConnectionState: RTCIceConnectionState = oursT.RTCIceConnectionState;
export const d_RTCIceConnectionState: W.RTCIceConnectionState = domT.RTCIceConnectionState;
export const o_RTCIceGathererState: RTCIceGathererState = oursT.RTCIceGathererState;
export const d_RTCIceGathererState: W.RTCIceGathererState = domT.RTCIceGathererState;
export const o_RTCIceGatheringState: RTCIceGatheringState = oursT.RTCIceGatheringState;
export const d_RTCIceGatheringState: W.RTCIceGatheringState = domT.RTCIceGatheringState;
export const o_RTCIceProtocol: RTCIceProtocol = oursT.RTCIceProtocol;
export const d_RTCIceProtocol: W.RTCIceProtocol = domT.RTCIceProtocol;
export const o_RTCIceRole: RTCIceRole = oursT.RTCIceRole;
export const d_RTCIceRole: W.RTCIceRole = domT.RTCIceRole;
export const o_RTCIceServer: RTCIceServer = oursT.RTCIceServer;
export const d_RTCIceServer: W.RTCIceServer = domT.RTCIceServer;
export const o_RTCIceTcpCandidateType: RTCIceTcpCandidateType = oursT.RTCIceTcpCandidateType;
export const d_RTCIceTcpCandidateType: W.RTCIceTcpCandidateType = domT.RTCIceTcpCandidateType;
export const o_RTCIceTransportEventMap: RTCIceTransportEventMap = oursT.RTCIceTransportEventMap;
export const d_RTCIceTransportEventMap: W.RTCIceTransportEventMap = domT.RTCIceTransportEventMap;
export const o_RTCIceTransportPolicy: RTCIceTransportPolicy = oursT.RTCIceTransportPolicy;
export const d_RTCIceTransportPolicy: W.RTCIceTransportPolicy = domT.RTCIceTransportPolicy;
export const o_RTCIceTransportState: RTCIceTransportState = oursT.RTCIceTransportState;
export const d_RTCIceTransportState: W.RTCIceTransportState = domT.RTCIceTransportState;
export const o_RTCLocalSessionDescriptionInit: RTCLocalSessionDescriptionInit =
  oursT.RTCLocalSessionDescriptionInit;
export const d_RTCLocalSessionDescriptionInit: W.RTCLocalSessionDescriptionInit =
  domT.RTCLocalSessionDescriptionInit;
export const o_RTCOfferOptions: RTCOfferOptions = oursT.RTCOfferOptions;
export const d_RTCOfferOptions: W.RTCOfferOptions = domT.RTCOfferOptions;
export const o_RTCPeerConnectionErrorCallback: RTCPeerConnectionErrorCallback =
  oursT.RTCPeerConnectionErrorCallback;
export const d_RTCPeerConnectionErrorCallback: W.RTCPeerConnectionErrorCallback =
  domT.RTCPeerConnectionErrorCallback;
export const o_RTCPeerConnectionEventMap: RTCPeerConnectionEventMap =
  oursT.RTCPeerConnectionEventMap;
// Ours has the legacy addstream and removestream, which Chrome still fires,
// and its icecandidate and track events are as above.
// @ts-expect-error
export const d_RTCPeerConnectionEventMap: W.RTCPeerConnectionEventMap =
  domT.RTCPeerConnectionEventMap;
export const d_RTCPeerConnectionEventMapBut: Omit<
  W.RTCPeerConnectionEventMap,
  'addstream' | 'removestream' | 'icecandidate' | 'track'
> = domT.RTCPeerConnectionEventMap;
export const o_RTCPeerConnectionIceErrorEventInit: RTCPeerConnectionIceErrorEventInit =
  oursT.RTCPeerConnectionIceErrorEventInit;
export const d_RTCPeerConnectionIceErrorEventInit: W.RTCPeerConnectionIceErrorEventInit =
  domT.RTCPeerConnectionIceErrorEventInit;
export const o_RTCPeerConnectionIceEventInit: RTCPeerConnectionIceEventInit =
  oursT.RTCPeerConnectionIceEventInit;
// Its candidate is an RTCIceCandidate (above).
// @ts-expect-error
export const d_RTCPeerConnectionIceEventInit: W.RTCPeerConnectionIceEventInit =
  domT.RTCPeerConnectionIceEventInit;
export const o_RTCPeerConnectionState: RTCPeerConnectionState = oursT.RTCPeerConnectionState;
export const d_RTCPeerConnectionState: W.RTCPeerConnectionState = domT.RTCPeerConnectionState;
export const o_RTCRtcpMuxPolicy: RTCRtcpMuxPolicy = oursT.RTCRtcpMuxPolicy;
export const d_RTCRtcpMuxPolicy: W.RTCRtcpMuxPolicy = domT.RTCRtcpMuxPolicy;
export const o_RTCRtpCapabilities: RTCRtpCapabilities = oursT.RTCRtpCapabilities;
// Its headerExtensions have webrtc-extensions' required `direction`, which
// lib.dom lacks.
// @ts-expect-error
export const d_RTCRtpCapabilities: W.RTCRtpCapabilities = domT.RTCRtpCapabilities;
export const d_RTCRtpCapabilitiesBut: Omit<W.RTCRtpCapabilities, 'headerExtensions'> =
  domT.RTCRtpCapabilities;
export const o_RTCRtpCodec: RTCRtpCodec = oursT.RTCRtpCodec;
export const d_RTCRtpCodec: W.RTCRtpCodec = domT.RTCRtpCodec;
export const o_RTCRtpEncodingParameters: RTCRtpEncodingParameters = oursT.RTCRtpEncodingParameters;
export const d_RTCRtpEncodingParameters: W.RTCRtpEncodingParameters = domT.RTCRtpEncodingParameters;
export const o_RTCRtpReceiveParameters: RTCRtpReceiveParameters = oursT.RTCRtpReceiveParameters;
export const d_RTCRtpReceiveParameters: W.RTCRtpReceiveParameters = domT.RTCRtpReceiveParameters;
export const o_RTCRtpSendParameters: RTCRtpSendParameters = oursT.RTCRtpSendParameters;
export const d_RTCRtpSendParameters: W.RTCRtpSendParameters = domT.RTCRtpSendParameters;
export const o_RTCRtpTransceiverDirection: RTCRtpTransceiverDirection =
  oursT.RTCRtpTransceiverDirection;
export const d_RTCRtpTransceiverDirection: W.RTCRtpTransceiverDirection =
  domT.RTCRtpTransceiverDirection;
// Its streams are MediaStreamLikes, so that DOM-typed streams can be passed;
// at runtime only their ids are read.
// @ts-expect-error
export const o_RTCRtpTransceiverInit: RTCRtpTransceiverInit = oursT.RTCRtpTransceiverInit;
export const d_RTCRtpTransceiverInit: W.RTCRtpTransceiverInit = domT.RTCRtpTransceiverInit;
export const o_RTCSctpTransportEventMap: RTCSctpTransportEventMap = oursT.RTCSctpTransportEventMap;
export const d_RTCSctpTransportEventMap: W.RTCSctpTransportEventMap = domT.RTCSctpTransportEventMap;
export const o_RTCSctpTransportState: RTCSctpTransportState = oursT.RTCSctpTransportState;
export const d_RTCSctpTransportState: W.RTCSctpTransportState = domT.RTCSctpTransportState;
export const o_RTCSdpType: RTCSdpType = oursT.RTCSdpType;
export const d_RTCSdpType: W.RTCSdpType = domT.RTCSdpType;
export const o_RTCSessionDescriptionCallback: RTCSessionDescriptionCallback =
  oursT.RTCSessionDescriptionCallback;
export const d_RTCSessionDescriptionCallback: W.RTCSessionDescriptionCallback =
  domT.RTCSessionDescriptionCallback;
export const o_RTCSessionDescriptionInit: RTCSessionDescriptionInit =
  oursT.RTCSessionDescriptionInit;
export const d_RTCSessionDescriptionInit: W.RTCSessionDescriptionInit =
  domT.RTCSessionDescriptionInit;
export const o_RTCSetParameterOptions: RTCSetParameterOptions = oursT.RTCSetParameterOptions;
export const d_RTCSetParameterOptions: W.RTCSetParameterOptions = domT.RTCSetParameterOptions;
export const o_RTCSignalingState: RTCSignalingState = oursT.RTCSignalingState;
export const d_RTCSignalingState: W.RTCSignalingState = domT.RTCSignalingState;
export const o_RTCTrackEventInit: RTCTrackEventInit = oursT.RTCTrackEventInit;
// Its receiver and transceiver have transports (above).
// @ts-expect-error
export const d_RTCTrackEventInit: W.RTCTrackEventInit = domT.RTCTrackEventInit;
export const d_RTCTrackEventInitBut: Omit<W.RTCTrackEventInit, 'receiver' | 'transceiver'> =
  domT.RTCTrackEventInit;
