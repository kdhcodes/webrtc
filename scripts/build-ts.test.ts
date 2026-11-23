// Tests of scripts/build-ts.mjs: the declaration post-processing, and how it
// finds tsc's output directory. That the real declarations come out
// structural is checked by test/dom-compat/ (pnpm run typecheck), whose
// DOM-to-ours assignments fail on a `#private`.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { outDirFor, structuralDeclarations, tscArgs } from './build-ts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// structuralDeclarations

const emitted = `export declare class MediaStream extends EventTarget {
    #private;
    constructor(streamOrTracks?: MediaStream);
    get [Symbol.toStringTag](): string;
    get id(): string;
    get onaddtrack(): AnyEventHandler;
}
export declare class RTCError extends DOMException {
    #private;
    get [Symbol.toStringTag](): string;
    get errorDetail(): RTCErrorDetailType;
}
`;

test("drops every class's #private placeholder and toStringTag getter, nothing else", () => {
  assert.equal(
    structuralDeclarations(emitted),
    `export declare class MediaStream extends EventTarget {
    constructor(streamOrTracks?: MediaStream);
    get id(): string;
    get onaddtrack(): AnyEventHandler;
}
export declare class RTCError extends DOMException {
    get errorDetail(): RTCErrorDetailType;
}
`,
  );
});

test('drops a toStringTag declared as a property, or with a setter', () => {
  for (const member of [
    'readonly [Symbol.toStringTag]: "RTCError";',
    '[Symbol.toStringTag]: string;',
    'static readonly [Symbol.toStringTag]: string;',
    'set [Symbol.toStringTag](value: string);',
  ]) {
    assert.equal(
      structuralDeclarations(`declare class A {\n    ${member}\n    get id(): string;\n}\n`),
      'declare class A {\n    get id(): string;\n}\n',
      member,
    );
  }
});

test('leaves a file without classes, and toStringTag in a comment, as they are', () => {
  const text =
    'export interface RTCIceServer {\n    /** Unlike [Symbol.toStringTag]: kept. */\n    urls: string | string[];\n}\n';
  assert.equal(structuralDeclarations(text), text);
});

test('throws if a private name is still declared, naming the file and the member', () => {
  for (const member of ['#native: object;', 'readonly #id: string;', 'get #state(): string;']) {
    assert.throws(
      () => structuralDeclarations(`declare class A {\n    ${member}\n}\n`, 'A.d.ts'),
      { message: `A.d.ts: still declares ${member.replace(/[:(].*/, '')}` },
      member,
    );
  }
});

test('throws if a toStringTag in a form it does not drop is still declared', () => {
  const text = 'declare class A {\n    get [Symbol.toStringTag](): {\n        a: 1;\n    };\n}\n';
  assert.throws(() => structuralDeclarations(text, 'A.d.ts'), {
    message: 'A.d.ts: still declares get [Symbol.toStringTag](): {',
  });
});

// ---------------------------------------------------------------------------
// tsc's arguments and output directory

test('refuses a -p/--project override, in any case', () => {
  for (const flag of ['-p', '--project', '--PROJECT', '-P']) {
    assert.throws(() => tscArgs([flag, 'other.json']), {
      message: `build:ts only builds tsconfig.json, so it doesn't take ${flag}`,
    });
  }
  assert.deepEqual(tscArgs(['--sourceMap', 'false']), [
    '-p',
    'tsconfig.json',
    '--sourceMap',
    'false',
  ]);
});

test("the output directory is tsconfig.json's, or --outDir's in any case", () => {
  assert.equal(outDirFor([]), join(root, 'dist'));
  assert.equal(outDirFor(['--outDir', 'out/a']), join(root, 'out/a'));
  assert.equal(outDirFor(['--outdir', 'out/b', '--sourceMap', 'false']), join(root, 'out/b'));
  assert.equal(outDirFor(['--OUTDIR', join(tmpdir(), 'c')]), join(tmpdir(), 'c'));
});

test('reads a tsconfig.json with comments and trailing commas, as tsc does', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'build-ts-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
  await writeFile(
    join(dir, 'tsconfig.json'),
    '{\n  // where it goes\n  "compilerOptions": { "outDir": "built", /* here */ },\n}\n',
  );
  assert.equal(outDirFor([], dir), join(dir, 'built'));
});
