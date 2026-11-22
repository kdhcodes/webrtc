// Remote track mute/unmute end to end (SPEC-LAYER-PLAN.md, "MediaStreamTrack"):
// a receiver's track starts muted, unmutes on the first packet after its
// transceiver starts receiving (libwebrtc's
// OnFirstPacketReceivedAfterReceptiveChange, as Chrome uses), and mutes when
// a description stops it receiving. Muting never touches media: the
// nonstandard sinks get whatever arrives.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type MediaStreamTrack,
  nonstandard,
  type RTCRtpTransceiver,
  type RTCTrackEvent,
} from '../../lib/index.ts';
import { audible, connect, media, negotiate, next, type Pair, pair } from './harness.ts';

interface Received {
  track: MediaStreamTrack;
  mutedInEvent: boolean;
  /** Attached in the track event, before any packet can have arrived. */
  sink: nonstandard.RTCAudioSink | nonstandard.RTCVideoSink;
}

/** Records b's track events, attaching a sink to each track right there. */
function receive(t: TestContext, p: Pair): Received[] {
  const received: Received[] = [];
  p.b.addEventListener('track', (e) => {
    const { track } = e as RTCTrackEvent;
    const sink =
      track.kind === 'audio'
        ? new nonstandard.RTCAudioSink(track)
        : new nonstandard.RTCVideoSink(track);
    t.after(() => sink.stop());
    received.push({ track, mutedInEvent: track.muted, sink });
  });
  return received;
}

/** Resolves with the sink's next audible audio or any video frame. */
function nextMedia(sink: Received['sink']): Promise<unknown> {
  return sink instanceof nonstandard.RTCAudioSink
    ? next<nonstandard.RTCAudioDataEvent>(sink, 'data', (e) => audible(e.samples))
    : next(sink, 'frame');
}

/** Resolves once `track` is unmuted (now or later). */
function unmuted(track: MediaStreamTrack): Promise<void> {
  return track.muted ? next(track, 'unmute').then(() => {}) : Promise.resolve();
}

/** Two connected PCs, a sending audio and video to b, both unmuted at b. */
async function sending(t: TestContext) {
  const p = pair(t);
  const m = media(t);
  p.a.addTrack(m.audio);
  p.a.addTrack(m.video);
  const received = receive(t, p);
  await connect(p);
  await Promise.all(received.map(({ track }) => unmuted(track)));
  return { p, received };
}

test('remote tracks start muted, unmute when media arrives, and sinks attached before get it', async (t) => {
  const p = pair(t);
  const m = media(t);
  p.a.addTrack(m.audio);
  p.a.addTrack(m.video);
  const received = receive(t, p);
  await connect(p);

  assert.deepEqual(
    received.map((r) => [r.track.kind, r.mutedInEvent]),
    [
      ['audio', true],
      ['video', true],
    ],
  );
  await Promise.all(received.map(({ track }) => unmuted(track)));
  await Promise.all(received.map(({ sink }) => nextMedia(sink)));
  assert.deepEqual(
    received.map((r) => r.track.muted),
    [false, false],
  );
});

test("the sender's direction going to recvonly mutes; back to sendrecv unmutes once media resumes", async (t) => {
  const { p, received } = await sending(t);
  const transceivers = p.a.getTransceivers();

  const muted = Promise.all(received.map(({ track }) => next(track, 'mute')));
  for (const transceiver of transceivers) transceiver.direction = 'recvonly';
  await negotiate(p.a, p.b);
  // Fired during b's setRemoteDescription(offer), before it resolved.
  await muted;
  assert.deepEqual(
    received.map((r) => r.track.muted),
    [true, true],
  );

  // Listening from before negotiating: media can resume before it returns.
  const unmute = Promise.all(received.map(({ track }) => next(track, 'unmute')));
  for (const transceiver of transceivers) transceiver.direction = 'sendrecv';
  await negotiate(p.a, p.b);
  await unmute;
  await Promise.all(received.map(({ sink }) => nextMedia(sink)));
});

test("the receiver's own direction going to inactive or sendonly mutes; back to recvonly unmutes", async (t) => {
  const { p, received } = await sending(t);
  const at = (i: number): RTCRtpTransceiver => p.b.getTransceivers()[i] ?? assert.fail();
  const [audio, video] = received;
  assert.ok(audio && video);

  // b offers this time: its tracks mute in setRemoteDescription(answer).
  const muted = Promise.all([next(audio.track, 'mute'), next(video.track, 'mute')]);
  at(0).direction = 'inactive';
  at(1).direction = 'sendonly';
  await negotiate(p.b, p.a);
  await muted;

  // b is receptive from its setLocalDescription(offer) and a sends from its
  // setLocalDescription(answer), so the first packet (and unmute) can come
  // before b's setRemoteDescription(answer) and negotiate() return.
  const unmute = Promise.all(received.map(({ track }) => next(track, 'unmute')));
  at(0).direction = 'recvonly';
  at(1).direction = 'recvonly';
  await negotiate(p.b, p.a);
  await unmute;
  await Promise.all(received.map(({ sink }) => nextMedia(sink)));
});

/** Resolves after `n` more `type` events on `target`. */
async function after(target: EventTarget, type: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await next(target, type);
}

test('a stopped transceiver ends its track with ended, on either side, and its sink stops itself', async (t) => {
  const { p, received } = await sending(t);
  const [audio, video] = received;
  assert.ok(audio && video);
  const log: string[] = [];
  for (const { track } of received) {
    track.onmute = () => log.push(`mute ${track.kind}`);
    track.onended = () => log.push(`ended ${track.kind} ${track.readyState}`);
  }

  // b stops its own video transceiver: the track ends in a queued task.
  const videoEnded = next(video.track, 'ended');
  p.b.getTransceivers()[1]?.stop();
  assert.equal(video.track.readyState, 'live');
  await videoEnded;
  // The source ended, so its sink released itself in the same task; one
  // made on the ended track starts stopped. Audio is unaffected.
  assert.equal(video.sink.stopped, true);
  assert.equal(new nonstandard.RTCVideoSink(video.track).stopped, true);
  assert.equal(audio.sink.stopped, false);
  await after(audio.sink, 'data', 5);

  // a stops audio and renegotiates: b's transceiver stops at the offer, and
  // its track ends after setRemoteDescription resolved.
  const audioEnded = next(audio.track, 'ended');
  p.a.getTransceivers()[0]?.stop();
  await negotiate(p.a, p.b);
  await audioEnded;
  assert.equal(audio.sink.stopped, true);

  // The remote stop mutes first: webrtc-pc processes a rejected m-section
  // as direction inactive ("process remote tracks", in the SRD's task),
  // then stops the transceiver, whose track ends in a later task. The
  // local stop doesn't mute.
  assert.deepEqual(log, ['ended video ended', 'mute audio', 'ended audio ended']);
  assert.deepEqual(
    received.map((r) => r.track.muted),
    [true, false],
  );
});

test("close() ends the receivers' tracks with ended, except one the app stopped", async (t) => {
  const { p, received } = await sending(t);
  const [audio, video] = received;
  assert.ok(audio && video);
  const log: string[] = [];
  for (const { track } of received) {
    track.onended = () => log.push(`ended ${track.kind}`);
  }
  video.track.stop();
  const ended = next(audio.track, 'ended');
  p.b.close();
  assert.equal(audio.track.readyState, 'live');
  await ended;
  assert.deepEqual(log, ['ended audio']);
});

test('sinks nobody stopped no longer keep the process alive once their tracks end', async () => {
  const script = fileURLToPath(new URL('./sink-exit.ts', import.meta.url));
  const { code, stdout } = await new Promise<{ code: number | string; stdout: string }>(
    (resolve) => {
      execFile(process.execPath, [script], { timeout: 20_000 }, (error, out) => {
        resolve({ code: error ? (error.signal ?? error.code ?? 'error') : 0, stdout: out });
      });
    },
  );
  assert.equal(code, 0, `the child ended with ${code} (SIGTERM: it hung)`);
  assert.equal(stdout.trim(), 'true true true', 'every sink stopped itself');
});
