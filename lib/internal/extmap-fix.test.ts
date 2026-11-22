import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixBundledExtmapCollisions, isExtmapCollision } from './extmap-fix.ts';

const sdp = (...lines: string[]) => `${lines.join('\r\n')}\r\n`;
const TOFFSET = 'urn:ietf:params:rtp-hdrext:toffset';
const AUDIO_LEVEL = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level';
const ABS_SEND_TIME = 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time';
const ORIENTATION = 'urn:3gpp:video-orientation';

const section = (kind: string, mid: string, ...extmaps: [number, string][]) => [
  `m=${kind} 9 UDP/TLS/RTP/SAVPF 96`,
  `a=mid:${mid}`,
  ...extmaps.map(([id, uri]) => `a=extmap:${id} ${uri}`),
];
/** What the remote offer bundled, as the polite peer answered it. */
const VIDEO = section('video', '0', [1, TOFFSET], [2, ABS_SEND_TIME], [3, ORIENTATION]);
/** The rolled-back transceiver, with the ids of its rolled-back offer. */
const AUDIO = section('audio', '1', [1, AUDIO_LEVEL], [2, ABS_SEND_TIME]);

/** The a=extmap lines of the section with `mid`. */
function extmaps(text: string, mid: string): string[] {
  const block = text.split(/\r?\n(?=m=)/).find((s) => s.includes(`a=mid:${mid}`)) ?? '';
  return block.split(/\r?\n/).filter((l) => l.startsWith('a=extmap:'));
}

test('a colliding id in a new section moves to the highest free one-byte id', () => {
  const offer = sdp('v=0', 'a=group:BUNDLE 0 1', ...VIDEO, ...AUDIO);
  assert.equal(
    fixBundledExtmapCollisions(offer, new Set(['0'])),
    offer.replace(`a=extmap:1 ${AUDIO_LEVEL}`, `a=extmap:14 ${AUDIO_LEVEL}`),
  );
});

test('established sections keep their ids even when listed after the new one', () => {
  const offer = sdp('v=0', 'a=group:BUNDLE 1 0', ...AUDIO, ...VIDEO);
  const fixed = fixBundledExtmapCollisions(offer, new Set(['0']));
  assert.deepEqual(extmaps(fixed, '0'), extmaps(offer, '0'));
  assert.deepEqual(extmaps(fixed, '1'), [
    `a=extmap:14 ${AUDIO_LEVEL}`,
    `a=extmap:2 ${ABS_SEND_TIME}`,
  ]);
});

test('a colliding extension takes the id the group already uses for it', () => {
  const audio = section('audio', '1', [1, AUDIO_LEVEL], [3, ABS_SEND_TIME]);
  const offer = sdp('v=0', 'a=group:BUNDLE 0 1', ...VIDEO, ...audio);
  assert.deepEqual(extmaps(fixBundledExtmapCollisions(offer, new Set(['0'])), '1'), [
    `a=extmap:14 ${AUDIO_LEVEL}`,
    `a=extmap:2 ${ABS_SEND_TIME}`,
  ]);
});

test("an extension takes the group's id even when the section has another extension there, which moves", () => {
  // abs-send-time is 2 in the group, and this section has audio-level at 2.
  // abs-send-time must not get a second id in the group (RFC 8843).
  const audio = section('audio', '1', [3, ABS_SEND_TIME], [2, AUDIO_LEVEL]);
  const offer = sdp('v=0', 'a=group:BUNDLE 0 1', ...VIDEO, ...audio);
  assert.deepEqual(extmaps(fixBundledExtmapCollisions(offer, new Set(['0'])), '1'), [
    `a=extmap:2 ${ABS_SEND_TIME}`,
    `a=extmap:14 ${AUDIO_LEVEL}`,
  ]);
});

test('in a colliding section, an extension the group has at another id takes that id', () => {
  // abs-send-time at 4 doesn't collide, but the group has it at 2.
  const audio = section('audio', '1', [1, AUDIO_LEVEL], [4, ABS_SEND_TIME]);
  const offer = sdp('v=0', 'a=group:BUNDLE 0 1', ...VIDEO, ...audio);
  assert.deepEqual(extmaps(fixBundledExtmapCollisions(offer, new Set(['0'])), '1'), [
    `a=extmap:14 ${AUDIO_LEVEL}`,
    `a=extmap:2 ${ABS_SEND_TIME}`,
  ]);
});

test('a free id is free in the whole offer, not just in the group', () => {
  const offer = sdp(
    'v=0',
    'a=group:BUNDLE 0 1',
    'a=group:BUNDLE 2',
    ...VIDEO,
    ...AUDIO,
    ...section('audio', '2', [14, AUDIO_LEVEL]),
  );
  assert.deepEqual(extmaps(fixBundledExtmapCollisions(offer, new Set(['0'])), '1'), [
    `a=extmap:13 ${AUDIO_LEVEL}`,
    `a=extmap:2 ${ABS_SEND_TIME}`,
  ]);
});

test('each BUNDLE group is checked on its own', () => {
  // The same ids in two groups don't collide; within each group they do.
  const offer = sdp(
    'v=0',
    'a=group:BUNDLE 0 1',
    'a=group:BUNDLE 2 3',
    ...VIDEO,
    ...AUDIO,
    ...section('video', '2', [1, TOFFSET]),
    ...section('audio', '3', [1, AUDIO_LEVEL]),
  );
  const fixed = fixBundledExtmapCollisions(offer, new Set(['0', '2']));
  assert.deepEqual(extmaps(fixed, '1'), [
    `a=extmap:14 ${AUDIO_LEVEL}`,
    `a=extmap:2 ${ABS_SEND_TIME}`,
  ]);
  assert.deepEqual(extmaps(fixed, '2'), [`a=extmap:1 ${TOFFSET}`]);
  // The group's own id for audio-level is taken by toffset, so a free one.
  assert.deepEqual(extmaps(fixed, '3'), [`a=extmap:13 ${AUDIO_LEVEL}`]);
});

test('encrypted and plain forms of a URI are different extensions; direction suffixes stay', () => {
  const audio = [
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:1',
    `a=extmap:1/sendonly urn:ietf:params:rtp-hdrext:encrypt ${TOFFSET}`,
  ];
  const offer = sdp('v=0', 'a=group:BUNDLE 0 1', ...VIDEO, ...audio);
  assert.deepEqual(extmaps(fixBundledExtmapCollisions(offer, new Set(['0'])), '1'), [
    `a=extmap:14/sendonly urn:ietf:params:rtp-hdrext:encrypt ${TOFFSET}`,
  ]);
});

test('with every one-byte id taken, a=extmap-allow-mixed allows a two-byte id', () => {
  const full = section(
    'video',
    '0',
    ...Array.from({ length: 14 }, (_, i): [number, string] => [i + 1, `urn:x:${i + 1}`]),
  );
  const offer = (...session: string[]) =>
    sdp('v=0', ...session, 'a=group:BUNDLE 0 1', ...full, ...AUDIO);
  assert.deepEqual(
    extmaps(fixBundledExtmapCollisions(offer('a=extmap-allow-mixed'), new Set(['0'])), '1'),
    [`a=extmap:16 ${AUDIO_LEVEL}`, `a=extmap:17 ${ABS_SEND_TIME}`],
  );
  // Without it there's no id to move to: the offer is left for libwebrtc to reject.
  assert.equal(fixBundledExtmapCollisions(offer(), new Set(['0'])), offer());
});

test('LF-only descriptions keep their line endings', () => {
  const offer = `${['v=0', 'a=group:BUNDLE 0 1', ...VIDEO, ...AUDIO].join('\n')}\n`;
  const fixed = fixBundledExtmapCollisions(offer, new Set(['0']));
  assert.equal(fixed, offer.replace(`a=extmap:1 ${AUDIO_LEVEL}`, `a=extmap:14 ${AUDIO_LEVEL}`));
  assert.ok(!fixed.includes('\r'));
});

test('offers without a collision, and sections outside the group, are returned as is', () => {
  const unbundled = sdp('v=0', 'a=group:BUNDLE 0', ...VIDEO, ...AUDIO);
  assert.equal(fixBundledExtmapCollisions(unbundled, new Set()), unbundled);
  // The same extension under the same id in several sections is no collision.
  const shared = sdp(
    'v=0',
    'a=group:BUNDLE 0 1',
    ...VIDEO,
    ...section('audio', '1', [2, ABS_SEND_TIME], [4, AUDIO_LEVEL]),
  );
  assert.equal(fixBundledExtmapCollisions(shared, new Set(['0'])), shared);
  const none = sdp('v=0', 'a=group:BUNDLE 0 1', ...VIDEO, ...section('audio', '1'));
  assert.equal(fixBundledExtmapCollisions(none, new Set()), none);
});

test("isExtmapCollision matches only libwebrtc's BUNDLE header extension collision", () => {
  const error = (name: string, message: string) => Object.assign(new Error(message), { name });
  const message =
    'Failed to set local offer sdp: A BUNDLE group contains a codec collision for header ' +
    'extension id=1. The id must be the same across all bundled media descriptions';
  assert.equal(isExtmapCollision(error('InvalidAccessError', message)), true);
  assert.equal(
    isExtmapCollision(
      error('InvalidAccessError', 'A BUNDLE group contains a codec collision for payload_type=96'),
    ),
    false,
  );
  assert.equal(isExtmapCollision(error('OperationError', message)), false);
  assert.equal(isExtmapCollision({ name: 'InvalidAccessError', message }), false);
});
