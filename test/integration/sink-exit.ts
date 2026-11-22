// Child process of remote-mute.test.ts: receives audio and video into sinks
// it never stops, closes both connections, and then must exit on its own (a
// sink releases the process once its track ends). Also sinks a local track
// and ends it with track.stop(), as assistant-sdk's AudioMixer does with its
// combined track. Prints every sink's `stopped` once the tracks have ended.
import { nonstandard, RTCPeerConnection, type RTCSessionDescriptionInit } from '../../lib/index.ts';

const a = new RTCPeerConnection();
const b = new RTCPeerConnection();
a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate);
b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate);

const audioSource = new nonstandard.RTCAudioSource();
const videoSource = new nonstandard.RTCVideoSource();
a.addTrack(audioSource.createTrack());
a.addTrack(videoSource.createTrack());
const samples = new Int16Array(480).fill(1000);
const frame = { width: 32, height: 32, data: new Uint8Array(32 * 32 * 1.5).fill(128) };
const push = setInterval(() => {
  audioSource.onData({ samples, sampleRate: 48000 });
  videoSource.onFrame(frame);
}, 10);

const sinks: (nonstandard.RTCAudioSink | nonstandard.RTCVideoSink)[] = [];
const ended: Promise<unknown>[] = [];
const media: Promise<unknown>[] = [];
b.ontrack = ({ track }) => {
  ended.push(new Promise((resolve) => track.addEventListener('ended', resolve)));
  if (track.kind === 'audio') {
    const sink = new nonstandard.RTCAudioSink(track);
    sinks.push(sink);
    media.push(new Promise((resolve) => sink.addEventListener('data', resolve, { once: true })));
  } else {
    const sink = new nonstandard.RTCVideoSink(track);
    sinks.push(sink);
    media.push(new Promise((resolve) => sink.addEventListener('frame', resolve, { once: true })));
  }
};

await a.setLocalDescription(await a.createOffer());
await b.setRemoteDescription(a.localDescription as RTCSessionDescriptionInit);
await b.setLocalDescription(await b.createAnswer());
await a.setRemoteDescription(b.localDescription as RTCSessionDescriptionInit);
await Promise.all(media);

const mixed = new nonstandard.RTCAudioSource();
const mixedTrack = mixed.createTrack();
const mixedSink = new nonstandard.RTCAudioSink(mixedTrack);
sinks.push(mixedSink);
const mixedData = new Promise((resolve) =>
  mixedSink.addEventListener('data', resolve, { once: true }),
);
mixed.onData({ samples, sampleRate: 48000 });
await mixedData;
mixedTrack.stop();

clearInterval(push);
a.close();
b.close();
await Promise.all(ended);
await new Promise((resolve) => setImmediate(resolve));
console.log(sinks.map((sink) => sink.stopped).join(' '));
