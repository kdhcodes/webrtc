#!/usr/bin/env node
// `pnpm run build:ts`: compiles lib/ with tsconfig.json (into dist/, or the
// --outDir given), then post-processes the emitted declarations so our
// classes are typed structurally, as lib.dom's interfaces are. Extra
// arguments go to tsc (scripts/package.sh passes `--sourceMap false`;
// scripts/check-dom-types.mjs `--emitDeclarationOnly --outDir ...`).
//
// Two kinds of member are dropped from the .d.ts files (the JS is untouched):
// - `#private;`, the placeholder tsc emits for a class's JS private fields.
//   It makes the class nominal: nothing but an instance of that very class
//   is assignable to it, so a value typed with lib.dom's MediaStream (which
//   is what wrtc's types export) couldn't be used where ours is expected.
//   Our methods still brand-check at runtime, as they do for the *Like
//   parameter types.
// - `get [Symbol.toStringTag](): string;`, which lib.dom's interfaces don't
//   declare. Object.prototype.toString() still reads it at runtime.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DROPPED = [
  /^[ \t]*#private;\r?\n/gm,
  /^[ \t]*get \[Symbol\.toStringTag\]\(\): string;\r?\n/gm,
];

/**
 * `text` (one .d.ts file) without the members above. Throws if a private
 * name is still declared afterwards: tsc changed how it emits them, and the
 * class would silently be nominal again.
 */
export function structuralDeclarations(text, file = 'declaration') {
  let out = text;
  for (const pattern of DROPPED) out = out.replace(pattern, '');
  const leftover = /^[ \t]*(?:(?:readonly|static|get|set|async) +)*#\w+/m.exec(out);
  if (leftover) {
    throw new Error(`${file}: a private name is still declared: ${leftover[0].trim()}`);
  }
  return out;
}

/** Rewrites every .d.ts under `dir` with structuralDeclarations(). */
export function rewriteDeclarations(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
    const path = join(entry.parentPath, entry.name);
    const text = readFileSync(path, 'utf8');
    const out = structuralDeclarations(text, path);
    if (out !== text) writeFileSync(path, out);
  }
}

function main(args) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
  const outDirArg = args.indexOf('--outDir');
  const outDir = resolve(
    root,
    outDirArg >= 0 ? args[outDirArg + 1] : tsconfig.compilerOptions.outDir,
  );
  const tsc = join(root, 'node_modules/typescript/bin/tsc');
  const { status } = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (status !== 0) process.exit(status ?? 1);
  rewriteDeclarations(outDir);
}

if (import.meta.main) main(process.argv.slice(2));
