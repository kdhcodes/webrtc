#!/usr/bin/env node
// Generates lib/internal/generated/idl.ts from @webref/idl: TypeScript types
// plus WebIDL converters for every enum and dictionary in the WebRTC and
// Media Capture specs. Interfaces are hand-written; for them it only writes
// lib/internal/generated/interfaces.ts, each interface's property shape
// (member names, kinds and lengths) for lib/internal/interface-shape.ts.
// Run with `pnpm gen:idl`; the output is committed.
//
// `generate()` is the pure core (IDL text in, TypeScript out), exported for
// scripts/gen-idl.test.ts; running this file is the CLI, which reads
// @webref/idl, writes the file and formats it with Biome.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'webidl2';

// Specs whose value types we need. Encoded transforms and identity are out
// of scope (SPEC-LAYER-PLAN.md).
const SPECS = [
  'webrtc',
  'webrtc-extensions',
  'webrtc-priority',
  'webrtc-svc',
  'webrtc-ice',
  'webrtc-stats',
  'mediacapture-streams',
  'mst-content-hint',
];

// Extended attributes the converters understand on dictionary members and
// their types. Anything else fails generation, so an IDL update that needs
// new handling can't be silently mis-emitted.
const KNOWN_EXT_ATTRS = new Set(['Clamp', 'EnforceRange']);

// Dictionaries from other specs that ours inherit from.
const EXTRA_IDL = `
dictionary PermissionDescriptor {
  required DOMString name;
};
dictionary EventInit {
  boolean bubbles = false;
  boolean cancelable = false;
  boolean composed = false;
};
`;

// Nonstandard members wrtc accepts (SPEC-LAYER-PLAN.md, "Native contract").
const NONSTANDARD_IDL = `
dictionary RTCPortRange {
  [EnforceRange] unsigned short min;
  [EnforceRange] unsigned short max;
};
enum RTCSdpSemantics { "unified-plan" };
partial dictionary RTCConfiguration {
  RTCPortRange portRange;
  RTCSdpSemantics sdpSemantics;
};
`;

const BUILTINS = {
  any: { ts: 'unknown', conv: 'webidl.any' },
  object: { ts: 'object', conv: 'webidl.object' },
  boolean: { ts: 'boolean', conv: 'webidl.boolean', kind: 'boolean' },
  DOMString: { ts: 'string', conv: 'webidl.DOMString', kind: 'string' },
  USVString: { ts: 'string', conv: 'webidl.USVString', kind: 'string' },
  ByteString: { ts: 'string', conv: 'webidl.ByteString', kind: 'string' },
  byte: { ts: 'number', conv: 'webidl.byte', kind: 'number', integer: true },
  octet: { ts: 'number', conv: 'webidl.octet', kind: 'number', integer: true },
  short: { ts: 'number', conv: 'webidl.short', kind: 'number', integer: true },
  'unsigned short': { ts: 'number', conv: 'webidl.unsignedShort', kind: 'number', integer: true },
  long: { ts: 'number', conv: 'webidl.long', kind: 'number', integer: true },
  'unsigned long': { ts: 'number', conv: 'webidl.unsignedLong', kind: 'number', integer: true },
  'long long': { ts: 'number', conv: 'webidl.longLong', kind: 'number', integer: true },
  'unsigned long long': {
    ts: 'number',
    conv: 'webidl.unsignedLongLong',
    kind: 'number',
    integer: true,
  },
  double: { ts: 'number', conv: 'webidl.double', kind: 'number' },
  'unrestricted double': { ts: 'number', conv: 'webidl.unrestrictedDouble', kind: 'number' },
  float: { ts: 'number', conv: 'webidl.float', kind: 'number' },
  'unrestricted float': { ts: 'number', conv: 'webidl.unrestrictedFloat', kind: 'number' },
  // hr-time
  DOMHighResTimeStamp: { ts: 'number', conv: 'webidl.double', kind: 'number' },
  EpochTimeStamp: { ts: 'number', conv: 'webidl.unsignedLongLong', kind: 'number', integer: true },
  BufferSource: { ts: 'ArrayBuffer | ArrayBufferView', conv: 'webidl.BufferSource' },
  ArrayBuffer: { ts: 'ArrayBuffer', conv: 'webidl.BufferSource' },
};

// ---------------------------------------------------------------------------
// Collect definitions

// webidl2's AST nodes expose their fields as prototype getters, so they don't
// survive object spread. Copy types into plain objects up front.
function checkExtAttrs(extAttrs, where) {
  for (const a of extAttrs) {
    if (!KNOWN_EXT_ATTRS.has(a.name)) {
      throw new Error(`unsupported extended attribute [${a.name}] on ${where}`);
    }
  }
}

function plainType(t) {
  checkExtAttrs(t.extAttrs, `type ${JSON.stringify(t.idlType)}`);
  return {
    union: t.union,
    generic: t.generic,
    nullable: t.nullable,
    extAttrs: t.extAttrs.map((a) => ({ name: a.name })),
    idlType: Array.isArray(t.idlType) ? t.idlType.map(plainType) : t.idlType,
  };
}

function plainMember(m) {
  checkExtAttrs(m.extAttrs, `member ${m.name}`);
  return {
    type: m.type,
    name: m.name,
    required: m.required,
    extAttrs: m.extAttrs.map((a) => ({ name: a.name })),
    default: m.default ? { type: m.default.type, value: m.default.value } : null,
    idlType: plainType(m.idlType),
  };
}

/**
 * Generates the TypeScript module for `sources` ({ idl, origin } in
 * collection order; later partial dictionaries extend earlier ones). Returns
 * `header` followed by the unformatted code, plus counts for the log line.
 * Throws on anything it can't emit faithfully: unknown type names, unknown
 * extended attributes, two union members of one kind, unsupported defaults.
 */
export function generate(sources, { header = '' } = {}) {
  const enums = new Map();
  const typedefs = new Map();
  const dictionaries = new Map(); // name -> { inheritance, members[] }
  const interfaceNames = new Set();
  const callbackNames = new Set();

  function collect(source, origin) {
    for (const def of parse(source)) {
      switch (def.type) {
        case 'enum':
          enums.set(
            def.name,
            def.values.map((v) => v.value),
          );
          break;
        case 'typedef':
          typedefs.set(def.name, plainType(def.idlType));
          break;
        case 'dictionary': {
          const existing = dictionaries.get(def.name);
          if (existing) {
            existing.members.push(...def.members.map(plainMember));
            if (!def.partial) existing.inheritance = def.inheritance;
          } else {
            dictionaries.set(def.name, {
              inheritance: def.partial ? null : def.inheritance,
              members: def.members.map(plainMember),
              origin,
            });
          }
          break;
        }
        case 'interface':
        case 'interface mixin':
          interfaceNames.add(def.name);
          break;
        case 'callback':
        case 'callback interface':
          callbackNames.add(def.name);
          break;
        default:
          break;
      }
    }
  }

  for (const { idl, origin } of sources) {
    collect(idl, origin);
  }

  // ---------------------------------------------------------------------------
  // Type mapping

  function resolveTypedef(t) {
    if (!t.union && !t.generic && typedefs.has(t.idlType)) {
      const resolved = typedefs.get(t.idlType);
      return { ...resolved, nullable: resolved.nullable || t.nullable };
    }
    return t;
  }

  function tsType(t) {
    const n = t.nullable ? ' | null' : '';
    if (t.union) return `(${t.idlType.map(tsType).join(' | ')})${n}`;
    if (t.generic === 'sequence' || t.generic === 'FrozenArray') {
      return `(${tsType(t.idlType[0])})[]${n}`;
    }
    if (t.generic === 'record') return `Record<string, ${tsType(t.idlType[1])}>${n}`;
    const name = t.idlType;
    if (BUILTINS[name]) return `${BUILTINS[name].ts}${n}`;
    if (enums.has(name) || dictionaries.has(name) || typedefs.has(name)) return `${name}${n}`;
    if (callbackNames.has(name)) return `((...args: never[]) => unknown)${n}`;
    if (interfaceNames.has(name)) return `object${n}`;
    throw new Error(`unknown IDL type ${name}`);
  }

  let unionCount = 0;
  const unionDecls = [];

  function integerOptions(extAttrs) {
    const names = new Set((extAttrs ?? []).map((a) => a.name));
    const opts = [];
    if (names.has('Clamp')) opts.push('clamp: true');
    if (names.has('EnforceRange')) opts.push('enforceRange: true');
    return opts.length ? `{ ${opts.join(', ')} }` : null;
  }

  function converter(rawType, extAttrs = []) {
    const t = resolveTypedef(rawType);
    // Unions keep their own `?`: unionConverter handles null itself, so
    // clearing it here would turn null into the string "null".
    const inner = converterNonNull(t.union ? t : { ...t, nullable: false }, [
      ...extAttrs,
      ...(t.extAttrs ?? []),
    ]);
    return t.nullable && !t.union ? `webidl.nullable(${inner})` : inner;
  }

  function converterNonNull(t, extAttrs) {
    if (t.union) return unionConverter(t);
    if (t.generic === 'sequence' || t.generic === 'FrozenArray') {
      return `webidl.sequence(${converter(t.idlType[0])})`;
    }
    if (t.generic === 'record') return `webidl.record(${converter(t.idlType[1])})`;
    const name = t.idlType;
    const builtin = BUILTINS[name];
    if (builtin) {
      const opts = builtin.integer ? integerOptions(extAttrs) : null;
      return opts ? `(v: unknown, c: string) => ${builtin.conv}(v, c, ${opts})` : builtin.conv;
    }
    if (enums.has(name)) return `to${name}`;
    if (dictionaries.has(name)) return `to${name}`;
    if (callbackNames.has(name)) return 'webidl.callback';
    if (interfaceNames.has(name)) return `webidl.interfaceType('${name}')`;
    throw new Error(`unknown IDL type ${name}`);
  }

  function flattenUnion(t, out = { members: [], nullable: false }) {
    if (t.nullable) out.nullable = true;
    for (const raw of t.idlType) {
      const m = resolveTypedef(raw);
      if (m.nullable) out.nullable = true;
      if (m.union) flattenUnion(m, out);
      else out.members.push({ ...m, nullable: false });
    }
    return out;
  }

  function unionConverter(t) {
    const { members, nullable } = flattenUnion(t);
    const parts = [];
    const kinds = new Set();
    const interfaces = [];
    const add = (kind, conv) => {
      // WebIDL forbids indistinguishable members, and the runtime keeps one
      // converter per kind; a duplicate means the IDL needs new handling.
      if (kinds.has(kind)) throw new Error(`union has two ${kind} members: ${JSON.stringify(t)}`);
      kinds.add(kind);
      parts.push(`${kind}: ${conv}`);
    };
    for (const m of members) {
      const conv = converter(m, m.extAttrs);
      if (m.generic === 'sequence' || m.generic === 'FrozenArray') add('sequence', conv);
      else if (m.generic === 'record') add('record', conv);
      else if (dictionaries.has(m.idlType)) add('dictionary', conv);
      else if (enums.has(m.idlType)) add('string', conv);
      else if (BUILTINS[m.idlType]?.kind) add(BUILTINS[m.idlType].kind, conv);
      else if (interfaceNames.has(m.idlType)) {
        interfaces.push(`{ name: '${m.idlType}', convert: ${conv} }`);
      } else throw new Error(`unknown IDL type ${m.idlType} in union`);
    }
    if (interfaces.length) parts.push(`interfaces: [${interfaces.join(', ')}]`);
    if (nullable) parts.push('nullable: true');
    const name = `union${unionCount++}`;
    const label = t.idlType.map((m) => m.idlType).join(' or ');
    unionDecls.push(
      `const ${name}: webidl.Converter<${tsType(t)}> = webidl.union('(${label})', { ${parts.join(', ')} });`,
    );
    return name;
  }

  function defaultLiteral(member, memberConv, context) {
    const d = member.default;
    switch (d.type) {
      case 'string':
        return JSON.stringify(d.value);
      case 'number':
        return String(Number(d.value));
      case 'boolean':
        return String(d.value);
      case 'null':
        return 'null';
      case 'sequence':
        return '[]';
      case 'dictionary':
        return `${memberConv}(undefined, ${context})`;
      default:
        throw new Error(`unsupported default ${d.type} for ${member.name}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Emit

  const out = [];
  if (header) out.push(header);

  const sortedEnums = [...enums.keys()].sort();
  const sortedTypedefs = [...typedefs.keys()].sort();
  const sortedDicts = [...dictionaries.keys()].sort();

  out.push('// Enums\n');
  for (const name of sortedEnums) {
    const values = enums.get(name);
    out.push(`export const ${name}Values = ${JSON.stringify(values)} as const;
export type ${name} = (typeof ${name}Values)[number];
export const to${name}: webidl.Converter<${name}> = webidl.enumeration('${name}', ${name}Values);
`);
  }

  out.push('// Typedefs\n');
  for (const name of sortedTypedefs) {
    out.push(`export type ${name} = ${tsType(typedefs.get(name))};\n`);
  }

  const dictCode = [];
  for (const name of sortedDicts) {
    const dict = dictionaries.get(name);
    const members = dict.members.filter((m) => m.type === 'field');
    const fields = members
      .map((m) => `  ${JSON.stringify(m.name)}${m.required ? '' : '?'}: ${tsType(m.idlType)};`)
      .join('\n');
    const ext = dict.inheritance ? ` extends ${dict.inheritance}` : '';
    dictCode.push(`/** ${dict.origin} */
export interface ${name}${ext} {
${fields}
}
`);

    // Members are processed in lexicographic order, inherited ones first
    // (https://webidl.spec.whatwg.org/#es-dictionary).
    const sorted = [...members].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const body = [];
    body.push('  const source = webidl.dictionarySource(value, context);');
    body.push(
      dict.inheritance
        ? `  const out: Record<string, unknown> = { ...to${dict.inheritance}(value, context) };`
        : '  const out: Record<string, unknown> = {};',
    );
    body.push('  let v: unknown;');
    for (const m of sorted) {
      const conv = converter(m.idlType, m.extAttrs);
      const ctx = `\`\${context}.${m.name}\``;
      body.push(`  v = source?.[${JSON.stringify(m.name)}];`);
      body.push(`  if (v !== undefined) out[${JSON.stringify(m.name)}] = (${conv})(v, ${ctx});`);
      if (m.required) {
        body.push(`  else webidl.requiredMember(context, ${JSON.stringify(m.name)});`);
      } else if (m.default) {
        body.push(
          `  else out[${JSON.stringify(m.name)}] = ${defaultLiteral(m, `(${conv})`, ctx)};`,
        );
      }
    }
    body.push(`  return out as unknown as ${name};`);
    dictCode.push(`export function to${name}(value: unknown, context = '${name}'): ${name} {
${body.join('\n')}
}
`);
  }

  out.push('// Unions\n');
  out.push(...unionDecls.map((d) => `${d}\n`));
  out.push('\n// Dictionaries\n');
  out.push(...dictCode);

  return {
    code: out.join('\n'),
    counts: {
      enums: enums.size,
      typedefs: typedefs.size,
      dictionaries: dictionaries.size,
      unions: unionCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Interface shapes

// A readonly maplike's members (https://webidl.spec.whatwg.org/#es-maplike):
// operation lengths, plus the `size` attribute.
const MAPLIKE_OPERATIONS = { entries: 0, forEach: 1, get: 1, has: 1, keys: 0, values: 0 };

/** WebIDL's length for an operation or constructor: its shortest overload's required arguments. */
function minLength(overloads) {
  return Math.min(
    ...overloads.map((o) => o.arguments.filter((a) => !a.optional && !a.variadic).length),
  );
}

/**
 * Generates the module describing each interface's ECMAScript shape (for
 * lib/internal/interface-shape.ts): its interface object's `length`, its
 * regular attributes (event handlers separately), and its regular and static
 * operations with their `length` (and which regular ones return a promise). Partial interfaces merge into the full
 * one. Throws on member kinds the runtime helper doesn't handle (constants,
 * stringifiers, iterables, setlikes, static attributes, mixins), so an IDL
 * update that needs them can't be silently mis-described.
 */
export function generateInterfaces(sources, { header = '' } = {}) {
  const interfaces = new Map(); // name -> { constructors[], attributes, eventHandlers, operations, statics, maplike }
  function entry(name) {
    let e = interfaces.get(name);
    if (!e) {
      e = {
        constructors: [],
        attributes: new Set(),
        eventHandlers: new Set(),
        operations: new Map(),
        statics: new Map(),
        promises: new Set(),
        staticPromises: new Set(),
        maplike: false,
      };
      interfaces.set(name, e);
    }
    return e;
  }
  for (const { idl } of sources) {
    for (const def of parse(idl)) {
      if (def.type === 'includes' || def.type === 'interface mixin') {
        throw new Error(`interface mixins aren't supported (${def.target ?? def.name})`);
      }
      if (def.type !== 'interface') continue;
      const e = entry(def.name);
      for (const m of def.members) {
        const where = `${def.name}.${m.name ?? m.type}`;
        if (m.type === 'constructor') {
          e.constructors.push(m);
        } else if (m.type === 'attribute' && !m.special) {
          (m.idlType.idlType === 'EventHandler' ? e.eventHandlers : e.attributes).add(m.name);
        } else if (m.type === 'operation' && (m.special === '' || m.special === 'static')) {
          if (!m.name) throw new Error(`unsupported anonymous operation on ${def.name}`);
          const byName = m.special === 'static' ? e.statics : e.operations;
          byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
          if (m.idlType.generic === 'Promise') {
            (m.special === 'static' ? e.staticPromises : e.promises).add(m.name);
          }
        } else if (m.type === 'maplike' && m.readonly) {
          e.maplike = true;
          e.attributes.add('size');
          for (const [name, length] of Object.entries(MAPLIKE_OPERATIONS)) {
            e.operations.set(name, [{ arguments: Array(length).fill({}) }]);
          }
        } else {
          throw new Error(`unsupported member ${where} (${m.type} ${m.special ?? ''})`);
        }
      }
    }
  }

  const lengths = (byName) =>
    `{ ${[...byName].map(([name, overloads]) => `${name}: ${minLength(overloads)}`).join(', ')} }`;
  const list = (names) => `[${[...names].map((n) => `'${n}'`).join(', ')}]`;
  const out = [header];
  out.push(`/** An interface's ECMAScript shape, from its IDL. */
export interface InterfaceShape {
  /** The interface object's \`length\`: its constructor's (0 when it has none). */
  readonly length: number;
  /** Regular attributes other than event handlers. */
  readonly attributes: readonly string[];
  /** EventHandler attributes (\`on<event>\`). */
  readonly eventHandlers: readonly string[];
  /** Regular operations, each with its \`length\`. */
  readonly operations: Readonly<Record<string, number>>;
  /** Regular operations that return a promise. */
  readonly promiseOperations: readonly string[];
  /** Static operations, each with its \`length\`. */
  readonly staticOperations: Readonly<Record<string, number>>;
  /** Static operations that return a promise. */
  readonly staticPromiseOperations: readonly string[];
  /** A readonly maplike: \`@@iterator\` is \`entries\`. */
  readonly maplike: boolean;
}

export const interfaceShapes: Readonly<Record<string, InterfaceShape>> = {`);
  for (const name of [...interfaces.keys()].sort()) {
    const e = interfaces.get(name);
    out.push(`  ${name}: {
    length: ${e.constructors.length ? minLength(e.constructors) : 0},
    attributes: ${list(e.attributes)},
    eventHandlers: ${list(e.eventHandlers)},
    operations: ${lengths(e.operations)},
    promiseOperations: ${list(e.promises)},
    staticOperations: ${lengths(e.statics)},
    staticPromiseOperations: ${list(e.staticPromises)},
    maplike: ${e.maplike},
  },`);
  }
  out.push('};\n');
  return { code: out.join('\n'), count: interfaces.size };
}

// ---------------------------------------------------------------------------
// CLI

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `code` as Biome formats it (as a file at `path`). */
function format(code, path) {
  return execFileSync(
    join(root, 'node_modules/.bin/biome'),
    ['format', `--stdin-file-path=${path}`],
    // From the repo root, so Biome finds biome.json wherever this runs from.
    { cwd: root, input: code, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Both generated modules, formatted as committed: `files` maps each path
 * (relative to the repo root) to its code. scripts/gen-idl.test.ts compares
 * them with the committed files.
 */
export function generateFiles() {
  const require = createRequire(import.meta.url);
  const idlDir = dirname(require.resolve('@webref/idl/package.json'));
  const idlVersion = JSON.parse(readFileSync(join(idlDir, 'package.json'), 'utf8')).version;

  const sources = [
    ...SPECS.map((spec) => ({
      idl: readFileSync(join(idlDir, `${spec}.idl`), 'utf8'),
      origin: spec,
    })),
    { idl: EXTRA_IDL, origin: 'dom' },
    { idl: NONSTANDARD_IDL, origin: 'wrtc (nonstandard)' },
  ];
  const { code, counts } = generate(sources, {
    header: `// Generated by scripts/gen-idl.mjs from @webref/idl ${idlVersion}. Do not edit.
// Specs: ${SPECS.join(', ')}, plus EventInit and wrtc's nonstandard
// RTCConfiguration members.
/* eslint-disable */
import * as webidl from '../webidl.ts';
`,
  });
  const shapes = generateInterfaces(sources, {
    header: `// Generated by scripts/gen-idl.mjs from @webref/idl ${idlVersion}. Do not edit.
// Specs: ${SPECS.join(', ')}.
// Interface shapes for lib/internal/interface-shape.ts.
`,
  });
  const idlPath = 'lib/internal/generated/idl.ts';
  const shapesPath = 'lib/internal/generated/interfaces.ts';
  return {
    files: { [idlPath]: format(code, idlPath), [shapesPath]: format(shapes.code, shapesPath) },
    log: [
      `${idlPath}: ${counts.enums} enums, ${counts.typedefs} typedefs, ${counts.dictionaries} dictionaries, ${counts.unions} unions`,
      `${shapesPath}: ${shapes.count} interfaces`,
    ],
  };
}

function main() {
  const { files, log } = generateFiles();
  for (const [path, code] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), code);
  }
  for (const line of log) console.log(`wrote ${line}`);
}

if (import.meta.main) main();
