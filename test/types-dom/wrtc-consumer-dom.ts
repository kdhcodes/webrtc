// Type-check fixture with the DOM lib (tsconfig.dom.json; never executed).
// wrtc's types re-export the global DOM types, so consumer code commonly
// annotates with the global MediaStreamTrack / RTCTrackEvent. Those
// annotations must keep compiling against our types.
import * as wrtc from '../../lib/index.ts';
import { nonstandard } from '../../lib/index.ts';

export function sinkFromTrackEvent(e: RTCTrackEvent): void {
  const sink = new nonstandard.RTCVideoSink(e.track);
  const audio = new nonstandard.RTCAudioSink(e.track);
  sink.stop();
  audio.stop();
}

export function makeTrack(): MediaStreamTrack {
  const source = new nonstandard.RTCAudioSource();
  return source.createTrack();
}

export function makeVideoTrack(): MediaStreamTrack {
  return new nonstandard.RTCVideoSource().createTrack();
}

export function denoising(): boolean | undefined {
  return new nonstandard.RTCVideoSource().needsDenoising;
}

// Our objects stored in variables, fields and returns annotated with the
// DOM's types, which is what wrtc's re-exported types make them.
export function makePeerConnection(config: RTCConfiguration): RTCPeerConnection {
  const pc: RTCPeerConnection = new wrtc.RTCPeerConnection(config);
  return pc;
}

export async function domTypedCall(
  remote: RTCSessionDescriptionInit,
  candidate: RTCIceCandidateInit,
  domTrack: MediaStreamTrack,
  domStream: MediaStream,
): Promise<RTCStatsReport> {
  const pc = new wrtc.RTCPeerConnection();
  pc.ontrack = (e: RTCTrackEvent) => {
    const sink = new nonstandard.RTCVideoSink(e.track);
    sink.stop();
  };
  pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => void e.candidate?.toJSON();
  pc.addEventListener('icecandidate', (e: RTCPeerConnectionIceEvent) => void e.candidate);
  pc.addEventListener('connectionstatechange', (e: Event) => void e.type);

  const sender: RTCRtpSender = pc.addTrack(domTrack, domStream);
  const transceiver: RTCRtpTransceiver = pc.addTransceiver('audio', {
    direction: 'recvonly',
    streams: [domStream],
  });
  const receivers: RTCRtpReceiver[] = pc.getReceivers();
  const stream: MediaStream = new wrtc.MediaStream();
  const ice: RTCIceCandidate = new wrtc.RTCIceCandidate(candidate);
  const description: RTCSessionDescription = new wrtc.RTCSessionDescription(remote);
  await pc.setRemoteDescription(remote);
  await pc.setRemoteDescription(description);
  const answer: RTCSessionDescriptionInit = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  const local: RTCSessionDescription | null = pc.localDescription;
  await pc.addIceCandidate(candidate);
  await pc.addIceCandidate(ice);
  await sender.replaceTrack(domTrack);
  const params: RTCRtpSendParameters = sender.getParameters();
  await sender.setParameters(params);
  pc.removeTrack(sender);
  const config: RTCConfiguration = pc.getConfiguration();
  const state: RTCPeerConnectionState = pc.connectionState;
  void [transceiver, receivers, stream, local, config, state];
  const stats: RTCStatsReport = await pc.getStats();
  pc.close();
  return stats;
}

// Data channels annotated with the DOM's types, as code written for
// browsers (and mediasoup-client's handlers) has them.
export function domTypedDataChannel(pc: RTCPeerConnection): RTCDataChannel {
  const ours = new wrtc.RTCPeerConnection();
  const dc: RTCDataChannel = ours.createDataChannel('chat', { negotiated: true, id: 1 });
  dc.onmessage = (e: MessageEvent) => void e.data;
  dc.onerror = (e: RTCErrorEvent) => void e.error.errorDetail;
  dc.addEventListener('message', (e: MessageEvent) => void e.data);
  dc.binaryType = 'blob';
  ours.ondatachannel = (e: RTCDataChannelEvent) => void e.channel.label;
  const sctp: RTCSctpTransport | null = ours.sctp;
  const dtls: RTCDtlsTransport | undefined = sctp?.transport;
  const ice: RTCIceTransport | undefined = dtls?.iceTransport;
  void [ice, pc];
  return dc;
}

// getUserMedia and mediaDevices with the DOM's types, including wiring them
// into a DOM-typed `navigator.mediaDevices`, as assistant-sdk's polyfills do.
export async function domTypedUserMedia(): Promise<MediaTrackSettings> {
  const constraints: MediaStreamConstraints = {
    audio: { echoCancellation: false },
    video: { width: { ideal: 1280 }, frameRate: 30, facingMode: 'user' },
  };
  const stream: MediaStream = await wrtc.getUserMedia(constraints);
  const devices: MediaDeviceInfo[] = await wrtc.mediaDevices.enumerateDevices();
  const kind: MediaDeviceKind | undefined = devices[0]?.kind;
  const navigatorMediaDevices: Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'> = {
    getUserMedia: wrtc.getUserMedia,
    enumerateDevices: wrtc.mediaDevices.enumerateDevices,
  };
  const again: MediaStream = await navigatorMediaDevices.getUserMedia({ audio: true });
  const track: MediaStreamTrack | undefined = stream.getVideoTracks()[0];
  for (const t of [...stream.getTracks(), ...again.getTracks()]) t.stop();
  void kind;
  return track?.getSettings() ?? {};
}

export async function domTypedDisplayMedia(): Promise<MediaTrackSupportedConstraints> {
  const devices: Pick<MediaDevices, 'getDisplayMedia' | 'getSupportedConstraints'> = {
    getDisplayMedia: wrtc.mediaDevices.getDisplayMedia,
    getSupportedConstraints: wrtc.mediaDevices.getSupportedConstraints,
  };
  const stream: MediaStream = await devices.getDisplayMedia({ video: true });
  for (const t of stream.getTracks()) t.stop();
  return devices.getSupportedConstraints();
}
