// Type-check fixture (`pnpm typecheck`; never executed): code written
// against @roamhq/wrtc's nonstandard API and peer connection must compile
// against our types.
import {
  MediaStream,
  type MediaStreamTrack,
  nonstandard,
  type RTCBundlePolicy,
  type RTCDataChannel,
  type RTCDataChannelEvent,
  type RTCDataChannelInit,
  type RTCDataChannelState,
  RTCIceCandidate,
  type RTCIceCandidateInit,
  type RTCIceGatheringState,
  type RTCIceServer,
  type RTCOfferOptions,
  RTCPeerConnection,
  type RTCPeerConnectionState,
  type RTCRtpSender,
  type RTCRtpTransceiver,
  type RTCRtpTransceiverDirection,
  type RTCSctpTransport,
  type RTCSdpType,
  RTCSessionDescription,
  type RTCSessionDescriptionInit,
  type RTCSignalingState,
  type RTCTrackEvent,
} from '../../lib/index.ts';

const { RTCAudioSource, RTCAudioSink, RTCVideoSource, RTCVideoSink, i420ToRgba, rgbaToI420 } =
  nonstandard;

export function audio(): void {
  const source = new RTCAudioSource();
  const track: MediaStreamTrack = source.createTrack();
  const sink = new RTCAudioSink(track);
  const sampleRate = 48000;
  const samples = new Int16Array(sampleRate / 100);
  source.onData({ samples, sampleRate });
  source.onData({ samples, sampleRate, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 });
  sink.ondata = (data) => {
    const s: Int16Array = data.samples;
    const n: number = data.numberOfFrames + data.sampleRate + data.channelCount;
    void s;
    void n;
  };
  sink.addEventListener('data', () => {});
  track.stop();
  sink.stop();
  const stopped: boolean = sink.stopped;
  void stopped;
}

export function video(): void {
  const source = new RTCVideoSource({ isScreencast: false });
  const plain = new RTCVideoSource();
  const isScreencast: boolean = plain.isScreencast;
  const denoise: boolean | undefined = plain.needsDenoising;
  const track = source.createTrack();
  const sink = new RTCVideoSink(track);
  const width = 320;
  const height = 240;
  const data = new Uint8ClampedArray(width * height * 1.5);
  source.onFrame({ width, height, data });
  sink.onframe = ({ frame }) => {
    const bytes: Uint8Array = frame.data;
    const w: number = frame.width + frame.height + frame.rotation;
    void bytes;
    void w;
  };
  const rgba = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  i420ToRgba({ width, height, data }, rgba);
  rgbaToI420(rgba, { width, height, data });
  sink.stop();
  void isScreencast;
  void denoise;
}

declare function send(message: string): void;

/** The usual wrtc call setup: config, handlers, tracks from the sources. */
export async function call(remoteOffer: string): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    sdpSemantics: 'unified-plan',
    portRange: { min: 10000, max: 20000 },
  });
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send(JSON.stringify(candidate));
  };
  pc.oniceconnectionstatechange = () => send(pc.iceConnectionState);
  pc.onconnectionstatechange = () => send(pc.connectionState);
  pc.onnegotiationneeded = async () => {
    await pc.setLocalDescription(await pc.createOffer());
    send(JSON.stringify(pc.localDescription));
  };
  pc.ontrack = ({ track, streams, receiver, transceiver }) => {
    const id: string | undefined = streams[0]?.id;
    void id;
    void receiver.getStats();
    void transceiver.mid;
    if (track.kind === 'audio') {
      const sink = new RTCAudioSink(track);
      sink.ondata = ({ samples, sampleRate }) => void [samples, sampleRate];
    } else {
      const sink = new RTCVideoSink(track);
      sink.onframe = ({ frame }) => void frame.data;
    }
  };
  pc.addEventListener('track', (e) => {
    const event: RTCTrackEvent = e;
    void event.streams.map((s) => s.getTracks());
  });
  pc.addEventListener('icecandidate', (e) => void e.candidate?.toJSON());

  const audioSource = new RTCAudioSource();
  const videoSource = new RTCVideoSource();
  const stream = new MediaStream();
  const audioSender: RTCRtpSender = pc.addTrack(audioSource.createTrack(), stream);
  pc.addTrack(videoSource.createTrack(), stream);
  const transceiver: RTCRtpTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
  transceiver.direction = 'sendrecv';
  const current: string | null = transceiver.currentDirection;
  void current;

  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: remoteOffer }));
  await pc.setRemoteDescription({ type: 'offer', sdp: remoteOffer });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await pc.setLocalDescription();
  await pc.addIceCandidate(new RTCIceCandidate({ candidate: '', sdpMid: '0' }));
  await pc.addIceCandidate(JSON.parse('{}'));
  await pc.addIceCandidate();

  await audioSender.replaceTrack(audioSource.createTrack());
  await audioSender.replaceTrack(null);
  const params = audioSender.getParameters();
  const [encoding] = params.encodings;
  if (encoding) encoding.maxBitrate = 64_000;
  await audioSender.setParameters(params);
  pc.removeTrack(audioSender);

  const stats = await pc.getStats();
  stats.forEach((report) => {
    if (report.type === 'inbound-rtp') send(String(report.packetsReceived));
  });
  for (const [id, report] of stats) void [id, report.type];
  const remote: MediaStreamTrack[] = pc.getReceivers().map((r) => r.track);
  void remote;
  void pc.getSenders().length;
  void pc.getTransceivers().length;
  pc.restartIce();
  const { iceServers, portRange } = pc.getConfiguration();
  pc.setConfiguration({ iceServers, portRange });
  pc.close();
  return pc;
}

/** Signaling relayed by the app, annotated with the exported init types and enums. */
export async function relay(
  pc: RTCPeerConnection,
  message: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit },
): Promise<void> {
  if (message.description) {
    const type: RTCSdpType = message.description.type;
    void type;
    await pc.setRemoteDescription(message.description);
  }
  if (message.candidate) await pc.addIceCandidate(message.candidate);
  const directions: RTCRtpTransceiverDirection[] = pc
    .getTransceivers()
    .map((transceiver) => transceiver.direction);
  const state: RTCSignalingState = pc.signalingState;
  const gathering: RTCIceGatheringState = pc.iceGatheringState;
  const connection: RTCPeerConnectionState = pc.connectionState;
  const options: RTCOfferOptions = { iceRestart: true };
  const policy: RTCBundlePolicy = pc.getConfiguration().bundlePolicy;
  const server: RTCIceServer = { urls: 'stun:stun.example.org' };
  void [directions, state, gathering, connection, options, policy, server];
}

/** Data channels as mediasoup-client's handlers and plain apps use them. */
export function dataChannels(pc: RTCPeerConnection, streamId: number): RTCDataChannel {
  const init: RTCDataChannelInit = {
    negotiated: true,
    id: streamId,
    ordered: false,
    maxPacketLifeTime: undefined,
    maxRetransmits: 3,
    protocol: 'chat',
  };
  const dc = pc.createDataChannel('mediasoup', init);
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 65536;
  dc.onopen = () => dc.send('hello');
  dc.onmessage = ({ data }) => void (typeof data === 'string' ? data : new Uint8Array(data));
  dc.onerror = ({ error }) => void error.errorDetail;
  dc.addEventListener('bufferedamountlow', () => dc.send(new Uint8Array(8)));
  dc.addEventListener('close', () => void dc.readyState);
  dc.send(new Blob(['x']));
  dc.send(new ArrayBuffer(1));
  const state: RTCDataChannelState = dc.readyState;
  const id: number | null = dc.id;
  pc.ondatachannel = ({ channel }) => {
    channel.onmessage = (event) => void event.data;
  };
  pc.addEventListener('datachannel', (e) => {
    const event: RTCDataChannelEvent = e;
    void event.channel.label;
  });
  const sctp: RTCSctpTransport | null = pc.sctp;
  const max: number | undefined = sctp?.maxMessageSize;
  void sctp?.transport.iceTransport.state;
  void sctp?.transport.getRemoteCertificates();
  void [state, id, max];
  return dc;
}

// `import wrtc from "@roamhq/wrtc"` style, as @whereby.com/assistant-sdk
// writes it: the default import is used as a value and as a type namespace,
// including subclassing.
import wrtc, { type RTCStatsReport } from '../../lib/index.ts';

export class AssistantStyleVideoSink extends wrtc.nonstandard.RTCVideoSink {
  private readonly inner: wrtc.nonstandard.RTCVideoSink;
  constructor(track: wrtc.MediaStreamTrack) {
    super(track);
    this.inner = new wrtc.nonstandard.RTCVideoSink(track);
  }
  stop(): void {
    this.inner.stop();
    super.stop();
  }
}

export class AssistantStylePeerConnection extends wrtc.RTCPeerConnection {
  private readonly wrappedGetStats = wrtc.RTCPeerConnection.prototype.getStats.bind(this);
  async getStats(arg?: MediaStreamTrack | null): Promise<RTCStatsReport> {
    return this.wrappedGetStats(arg instanceof Object ? arg : undefined);
  }
}

export const emptyStream: wrtc.MediaStream = new wrtc.MediaStream([]);

// getUserMedia and mediaDevices as wrtc code uses them, typed with ours.
export async function userMedia(): Promise<string[]> {
  const constraints: wrtc.MediaStreamConstraints = { audio: true, video: { width: 640 } };
  const stream: wrtc.MediaStream = await wrtc.getUserMedia(constraints);
  const fromDevices = await wrtc.mediaDevices.getUserMedia({ video: true });
  const { getUserMedia, enumerateDevices } = wrtc.mediaDevices;
  const detached: MediaStream = await getUserMedia({ audio: {} });
  const devices: wrtc.MediaDeviceInfo[] = await enumerateDevices();
  const kinds: wrtc.MediaDeviceKind[] = devices.map((device) => device.kind);
  const sink = new wrtc.nonstandard.RTCVideoSink(
    fromDevices.getVideoTracks()[0] as MediaStreamTrack,
  );
  sink.stop();
  for (const track of [
    ...stream.getTracks(),
    ...fromDevices.getTracks(),
    ...detached.getTracks(),
  ]) {
    track.stop();
  }
  return [...kinds, ...devices.map((device) => JSON.stringify(device.toJSON()))];
}
