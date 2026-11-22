import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendToSections,
  parseSdp,
  sctpSection,
  sectionCodecs,
  transportSections,
} from './sdp.ts';

const sdp = (lines: string[]) => `${lines.join('\r\n')}\r\n`;

test('sctpSection finds the first data channel m-section that is not rejected, with its max-message-size', () => {
  const audio = ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0', 'a=max-message-size:1'];
  const data = (port: number, mid: string, max?: number) => [
    `m=application ${port} UDP/DTLS/SCTP webrtc-datachannel`,
    `a=mid:${mid}`,
    ...(max === undefined ? [] : [`a=max-message-size:${max}`]),
  ];
  assert.equal(sctpSection(sdp(['v=0', ...audio])), null);
  assert.deepEqual(sctpSection(sdp(['v=0', ...audio, ...data(9, '1', 1000)])), {
    index: 1,
    maxMessageSize: 1000,
  });
  assert.deepEqual(sctpSection(sdp(['v=0', ...data(0, '0', 5), ...data(9, '1')])), {
    index: 1,
    maxMessageSize: null,
  });
  assert.deepEqual(sctpSection(sdp(['v=0', 'm=application 9 DTLS/SCTP 5000', 'a=mid:d'])), {
    index: 0,
    maxMessageSize: null,
  });
});

test('appendToSections adds a line at the end of the chosen m-sections, once, keeping CRLF', () => {
  const before = sdp(['v=0', 'm=audio 9 X 0', 'a=mid:0', 'm=video 9 X 96', 'a=mid:1']);
  const after = appendToSections(before, [1], 'a=end-of-candidates');
  assert.equal(
    after,
    sdp(['v=0', 'm=audio 9 X 0', 'a=mid:0', 'm=video 9 X 96', 'a=mid:1', 'a=end-of-candidates']),
  );
  assert.equal(appendToSections(after, [1], 'a=end-of-candidates'), after, 'already there');
  assert.equal(
    appendToSections(before, [0], 'a=end-of-candidates'),
    sdp(['v=0', 'm=audio 9 X 0', 'a=mid:0', 'a=end-of-candidates', 'm=video 9 X 96', 'a=mid:1']),
  );
});

test('reads mids, ufrags (inheriting the session one) and trickle', () => {
  const parsed = parseSdp(
    sdp([
      'v=0',
      'a=ice-ufrag:session',
      'a=ice-options:trickle',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=mid:a',
      'a=ice-ufrag:own',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:v',
    ]),
  );
  assert.deepEqual(parsed.sections, [
    { index: 0, mid: 'a', ufrag: 'own', rejected: false },
    { index: 1, mid: 'v', ufrag: 'session', rejected: false },
  ]);
  assert.equal(parsed.trickle, true);
  assert.equal(parseSdp('v=0\r\n').trickle, false);
});

test('one transport per BUNDLE group (its first mid) plus each unbundled live section', () => {
  const parsed = parseSdp(
    sdp([
      'v=0',
      'a=group:BUNDLE 1 0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=mid:0',
      'm=video 0 UDP/TLS/RTP/SAVPF 96',
      'a=mid:1',
      'a=bundle-only',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=mid:2',
      'm=audio 0 UDP/TLS/RTP/SAVPF 111',
      'a=mid:3',
    ]),
  );
  // mid 1 has port 0 but is bundled, so it isn't rejected; mid 3 is.
  assert.deepEqual(
    parsed.sections.map((s) => [s.mid, s.rejected]),
    [
      ['0', false],
      ['1', false],
      ['2', false],
      ['3', true],
    ],
  );
  assert.deepEqual(
    transportSections(parsed).map((s) => s.mid),
    ['1', '2'],
  );
});

test("sectionCodecs lists each mid's payload types in m-line order, with verbatim fmtp", () => {
  const description = sdp([
    'v=0',
    'a=rtpmap:96 session-level/1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 0 101',
    'a=mid:a',
    'a=rtpmap:101 telephone-event/8000',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 98 97 96',
    'a=rtpmap:96 VP8/90000',
    'a=rtpmap:97 rtx/90000',
    'a=fmtp:97 apt=96',
    'a=mid:v',
  ]);
  assert.deepEqual(sectionCodecs(description).get('a'), [
    {
      payloadType: 111,
      name: 'opus',
      clockRate: 48000,
      channels: 2,
      fmtp: 'minptime=10;useinbandfec=1',
    },
    // A static payload type without an rtpmap.
    { payloadType: 0, name: 'PCMU', clockRate: 8000 },
    { payloadType: 101, name: 'telephone-event', clockRate: 8000 },
  ]);
  // 98 has neither an rtpmap nor a static assignment; the mid may follow
  // the rtpmaps.
  assert.deepEqual(sectionCodecs(description).get('v'), [
    { payloadType: 97, name: 'rtx', clockRate: 90000, fmtp: 'apt=96' },
    { payloadType: 96, name: 'VP8', clockRate: 90000 },
  ]);
  assert.deepEqual([...sectionCodecs(description).keys()], ['a', 'v']);
});
