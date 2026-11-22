#!/usr/bin/env node
// Stress repro for libwebrtc's removeTrack race (PLAN.md "Gotchas",
// src/sink_reassert.cc). Not part of `pnpm test`: it takes minutes and
// needs a loaded CPU to hit the race at all.
//
//   node scripts/stress-removetrack-race.mjs [--runs 600] [--load 12] [--log <file>]
//
// Each run: two peer connections sending each other audio and video; once
// a has decoded some of b's video, a removes its video track and
// renegotiates (sendrecv -> recvonly recreates a's video receive stream),
// then a sink on a's remote video track must get a frame within 5 s.
// `--load N` runs N busy loops alongside (default: one per CPU). libwebrtc's
// log (src/log_hook.cc) counts the races: a "Could not create default
// receive stream" is the race nulling the sink, and the next "SetSink ...
// (ptr)" for that SSRC is the workaround restoring it. Without the
// workaround about 1 run in 180 fails under load; with it, none should.
// Exits non-zero if any run failed.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '600' },
    load: { type: 'string', default: String(availableParallelism()) },
    log: { type: 'string' },
  },
});
const runs = Number(values.runs);
const logFile = values.log ?? join(mkdtempSync(join(tmpdir(), 'wrtc-stress-')), 'libwebrtc.log');

// The log hook reads these when the addon loads, so set them before importing it.
process.env.WRTC_LOG = 'Could not create default receive stream|SetSink: ssrc';
process.env.WRTC_LOG_FILE = logFile;
const { nonstandard, RTCPeerConnection } = await import('../lib/index.ts');

const load = Array.from({ length: Number(values.load) }, () =>
  spawn('sh', ['-c', 'exec yes > /dev/null'], { stdio: 'ignore' }),
);
const stopLoad = () => {
  for (const child of load) child.kill();
};
process.on('exit', stopLoad);
process.on('SIGINT', () => process.exit(130));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with the first `type` event on `target`, or null after `ms`. */
function next(target, type, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, listener);
      resolve(null);
    }, ms);
    const listener = (event) => {
      clearTimeout(timer);
      target.removeEventListener(type, listener);
      resolve(event);
    };
    target.addEventListener(type, listener);
  });
}

async function negotiate(offerer, answerer) {
  await offerer.setLocalDescription();
  await answerer.setRemoteDescription(offerer.localDescription);
  await answerer.setLocalDescription();
  await offerer.setRemoteDescription(answerer.localDescription);
}

async function inboundVideo(pc) {
  for (const stats of (await pc.getStats()).values()) {
    if (stats.type === 'inbound-rtp' && stats.kind === 'video') return stats;
  }
  return undefined;
}

/** Audio and video sources pushing a tone and grey frames until stopped. */
function media() {
  const audio = new nonstandard.RTCAudioSource();
  const video = new nonstandard.RTCVideoSource();
  const samples = new Int16Array(480).map((_, i) => 8000 * Math.sin((2 * Math.PI * i) / 48));
  const frame = { width: 320, height: 240, data: new Uint8Array((320 * 240 * 3) / 2).fill(128) };
  let tick = 0;
  const pump = setInterval(() => {
    audio.onData({ samples, sampleRate: 48_000 });
    if (tick++ % 3 === 0) video.onFrame(frame);
  }, 10);
  const tracks = [audio.createTrack(), video.createTrack()];
  return {
    tracks,
    stop() {
      clearInterval(pump);
      for (const track of tracks) track.stop();
    },
  };
}

/** One run; resolves with whether a's sink got a frame after the renegotiation. */
async function run() {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  const ma = media();
  const mb = media();
  let sink;
  try {
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
    const [, videoSender] = ma.tracks.map((track) => a.addTrack(track));
    for (const track of mb.tracks) b.addTrack(track);
    const remote = [];
    a.ontrack = (e) => remote.push(e.track);
    await negotiate(a, b);
    for (let waited = 0; ((await inboundVideo(a))?.framesDecoded ?? 0) <= 20; waited += 50) {
      if (waited > 20_000) throw new Error('no video decoded within 20 s');
      await sleep(50);
    }
    a.removeTrack(videoSender);
    await negotiate(a, b);
    const video = remote.find((track) => track.kind === 'video');
    sink = new nonstandard.RTCVideoSink(video);
    return (await next(sink, 'frame', 5000)) !== null;
  } finally {
    sink?.stop();
    ma.stop();
    mb.stop();
    a.close();
    b.close();
  }
}

/** RTCLOG lines from byte `offset` of the log on: time (s) and text. */
function logSince(offset) {
  const text = readFileSync(logFile).subarray(offset).toString('utf8');
  return text
    .split('\n')
    .filter((line) => line.startsWith('RTCLOG '))
    .map((line) => {
      const [, time, rest] = line.match(/^RTCLOG (\S+) \[\S+\] (.*)$/) ?? [];
      return { time: Number(time), text: rest ?? '' };
    });
}

/** Each race in `lines`: whether the sink was restored, and how long that took. */
function races(lines) {
  const found = [];
  for (const [i, line] of lines.entries()) {
    if (!line.text.includes('Could not create default receive stream')) continue;
    const nulled = lines.slice(i + 1).find((l) => / SetSink: ssrc:\d+ nullptr$/.test(l.text));
    const ssrc = nulled?.text.match(/ssrc:(\d+)/)?.[1];
    const restored =
      ssrc && lines.slice(i + 1).find((l) => l.text.endsWith(`SetSink: ssrc:${ssrc} (ptr)`));
    found.push(restored ? (restored.time - (nulled?.time ?? line.time)) * 1000 : null);
  }
  return found;
}

console.log(`${runs} runs, ${load.length} busy loops, libwebrtc log in ${logFile}`);
const started = Date.now();
let failed = 0;
let errors = 0;
const recoveries = [];
let unrecovered = 0;
for (let i = 1; i <= runs; i++) {
  let offset = 0;
  try {
    offset = readFileSync(logFile).length;
  } catch {}
  let ok;
  try {
    ok = await run();
  } catch (error) {
    errors++;
    console.log(`run ${i}: error: ${error.message}`);
    continue;
  }
  const hit = races(logSince(offset));
  for (const ms of hit) {
    if (ms === null) unrecovered++;
    else recoveries.push(ms);
  }
  if (!ok) failed++;
  if (!ok || hit.length > 0) {
    const what = hit.map((ms) =>
      ms === null ? 'not restored' : `restored in ${ms.toFixed(2)} ms`,
    );
    console.log(`run ${i}: ${ok ? 'frames' : 'NO FRAME'}; races: ${what.join(', ') || 'none'}`);
  }
  if (i % 50 === 0)
    console.log(`... ${i} runs, ${failed} failed, ${recoveries.length + unrecovered} races so far`);
}
const max = recoveries.length > 0 ? Math.max(...recoveries).toFixed(2) : '-';
console.log(
  `done in ${Math.round((Date.now() - started) / 1000)} s: ${runs} runs, ${failed} without frames, ` +
    `${errors} errors; races hit: ${recoveries.length + unrecovered}, restored: ` +
    `${recoveries.length} (max ${max} ms), not restored: ${unrecovered}`,
);
stopLoad();
process.exit(failed > 0 || errors > 0 ? 1 : 0);
