// Shared by the data channel unit tests: negotiating an SCTP transport on a
// FakePeerConnection. Not part of the published build.
import type { RTCPeerConnection } from '../../RTCPeerConnection.ts';
import type { NativeSessionDescription } from '../native-types.ts';
import type { FakePeerConnection } from './fake-native.ts';

/** A description with one data channel m-section (and `a=max-message-size`, unless null). */
export function dataDescription(
  type: 'offer' | 'answer',
  maxMessageSize: number | null = 262144,
): NativeSessionDescription {
  const lines = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=mid:0',
    'a=ice-ufrag:uf',
    'a=sctp-port:5000',
    ...(maxMessageSize === null ? [] : [`a=max-message-size:${maxMessageSize}`]),
    '',
  ];
  return { type, sdp: lines.join('\r\n') };
}

/**
 * Applies a local offer and a remote answer with a data m-section, so `pc`
 * gets its SCTP transport (from the offer on). As in libwebrtc, the first
 * sctp:state and dtls:state precede the SLD completion.
 */
export async function negotiateData(
  pc: RTCPeerConnection,
  fake: FakePeerConnection,
  remoteMaxMessageSize: number | null = 262144,
): Promise<void> {
  const offer = dataDescription('offer');
  const answer = dataDescription('answer', remoteMaxMessageSize);
  const sld = pc.setLocalDescription(offer);
  // libwebrtc creates the SCTP transport (key 1, on DTLS transport 1) for
  // the local offer.
  fake.sctp = { key: 1, transport: 1 };
  fake.emit({
    kind: 'sctp:state',
    transport: 1,
    state: 'connecting',
    maxMessageSize: null,
    maxChannels: null,
  });
  fake.emit({ kind: 'dtls:state', transport: 1, state: 'new', remoteCertificates: [] });
  fake.completeSetLocalDescription({
    signalingState: 'have-local-offer',
    snapshot: { localDescription: offer, pendingLocalDescription: offer },
  });
  await sld;
  const srd = pc.setRemoteDescription(answer);
  // It starts once the operations chain advances.
  await fake.flush();
  fake.completeSetRemoteDescription({
    signalingState: 'stable',
    snapshot: {
      localDescription: offer,
      currentLocalDescription: offer,
      remoteDescription: answer,
      currentRemoteDescription: answer,
    },
  });
  await srd;
}
