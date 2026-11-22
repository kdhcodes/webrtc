// The package as an install would lay it out, for tests that must load
// compiled JavaScript rather than lib/'s TypeScript: lib/ compiled with tsc
// into a temporary node_modules/<name>/dist, next to a copy of package.json
// and a link to this checkout's build/ (so the addon loads as from a
// checkout). Never touches the checkout's own dist/.
//
// Workers that use the library load it from here: a worker that imports
// lib/*.ts runs Node's type stripper, which is wasm, and Node 24's V8 can
// crash the whole process when workers using wasm come and go (PLAN.md, "V8
// wasm crash in workers").
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

export const packageName = (
  JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { name: string }
).name;

export interface BuiltPackage {
  /** The temporary directory holding node_modules/; a consumer's cwd. */
  root: string;
  /** file: URL of the package's entry point (dist/index.js), for import(). */
  entry: string;
}

/** Builds the package; it's removed after the test. */
export function builtPackage(t: TestContext): BuiltPackage {
  const root = mkdtempSync(join(tmpdir(), 'wrtc-pkg-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'node_modules', ...packageName.split('/'));
  mkdirSync(pkg, { recursive: true });
  copyFileSync(join(repo, 'package.json'), join(pkg, 'package.json'));
  symlinkSync(join(repo, 'build'), join(pkg, 'build'));
  const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(
    process.execPath,
    [tsc, '-p', join(repo, 'tsconfig.json'), '--outDir', join(pkg, 'dist')],
    { timeout: 60_000 },
  );
  return { root, entry: pathToFileURL(join(pkg, 'dist', 'index.js')).href };
}
