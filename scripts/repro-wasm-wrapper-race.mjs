#!/usr/bin/env node
// Standalone reproducer (no addon, no dependencies) for two V8 crashes in
// wasm-to-JS wrapper tier-up when worker_threads that call JS imports from
// wasm come and go.
//
// - Node 24 (V8 13.6): a SIGSEGV or SIGBUS (often in NativeModule::FreeCode
//   or RecursiveMutex::Lock) or a V8_Fatal in ThreadIsolation
//   (UnregisterWasmAllocation / TryLookupJitPageLocked: "Check failed: end >
//   addr.", "Check failed: jit_page.has_value()."), under
//   Runtime_TierUpWasmToJSWrapper -> ~WasmCodeRefScope ->
//   WasmEngine::FreeDeadCode. A tier-up that looks up a wrapper just as the
//   wasm code GC frees it on another thread takes a reference to it
//   (WasmImportWrapperCache::MaybeGet adds the reference before checking
//   is_dying()) and frees it again when its WasmCodeRefScope ends. Fixed in
//   V8 by 9b8ca54d5a ("[wasm] Fix lookup of wrappers marked is_dying"), not
//   in Node 24 as of 24.22.3 (nodejs/node#66366, backport PR #66376).
// - Node 25 and 26 (V8 14.1, 14.6), arm64 only: SIGILL (exit 132, nothing on
//   stderr) at the first instruction of a freshly tiered wrapper
//   (nodejs/node#67467).
//
//   node repro-wasm-wrapper-race.mjs [lanes=4] [seconds=60] [maxCalls=2000]
//
// Worker churn, as a test runner's thread pool or a worker per job: `lanes`
// workers at a time, each instantiating one module whose 24 imports have
// distinct signatures and calling them a random number of times (0 to
// maxCalls each, in random order) before exiting. Imports that pass V8's
// wrapper tier-up budget (1000 calls) get a compiled wasm-to-JS wrapper from
// V8's process-wide import wrapper cache, at different moments in different
// workers, and a worker's exit drops the wrappers only it held, which the
// wasm code GC then frees. Node's TypeScript type stripping (amaro) is such
// a module, so .ts code in workers is exposed the same way.
//
// Prints `progress N` every 100 workers and `survived N workers` at the end.
// Observed, official builds unless noted, 60 s runs:
// - Node 24.22.3, Linux arm64 (Docker on an M-series Mac): 22 of 31 runs
//   crashed, about once per 2,200 workers. Linux x64: every run on a native
//   8-core box (about once per 1,300 workers); 6 of 18 emulated.
// - Node 24.22.2 (nixpkgs), macOS arm64: 3 of 27 runs, about once per
//   41,000 workers; run it many times there.
// - Node 25.9.0 and 26.13.1, arm64 (Linux and macOS): SIGILL in every run,
//   usually within a few hundred workers. Not seen on emulated x64.
// - Node 22.23.5: no crash in 45,000 workers.
// `--wasm-wrapper-tiering-budget=2147483647` (no wrapper tier-up) avoided
// both crashes in every run. `--no-wasm-code-gc` avoided Node 24's but not
// Node 25/26's.
import { isMainThread, Worker, workerData } from 'node:worker_threads';

const N = 24;

function leb(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}
const str = (s) => [...leb(s.length), ...Buffer.from(s)];
const section = (id, body) => [id, ...leb(body.length), ...body];
const vec = (items) => [...leb(items.length), ...items.flat()];

// Import i: (i32 x (i % 12), plus an f64 if i >= 12) -> i32, so each import
// has its own wrapper. Export e<i> calls import i with constant arguments.
function buildModule() {
  const I32 = 0x7f;
  const F64 = 0x7c;
  const params = (i) => [...Array(i % 12).fill(I32), ...(i >= 12 ? [F64] : [])];
  const types = [];
  for (let i = 0; i < N; i++) types.push([0x60, ...vec(params(i).map((p) => [p])), 1, I32]);
  types.push([0x60, 0, 1, I32]);
  const imports = [];
  for (let i = 0; i < N; i++) imports.push([...str('m'), ...str(`f${i}`), 0x00, ...leb(i)]);
  const funcs = [];
  for (let i = 0; i < N; i++) funcs.push(leb(N));
  const exports = [];
  for (let i = 0; i < N; i++) exports.push([...str(`e${i}`), 0x00, ...leb(N + i)]);
  const bodies = [];
  for (let i = 0; i < N; i++) {
    const code = [0x00];
    for (const p of params(i)) {
      if (p === I32) code.push(0x41, 0x01);
      else code.push(0x44, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f);
    }
    code.push(0x10, ...leb(i), 0x0b);
    bodies.push([...leb(code.length), ...code]);
  }
  return new Uint8Array([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...section(1, vec(types)),
    ...section(2, vec(imports)),
    ...section(3, vec(funcs)),
    ...section(7, vec(exports)),
    ...section(10, vec(bodies)),
  ]);
}

if (isMainThread) {
  const lanes = Number(process.argv[2] ?? 4);
  const until = Date.now() + Number(process.argv[3] ?? 60) * 1000;
  const maxCalls = Number(process.argv[4] ?? 2000);
  const bytes = buildModule();
  let workers = 0;
  const lane = async () => {
    while (Date.now() < until) {
      const w = new Worker(new URL(import.meta.url), { workerData: { bytes, maxCalls } });
      await new Promise((resolve, reject) => {
        w.once('error', reject);
        w.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
      if (++workers % 100 === 0) console.log(`progress ${workers} workers`);
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  console.log(`survived ${workers} workers`);
} else {
  const { bytes, maxCalls } = workerData;
  const imports = { m: {} };
  for (let i = 0; i < N; i++) imports.m[`f${i}`] = () => i;
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), imports);
  const left = Array.from({ length: N }, () => Math.floor(Math.random() * maxCalls));
  let total = left.reduce((a, b) => a + b, 0);
  while (total > 0) {
    const i = Math.floor(Math.random() * N);
    if (left[i] === 0) continue;
    left[i]--;
    total--;
    if (exports[`e${i}`]() !== i) throw new Error('bad result');
  }
}
