// Tests of the IDL generator's core on small inline IDL. Behaviour is
// checked by running the generated converters (written to a temp file and
// imported, with the real lib/internal/webidl.ts), not by matching text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { registerInterface } from '../lib/internal/webidl.ts';
import { generate, generateFiles, generateInterfaces } from './gen-idl.mjs';

type Converter = (value: unknown, context?: string) => unknown;

const webidlUrl = new URL('../lib/internal/webidl.ts', import.meta.url).href;

/** Generates code for IDL sources, collected in the order given. */
function generateCode(...sources: string[]): string {
  return generate(
    sources.map((idl, i) => ({ idl, origin: `source ${i}` })),
    { header: `import * as webidl from '${webidlUrl}';\n` },
  ).code;
}

/**
 * Generates the module for `sources`, imports it from a temp file (removed
 * after the test) and returns its export `name`.
 */
async function compile(t: TestContext, name: string, ...sources: string[]): Promise<Converter> {
  const code = generateCode(...sources);
  const dir = await mkdtemp(join(tmpdir(), 'gen-idl-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'idl.mts');
  await writeFile(file, code);
  const module: Record<string, unknown> = await import(pathToFileURL(file).href);
  const converter = module[name];
  if (typeof converter !== 'function') throw new Error(`generated code has no ${name}()`);
  return converter as Converter;
}

/** `target` behind a proxy that logs the string keys read from it. */
function logReads(target: object): { value: object; reads: string[] } {
  const reads: string[] = [];
  const value = new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === 'string') reads.push(key);
      return Reflect.get(object, key, receiver);
    },
  });
  return { value, reads };
}

// ---------------------------------------------------------------------------
// Dictionaries

test('partial dictionaries merge into the full one (and its inheritance), from any source', async (t) => {
  const toD = await compile(
    t,
    'toD',
    'partial dictionary D { long early; };',
    'dictionary D : Base { long main; }; dictionary Base { long base; };',
    'partial dictionary D { long late; };',
  );
  assert.deepEqual(toD({ base: 1, early: 2, main: 3, late: 4 }), {
    base: 1,
    early: 2,
    main: 3,
    late: 4,
  });
});

test('members are read parent first, each level in lexicographic order', async (t) => {
  const toChild = await compile(
    t,
    'toChild',
    `dictionary Base { long z; long a; };
     dictionary Child : Base { long y; long b; };`,
  );
  const { value, reads } = logReads({ a: 1, b: 2, y: 3, z: 4 });
  assert.deepEqual(toChild(value), { a: 1, b: 2, y: 3, z: 4 });
  assert.deepEqual(reads, ['a', 'z', 'b', 'y']);
});

test('defaults fill in absent members, including nested dictionary defaults', async (t) => {
  const toD = await compile(
    t,
    'toD',
    `dictionary Inner { long depth = 3; };
     dictionary D {
       DOMString s = "x";
       long n = -7;
       double d = 0.5;
       boolean flag = true;
       long? maybe = null;
       sequence<long> list = [];
       Inner inner = {};
       long noDefault;
     };`,
  );
  const expected = {
    s: 'x',
    n: -7,
    d: 0.5,
    flag: true,
    maybe: null,
    list: [],
    inner: { depth: 3 },
  };
  assert.deepEqual(toD({}), expected);
  assert.deepEqual(toD(undefined), expected);
  assert.deepEqual(toD(null), expected);
});

test('a given member overrides its default', async (t) => {
  const toD = await compile(t, 'toD', 'dictionary D { long n = 1; boolean flag = true; };');
  assert.deepEqual(toD({ n: 5, flag: 0 }), { n: 5, flag: false });
});

test('a missing required member throws, naming the dictionary and the member', async (t) => {
  const toD = await compile(t, 'toD', 'dictionary D { required DOMString name; long other; };');
  assert.deepEqual(toD({ name: 'n' }), { name: 'n' });
  assert.throws(() => toD({ other: 1 }), {
    name: 'TypeError',
    message: "D: required member 'name' is undefined",
  });
});

test('required members are non-optional in the TypeScript interface', () => {
  const code = generateCode('dictionary D { required DOMString name; long other; };');
  assert.match(code, /"name": string;/);
  assert.match(code, /"other"\?: number;/);
});

test('member errors carry the member path as context', async (t) => {
  const toOuter = await compile(
    t,
    'toOuter',
    `dictionary Inner { required long n; };
     dictionary Outer { sequence<Inner> items; };`,
  );
  assert.throws(() => toOuter({ items: [{ n: 1 }, {}] }), {
    name: 'TypeError',
    message: "Outer.items[1]: required member 'n' is undefined",
  });
});

// ---------------------------------------------------------------------------
// Extended attributes

test('[Clamp] and [EnforceRange] on a member reach the integer conversion', async (t) => {
  const toD = await compile(
    t,
    'toD',
    'dictionary D { [Clamp] octet c; [EnforceRange] octet e; octet m; };',
  );
  assert.deepEqual(toD({ c: 300, e: 255, m: 300 }), { c: 255, e: 255, m: 44 });
  assert.throws(() => toD({ e: 256 }), {
    name: 'TypeError',
    message: 'D.e: is outside the range [0, 255]',
  });
});

test('[EnforceRange] on a typedef applies where the typedef is used', async (t) => {
  const toD = await compile(
    t,
    'toD',
    'typedef [EnforceRange] unsigned short Port; dictionary D { Port port; };',
  );
  assert.deepEqual(toD({ port: 443 }), { port: 443 });
  assert.throws(() => toD({ port: 70000 }), {
    name: 'TypeError',
    message: 'D.port: is outside the range [0, 65535]',
  });
});

// ---------------------------------------------------------------------------
// Unions

test('a (string or sequence) union picks the member that matches the value', async (t) => {
  const toD = await compile(t, 'toD', 'dictionary D { (DOMString or sequence<DOMString>) urls; };');
  assert.deepEqual(toD({ urls: 'a' }), { urls: 'a' });
  assert.deepEqual(toD({ urls: ['a', 'b'] }), { urls: ['a', 'b'] });
  assert.deepEqual(toD({ urls: 1 }), { urls: '1' });
});

test('an enum counts as the string member of a union', async (t) => {
  const toD = await compile(t, 'toD', 'enum E { "on" }; dictionary D { (long or E) v; };');
  assert.deepEqual(toD({ v: 5 }), { v: 5 });
  assert.deepEqual(toD({ v: 'on' }), { v: 'on' });
  assert.throws(() => toD({ v: 'off' }), {
    name: 'TypeError',
    message: "D.v: 'off' is not a valid value for enumeration E",
  });
});

test('a nullable member inside a union makes the union nullable', async (t) => {
  const toD = await compile(t, 'toD', 'dictionary D { (long? or sequence<long>) v; };');
  assert.deepEqual(toD({ v: null }), { v: null });
});

// Regression test: converter() used to clear a union's `?` before calling
// unionConverter(), so null was converted as the string "null". (Latent: no
// IDL we generate from has a nullable union.)
test('a nullable union accepts null', async (t) => {
  const toD = await compile(t, 'toD', 'dictionary D { (long or DOMString)? v; };');
  assert.deepEqual(toD({ v: null }), { v: null });
});

test('a union nested through a typedef is flattened', async (t) => {
  const toD = await compile(
    t,
    'toD',
    'typedef (long or DOMString) LongOrString; dictionary D { (LongOrString or sequence<long>) m; };',
  );
  assert.deepEqual(
    [3, 'x', [1, 2]].map((m) => toD({ m })),
    [{ m: 3 }, { m: 'x' }, { m: [1, 2] }],
  );
});

test('an interface member of a union is matched by its registered brand check', async (t) => {
  const brand = new WeakSet<object>();
  registerInterface('GenIdlTestThing', (value) => brand.has(value));
  const toD = await compile(
    t,
    'toD',
    'interface GenIdlTestThing {}; dictionary D { (GenIdlTestThing or DOMString) v; };',
  );
  const thing = {};
  brand.add(thing);
  assert.equal((toD({ v: thing }) as { v: unknown }).v, thing);
  assert.deepEqual(toD({ v: {} }), { v: '[object Object]' });
});

// ---------------------------------------------------------------------------
// Strictness: anything the generator can't emit faithfully fails generation.

/**
 * Why generating `idl` fails: `[idl, message]`, or `[idl, 'no error']`.
 * Comparing these pairs in one assertion names the failing IDL and shows
 * the actual message next to the expected one.
 */
function generationError(idl: string): [string, string] {
  try {
    generateCode(idl);
    return [idl, 'no error'];
  } catch (error) {
    return [idl, (error as Error).message];
  }
}

test('an unknown type name fails generation', () => {
  const sources = [
    'dictionary D { Mystery m; };',
    'dictionary D { sequence<Mystery> m; };',
    'dictionary D { (Mystery or DOMString) m; };',
    'typedef Mystery T;',
  ];
  assert.deepEqual(
    sources.map(generationError),
    sources.map((idl) => [idl, 'unknown IDL type Mystery']),
  );
});

test('an unknown extended attribute fails generation', () => {
  const cases: [string, string][] = [
    ['dictionary D { [LegacyNullToEmptyString] DOMString m; };', 'member m'],
    ['dictionary D { ([Unknown] long or DOMString) m; };', 'type "long"'],
    ['typedef [Unknown] long T;', 'type "long"'],
  ];
  assert.deepEqual(
    cases.map(([idl]) => generationError(idl)),
    cases.map(([idl, where]) => {
      const name = /\[(\w+)\]/.exec(idl)?.[1];
      return [idl, `unsupported extended attribute [${name}] on ${where}`];
    }),
  );
});

test('two union members of one kind fail generation', () => {
  const cases: [string, string][] = [
    ['dictionary D { (long or double) m; };', 'number'],
    ['enum E { "a" }; dictionary D { (DOMString or E) m; };', 'string'],
    ['dictionary A {}; dictionary B {}; dictionary D { (A or B) m; };', 'dictionary'],
    ['dictionary D { (sequence<long> or sequence<DOMString>) m; };', 'sequence'],
  ];
  for (const [idl, kind] of cases) {
    assert.throws(
      () => generateCode(idl),
      (error: Error) => error.message.startsWith(`union has two ${kind} members: `),
      idl,
    );
  }
});

test('an unsupported default fails generation', () => {
  assert.throws(() => generateCode('dictionary D { unrestricted double x = NaN; };'), {
    message: 'unsupported default NaN for x',
  });
});

// ---------------------------------------------------------------------------
// Interface shapes (generateInterfaces)

/** The `interfaceShapes` table generated for `sources`, imported from a temp file. */
async function shapes(t: TestContext, ...sources: string[]): Promise<Record<string, unknown>> {
  const { code } = generateInterfaces(sources.map((idl, i) => ({ idl, origin: `source ${i}` })));
  const dir = await mkdtemp(join(tmpdir(), 'gen-idl-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'interfaces.mts');
  await writeFile(file, code);
  return (await import(pathToFileURL(file).href)).interfaceShapes;
}

test('interface shapes: lengths from the shortest overload, partials merged, event handlers apart', async (t) => {
  const table = await shapes(
    t,
    `interface Thing : EventTarget {
       constructor(DOMString a, optional long b);
       constructor(DOMString a, long b, long c);
       readonly attribute DOMString name;
       attribute EventHandler onping;
       Promise<undefined> go(long a, optional long b, long... rest);
       Promise<undefined> go(long a, long b, long c);
       undefined stop();
       static Thing? make(DOMString kind);
       static Promise<Thing> build(optional DOMString kind);
     };`,
    'partial interface Thing { attribute long extra; undefined more(long x, long y); };',
    'interface Plain {};',
  );
  assert.deepEqual(table.Thing, {
    length: 1,
    attributes: ['name', 'extra'],
    eventHandlers: ['onping'],
    operations: { go: 1, stop: 0, more: 2 },
    promiseOperations: ['go'],
    staticOperations: { make: 1, build: 0 },
    staticPromiseOperations: ['build'],
    maplike: false,
  });
  assert.equal((table.Plain as { length: number }).length, 0);
});

test('interface shapes: a readonly maplike gets the map read members', async (t) => {
  const table = await shapes(t, 'interface Report { readonly maplike<DOMString, object>; };');
  assert.deepEqual(table.Report, {
    length: 0,
    attributes: ['size'],
    eventHandlers: [],
    operations: { entries: 0, forEach: 1, get: 1, has: 1, keys: 0, values: 0 },
    promiseOperations: [],
    staticOperations: {},
    staticPromiseOperations: [],
    maplike: true,
  });
});

test('interface shapes: member kinds the runtime helper does not handle fail generation', () => {
  for (const idl of [
    'interface I { const long X = 1; };',
    'interface I { stringifier; };',
    'interface I { iterable<long>; };',
    'interface I { static attribute long x; };',
    'interface mixin M {}; I includes M;',
  ]) {
    assert.throws(() => generateInterfaces([{ idl, origin: 'test' }]), /unsupported|mixins/, idl);
  }
});

test('the committed generated files are up to date (else run pnpm gen:idl)', () => {
  const { files } = generateFiles();
  const root = new URL('..', import.meta.url);
  for (const [path, code] of Object.entries(files)) {
    const committed = readFileSync(new URL(path, root), 'utf8');
    assert.ok(committed === code, `${path} is stale: run pnpm gen:idl`);
  }
});
