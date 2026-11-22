// Child process of renegotiation.test.ts, run with WRTC_LOG='SetSink: ssrc'
// and WRTC_LOG_FILE set (the log hook reads them when the addon loads).
// One video track from a to b, then RENEGOTIATIONS offer/answer rounds that
// change nothing. Prints the number of "SetSink: ssrc:N (ptr)" log lines
// seen after the call is up and after each round.
import { readFileSync } from 'node:fs';
import { nonstandard, RTCPeerConnection, type RTCTrackEvent } from '../../lib/index.ts';
import { greyFrame, negotiate, next, WAIT_MS } from './harness.ts';

const LOG = process.env.WRTC_LOG_FILE ?? '';
const ROUNDS = Number(process.env.RENEGOTIATIONS ?? 3);

const logLines = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
const sinkSets = () => logLines().filter((l) => / SetSink: ssrc:\d+ \(ptr\)$/.test(l)).length;

/** Resolves once at least `count` sinks were set; the deadline is only a failure guard. */
async function sinkSetsReach(count: number): Promise<number> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const n = sinkSets();
    if (n >= count || Date.now() > deadline) return n;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const a = new RTCPeerConnection();
const b = new RTCPeerConnection();
const source = new nonstandard.RTCVideoSource();
const frame = { width: 160, height: 120, data: greyFrame(160, 120) };
const pump = setInterval(() => source.onFrame(frame), 30);
const track = source.createTrack();
let sink: nonstandard.RTCVideoSink | undefined;
try {
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  a.addTrack(track);
  const tracked = next<RTCTrackEvent>(b, 'track');
  await negotiate(a, b);
  sink = new nonstandard.RTCVideoSink((await tracked).track);
  await next(sink, 'frame');
  // b's receiver set its sink once, then one re-assert after b's SRD and
  // one after its SLD. a receives no video, so it has nothing to re-assert.
  const counts = [await sinkSetsReach(3)];
  // Stops at the first count that falls short, so a failure is quick.
  for (let round = 1; round <= ROUNDS && counts.at(-1) === 1 + 2 * round; round++) {
    await negotiate(a, b);
    counts.push(await sinkSetsReach(3 + 2 * round));
  }
  console.log(JSON.stringify(counts));
} finally {
  clearInterval(pump);
  sink?.stop();
  track.stop();
  a.close();
  b.close();
}
