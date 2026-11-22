// getUserMedia's synthetic tracks end to end: over two peer connections into
// the nonstandard sinks, with stop() and clone(), and process exit.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getUserMedia,
  type MediaStream,
  type MediaStreamTrack,
  nonstandard,
  type RTCPeerConnection,
  type RTCTrackEvent,
} from '../../lib/index.ts';
import { connect, media, type Pair, pair, WAIT_MS } from './harness.ts';

const { RTCAudioSink, RTCVideoSink } = nonstandard;

async function open(t: TestContext): Promise<MediaStream> {
  const stream = await getUserMedia({ audio: true, video: true });
  t.after(() => {
    for (const track of stream.getTracks()) track.stop();
  });
  return stream;
}

interface Frame {
  width: number;
  height: number;
  data: Uint8Array;
  /** performance.now() when the sink delivered it. */
  at: number;
}

/** Frames a remote video track delivers, as they arrive. */
class FrameLog {
  frames: Frame[] = [];
  #waiters: { count: number; resolve: () => void }[] = [];

  constructor(t: TestContext, track: MediaStreamTrack) {
    const sink = new RTCVideoSink(track);
    t.after(() => sink.stop());
    sink.onframe = ({ frame }) => {
      this.frames.push({ ...frame, at: performance.now() });
      for (const w of this.#waiters.filter((w) => this.frames.length >= w.count)) w.resolve();
    };
  }

  /** Resolves once `count` frames in total have arrived (failure guard: WAIT_MS). */
  until(count: number): Promise<void> {
    if (this.frames.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`only ${this.frames.length} of ${count} frames arrived`)),
        WAIT_MS,
      );
      this.#waiters.push({
        count,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }
}

/** The remote tracks `b` gets, by mid, once negotiated and connected. */
async function remoteTracks(p: Pair): Promise<Map<string, MediaStreamTrack>> {
  const tracks = new Map<string, MediaStreamTrack>();
  p.b.addEventListener('track', (e) => {
    const { track, transceiver } = e as RTCTrackEvent;
    tracks.set(transceiver.mid ?? '', track);
  });
  await connect(p);
  return tracks;
}

/** The luma at the middle of each of the 8 bars, halfway down, at any frame size. */
function barLuma({ width, height, data }: Frame): number[] {
  const row = (height >> 1) * width;
  return Array.from(
    { length: 8 },
    (_, bar) => data[row + Math.floor(((bar * 2 + 1) * width) / 16)] ?? -1,
  );
}

async function inboundAudioPackets(pc: RTCPeerConnection): Promise<number> {
  const report = await pc.getStats();
  let packets = 0;
  report.forEach((stats) => {
    if (stats.type === 'inbound-rtp' && stats.kind === 'audio') packets += stats.packetsReceived;
  });
  return packets;
}

test('gUM tracks reach remote sinks: silence, and 640x480 colour bars at 30 fps', async (t) => {
  const p = pair(t);
  const stream = await open(t);
  for (const track of stream.getTracks()) p.a.addTrack(track, stream);
  const remote = await remoteTracks(p);
  const remoteAudio = [...remote.values()].find((track) => track.kind === 'audio');
  const remoteVideo = [...remote.values()].find((track) => track.kind === 'video');
  assert.ok(remoteAudio && remoteVideo, 'both tracks arrived');

  const video = new FrameLog(t, remoteVideo);
  const audioSink = new RTCAudioSink(remoteAudio);
  t.after(() => audioSink.stop());
  let loudest = 0;
  let audioEvents = 0;
  audioSink.ondata = ({ samples }) => {
    audioEvents++;
    for (const s of samples) loudest = Math.max(loudest, Math.abs(s));
  };

  await video.until(31);
  const [first, last] = [video.frames[0], video.frames[30]] as [Frame, Frame];
  // The full size from the first frames: video senders default to
  // 'maintain-resolution'. Under Chrome's default, the first frame would
  // meet a start estimate (less the audio's share) under 300 kbps, and the
  // stream would start at 320x240 (VideoStreamEncoder::DropDueToSize).
  assert.deepEqual([first.width, first.height, last.width, last.height], [640, 480, 640, 480]);
  const elapsed = last.at - first.at;
  // Only a lower bound: a loaded machine delivers late, never early. 30
  // frames at 30 fps take a second; a pacing bug (a frame per 10 ms tick)
  // would take 0.3 s.
  assert.ok(elapsed > 700, `30 frames took ${elapsed.toFixed(0)} ms; expected about 1000`);
  const luma = barLuma(last);
  const expected = [180, 162, 131, 112, 84, 65, 35, 16];
  assert.ok(
    luma.every((y, i) => Math.abs(y - (expected[i] ?? 0)) <= 12),
    `bar luma ${luma}, expected about ${expected}`,
  );

  // The remote mixer plays out silence even when nothing arrives, so check
  // that audio packets did arrive (a second's worth of video has, and audio
  // started with it), and that what they carry is silence.
  const packets = await inboundAudioPackets(p.b);
  assert.ok(packets >= 10, `${packets} audio packets arrived in the time 30 video frames took`);
  assert.ok(audioEvents > 0, 'the remote audio sink got data');
  assert.ok(loudest <= 10, `remote audio is silence (loudest sample ${loudest})`);
});

test("a clone keeps the source's media flowing after the original stops; stopping both stops it", async (t) => {
  const p = pair(t);
  const stream = await open(t);
  const [original] = stream.getVideoTracks() as [MediaStreamTrack];
  const clone = original.clone();
  t.after(() => clone.stop());
  // The clone is what's sent; a nonstandard source on a second transceiver
  // is the control that shows time passing at the far end.
  p.a.addTrack(clone);
  const control = media(t);
  p.a.addTrack(control.video);
  const remote = await remoteTracks(p);
  const [gum, other] = [...remote.values()] as [MediaStreamTrack, MediaStreamTrack];
  const sent = new FrameLog(t, gum);
  const controlLog = new FrameLog(t, other);

  await sent.until(5);
  original.stop();
  const atStop = sent.frames.length;
  // Frames keep coming after the original stops (until() fails otherwise).
  await sent.until(atStop + 10);

  clone.stop();
  const afterBoth = sent.frames.length;
  await controlLog.until(controlLog.frames.length + 20);
  const late = sent.frames.length - afterBoth;
  assert.ok(late <= 2, `${late} frames arrived after every gUM track stopped (in flight: <= 2)`);
});

test("gUM tracks left running don't keep the process alive", async () => {
  const script = fileURLToPath(new URL('./getusermedia-exit.ts', import.meta.url));
  const { code, stdout } = await new Promise<{ code: number | string; stdout: string }>(
    (resolve) => {
      execFile(process.execPath, [script], { timeout: 20_000 }, (error, out) => {
        resolve({ code: error ? (error.signal ?? error.code ?? 'error') : 0, stdout: out });
      });
    },
  );
  assert.equal(code, 0, `the child ended with ${code} (SIGTERM: it hung)`);
  assert.equal(stdout.trim(), '640x480 live,live');
});
