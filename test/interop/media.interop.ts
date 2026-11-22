// Audio and video both ways between our RTCPeerConnection and Chromium's,
// with either side offering, and replaceTrack on ours.
import assert from 'node:assert/strict';
import { after, before, type TestContext, test } from 'node:test';
import type { Browser } from 'playwright';
import type { MediaStreamTrack, RTCTrackEvent } from '../../lib/index.ts';
import {
  type Call,
  call,
  chromeHears,
  chromeSees,
  connect,
  fromCanvas,
  hear,
  launch,
  near,
  nodeMedia,
  see,
  summary,
} from './chrome.ts';

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(() => browser?.close());

// What each side sends: distinct tones and grey levels, so each side can
// tell the other's media from its own (and from silence or garbage).
const NODE_TONE = 440;
const NODE_LUMA = 200;
const CHROME_TONE = 660;
const CHROME_GREY = 64;

/** Adds Chrome's tone and canvas to its peer connection. */
async function chromeSends(c: Call) {
  await c.chrome.call('addTone', CHROME_TONE);
  await c.chrome.call('addCanvas', 320, 240, CHROME_GREY);
}

/** Collects our side's track events, by kind. */
function nodeTracks(c: Call) {
  const tracks = new Map<string, MediaStreamTrack>();
  c.pc.addEventListener('track', (e) => {
    const { track } = e as RTCTrackEvent;
    tracks.set(track.kind, track);
  });
  return tracks;
}

/** Both sides receive the other's tone and frames. */
async function mediaFlowsBothWays(t: TestContext, c: Call, tracks: Map<string, MediaStreamTrack>) {
  const audio = tracks.get('audio');
  const video = tracks.get('video');
  assert.ok(audio && video, `our side got audio and video tracks, got ${[...tracks.keys()]}`);
  const [heard, seen, chromeAudio, chromeVideo] = await Promise.all([
    hear(t, audio),
    see(t, video, 320, 240),
    chromeHears(c.chrome, NODE_TONE),
    chromeSees(c.chrome, 320, 240, NODE_LUMA),
  ]);
  t.diagnostic(`we heard ${JSON.stringify(heard)}`);
  t.diagnostic(`we saw ${JSON.stringify(seen)}`);
  t.diagnostic(`Chrome audio: ${summary(chromeAudio)}`);
  t.diagnostic(`Chrome video: ${summary(chromeVideo)}`);

  // Chrome's oscillator at gain 0.5, through Opus: about 16384 of 32768.
  assert.deepEqual([heard.sampleRate, heard.channelCount, heard.numberOfFrames], [48_000, 1, 480]);
  assert.ok(near(heard.frequency, CHROME_TONE, 20), `heard ${heard.frequency} Hz`);
  assert.ok(near(heard.peak, 16_384, 2000), `heard peak ${heard.peak}`);
  assert.ok(fromCanvas(seen.luma, CHROME_GREY), `saw luma ${seen.luma}`);
  assert.ok(seen.fps >= 10, `saw ${seen.fps} fps`);

  assert.equal(chromeAudio.codec, 'audio/opus');
  assert.equal(chromeVideo.codec, 'video/VP8');
  assert.ok(chromeVideo.framesPerSecond >= 10, `Chrome decodes ${chromeVideo.framesPerSecond} fps`);
  // Each test ends with checkCandidates(): both sides added every trickled
  // candidate, including our end-of-candidates ('') and Chrome's mDNS
  // (.local) ones.
  const stats = await c.pc.getStats();
  const pair = [...stats.values()].find((s) => s.type === 'candidate-pair' && s.nominated);
  const local = stats.get(pair?.localCandidateId);
  const remote = stats.get(pair?.remoteCandidateId);
  t.diagnostic(
    `our selected pair: ${local?.candidateType} ${local?.protocol} -> ${remote?.candidateType} ${remote?.address || '(address hidden)'}`,
  );
}

test('we offer, Chrome answers: audio and video flow both ways', async (t) => {
  const c = await call(t, browser);
  const m = nodeMedia(t, { frequency: NODE_TONE, luma: NODE_LUMA });
  c.pc.addTrack(m.audio);
  c.pc.addTrack(m.video);
  await chromeSends(c);
  const tracks = nodeTracks(c);

  await connect(c, c.nodeOffers);
  assert.deepEqual(
    c.pc.getTransceivers().map((tr) => tr.currentDirection),
    ['sendrecv', 'sendrecv'],
  );
  await mediaFlowsBothWays(t, c, tracks);
  await c.checkCandidates();
});

test('Chrome offers, we answer: audio and video flow both ways', async (t) => {
  const c = await call(t, browser);
  const m = nodeMedia(t, { frequency: NODE_TONE, luma: NODE_LUMA });
  // Added before the offer arrives; the offer's m-lines take these
  // transceivers over (no extra ones).
  c.pc.addTrack(m.audio);
  c.pc.addTrack(m.video);
  await chromeSends(c);
  const tracks = nodeTracks(c);

  await connect(c, c.chromeOffers);
  assert.deepEqual(
    c.pc.getTransceivers().map((tr) => [tr.mid, tr.currentDirection]),
    [
      ['0', 'sendrecv'],
      ['1', 'sendrecv'],
    ],
  );
  await mediaFlowsBothWays(t, c, tracks);
  await c.checkCandidates();
});

test('replaceTrack switches what Chrome receives to the new sources, without renegotiation', async (t) => {
  const c = await call(t, browser);
  const first = nodeMedia(t, { frequency: NODE_TONE, luma: NODE_LUMA });
  const second = nodeMedia(t, { frequency: 880, width: 176, height: 144, luma: 64 });
  const audio = c.pc.addTrack(first.audio);
  const video = c.pc.addTrack(first.video);
  await connect(c, c.nodeOffers);
  await Promise.all([chromeHears(c.chrome, NODE_TONE), chromeSees(c.chrome, 320, 240, NODE_LUMA)]);
  const offer = c.pc.currentLocalDescription?.sdp;

  await Promise.all([audio.replaceTrack(second.audio), video.replaceTrack(second.video)]);
  const [chromeAudio, chromeVideo] = await Promise.all([
    chromeHears(c.chrome, 880),
    chromeSees(c.chrome, 176, 144, 64),
  ]);
  t.diagnostic(`Chrome audio after replaceTrack: ${summary(chromeAudio)}`);
  t.diagnostic(`Chrome video after replaceTrack: ${summary(chromeVideo)}`);
  assert.equal(c.pc.signalingState, 'stable');
  assert.equal(c.pc.currentLocalDescription?.sdp, offer, 'no renegotiation');
  assert.equal(audio.track, second.audio);
  assert.equal(video.track, second.video);
  await c.checkCandidates();
});
