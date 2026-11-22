// Child process of getusermedia.test.ts: sends getUserMedia's tracks over a
// peer connection pair into remote sinks until frames arrive, then closes
// the connections and stops the sinks but leaves the gUM tracks (and their
// generator) running. It must then exit on its own. Prints what it received.
import { getUserMedia, nonstandard, RTCPeerConnection } from '../../lib/index.ts';

const a = new RTCPeerConnection();
const b = new RTCPeerConnection();
a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate);
b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate);
const stream = await getUserMedia({ audio: true, video: true });
for (const track of stream.getTracks()) a.addTrack(track, stream);
const frame = new Promise<string>((resolve) => {
  b.ontrack = ({ track }) => {
    if (track.kind !== 'video') return;
    const sink = new nonstandard.RTCVideoSink(track);
    sink.onframe = ({ frame: { width, height } }) => {
      sink.stop();
      resolve(`${width}x${height}`);
    };
  };
});
await a.setLocalDescription(await a.createOffer());
await b.setRemoteDescription(a.localDescription ?? { type: 'offer' });
await b.setLocalDescription(await b.createAnswer());
await a.setRemoteDescription(b.localDescription ?? { type: 'answer' });
console.log(`${await frame} ${stream.getTracks().map((t) => t.readyState)}`);
a.close();
b.close();
