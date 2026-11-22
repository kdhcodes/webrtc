/**
 * The single place that loads the native addon. Works from both lib/ (tests
 * run the .ts sources directly) and dist/ (compiled), which sit at the same
 * depth relative to build/ and package.json. See addon-path.ts for where the
 * addon is looked for.
 */
import { loadAddon, type Manifest } from './addon-path.ts';
import type { NativeModule } from './native-types.ts';

// Not imports, for import time (see addon-path.ts).
const { existsSync, readdirSync, readFileSync } = process.getBuiltinModule('node:fs');
const { createRequire } = process.getBuiltinModule('node:module');
const { fileURLToPath } = process.getBuiltinModule('node:url');

const require = createRequire(import.meta.url);
const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8'));

export const native = loadAddon({
  self: readManifest(fileURLToPath(new URL('../../package.json', import.meta.url))),
  platform: process.platform,
  arch: process.arch,
  // musl's dynamic loader, as detect-libc checks. Only consulted to explain a
  // failure, so a glibc system that also has musl installed still loads.
  isMusl: () => {
    try {
      return readdirSync('/lib').some((file) => file.startsWith('ld-musl-'));
    } catch {
      return false;
    }
  },
  localBuild: fileURLToPath(new URL('../../build/Release/wrtc.node', import.meta.url)),
  exists: existsSync,
  resolve: require.resolve,
  readManifest,
  load: require,
}) as NativeModule;
