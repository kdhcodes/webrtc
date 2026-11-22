// Renegotiation with Chromium mid-call: a video track added by either side,
// removeTrack by either side, and perfect negotiation through glare.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import {
  MediaStream,
  type MediaStreamTrack,
  type MediaStreamTrackEvent,
  nonstandard,
  type RTCSessionDescriptionInit,
  type RTCTrackEvent,
} from '../../lib/index.ts';
import {
  type ChromeTransceiver,
  call,
  chromeHears,
  chromeSees,
  connect,
  fromCanvas,
  hear,
  launch,
  near,
  next,
  nodeMedia,
  type PageEvent,
  see,
  summary,
  until,
} from './chrome.ts';

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(() => browser?.close());

test('we add a video track mid-call and renegotiate; Chrome decodes it', async (t) => {
  const c = await call(t, browser);
  const m = nodeMedia(t, { luma: 200 });
  c.pc.addTrack(m.audio);
  await connect(c, c.nodeOffers);
  await chromeHears(c.chrome, 440);

  const needed = next(c.pc, 'negotiationneeded');
  const chromeTrack = next<PageEvent<{ kind: string; mid: string }>>(c.chrome, 'track');
  c.pc.addTrack(m.video);
  await needed;
  await c.nodeOffers();
  assert.deepEqual((await chromeTrack).detail.kind, 'video');
  const video = await chromeSees(c.chrome, 320, 240, 200);
  t.diagnostic(`Chrome video: ${summary(video)}`);
  assert.equal(video.mid, '1');
  // The audio is unaffected by the renegotiation.
  await chromeHears(c.chrome, 440);
  await c.checkCandidates();
});

test('Chrome adds a video track mid-call and renegotiates; we receive it', async (t) => {
  const c = await call(t, browser);
  const m = nodeMedia(t);
  c.pc.addTrack(m.audio);
  await c.chrome.call('addTone', 660);
  const tracks: RTCTrackEvent[] = [];
  c.pc.ontrack = (e) => tracks.push(e);
  await connect(c, c.nodeOffers);
  assert.deepEqual(
    tracks.map((e) => e.track.kind),
    ['audio'],
  );

  const tracked = next<RTCTrackEvent>(c.pc, 'track');
  await c.chrome.call('addCanvas', 320, 240, 200);
  await c.chromeOffers();
  const { track, transceiver } = await tracked;
  assert.equal(track.kind, 'video');
  assert.equal(transceiver.mid, '1');
  assert.equal(transceiver.currentDirection, 'recvonly');
  const seen = await see(t, track, 320, 240);
  t.diagnostic(`we saw ${JSON.stringify(seen)}`);
  assert.ok(fromCanvas(seen.luma, 200), `saw luma ${seen.luma}`);
  const heard = await hear(t, (tracks[0] as RTCTrackEvent).track);
  assert.ok(near(heard.frequency, 660, 20), `heard ${heard.frequency} Hz`);
  await c.checkCandidates();
});

test('removeTrack on either side, with renegotiation, ends that direction only', async (t) => {
  const c = await call(t, browser);
  const m = nodeMedia(t, { luma: 200 });
  const sent = new MediaStream();
  const audioSender = c.pc.addTrack(m.audio, sent);
  const videoSender = c.pc.addTrack(m.video, sent);
  await c.chrome.call('addTone', 660);
  await c.chrome.call('addCanvas', 320, 240, 64);
  const tracks: RTCTrackEvent[] = [];
  c.pc.ontrack = (e) => tracks.push(e);
  await connect(c, c.nodeOffers);
  const [audio, video] = tracks.map((e) => e.track) as [MediaStreamTrack, MediaStreamTrack];
  // A sink on Chrome's video from the start, as an app attaches one in
  // ontrack. Our removeTrack makes libwebrtc recreate this video's receive
  // stream, which under CPU load can race a packet in flight and null the
  // stream's sink; src/sink_reassert.cc restores it (PLAN.md "Gotchas").
  const attached = new nonstandard.RTCVideoSink(video);
  t.after(() => attached.stop());
  await Promise.all([next(attached, 'frame'), chromeSees(c.chrome, 320, 240, 200)]);
  const chromeVideo = (await c.chrome.transceivers())[1] as ChromeTransceiver;

  // We stop sending video: Chrome's remote video track leaves the stream
  // and is muted; Chrome still sends us video, and audio flows both ways.
  const chromeRemoved = next<PageEvent<{ trackId: string }>>(c.chrome, 'removetrack');
  c.pc.removeTrack(videoSender);
  await c.nodeOffers();
  assert.equal((await chromeRemoved).detail.trackId, chromeVideo.remoteTrack.id);
  const [, chromeVideoAfter] = await until(
    () => c.chrome.transceivers(),
    (trs) => trs[1]?.remoteTrack.muted === true,
    'Chrome to mute its remote video track',
  );
  assert.equal(chromeVideoAfter?.currentDirection, 'sendonly');
  assert.equal(c.pc.getTransceivers()[1]?.currentDirection, 'recvonly');
  await Promise.all([see(t, video, 320, 240), chromeHears(c.chrome, 440)]);

  // Chrome stops sending video: our remote video track leaves its stream
  // (Chrome's canvas has a stream of its own).
  const stream = (tracks[1] as RTCTrackEvent).streams[0] as MediaStream;
  const removed = next<MediaStreamTrackEvent>(stream, 'removetrack');
  await c.chrome.call('removeTrack', 'video');
  await c.chromeOffers();
  assert.equal((await removed).track, video);
  assert.equal(c.pc.getTransceivers()[1]?.currentDirection, 'inactive');
  assert.equal((await c.chrome.transceivers())[1]?.currentDirection, 'inactive');
  assert.deepEqual(stream.getTracks(), []);
  // Audio keeps flowing both ways.
  const [heard] = await Promise.all([hear(t, audio), chromeHears(c.chrome, 440)]);
  assert.ok(near(heard.frequency, 660, 20), `heard ${heard.frequency} Hz`);
  assert.equal(audioSender.track, m.audio);
  await c.checkCandidates();
});

test('perfect negotiation with glare: as the polite peer we roll back, re-offer, and media flows', async (t) => {
  const c = await call(t, browser);
  const { pc, chrome } = c;
  const m = nodeMedia(t);
  // Chrome is the impolite peer and we're the polite one, as in the spec's
  // example. Chrome's page code is in chrome-peer.js (perfectNegotiation).
  await chrome.call('perfectNegotiation', false);
  const errors: string[] = [];
  chrome.addEventListener('negotiationerror', (e) =>
    errors.push(`Chrome: ${(e as PageEvent<string>).detail}`),
  );

  // The signaling channel: one ordered queue per direction, both held until
  // each side has sent its first offer, so that the offers cross (glare).
  const offers: string[] = [];
  const chromeReplies: string[] = [];
  let toChrome = Promise.resolve();
  let toNode = Promise.resolve();
  let held: { toChrome: (() => Promise<void>)[]; toNode: (() => Promise<void>)[] } | null = {
    toChrome: [],
    toNode: [],
  };
  const firstOffers = {
    ours: Promise.withResolvers<void>(),
    chrome: Promise.withResolvers<void>(),
  };
  const sendToChrome = (description: RTCSessionDescriptionInit) => {
    if (description.type === 'offer') offers.push(description.sdp ?? '');
    const deliver = async () => {
      chromeReplies.push(await chrome.call<string>('description', description));
    };
    if (held) {
      held.toChrome.push(deliver);
      firstOffers.ours.resolve();
    } else {
      toChrome = toChrome.then(deliver);
    }
  };
  const sendToNode = (description: RTCSessionDescriptionInit) => {
    const deliver = () => receive(description);
    if (held) {
      held.toNode.push(deliver);
      firstOffers.chrome.resolve();
    } else {
      toNode = toNode.then(deliver);
    }
  };
  chrome.addEventListener('description', (e) =>
    sendToNode((e as PageEvent<RTCSessionDescriptionInit>).detail),
  );

  // Our side. The polite peer never ignores an offer: SRD of one that
  // collides with ours rolls ours back (implicitly).
  pc.onnegotiationneeded = async () => {
    try {
      await pc.setLocalDescription();
      sendToChrome(pc.localDescription?.toJSON() ?? assert.fail());
    } catch (error) {
      errors.push(`ours: ${error}`);
    }
  };
  async function receive(description: RTCSessionDescriptionInit) {
    try {
      await pc.setRemoteDescription(description);
      await c.flushCandidates();
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        sendToChrome(pc.localDescription?.toJSON() ?? assert.fail());
      }
    } catch (error) {
      errors.push(`ours: ${error}`);
    }
  }

  const video = next<RTCTrackEvent>(pc, 'track').then((e) => e.track);
  const audioSender = pc.addTrack(m.audio);
  await chrome.call('addCanvas', 320, 240, 200);
  await Promise.all([firstOffers.ours.promise, firstOffers.chrome.promise]);
  const { toChrome: first, toNode: second } = held;
  held = null;
  for (const deliver of first) toChrome = toChrome.then(deliver);
  for (const deliver of second) toNode = toNode.then(deliver);

  // Chrome ignores our offer and we answer Chrome's. Then our follow-up
  // offer adds the audio: libwebrtc's own version of it collides with
  // itself after the rollback (lib/internal/extmap-fix.ts).
  try {
    const [track] = await Promise.all([video, chromeHears(chrome, 440)]);
    const seen = await see(t, track, 320, 240);
    assert.ok(fromCanvas(seen.luma, 200), `saw luma ${seen.luma}`);
  } catch (error) {
    throw new Error(`no media both ways; negotiation errors: ${JSON.stringify(errors)}`, {
      cause: error,
    });
  }
  await Promise.all([toChrome, toNode]);
  assert.deepEqual(errors, []);
  assert.deepEqual(chromeReplies, ['ignored', 'applied', 'applied']);
  assert.equal(offers.length, 2);
  const audioLevel = (sdp = '') => sdp.split('\r\n').find((l) => l.endsWith('ssrc-audio-level'));
  t.diagnostic(`audio-level: ${audioLevel(offers[0])}, then ${audioLevel(offers[1])}`);
  const audio = pc.getTransceivers().find((tr) => tr.sender === audioSender);
  assert.equal(audio?.currentDirection, 'sendonly');
  assert.deepEqual([pc.signalingState, await chrome.call('signalingState')], ['stable', 'stable']);
  await c.checkCandidates();
});
