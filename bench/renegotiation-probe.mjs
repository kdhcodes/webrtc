// Wall-clock vs process CPU time per signaling step, for one implementation
// (never load both addons in one process). Used to show that our slower
// renegotiation is CPU work, and as the workload for a native profile:
//
//   node bench/renegotiation-probe.mjs ours|wrtc [extra-renegotiations]
//   sample <pid> 8 -file out.txt      # macOS, while it runs
//
// It adds 8 video tracks one renegotiation at a time, then (for profiling)
// renegotiates `extra` more times with nothing changed: the full SDP path
// still runs. (It once flipped directions instead, which found the macOS
// sendonly -> sendrecv failure fixed in 7eded0d; see bench/RESULTS.md.)
import { createRequire } from 'node:module';

const impl = process.argv[2];
const extra = Number(process.argv[3] ?? 0);
const w =
  impl === 'wrtc'
    ? createRequire(import.meta.url)('@roamhq/wrtc')
    : await import('../dist/index.js');
const { RTCPeerConnection, MediaStream, nonstandard } = w;

const a = new RTCPeerConnection();
const b = new RTCPeerConnection();
const forward = (to) => (e) => {
  if (e.candidate?.candidate) to.addIceCandidate(e.candidate).catch(() => {});
};
a.addEventListener('icecandidate', forward(b));
b.addEventListener('icecandidate', forward(a));
const stream = new MediaStream();
const tracks = [];
const addTrack = () => {
  const track = new nonstandard.RTCVideoSource().createTrack();
  tracks.push(track);
  a.addTrack(track, stream);
};

/** [wall ms, process CPU ms] per step, over the recorded renegotiations. */
const steps = {};
async function negotiate(record) {
  const lap = async (name, fn) => {
    const cpu = process.cpuUsage();
    const t0 = performance.now();
    const value = await fn();
    const wall = performance.now() - t0;
    const used = process.cpuUsage(cpu);
    if (record) {
      steps[name] ??= [];
      steps[name].push([wall, (used.user + used.system) / 1000]);
    }
    return value;
  };
  const offer = await lap('createOffer', () => a.createOffer());
  await lap('sldOffer', () => a.setLocalDescription(offer));
  await lap('srdOffer', () => b.setRemoteDescription(offer));
  const answer = await lap('createAnswer', () => b.createAnswer());
  await lap('sldAnswer', () => b.setLocalDescription(answer));
  await lap('srdAnswer', () => a.setRemoteDescription(answer));
}

addTrack();
await negotiate(false);
await new Promise((resolve) => setTimeout(resolve, 500));
for (let i = 0; i < 8 + extra; i++) {
  if (i < 8) addTrack();
  // The first renegotiation is a warm-up.
  await negotiate(i > 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const median = (values) => values.sort((x, y) => x - y)[Math.floor(values.length / 2)];
for (const [name, samples] of Object.entries(steps)) {
  const wall = median(samples.map((s) => s[0])).toFixed(2);
  const cpu = median(samples.map((s) => s[1])).toFixed(2);
  console.log(`${impl} ${name.padEnd(12)} wall ${wall} ms, cpu ${cpu} ms`);
}
a.close();
b.close();
for (const track of tracks) track.stop();
// wrtc's threads keep its process alive.
if (impl === 'wrtc') process.exit(0);
