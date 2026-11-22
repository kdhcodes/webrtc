# Worker threads using wasm crash Node 24, 25 and 26 in wasm-to-JS wrapper tier-up

Both crashes need `worker_threads` that call JS imports from wasm often
enough for V8 to tier the import's wasm-to-JS wrapper up (1000 calls by
default), while other workers come and go. Node's TypeScript type stripping
is such a wasm module (amaro), so `.ts` code in workers is exposed without
using wasm directly. No native addon is involved: the reproducer below is
plain JavaScript.

## Reproducer

`repro-wasm-wrapper-race.mjs` (about 100 lines, no dependencies; attached
inline). It keeps 4 workers running at a time; each instantiates one module
whose 24 imports have distinct signatures, calls them a random number of
times (0 to 2000 each, in random order), and exits. `node
repro-wasm-wrapper-race.mjs 4 60` runs for 60 s and prints `survived N
workers`, or crashes.

Results, Linux arm64 (Docker on an M-series Mac, 12 vCPUs) and macOS arm64,
official builds except macOS Node 24 (nixpkgs' 24.22.2), runs of 60 s,
interleaved so machine load is comparable. On Linux arm64, Node 24 crashed
about once per 2,200 workers, so the flags' clean counts are over 15 times
that; on macOS it crashed about once per 40,000, too rarely there to judge
the flags.

| Node (Linux / macOS) | Flags | Linux arm64: runs, crashed | macOS arm64: runs, crashed |
|---|---|---|---|
| 24.22.3 / 24.22.2 | none | 31, 22 | 27, 3 (about 124,000 workers) |
| 24.22.3 / 24.22.2 | `--no-wasm-code-gc` | 0 crashes in 37,543 workers | 0 in 28,571 |
| 24.22.3 / 24.22.2 | `--wasm-wrapper-tiering-budget=1000000000` | 0 in 38,581 | 0 in 28,949 |
| 22.23.5 | none | 0 in 20,830 | 0 in 24,739 |
| 25.9.0 | none | 8, 8 (SIGILL) | not run |
| 26.13.1 | none | 56, 56 (SIGILL) | 6, 6 (SIGILL) |
| 26.13.1 | `--no-wasm-code-gc` | 27, 27 (SIGILL) | 6, 6 (SIGILL) |
| 26.13.1 | `--wasm-wrapper-tiering-budget=1000000000` | 0 in 137,389 | 0 in 60,926 |
| 26.13.1 | `--wasm-wrapper-tiering-budget=2147483647` | not run | 0 in 39,161 |

The flags work the same set at runtime with `v8.setFlagsFromString()`
before the first worker starts, even after the main thread has tiered up
the same imports itself (Node 26, macOS, budget 2147483647: 0 crashes in
22,908 workers). Linux x64 (emulated under Docker on the
Mac, so slow): Node 24 crashed 6 times in 18 runs (17,836 workers);
Node 25 and 26 showed no SIGILL in 14,920 and 22,412 workers, so that one
looks arm64 only (x86 keeps instruction caches coherent). On a native
8-core Linux x64 box, Node 24.22.3 crashed in all 7 runs (about once per
1,300 workers).

## Node 24 (nodejs/node#66366)

Signatures seen with the reproducer:
- `# Check failed: end > addr.` or `# Check failed: jit_page.has_value().`
  (the issue's `jit_page_->allocations_.erase(addr) == 1` is the same
  path) from
  `ThreadIsolation::UnregisterWasmAllocation` <- `WasmCodeAllocator::FreeCode`
  <- `WasmImportWrapperCache::Free` <- `WasmEngine::FreeDeadCode` <-
  `WasmCode::DecrementRefCount` <- `WasmCodeRefScope::~WasmCodeRefScope` <-
  `Runtime_TierUpWasmToJSWrapper`.
- SIGSEGV in `RecursiveMutex::Lock` <- `NativeModule::FreeCode` <-
  `WasmEngine::FreeDeadCodeLocked` <- ... the same frames up to
  `Runtime_TierUpWasmToJSWrapper` (the freed wrapper's `native_module_`
  read as garbage), or SIGBUS.

This is the race fixed by V8 9b8ca54d5a ("[wasm] Fix lookup of wrappers
marked is_dying"): `WasmImportWrapperCache::MaybeGet` adds the wrapper to
the `WasmCodeRefScope` before checking `is_dying()`, so a tier-up can take a
reference to a wrapper whose last reference the wasm code GC just dropped
on another thread; the GC frees it, then the scope's destructor frees it
again. Node 24.22.3 built with 68210d500a and 9b8ca54d5a applied (both
apply cleanly to `deps/v8`) survived 29,044 workers on Linux x64, run
alternately with the official 24.22.3, which crashed in all 7 of its runs.
Node 22 (V8 12.4) still had a per-module import wrapper cache and survives.

`--no-wasm-code-gc` and `--wasm-wrapper-tiering-budget=1000000000` (no
tier-up, so no lookup) both avoid it in the reproducer; numbers above.

## Node 25 and 26 (nodejs/node#67467)

SIGILL (exit 132) in wasm code, on arm64 (Linux and macOS), usually within
the first few hundred workers, every run. The faulting pc is the first
instruction of a wasm-to-JS wrapper, `0xd2800650` (`movz x16, #0x32`), which
reads back as valid in the core: the same signature as #67467. Another
thread is typically in `Builtins_WasmToJsWrapperCSA`. That points at a
freshly compiled wrapper being executed by a core that hasn't
resynchronised its instruction stream (stale instructions), not at the code
GC: `--no-wasm-code-gc` doesn't help, while
`--wasm-wrapper-tiering-budget=1000000000` (no wrapper tier-up) does.
