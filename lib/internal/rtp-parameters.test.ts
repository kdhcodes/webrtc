import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RTCRtpCapabilities } from './generated/idl.ts';
import { negotiatedCodecs, presentEncodings, unpresentEncodings } from './rtp-parameters.ts';

const sdp = (lines: string[]) => `${lines.join('\r\n')}\r\n`;

const video: RTCRtpCapabilities = {
  codecs: [
    { mimeType: 'video/VP8', clockRate: 90000 },
    { mimeType: 'video/rtx', clockRate: 90000 },
    { mimeType: 'video/red', clockRate: 90000 },
  ],
  headerExtensions: [],
};

const audio: RTCRtpCapabilities = {
  codecs: [
    { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { mimeType: 'audio/PCMU', clockRate: 8000, channels: 1 },
    { mimeType: 'audio/telephone-event', clockRate: 8000, channels: 1 },
  ],
  headerExtensions: [],
};

test('negotiatedCodecs leaves out codecs libwebrtc lacks and the RTX for them', () => {
  const description = sdp([
    'v=0',
    'm=video 9 UDP/TLS/RTP/SAVPF 116 117 119 123 121',
    'a=mid:0',
    'a=rtpmap:116 flarglblurp/90000',
    'a=rtpmap:117 rtx/90000',
    'a=fmtp:117 apt=116',
    'a=rtpmap:119 vp8/90000',
    'a=fmtp:119 max-fs=12266;max-fr=40',
    'a=rtpmap:123 rtx/90000',
    'a=fmtp:123 apt=119',
    'a=rtpmap:121 red/90000',
  ]);
  assert.deepEqual(negotiatedCodecs(description, '0', 'video', 'sender', video), [
    // The capability's spelling of the mime type; the SDP's fmtp verbatim.
    {
      payloadType: 119,
      mimeType: 'video/VP8',
      clockRate: 90000,
      sdpFmtpLine: 'max-fs=12266;max-fr=40',
    },
    { payloadType: 123, mimeType: 'video/rtx', clockRate: 90000, sdpFmtpLine: 'apt=119' },
    { payloadType: 121, mimeType: 'video/red', clockRate: 90000 },
  ]);
});

test('negotiatedCodecs gives audio codecs a channel count, 1 when the SDP has none', () => {
  const description = sdp([
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 0 101',
    'a=mid:a',
    'a=rtpmap:111 opus/48000/2',
    'a=rtpmap:101 telephone-event/8000',
  ]);
  assert.deepEqual(negotiatedCodecs(description, 'a', 'audio', 'receiver', audio), [
    { payloadType: 111, mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { payloadType: 0, mimeType: 'audio/PCMU', clockRate: 8000, channels: 1 },
    { payloadType: 101, mimeType: 'audio/telephone-event', clockRate: 8000, channels: 1 },
  ]);
});

test('negotiatedCodecs is empty without a description, a mid or a matching section', () => {
  const description = sdp(['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 0', 'a=mid:a']);
  assert.deepEqual(negotiatedCodecs(null, 'a', 'audio', 'sender', audio), []);
  assert.deepEqual(negotiatedCodecs(description, null, 'audio', 'sender', audio), []);
  assert.deepEqual(negotiatedCodecs(description, 'b', 'audio', 'sender', audio), []);
  assert.deepEqual(negotiatedCodecs(description, 'a', 'audio', 'sender', null), []);
});

test('presentEncodings removes the video-only members from audio encodings', () => {
  const { encodings, synthesized } = presentEncodings(
    [{ active: true, scaleResolutionDownBy: 2, maxFramerate: 10 }],
    'audio',
    [],
  );
  assert.deepEqual(encodings, [{ active: true }]);
  assert.equal(synthesized, false);
});

test("presentEncodings shows libwebrtc's default scales, over the layers the sender was created with", () => {
  const three = [{ rid: 'l' }, { rid: 'm' }, { rid: 'h' }];
  assert.deepEqual(presentEncodings(three, 'video', ['l', 'm', 'h']), {
    encodings: [
      { rid: 'l', scaleResolutionDownBy: 4 },
      { rid: 'm', scaleResolutionDownBy: 2 },
      { rid: 'h', scaleResolutionDownBy: 1 },
    ],
    synthesized: true,
  });
  // A remote description removed 'h': 'm' keeps its scale.
  assert.deepEqual(presentEncodings([{ rid: 'm' }], 'video', ['l', 'm', 'h']).encodings, [
    { rid: 'm', scaleResolutionDownBy: 2 },
  ]);
  // Without rids (or an envelope), the index decides.
  assert.deepEqual(presentEncodings([{}, {}], 'video', []).encodings, [
    { scaleResolutionDownBy: 2 },
    { scaleResolutionDownBy: 1 },
  ]);
  assert.deepEqual(presentEncodings([{ active: true }], 'video', []).encodings, [
    { active: true, scaleResolutionDownBy: 1 },
  ]);
});

test('presentEncodings shows 1 for an encoding without a scale when another has one', () => {
  assert.deepEqual(
    presentEncodings([{ rid: 'a' }, { rid: 'b', scaleResolutionDownBy: 3 }], 'video', ['a', 'b']),
    {
      encodings: [
        { rid: 'a', scaleResolutionDownBy: 1 },
        { rid: 'b', scaleResolutionDownBy: 3 },
      ],
      synthesized: false,
    },
  );
});

test('unpresentEncodings drops default scales passed back unchanged, and keeps any change whole', () => {
  const shown = [
    { rid: 'a', scaleResolutionDownBy: 2 },
    { rid: 'b', scaleResolutionDownBy: 1 },
  ];
  assert.deepEqual(
    unpresentEncodings(
      [
        { rid: 'a', scaleResolutionDownBy: 2, active: false },
        { rid: 'b', scaleResolutionDownBy: 1 },
      ],
      shown,
      true,
    ),
    [{ rid: 'a', active: false }, { rid: 'b' }],
  );
  // Changing one scale sends the other default explicitly too: libwebrtc
  // would otherwise treat the unset one as 1.
  const changed = [
    { rid: 'a', scaleResolutionDownBy: 2 },
    { rid: 'b', scaleResolutionDownBy: 1.5 },
  ];
  assert.deepEqual(unpresentEncodings(changed, shown, true), changed);
  // Scales the caller (or libwebrtc) set are never dropped.
  assert.deepEqual(unpresentEncodings(shown, shown, false), shown);
});

test('negotiatedCodecs results are fresh objects, and a changed description is parsed again', () => {
  const description = sdp([
    'v=0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=mid:0',
    'a=rtpmap:96 VP8/90000',
  ]);
  const first = negotiatedCodecs(description, '0', 'video', 'sender', video);
  (first[0] as { payloadType: number }).payloadType = 1;
  assert.equal(negotiatedCodecs(description, '0', 'video', 'sender', video)[0]?.payloadType, 96);
  const changed = description.replace(/96/g, '100');
  assert.equal(negotiatedCodecs(changed, '0', 'video', 'sender', video)[0]?.payloadType, 100);
});
