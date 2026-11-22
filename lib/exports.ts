// Every named export of the package (lib/index.ts re-exports this module and
// also exposes it as the default export). The export shape matches
// @roamhq/wrtc 0.10.0 (lib/index.js); lib/index.test.ts checks it against
// wrtc itself.
// The type-only exports are the init dictionaries and enums code annotates
// with (wrtc's types re-export the DOM's).
import * as nonstandard from './nonstandard/index.ts';

export {
  MediaStream,
  type MediaStreamEventMap,
  type MediaStreamInit,
  MediaStreamTrackEvent,
  type MediaStreamTrackEventInit,
} from './MediaStream.ts';
export {
  MediaStreamTrack,
  type MediaStreamTrackLike,
  type MediaStreamTrackState,
} from './MediaStreamTrack.ts';
export {
  getUserMedia,
  MediaDeviceInfo,
  type MediaDeviceKind,
  MediaDevices,
  type MediaStreamConstraints,
  mediaDevices,
} from './mediaDevices.ts';
export {
  type AlgorithmIdentifier,
  RTCCertificate,
  type RTCCertificateLike,
  type RTCDtlsFingerprint,
} from './RTCCertificate.ts';
export {
  type BinaryType,
  RTCDataChannel,
  type RTCDataChannelEventMap,
  type RTCDataChannelInit,
  type RTCDataChannelState,
} from './RTCDataChannel.ts';
export { RTCDataChannelEvent, type RTCDataChannelEventInit } from './RTCDataChannelEvent.ts';
export {
  RTCDtlsTransport,
  type RTCDtlsTransportEventMap,
  type RTCDtlsTransportState,
} from './RTCDtlsTransport.ts';
export { RTCError, type RTCErrorDetailType, type RTCErrorInit } from './RTCError.ts';
export { RTCErrorEvent, type RTCErrorEventInit } from './RTCErrorEvent.ts';
export {
  RTCIceCandidate,
  type RTCIceCandidateInit,
  type RTCIceCandidateType,
  type RTCIceComponent,
  type RTCIceProtocol,
  type RTCIceServerTransportProtocol,
  type RTCIceTcpCandidateType,
  type RTCLocalIceCandidateInit,
} from './RTCIceCandidate.ts';
export { RTCIceCandidatePair } from './RTCIceCandidatePair.ts';
export {
  type RTCIceGathererState,
  type RTCIceParameters,
  type RTCIceRole,
  RTCIceTransport,
  type RTCIceTransportEventMap,
  type RTCIceTransportState,
} from './RTCIceTransport.ts';
export type {
  RTCAnswerOptions,
  RTCBundlePolicy,
  RTCConfiguration,
  RTCConfigurationResult,
  RTCIceConnectionState,
  RTCIceGatheringState,
  RTCIceServer,
  RTCIceTransportPolicy,
  RTCLocalSessionDescriptionInit,
  RTCOfferOptions,
  RTCPeerConnectionErrorCallback,
  RTCPeerConnectionEventMap,
  RTCPeerConnectionState,
  RTCPortRange,
  RTCRtcpMuxPolicy,
  RTCRtpEncodingParameters,
  RTCRtpTransceiverInit,
  RTCSdpSemantics,
  RTCSessionDescriptionCallback,
  RTCSignalingState,
} from './RTCPeerConnection.ts';
export { RTCPeerConnection } from './RTCPeerConnection.ts';
export {
  RTCPeerConnectionIceErrorEvent,
  type RTCPeerConnectionIceErrorEventInit,
} from './RTCPeerConnectionIceErrorEvent.ts';
export {
  RTCPeerConnectionIceEvent,
  type RTCPeerConnectionIceEventInit,
} from './RTCPeerConnectionIceEvent.ts';
export {
  type RTCRtpCapabilities,
  type RTCRtpReceiveParameters,
  RTCRtpReceiver,
} from './RTCRtpReceiver.ts';
export type {
  MediaStreamLike,
  RTCDegradationPreference,
  RTCRtpSenderLike,
  RTCRtpSendParameters,
  RTCSetParameterOptions,
} from './RTCRtpSender.ts';
export { RTCRtpSender } from './RTCRtpSender.ts';
export {
  type RTCRtpCodec,
  RTCRtpTransceiver,
  type RTCRtpTransceiverDirection,
} from './RTCRtpTransceiver.ts';
export {
  RTCSctpTransport,
  type RTCSctpTransportEventMap,
  type RTCSctpTransportState,
} from './RTCSctpTransport.ts';
export {
  type RTCSdpType,
  RTCSessionDescription,
  type RTCSessionDescriptionInit,
} from './RTCSessionDescription.ts';
export { RTCStatsReport } from './RTCStatsReport.ts';
export { RTCTrackEvent, type RTCTrackEventInit } from './RTCTrackEvent.ts';
export { nonstandard };
