// Third-party notices for what our packages ship: the licences of everything
// compiled into wrtc.node (libwebrtc.a and node-addon-api). Two steps:
//
//   node scripts/third-party-notices.mjs components <out dir> <libwebrtc.a | members.txt>
//       On the machine that built libwebrtc: lists the third-party source
//       directories that the objects in libwebrtc.a were compiled from.
//       <out dir> is the gn out dir (<checkout>/src/out/<triple>), and the
//       second argument the archive scripts/build-libwebrtc.sh made from it,
//       or its member list (`ar t libwebrtc.a`, a .txt file) when the archive
//       that ships is a copy elsewhere. Save the output as
//       notices/<platform>.components.
//
//   node scripts/third-party-notices.mjs generate [--libwebrtc-dir D] [--checkout SRC]
//       Writes notices/<platform>.md for each notices/*.components, and
//       THIRD_PARTY_NOTICES.md, their union. Licence texts come from each
//       build's LICENSE.md (D/<triple>/LICENSE.md, libwebrtc's own
//       generator; D defaults to third_party/libwebrtc-upstream) and, for the
//       directories that file leaves out, from the libwebrtc checkout SRC
//       (default ~/src/webrtc-m150/src). Fails if any listed directory has no
//       licence text.
//
// `components` reads what is archived, not what the webrtc target links:
// build-libwebrtc.sh archives every object under out/obj (bar nasm, a host
// tool), so the script takes the same list and checks it against the
// archive's members. Each object's inputs (its source and every header or
// %include it pulled in) come from `ninja -t deps`; nasm writes no depfile,
// so for nasm objects the %include chain is followed by hand. An input's
// component is its deepest `third_party/<name>` directory, so nested code
// (libaom's third_party/vector, protobuf's third_party/utf8_range) counts
// on its own. x86inc.asm counts as `x86inc` wherever it sits (dav1d keeps
// it in src/ext/x86). Code outside any third_party directory is libwebrtc's.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Package platform -> libwebrtc build triple (third_party/libwebrtc-upstream/<triple>).
export const TRIPLES = {
  'darwin-arm64': 'mac-arm64-release',
  'linux-arm64': 'linux-arm64-release',
  'linux-x64': 'linux-x64-release',
};

const ENTITIES = { quot: '"', lt: '<', gt: '>', '#x27': "'", '#39': "'", amp: '&' };

/** Undoes HTML escaping, in one pass (so "&amp;quot;" stays "&quot;"). */
export function unescapeHtml(text) {
  return text.replace(/&(quot|lt|gt|#x27|#39|amp);/g, (_, name) => ENTITIES[name]);
}

/**
 * The sections of a generated LICENSE.md: `# <name>` followed by the licence
 * text in a ``` fence. Returns a Map of name to (unescaped) text.
 */
export function parseLicenses(markdown) {
  const sections = new Map();
  const re = /^# (.+)\n```\n([\s\S]*?)\n```$/gm;
  for (const match of markdown.matchAll(re)) sections.set(match[1], unescapeHtml(match[2]));
  if (sections.size === 0) throw new Error('no "# name" + ``` sections found');
  return sections;
}

/**
 * The component of a source path relative to the checkout's src/: the
 * deepest `third_party/<name>` directory, or the file itself for an
 * x86inc.asm outside a third_party/x86inc directory. Generated files
 * (gen/...) count as their source directory's. null for libwebrtc's own
 * code and for anything outside the checkout (SDK and compiler headers).
 */
export function componentOf(path) {
  let p = normalize(path);
  if (p.startsWith('..') || p.startsWith('/')) return null;
  if (p.startsWith('gen/')) p = p.slice(4);
  const parts = p.split('/');
  if (parts.at(-1) === 'x86inc.asm' && parts.at(-2) !== 'x86inc') return p;
  const last = parts.slice(0, -1).lastIndexOf('third_party');
  if (last < 0 || last + 1 >= parts.length - 1) return null;
  return parts.slice(0, last + 2).join('/');
}

/** A component's licence name: its directory's name, or x86inc. */
export function componentName(component) {
  return basename(component) === 'x86inc.asm' ? 'x86inc' : basename(component);
}

/**
 * Parses `ninja -t deps` output: a Map of object path to its inputs (as
 * ninja printed them, relative to the out dir), for entries with deps.
 */
export function parseDeps(text) {
  const deps = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('    ')) {
      if (current) current.push(line.trim());
    } else if (line.trim()) {
      const [obj, rest] = line.split(': ');
      current = rest?.startsWith('#deps') ? [] : null;
      if (current) deps.set(obj, current);
    }
  }
  return deps;
}

/**
 * The licence text in a source file's leading comment block (used for
 * dav1d's x86inc.asm, which has no LICENSE file of its own).
 */
export function headerLicence(source) {
  const lines = [];
  for (const line of source.split('\n')) {
    const m = /^\s*(?:;\*?|\/\/|\/\*+|\*\/?|#)\s?(.*)$/.exec(line);
    if (!m) break;
    if (/^\**$/.test(m[1].trim()) && lines.length === 0) continue;
    lines.push(m[1].replace(/\s*\*+\s*$/, '').trimEnd());
  }
  while (lines.length && /^\**$/.test(lines.at(-1).trim())) lines.pop();
  return lines.join('\n').trim();
}

/** Every file a nasm source %includes, transitively (it has no depfile). */
function nasmInputs(src, includeDirs) {
  const seen = new Set();
  const todo = [src];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, name] of readFileSync(file, 'latin1').matchAll(
      /^\s*%include\s+["<]([^">]+)[">]/gm,
    )) {
      const found = [dirname(file), ...includeDirs]
        .map((d) => join(d, name))
        .find((p) => existsSync(p));
      if (!found) throw new Error(`${file}: can't resolve %include "${name}"`);
      todo.push(found);
    }
  }
  return [...seen];
}

/** Objects under out/obj, as build-libwebrtc.sh archives them. */
function archivedObjects(outDir) {
  const objects = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(outDir, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (path !== 'obj/third_party/nasm') walk(path);
      } else if (entry.name.endsWith('.o')) {
        objects.push(path);
      }
    }
  };
  walk('obj');
  return objects.sort();
}

function components(outDir, archive) {
  const src = resolve(outDir, '../..');
  const objects = archivedObjects(outDir);
  // The archive keeps base names only; the multisets must agree.
  const llvmAr = join(src, 'third_party/llvm-build/Release+Asserts/bin/llvm-ar');
  const members = (
    archive.endsWith('.txt')
      ? readFileSync(archive, 'utf8')
      : execFileSync(existsSync(llvmAr) ? llvmAr : 'ar', ['t', archive], {
          encoding: 'utf8',
          maxBuffer: 1 << 26,
        })
  )
    .split('\n')
    .filter(Boolean)
    .sort();
  const names = objects.map((o) => basename(o)).sort();
  if (members.join('\n') !== names.join('\n')) {
    throw new Error(
      `${archive} has ${members.length} members, but ${outDir}/obj has ${names.length} objects ` +
        'that build-libwebrtc.sh would archive; is this the out dir it was built from?',
    );
  }
  const ninja = join(src, 'third_party/ninja/ninja');
  const run = (args) =>
    execFileSync(ninja, ['-C', outDir, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const deps = parseDeps(run(['-t', 'deps', ...objects]));
  const note = (input) => {
    // Inputs are relative to the out dir; generated ones stay under gen/.
    const rel = normalize(input);
    const c = componentOf(rel.startsWith('gen/') ? rel : relative(src, resolve(outDir, rel)));
    if (c) found.add(c);
  };
  const found = new Set();
  for (const inputs of deps.values()) inputs.forEach(note);
  const noDeps = objects.filter((o) => !deps.has(o));
  if (noDeps.length) {
    const wanted = new Set(noDeps.map((o) => normalize(o)));
    const handled = new Set();
    // `ninja -t commands` also prints what the objects depend on (such as
    // building nasm itself), so only the objects' own commands count.
    for (const line of run(['-t', 'commands', ...noDeps]).split('\n')) {
      const out = normalize(/-o\s*(\S+\.o)\b/.exec(line)?.[1] ?? '.');
      if (!wanted.has(out) || !/\bnasm\b/.test(line)) continue;
      handled.add(out);
      const words = line.split(/\s+/);
      const asm = words.findLast((w) => w.endsWith('.asm'));
      const dirs = words.filter((w) => w.startsWith('-I') && w.length > 2).map((w) => w.slice(2));
      for (const input of nasmInputs(
        resolve(outDir, asm),
        dirs.map((d) => resolve(outDir, d)),
      )) {
        note(relative(outDir, input));
      }
    }
    const unknown = noDeps.filter((o) => !handled.has(normalize(o)));
    if (unknown.length)
      throw new Error(`no deps for ${unknown.length} objects, e.g. ${unknown[0]}`);
  }
  return [...found].sort();
}

/** Per-component notes, shown under the heading. */
const NOT_LINKED =
  'In libwebrtc.a (built alongside the webrtc target), but not linked into wrtc.node: ' +
  'none of its symbols are in the link maps of darwin-arm64 and linux-x64 (2026-11-22).';
const NOTES = {
  protobuf: NOT_LINKED,
  utf8_range: NOT_LINKED,
  perfetto: NOT_LINKED,
  fastfeat: NOT_LINKED,
};

/**
 * Groups licence entries ({name, text, path, platform}) into sections, one
 * per name, each with its distinct texts (and where each came from).
 */
export function sections(entries) {
  const byName = new Map();
  for (const { name, text, path, platform } of entries) {
    if (!byName.has(name)) byName.set(name, { name, texts: [], platforms: new Set() });
    const section = byName.get(name);
    section.platforms.add(platform);
    let same = section.texts.find((t) => t.text === text);
    if (!same) {
      same = { text, paths: new Set() };
      section.texts.push(same);
    }
    same.paths.add(path);
  }
  // libwebrtc first, then by name.
  return [...byName.values()].sort((a, b) =>
    a.name === 'webrtc' ? -1 : b.name === 'webrtc' ? 1 : a.name.localeCompare(b.name),
  );
}

/** The notices file for `platforms` (one, or every one for the union). */
export function renderNotices(list, platforms) {
  const union = platforms.length > 1;
  const lines = [
    '# Third-party notices',
    '',
    union
      ? '`wrtc.node`, the native addon in the `@kdh.codes/webrtc-<os>-<arch>` packages,'
      : `\`wrtc.node\`, the native addon in \`@kdh.codes/webrtc-${platforms[0]}\`,`,
    'statically links libwebrtc and the third-party code below. The package’s own',
    'licence is in `LICENSE`.',
    '',
    union
      ? `This is the union for ${platforms.join(', ')}; each platform package carries its own list.`
      : `Platform: ${platforms[0]}.`,
    'Generated by `scripts/third-party-notices.mjs`; do not edit.',
    '',
    'Components:',
    '',
    ...list.map((s) => `- ${s.name}${union ? ` (${[...s.platforms].sort().join(', ')})` : ''}`),
    '',
  ];
  for (const s of list) {
    lines.push(`## ${s.name}`, '');
    if (NOTES[s.name]) lines.push(NOTES[s.name], '');
    for (const { text, paths } of s.texts) {
      if (s.texts.length > 1) {
        lines.push(
          `For ${[...paths]
            .sort()
            .map((p) => `\`${p}\``)
            .join(', ')}:`,
          '',
        );
      }
      lines.push('```', text, '```', '');
    }
  }
  return lines.join('\n');
}

function licenceFromCheckout(checkout, component) {
  const path = join(checkout, component);
  if (statSync(path).isFile()) return headerLicence(readFileSync(path, 'latin1'));
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE.TXT', 'COPYING']) {
    if (existsSync(join(path, name))) return readFileSync(join(path, name), 'utf8').trim();
  }
  return null;
}

function generate(root, libwebrtcDir, checkout) {
  const require = createRequire(join(root, 'package.json'));
  const napi = readFileSync(
    join(dirname(require.resolve('node-addon-api/package.json')), 'LICENSE.md'),
    'utf8',
  ).trim();
  const all = [];
  const platforms = [];
  for (const file of readdirSync(join(root, 'notices')).sort()) {
    if (!file.endsWith('.components')) continue;
    const platform = file.slice(0, -'.components'.length);
    const triple = TRIPLES[platform];
    if (!triple) throw new Error(`notices/${file}: unknown platform ${platform}`);
    const licenses = parseLicenses(readFileSync(join(libwebrtcDir, triple, 'LICENSE.md'), 'utf8'));
    const entries = [
      { name: 'webrtc', text: licenses.get('webrtc'), path: '.', platform },
      { name: 'node-addon-api', text: napi, path: 'node-addon-api', platform },
    ];
    const missing = [];
    for (const component of readFileSync(join(root, 'notices', file), 'utf8').split('\n')) {
      if (!component.trim() || component.startsWith('#')) continue;
      const name = componentName(component);
      const text = licenses.get(name) ?? licenceFromCheckout(checkout, component);
      if (text) entries.push({ name, text, path: component, platform });
      else missing.push(component);
    }
    if (missing.length) throw new Error(`${platform}: no licence text for ${missing.join(', ')}`);
    writeFileSync(
      join(root, 'notices', `${platform}.md`),
      renderNotices(sections(entries), [platform]),
    );
    all.push(...entries);
    platforms.push(platform);
    console.log(`notices/${platform}.md: ${sections(entries).length} components`);
  }
  writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), renderNotices(sections(all), platforms));
  console.log(
    `THIRD_PARTY_NOTICES.md: ${sections(all).length} components (${platforms.join(', ')})`,
  );
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (command === 'components' && args.length === 2) {
    process.stdout.write(`${components(resolve(args[0]), resolve(args[1])).join('\n')}\n`);
  } else if (command === 'generate') {
    const opt = (name, fallback) => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : fallback;
    };
    generate(
      root,
      resolve(opt('--libwebrtc-dir', join(root, 'third_party/libwebrtc-upstream'))),
      resolve(opt('--checkout', join(homedir(), 'src/webrtc-m150/src'))),
    );
  } else {
    console.error(
      'usage: node scripts/third-party-notices.mjs components <out dir> <libwebrtc.a>\n' +
        '       node scripts/third-party-notices.mjs generate [--libwebrtc-dir D] [--checkout SRC]',
    );
    process.exit(2);
  }
}

if (import.meta.main) main();
