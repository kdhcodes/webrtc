// GC behaviour of local video sinks with no other JS running, for one
// implementation (never load both addons in one process):
//
//   node bench/gc-sinks.mjs ours|wrtc [seconds] [sinks] [width] [height]
//
// `sinks` local sources at 30 fps, each straight into a sink whose handler
// reads one byte. Prints GC counts by kind every 5 s. Shows that the major
// GCs ("external memory pressure") in many-sink runs happen on both
// libraries once the app makes little other JS garbage (bench/RESULTS.md,
// "After the performance pass"). Run it with `--trace-incremental-marking`
// to see the reason.
import { createRequire } from 'node:module';
import { PerformanceObserver } from 'node:perf_hooks';

const [impl = 'ours', secondsArg = '25', countArg = '4', wArg = '1280', hArg = '720'] =
  process.argv.slice(2);
const [seconds, count, width, height] = [secondsArg, countArg, wArg, hArg].map(Number);
const { nonstandard } =
  impl === 'wrtc'
    ? createRequire(import.meta.url)('@roamhq/wrtc')
    : await import('../dist/index.js');

const sources = [];
const sinks = [];
let frames = 0;
for (let i = 0; i < count; i++) {
  const source = new nonstandard.RTCVideoSource();
  sources.push(source);
  const sink = new nonstandard.RTCVideoSink(source.createTrack());
  sink.onframe = ({ frame }) => {
    frames += frame.data[0] >= 0 ? 1 : 0;
  };
  sinks.push(sink);
}
const data = new Uint8Array(width * height * 1.5).fill(128);
const pump = setInterval(() => {
  for (const source of sources) source.onFrame({ width, height, data });
}, 33);

let bucket = { scavenge: 0, major: 0, other: 0, ms: 0 };
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const kind = entry.detail?.kind;
    if (kind === 1) bucket.scavenge++;
    else if (kind === 4) bucket.major++;
    else bucket.other++;
    bucket.ms += entry.duration;
  }
});
observer.observe({ entryTypes: ['gc'] });
const t0 = performance.now();
const report = setInterval(() => {
  const t = ((performance.now() - t0) / 1000).toFixed(0);
  const external = (process.memoryUsage().external / 1e6).toFixed(0);
  console.log(JSON.stringify({ impl, t, frames, externalMB: Number(external), ...bucket }));
  bucket = { scavenge: 0, major: 0, other: 0, ms: 0 };
}, 5000);
setTimeout(() => {
  clearInterval(pump);
  clearInterval(report);
  observer.disconnect();
  for (const sink of sinks) sink.stop();
  if (impl === 'wrtc') process.exit(0);
}, seconds * 1000);
