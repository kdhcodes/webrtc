#!/usr/bin/env node
// Checks that our public types and lib.dom's are assignable to each other,
// both ways (test/dom-compat/), against what a consumer compiles against:
// the declarations `pnpm run build:ts` emits (scripts/build-ts.mjs), written
// to test/dom-compat/.declarations. The test compiles twice: with the
// current TypeScript and its lib.dom, and with TypeScript 5.8 and its
// lib.dom (the `typescript-5.8` devDependency), whose dictionaries differ in
// places. Part of `pnpm run typecheck`.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const declarations = 'test/dom-compat/.declarations';

const version = (pkg) =>
  JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;
const compilers = [
  {
    name: `TypeScript ${version('typescript')}`,
    tsc: 'node_modules/typescript/bin/tsc',
    project: 'test/dom-compat/tsconfig.json',
  },
  {
    name: `TypeScript ${version('typescript-5.8')}`,
    tsc: 'node_modules/typescript-5.8/bin/tsc',
    project: 'test/dom-compat/tsconfig.ts5.8.json',
  },
];

/** Runs a Node script from the repo root; returns its exit status. */
function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' }).status;
}

/** Every name lib/exports.ts exports, from its emitted declarations. */
function exportedNames() {
  const text = readFileSync(join(root, declarations, 'exports.d.ts'), 'utf8');
  const names = [...text.matchAll(/^export (?:type )?\{([^}]*)\}/gm)].flatMap(([, list]) =>
    list.split(',').map((item) => item.trim().replace(/^type /, '')),
  );
  return names.filter(Boolean);
}

/** The global names the lib.dom `compiler` compiles its project with declares. */
function libDomNames(compiler) {
  const { stdout } = spawnSync(
    process.execPath,
    [compiler.tsc, '-p', compiler.project, '--listFilesOnly'],
    { cwd: root, encoding: 'utf8' },
  );
  const file = stdout.split('\n').find((line) => /[\\/]lib\.dom\.d\.ts$/.test(line.trim()));
  if (!file) throw new Error(`${compiler.name} compiles ${compiler.project} without lib.dom`);
  const text = readFileSync(file.trim(), 'utf8');
  return new Set([...text.matchAll(/^(?:interface|type|declare var) (\w+)/gm)].map((m) => m[1]));
}

rmSync(join(root, declarations), { recursive: true, force: true });
if (run('scripts/build-ts.mjs', ['--emitDeclarationOnly', '--outDir', declarations]) !== 0) {
  console.error('check-dom-types: emitting the declarations failed');
  process.exit(1);
}

// Every export a lib.dom also declares must be checked (as `W.<name>`).
const tested = new Set(
  readdirSync(join(root, 'test/dom-compat'))
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) => [
      ...readFileSync(join(root, 'test/dom-compat', file), 'utf8').matchAll(/\bW\.(\w+)/g),
    ])
    .map((m) => m[1]),
);
const exported = exportedNames();
let untested = false;
for (const compiler of compilers) {
  const dom = libDomNames(compiler);
  const missing = exported.filter((name) => dom.has(name) && !tested.has(name));
  if (missing.length) {
    console.error(
      `check-dom-types: ${compiler.name}'s lib.dom declares exports test/dom-compat doesn't check: ${missing.join(', ')}`,
    );
    untested = true;
  }
}
if (untested) process.exit(1);

const failed = compilers.filter((c) => run(c.tsc, ['-p', c.project]) !== 0).map((c) => c.name);
if (failed.length) {
  console.error(`check-dom-types: test/dom-compat fails with ${failed.join(' and ')}`);
  process.exit(1);
}
