#!/usr/bin/env node
// `pnpm run build:ts`: compiles lib/ with tsconfig.json (into dist/, or the
// --outDir given), then post-processes the emitted declarations so our
// classes are typed structurally, as lib.dom's interfaces are. Extra
// arguments go to tsc (scripts/package.sh passes `--sourceMap false`;
// scripts/check-dom-types.mjs `--emitDeclarationOnly --outDir ...`), except
// -p/--project: this only builds tsconfig.json.
//
// Two kinds of member are dropped from the .d.ts files (the JS is untouched):
// - `#private;`, the placeholder tsc emits for a class's JS private fields.
//   It makes the class nominal: nothing but an instance of that very class
//   is assignable to it, so a value typed with lib.dom's MediaStream (which
//   is what wrtc's types export) couldn't be used where ours is expected.
//   Our methods still brand-check at runtime, as they do for the *Like
//   parameter types.
// - `[Symbol.toStringTag]` (as a getter or a property), which lib.dom's
//   interfaces don't declare. Object.prototype.toString() still reads it at
//   runtime.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, 'node_modules/typescript/bin/tsc');

const DROPPED = [
  /^[ \t]*#private;\r?\n/gm,
  // One line each: `get [Symbol.toStringTag](): string;`, or a property
  // such as `readonly [Symbol.toStringTag]: "RTCError";`.
  /^[ \t]*(?:(?:readonly|static|get|set) +)*\[Symbol\.toStringTag\][^;\n]*;\r?\n/gm,
];
// What must not be left once they're dropped (outside comments).
const LEFTOVERS = [
  /^[ \t]*(?:(?:readonly|static|get|set|async) +)*#\w+/m,
  /^(?![ \t]*(?:\*|\/\/|\/\*)).*\[Symbol\.toStringTag\].*/m,
];

/**
 * `text` (one .d.ts file) without the members above. Throws if a private
 * name or a toStringTag is still declared afterwards (tsc emitted one in a
 * form this doesn't know): the class would silently be nominal again, or
 * lib.dom's interface not assignable to it.
 */
export function structuralDeclarations(text, file = 'declaration') {
  let out = text;
  for (const pattern of DROPPED) out = out.replace(pattern, '');
  for (const pattern of LEFTOVERS) {
    const leftover = pattern.exec(out);
    if (leftover) {
      throw new Error(`${file}: still declares ${leftover[0].trim()}`);
    }
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

/** tsc's arguments for tsconfig.json plus `args`. Throws on -p/--project. */
export function tscArgs(args) {
  const project = args.find((arg) => /^(?:-p|--project)$/i.test(arg));
  if (project) {
    throw new Error(`build:ts only builds tsconfig.json, so it doesn't take ${project}`);
  }
  return ['-p', 'tsconfig.json', ...args];
}

/**
 * The directory tsc emits into for tsconfig.json in `cwd` plus `args`, as
 * tsc itself reads them (`--showConfig`): comments in the config, options in
 * any case (`--outdir`), command-line overrides.
 */
export function outDirFor(args, cwd = root) {
  const shown = spawnSync(process.execPath, [tsc, ...tscArgs(args), '--showConfig'], {
    cwd,
    encoding: 'utf8',
  });
  if (shown.status !== 0) {
    throw new Error(`tsc --showConfig failed:\n${shown.stdout}${shown.stderr}`);
  }
  const outDir = JSON.parse(shown.stdout).compilerOptions?.outDir;
  if (typeof outDir !== 'string') {
    throw new Error('tsconfig.json sets no outDir, nor do the arguments');
  }
  return resolve(cwd, outDir);
}

function main(args) {
  let outDir;
  try {
    outDir = outDirFor(args);
  } catch (error) {
    console.error(`build:ts: ${error.message}`);
    process.exit(1);
  }
  const { status } = spawnSync(process.execPath, [tsc, ...tscArgs(args)], {
    cwd: root,
    stdio: 'inherit',
  });
  if (status !== 0) process.exit(status ?? 1);
  rewriteDeclarations(outDir);
}

if (import.meta.main) main(process.argv.slice(2));
