// Steady-state renegotiation cost by codec set, for one implementation
// (never load both addons in one process):
//
//   node bench/codec-probe.mjs ours|wrtc [families] [rounds]
//
// 8 video tracks; `rounds` offer/answer rounds back to back with nothing
// changed. `families` (ours only) limits every transceiver's codec
// preferences, e.g. `vp8,vp9,av1` leaves out H264 (rtx, red and ulpfec
// stay); `all` (the default) leaves them alone. GAP_MS=100 idles between
// rounds, as renegotiation-probe.mjs does. Prints one JSON line: median wall,
// process CPU and JS-thread CPU per round, and each step's median wall time.
// Used for the H264 cost in bench/RESULTS.md ("After the performance pass").
import { createRequire } from 'node:module';

const [impl = 'ours', families = 'all', roundsArg = '30'] = process.argv.slice(2);
const rounds = Number(roundsArg);
const w =
  impl === 'wrtc'
    ? createRequire(import.meta.url)('@roamhq/wrtc')
    : await import('../dist/index.js');
const { RTCPeerConnection, RTCRtpReceiver, MediaStream, nonstandard } = w;

const keep = (codec) => {
  const name = codec.mimeType.split('/')[1].toLowerCase();
  return (
    ['rtx', 'red', 'ulpfec', 'flexfec-03'].includes(name) || families.split(',').includes(name)
  );
};
const prefs = families === 'all' ? [] : RTCRtpReceiver.getCapabilities('video').codecs.filter(keep);

const a = new RTCPeerConnection();
const b = new RTCPeerConnection();
const forward = (to) => (e) => {
  if (e.candidate?.candidate) to.addIceCandidate(e.candidate).catch(() => {});
};
a.addEventListener('icecandidate', forward(b));
b.addEventListener('icecandidate', forward(a));
const stream = new MediaStream();
const tracks = [];
for (let i = 0; i < 8; i++) {
  const track = new nonstandard.RTCVideoSource().createTrack();
  tracks.push(track);
  const sender = a.addTrack(track, stream);
  if (families !== 'all') {
    a.getTransceivers()
      .find((t) => t.sender === sender)
      .setCodecPreferences(prefs);
  }
}

const steps = {};
const lap = async (name, fn) => {
  const t0 = performance.now();
  const value = await fn();
  steps[name] ??= [];
  steps[name].push(performance.now() - t0);
  return value;
};
async function negotiate() {
  const offer = await lap('createOffer', () => a.createOffer());
  await lap('sldOffer', () => a.setLocalDescription(offer));
  await lap('srdOffer', () => b.setRemoteDescription(offer));
  const answer = await lap('createAnswer', () => b.createAnswer());
  await lap('sldAnswer', () => b.setLocalDescription(answer));
  await lap('srdAnswer', () => a.setRemoteDescription(answer));
  return offer.sdp;
}

let sdp = await negotiate();
await new Promise((resolve) => setTimeout(resolve, 300));
const wall = [];
const cpu = [];
const js = [];
for (let i = 0; i < rounds; i++) {
  const c0 = process.cpuUsage();
  const j0 = process.threadCpuUsage();
  const t0 = performance.now();
  sdp = await negotiate();
  wall.push(performance.now() - t0);
  const c = process.cpuUsage(c0);
  const j = process.threadCpuUsage(j0);
  cpu.push((c.user + c.system) / 1000);
  js.push((j.user + j.system) / 1000);
  if (process.env.GAP_MS) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.GAP_MS)));
  }
}
const median = (values) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];
const round2 = (x) => Math.round(x * 100) / 100;
const mLine = sdp.split('\nm=video')[1]?.split('\n')[0] ?? '';
console.log(
  JSON.stringify({
    impl,
    families,
    videoPayloadTypes: mLine.trim().split(' ').length - 2,
    sdpBytes: sdp.length,
    wallMs: round2(median(wall)),
    cpuMs: round2(median(cpu)),
    jsThreadMs: round2(median(js)),
    stepMs: Object.fromEntries(
      Object.entries(steps).map(([k, v]) => [k, round2(median(v.slice(1)))]),
    ),
  }),
);
a.close();
b.close();
for (const track of tracks) track.stop();
// wrtc's threads keep its process alive.
if (impl === 'wrtc') process.exit(0);
