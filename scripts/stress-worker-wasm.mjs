#!/usr/bin/env node
// Stress run for the V8 wasm crash in workers (PLAN.md, "V8 wasm crash in
// workers"), with this library: worker lifecycles that load it and connect a
// peer connection pair, `--lanes` at a time, until `--count` have finished or
// the process dies. Not part of `pnpm test` (minutes per configuration).
//
//   node scripts/stress-worker-wasm.mjs [--entry lib|dist] [--exit terminate|natural]
//     [--lanes 3] [--count 2000] [--kill-within 800] [--strip] [--worker-timeout 30000]
//
// --entry lib imports lib/index.ts, so every worker runs Node's TypeScript
// type stripper (wasm); dist imports the compiled dist/index.js (run
// `pnpm run build:ts` first). --strip also has the worker import a trivial
// .ts file, as a consumer's own TypeScript worker would. --exit terminate
// terminates each worker at a random moment within --kill-within ms of its
// creation (often mid-import); natural lets it close everything and exit.
// A worker still running after --worker-timeout ms (natural: it never got
// media or never exited) is terminated and fails the run.
// Prints `progress N` every 100 lifecycles and `survived N` at the end; a
// crash ends the process (SIGSEGV, SIGILL, or a V8_Fatal on stderr).
// scripts/repro-wasm-wrapper-race.mjs is the same crash without the addon.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

if (isMainThread) {
  const { values } = parseArgs({
    options: {
      entry: { type: 'string', default: 'lib' },
      exit: { type: 'string', default: 'terminate' },
      lanes: { type: 'string', default: '3' },
      count: { type: 'string', default: '2000' },
      'kill-within': { type: 'string', default: '800' },
      'worker-timeout': { type: 'string', default: '30000' },
      strip: { type: 'boolean', default: false },
    },
  });
  const repo = new URL('../', import.meta.url);
  const entry = new URL(values.entry === 'dist' ? 'dist/index.js' : 'lib/index.ts', repo).href;
  const dir = mkdtempSync(join(tmpdir(), 'stress-worker-wasm-'));
  const tsFile = join(dir, 'plain.ts');
  writeFileSync(tsFile, 'export const add = (a: number, b: number): number => a + b;\n');
  const count = Number(values.count);
  const killWithin = Number(values['kill-within']);
  const workerTimeout = Number(values['worker-timeout']);
  const terminate = values.exit === 'terminate';
  let done = 0;
  const one = () =>
    new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), {
        workerData: { entry, tsFile: values.strip ? tsFile : null },
      });
      const timer = terminate ? setTimeout(() => w.terminate(), Math.random() * killWithin) : null;
      let timedOut = false;
      const guard = setTimeout(() => {
        timedOut = true;
        w.terminate();
      }, workerTimeout);
      w.once('error', reject);
      w.once('exit', (code) => {
        clearTimeout(timer);
        clearTimeout(guard);
        if (timedOut) reject(new Error(`a worker was still running after ${workerTimeout} ms`));
        else if (!terminate && code !== 0) reject(new Error(`worker exited with ${code}`));
        else resolve();
      });
    });
  const lane = async () => {
    while (done < count) {
      await one();
      if (++done % 100 === 0) console.log(`progress ${done}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Number(values.lanes) }, lane));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`survived ${done}`);
} else {
  const { entry, tsFile } = workerData;
  if (tsFile) await import(tsFile);
  const { RTCPeerConnection, nonstandard } = await import(entry);
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate).catch(() => {});
  b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate).catch(() => {});
  const source = new nonstandard.RTCAudioSource();
  const track = source.createTrack();
  a.addTrack(track);
  const remote = new Promise((resolve) => (b.ontrack = (e) => resolve(e.track)));
  await a.setLocalDescription();
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription();
  await a.setRemoteDescription(b.localDescription);
  const sink = new nonstandard.RTCAudioSink(await remote);
  const samples = new Int16Array(480).map((_, i) => 8000 * Math.sin(i / 5));
  const pump = setInterval(() => source.onData({ samples, sampleRate: 48000 }), 10);
  await new Promise((resolve) => (sink.ondata = resolve));
  parentPort.postMessage('media');
  clearInterval(pump);
  sink.stop();
  track.stop();
  a.close();
  b.close();
}
