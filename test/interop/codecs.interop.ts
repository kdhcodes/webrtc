// Video codecs negotiated with Chromium through setCodecPreferences on our
// side, each way, and simulcast sent from our side. No H264: we never offer
// it (test/integration/h264.test.ts).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { RTCRtpReceiver, RTCRtpSender, type RTCTrackEvent } from '../../lib/index.ts';
import {
  call,
  chromeSees,
  connect,
  fromCanvas,
  launch,
  next,
  nodeMedia,
  see,
  summary,
} from './chrome.ts';

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(() => browser?.close());

for (const codec of ['VP8', 'VP9', 'AV1']) {
  const mimeType = `video/${codec}`;

  test(`${codec}: Chrome decodes what we send`, async (t) => {
    const ours = RTCRtpSender.getCapabilities('video')?.codecs.filter(
      (c) => c.mimeType === mimeType,
    );
    assert.ok(ours?.length, `we cannot encode ${codec}`);
    const c = await call(t, browser);
    if (!(await c.chrome.call<string[]>('videoCodecs')).includes(mimeType)) {
      return t.skip(`this Chromium cannot decode ${codec}`);
    }
    const m = nodeMedia(t, { luma: 200 });
    c.pc.addTransceiver(m.video, { direction: 'sendonly' }).setCodecPreferences(ours);
    await connect(c, c.nodeOffers);

    const chrome = await chromeSees(c.chrome, 320, 240, 200);
    t.diagnostic(`Chrome video: ${summary(chrome)}`);
    assert.equal(chrome.codec, mimeType);
    await c.checkCandidates();
  });

  test(`${codec}: we decode what Chrome sends`, async (t) => {
    const ours = RTCRtpReceiver.getCapabilities('video')?.codecs.filter(
      (c) => c.mimeType === mimeType,
    );
    assert.ok(ours?.length, `we cannot decode ${codec}`);
    const c = await call(t, browser);
    const transceiver = c.pc.addTransceiver('video', { direction: 'recvonly' });
    transceiver.setCodecPreferences(ours);
    await c.chrome.call('addCanvas', 320, 240, 64);
    const tracked = next<RTCTrackEvent>(c.pc, 'track');
    await connect(c, c.nodeOffers);

    const seen = await see(t, (await tracked).track, 320, 240);
    const stats = await c.pc.getStats();
    const inbound = [...stats.values()].find((s) => s.type === 'inbound-rtp');
    const decoded = stats.get(inbound?.codecId)?.mimeType;
    t.diagnostic(`we decoded ${decoded}: ${JSON.stringify(seen)}`);
    assert.equal(decoded, mimeType);
    assert.ok(fromCanvas(seen.luma, 64), `saw luma ${seen.luma}`);
    await c.checkCandidates();
  });
}

// Peer to peer, Chrome doesn't receive simulcast on one m-line. WPT's
// simulcast tests (webrtc/simulcast/simulcast.js) get around that by
// munging: the sender's one simulcast m-line becomes one m-line per rid for
// the receiver, with the rid header extension relabelled as the mid one, so
// each layer demuxes to its own m-line (mid = rid); the receiver's answer is
// folded back into one m-line that receives the rids. RTX is dropped, as
// repaired-rid can't be reinterpreted.
const RID_EXT = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';
const RRID_EXT = 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id';
const MID_EXT = 'urn:ietf:params:rtp-hdrext:sdes:mid';

/** Splits SDP into its session part and media sections, as lines. */
function sections(sdp: string): [string[], ...string[][]] {
  const [session, ...media] = sdp.trim().split(/\r\n(?=m=)/);
  return [session?.split('\r\n') ?? [], ...media.map((m) => m.split('\r\n'))];
}

const join = (lines: string[]) => `${lines.join('\r\n')}\r\n`;
const bundle = (session: string[], mids: string[]) =>
  session.map((l) => (l.startsWith('a=group:BUNDLE') ? `a=group:BUNDLE ${mids.join(' ')}` : l));
// Candidates are trickled separately, with their mids translated.
const isCandidate = (line: string) => /^a=(candidate|end-of-candidates)/.test(line);

/** Our offer with one simulcast m-line -> one m-line per rid, for Chrome. */
function simulcastOfferToMids(sdp: string, rids: string[]): string {
  const [session, video] = sections(sdp);
  assert.ok(video, 'the offer has a video section');
  const rtx = video.flatMap((l) => /^a=rtpmap:(\d+) rtx\//.exec(l)?.[1] ?? []);
  const isRtx = (line: string) =>
    rtx.some((pt) => new RegExp(`^a=(rtpmap|fmtp|rtcp-fb):${pt} `).test(line));
  const base = video
    .filter(
      (l) =>
        !isCandidate(l) &&
        !isRtx(l) &&
        !/^a=(rid|simulcast|mid|msid|ssrc|ssrc-group):/.test(l) &&
        !l.endsWith(` ${MID_EXT}`) &&
        !l.endsWith(` ${RRID_EXT}`),
    )
    .map((l) =>
      l.startsWith('m=')
        ? l
            .split(' ')
            .filter((f) => !rtx.includes(f))
            .join(' ')
        : l,
    )
    .map((l) => l.replace(` ${RID_EXT}`, ` ${MID_EXT}`));
  return (
    join(bundle(session, rids)) +
    rids.map((rid) => join([...base, `a=mid:${rid}`, `a=msid:simulcast ${rid}`])).join('')
  );
}

/** Chrome's answer with one m-line per rid -> one m-line receiving the rids, for us. */
function midsAnswerToSimulcast(sdp: string, mid: string, rids: string[]): string {
  const [session, first] = sections(sdp);
  assert.ok(first, 'the answer has a media section');
  const media = first
    .filter((l) => !isCandidate(l))
    .map((l) =>
      l.startsWith('a=mid:') ? `a=mid:${mid}` : l.replace(` ${MID_EXT}`, ` ${RID_EXT}`),
    );
  return join([
    ...bundle(session, [mid]),
    ...media,
    ...rids.map((rid) => `a=rid:${rid} recv`),
    `a=simulcast:recv ${rids.join(';')}`,
  ]);
}

test('simulcast from our side: Chrome receives and decodes all three layers', async (t) => {
  const c = await call(t, browser);
  // 1280x720, not 640x360: libwebrtc caps the number of simulcast layers by
  // input size, and at 640x360 never encodes a third one.
  const m = nodeMedia(t, { width: 1280, height: 720, luma: 200 });
  const layers = [
    { rid: 'q', scaleResolutionDownBy: 4, width: 320, height: 180 },
    { rid: 'h', scaleResolutionDownBy: 2, width: 640, height: 360 },
    { rid: 'f', scaleResolutionDownBy: 1, width: 1280, height: 720 },
  ];
  const rids = layers.map((l) => l.rid);
  const { sender } = c.pc.addTransceiver(m.video, {
    direction: 'sendonly',
    sendEncodings: layers.map(({ rid, scaleResolutionDownBy }) => ({ rid, scaleResolutionDownBy })),
  });
  // Our one m-line has mid 0; Chrome's first (bundle) m-line is q.
  c.mids.toChrome = () => 'q';
  c.mids.toNode = () => '0';
  await connect(c, () =>
    c.nodeOffers({
      offer: (sdp) => simulcastOfferToMids(sdp, rids),
      answer: (sdp) => midsAnswerToSimulcast(sdp, '0', rids),
    }),
  );
  assert.match(c.pc.currentRemoteDescription?.sdp ?? '', /^a=simulcast:recv q;h;f\r?$/m);
  assert.deepEqual(
    sender.getParameters().encodings.map((e) => e.rid),
    rids,
    'the answer kept all three encodings',
  );

  // Each layer on its own m-line in Chrome, decoded at its own size.
  const decoded = await Promise.all(
    layers.map((l) => chromeSees(c.chrome, l.width, l.height, 200, (s) => s.mid === l.rid)),
  );
  for (const [i, s] of decoded.entries()) {
    t.diagnostic(`Chrome, ${layers[i]?.rid}: ${summary(s)}`);
  }
  const outbound = [...(await c.pc.getStats()).values()]
    .filter((s) => s.type === 'outbound-rtp')
    .sort((a, b) => a.encodingIndex - b.encodingIndex);
  assert.deepEqual(
    outbound.map((s) => [s.rid, s.frameWidth, s.frameHeight, s.framesEncoded > 0]),
    layers.map((l) => [l.rid, l.width, l.height, true]),
  );
  assert.equal(new Set(outbound.map((s) => s.ssrc)).size, 3, 'one SSRC per layer');
  await c.checkCandidates();
});

test('simulcast offered as is: Chrome declines it, so we send only the first layer (spec)', async (t) => {
  const c = await call(t, browser);
  const m = nodeMedia(t, { width: 640, height: 360, luma: 200 });
  const { sender } = c.pc.addTransceiver(m.video, {
    direction: 'sendonly',
    sendEncodings: [
      { rid: 'q', scaleResolutionDownBy: 4 },
      { rid: 'h', scaleResolutionDownBy: 2 },
      { rid: 'f' },
    ],
  });
  await connect(c, c.nodeOffers);
  assert.match(c.pc.currentLocalDescription?.sdp ?? '', /^a=simulcast:send q;h;f\r?$/m);
  // Unmunged, Chrome's answer has no a=simulcast, so only the first
  // encoding remains.
  assert.doesNotMatch(c.pc.currentRemoteDescription?.sdp ?? '', /^a=simulcast/m);
  assert.deepEqual(
    sender.getParameters().encodings.map((e) => [e.rid, e.scaleResolutionDownBy]),
    [['q', 4]],
  );
  const chrome = await chromeSees(c.chrome, 160, 90, 200);
  t.diagnostic(`Chrome video: ${summary(chrome)}`);
  await c.checkCandidates();
});
