// No H264 or H265, on any platform (user decision, 2026-11-22: VP8, VP9 and
// AV1 only). The codec factories in src/runtime.cc
// and src/video_encoder_factory.cc list no H264 or H265 adapter, so neither
// is in the capabilities, our offers or our answers, and our libwebrtc build
// sets rtc_use_h264 = false.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RTCPeerConnection,
  RTCRtpReceiver,
  RTCRtpSender,
  type RTCRtpTransceiverDirection,
} from '../../lib/index.ts';
import { connect, media, negotiate, pair } from './harness.ts';

const excluded = /^(H264|H265)$/i;

/** The distinct mime types of a kind's capabilities, in libwebrtc's order. */
function mimeTypes(caps: { codecs: { mimeType: string }[] } | null): string[] {
  return [...new Set((caps ?? assert.fail('no capabilities')).codecs.map((c) => c.mimeType))];
}

/** The codec names in an SDP's rtpmap lines. */
function rtpmapCodecs(sdp: string | undefined): string[] {
  return [...(sdp ?? '').matchAll(/^a=rtpmap:\d+ ([^/]+)\//gm)].map((m) => m[1] ?? '');
}

/** The H264 and H265 codec names in an SDP's rtpmap lines. */
const excludedIn = (sdp: string | undefined) => rtpmapCodecs(sdp).filter((c) => excluded.test(c));

/** The codec an answer's (only) video m-line settles on: its first payload type. */
function negotiated(sdp: string | undefined): string | undefined {
  const pt = /^m=video \d+ \S+ (\d+)/m.exec(sdp ?? '')?.[1];
  return new RegExp(`^a=rtpmap:${pt} ([^/]+)/`, 'm').exec(sdp ?? '')?.[1];
}

// A payload type none of our offers use (libwebrtc assigns from 96 and from 35).
const H264_PT = '125';

/**
 * Turns the (only) video m-line of one of our offers into a remote's that
 * lists H264 first, with Chrome's usual fmtp; with `only`, H264 is all it
 * lists.
 */
function preferH264(sdp: string, only = false): string {
  assert.doesNotMatch(sdp, new RegExp(`^a=rtpmap:${H264_PT} `, 'm'), 'payload type in use');
  const [head, video] = sdp.split(/(?=^m=video )/m);
  assert.ok(head !== undefined && video !== undefined, `no video m-line in\n${sdp}`);
  const h264 = [
    `a=rtpmap:${H264_PT} H264/90000`,
    `a=fmtp:${H264_PT} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f`,
  ];
  const lines = video.split('\r\n').flatMap((line) => {
    const m = /^m=video (\d+) (\S+) (.*)$/.exec(line);
    if (m) return [`m=video ${m[1]} ${m[2]} ${only ? H264_PT : `${H264_PT} ${m[3]}`}`];
    // The rtpmaps come after the attributes the m-line's codecs don't depend on.
    if (line.startsWith('a=rtpmap:')) {
      const added = h264.splice(0);
      return only ? added : [...added, line];
    }
    if (only && /^a=(?:fmtp|rtcp-fb):\d+ /.test(line)) return [];
    return [line];
  });
  return head + lines.join('\r\n');
}

test('video capabilities are VP8, VP9 and AV1 (plus RTX and FEC), with no H264 or H265', () => {
  assert.deepEqual(mimeTypes(RTCRtpSender.getCapabilities('video')), [
    'video/VP8',
    'video/rtx',
    'video/VP9',
    'video/AV1',
    'video/red',
    'video/ulpfec',
  ]);
  assert.deepEqual(mimeTypes(RTCRtpReceiver.getCapabilities('video')), [
    'video/VP8',
    'video/rtx',
    'video/VP9',
    'video/AV1',
    'video/red',
    'video/ulpfec',
    'video/flexfec-03',
  ]);
});

test('no offer lists H264 or H265, in any direction', async (t) => {
  for (const direction of ['sendrecv', 'sendonly', 'recvonly'] as RTCRtpTransceiverDirection[]) {
    const pc = new RTCPeerConnection();
    t.after(() => pc.close());
    pc.addTransceiver('video', { direction });
    const { sdp } = await pc.createOffer();
    const codecs = rtpmapCodecs(sdp);
    assert.ok(codecs.includes('VP8'), `${direction} offers ${codecs.join(' ')}`);
    assert.deepEqual(excludedIn(sdp), [], `${direction} offers ${codecs.join(' ')}`);
  }
});

test('setCodecPreferences rejects an H264 codec', (t) => {
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  const transceiver = pc.addTransceiver('video');
  assert.throws(
    () =>
      transceiver.setCodecPreferences([
        {
          mimeType: 'video/H264',
          clockRate: 90000,
          sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
        },
      ]),
    { name: 'InvalidModificationError' },
  );
});

test('a remote offer preferring H264 is answered with VP8', async (t) => {
  const { a, b } = pair(t);
  a.addTransceiver(media(t).video, { direction: 'sendrecv' });
  const offer = await a.createOffer();
  await b.setRemoteDescription({ type: 'offer', sdp: preferH264(offer.sdp ?? '') });
  const answer = await b.createAnswer();
  assert.equal(negotiated(answer.sdp), 'VP8');
  assert.deepEqual(excludedIn(answer.sdp), [], `answer:\n${answer.sdp}`);
});

test('a remote offer with only H264 gets its video m-line rejected', async (t) => {
  const { a, b } = pair(t);
  a.addTransceiver('video', { direction: 'sendrecv' });
  const offer = await a.createOffer();
  await b.setRemoteDescription({ type: 'offer', sdp: preferH264(offer.sdp ?? '', true) });
  const answer = await b.createAnswer();
  assert.match(answer.sdp ?? '', /^m=video 0 /m, `answer:\n${answer.sdp}`);
  assert.deepEqual(excludedIn(answer.sdp), [], `answer:\n${answer.sdp}`);
});

test('a video transceiver can go sendrecv → sendonly → sendrecv and renegotiate each time', async (t) => {
  // Regression: when H264 could be sent but not decoded (the macOS prebuilt),
  // the sendonly round negotiated H264 and the next sendrecv offer failed SLD
  // ("Failed to set local video description recv parameters"). With send and
  // receive offering the same video codecs, that can't recur.
  const p = pair(t);
  const transceiver = p.a.addTransceiver(media(t).video, { direction: 'sendrecv' });
  await connect(p);
  // The answerer sends too, so a's sendrecv is negotiated as sendrecv.
  const [remote] = p.b.getTransceivers();
  assert.ok(remote);
  remote.direction = 'sendrecv';
  await remote.sender.replaceTrack(media(t).video);
  await negotiate(p.b, p.a);
  for (const direction of ['sendonly', 'sendrecv', 'sendonly', 'sendrecv'] as const) {
    transceiver.direction = direction;
    await negotiate(p.a, p.b);
    assert.equal(transceiver.currentDirection, direction);
  }
  assert.deepEqual(p.iceErrors, []);
});
