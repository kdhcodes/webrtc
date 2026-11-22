// Tests of the notices generator's pure parts: which licence a source path
// falls under, reading ninja's deps and libwebrtc's LICENSE.md, and merging
// platforms into one file without duplicate sections.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  componentName,
  componentOf,
  type Entry,
  headerLicence,
  parseDeps,
  parseLicenses,
  renderNotices,
  sections,
  unescapeHtml,
} from './third-party-notices.mjs';

test('componentOf picks the deepest third_party directory, so nested code counts on its own', () => {
  assert.equal(componentOf('third_party/libvpx/source/libvpx/vpx/vp8cx.h'), 'third_party/libvpx');
  assert.equal(
    componentOf('third_party/libaom/source/libaom/third_party/vector/vector.c'),
    'third_party/libaom/source/libaom/third_party/vector',
  );
  assert.equal(componentOf('modules/third_party/g711/g711.c'), 'modules/third_party/g711');
  assert.equal(
    componentOf('buildtools/third_party/libc++/__config_site'),
    'buildtools/third_party/libc++',
  );
});

test("componentOf maps generated files to their source, and skips libwebrtc's own and outside code", () => {
  assert.equal(componentOf('gen/third_party/perfetto/protos/a.pbzero.h'), 'third_party/perfetto');
  assert.equal(componentOf('pc/peer_connection.cc'), null);
  assert.equal(componentOf('../../Applications/Xcode.app/x/third_party/y/z.h'), null);
  // A file directly in third_party/ belongs to no component.
  assert.equal(componentOf('third_party/BUILD.gn'), null);
});

test('x86inc.asm is its own component wherever it sits', () => {
  const dav1d = 'third_party/dav1d/libdav1d/src/ext/x86/x86inc.asm';
  assert.equal(componentOf(dav1d), dav1d);
  assert.equal(componentName(dav1d), 'x86inc');
  const vpx = 'third_party/libvpx/source/libvpx/third_party/x86inc/x86inc.asm';
  assert.equal(componentOf(vpx), 'third_party/libvpx/source/libvpx/third_party/x86inc');
  assert.equal(componentName(componentOf(vpx) ?? ''), 'x86inc');
});

test('parseDeps keeps the objects that have deps, with their inputs', () => {
  const deps = parseDeps(
    [
      'obj/a/a.o: #deps 2, deps mtime 1 (VALID)',
      '    ../../a/a.cc',
      '    ../../third_party/x/x.h',
      '',
      'obj/b/b.o: deps not found',
      'obj/c/c.o: #deps 1, deps mtime 1 (STALE)',
      '    ../../c/c.cc',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    [...deps],
    [
      ['obj/a/a.o', ['../../a/a.cc', '../../third_party/x/x.h']],
      ['obj/c/c.o', ['../../c/c.cc']],
    ],
  );
});

test('unescapeHtml undoes the generator escaping in one pass', () => {
  assert.equal(unescapeHtml('&quot;AS IS&quot; &lt;x&gt; it&#x27;s'), '"AS IS" <x> it\'s');
  // An escaped ampersand stays the literal text it stood for.
  assert.equal(unescapeHtml('&amp;quot; &amp;amp;'), '&quot; &amp;');
});

test('parseLicenses maps each "# name" section to its unescaped text', () => {
  const md = ['# webrtc', '```', '&quot;AS IS&quot;', '```', '', '# libvpx', '```', 'WebM', '```'];
  assert.deepEqual(
    [...parseLicenses(md.join('\n'))],
    [
      ['webrtc', '"AS IS"'],
      ['libvpx', 'WebM'],
    ],
  );
  assert.throws(() => parseLicenses('no sections'), /no "# name"/);
});

test("headerLicence reads an asm file's leading comment block", () => {
  const asm = [
    ';*****',
    ';* x86inc.asm: x86 abstraction layer',
    ';*****',
    ';* Copyright (C) 2005-2024 x264 project',
    ';*',
    ';* Permission to use ...',
    ';*****',
    '',
    '%ifndef private_prefix',
  ].join('\n');
  assert.equal(
    headerLicence(asm),
    'x86inc.asm: x86 abstraction layer\n\nCopyright (C) 2005-2024 x264 project\n\nPermission to use ...',
  );
});

test('merging platforms gives one section per name, with each distinct text once', () => {
  const entries: Entry[] = [
    { name: 'webrtc', text: 'BSD', path: '.', platform: 'darwin-arm64' },
    { name: 'libc++abi', text: 'LLVM', path: 'third_party/libc++abi', platform: 'linux-arm64' },
    { name: 'webrtc', text: 'BSD', path: '.', platform: 'linux-arm64' },
    { name: 'libc++abi', text: 'LLVM', path: 'third_party/libc++abi', platform: 'linux-x64' },
    { name: 'x86inc', text: 'ISC 2024', path: 'dav1d/x86inc.asm', platform: 'linux-x64' },
    { name: 'x86inc', text: 'ISC 2012', path: 'libvpx/x86inc', platform: 'linux-x64' },
    { name: 'x86inc', text: 'ISC 2012', path: 'libaom/x86inc', platform: 'linux-x64' },
  ];
  const out = renderNotices(sections(entries), ['darwin-arm64', 'linux-arm64', 'linux-x64']);
  assert.equal(out.match(/^## libc\+\+abi$/gm)?.length, 1);
  assert.equal(out.match(/^```\nLLVM\n```$/gm)?.length, 1);
  assert.match(out, /^- webrtc \(darwin-arm64, linux-arm64\)$/m);
  assert.match(out, /^- libc\+\+abi \(linux-arm64, linux-x64\)$/m);
  // libwebrtc first, the rest by name.
  assert.deepEqual(out.match(/^## .+$/gm), ['## webrtc', '## libc++abi', '## x86inc']);
  assert.match(out, /^For `dav1d\/x86inc.asm`:\n\n```\nISC 2024\n```$/m);
  assert.match(out, /^For `libaom\/x86inc`, `libvpx\/x86inc`:\n\n```\nISC 2012\n```$/m);
});

test('a single platform file lists its components without platform tags', () => {
  const entries: Entry[] = [{ name: 'webrtc', text: 'BSD', path: '.', platform: 'linux-x64' }];
  const out = renderNotices(sections(entries), ['linux-x64']);
  assert.match(out, /`@kdh.codes\/webrtc-linux-x64`/);
  assert.match(out, /^- webrtc$/m);
});
