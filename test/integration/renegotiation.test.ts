// Video across renegotiations, and the native workaround that re-sets each
// video receiver's sink after every SLD/SRD (src/sink_reassert.cc; PLAN.md
// "Gotchas"). The race it works around is too rare to hit in a test:
// scripts/stress-removetrack-race.mjs reproduces it under load.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type MediaStreamTrack,
  nonstandard,
  type RTCPeerConnection,
  type RTCTrackEvent,
} from '../../lib/index.ts';
import { connect, media, negotiate, next, pair } from './harness.ts';

/** A sink on `track` that is stopped after the test. */
function sinkOn(t: TestContext, track: MediaStreamTrack): nonstandard.RTCVideoSink {
  const sink = new nonstandard.RTCVideoSink(track);
  t.after(() => sink.stop());
  return sink;
}

test('video keeps reaching sinks attached before and after, across direction changes and renegotiations', async (t) => {
  const p = pair(t);
  const ma = media(t);
  const mb = media(t);
  const sender = p.a.addTrack(ma.video);
  p.b.addTrack(mb.video);
  const remoteOf = (pc: RTCPeerConnection) => next<RTCTrackEvent>(pc, 'track').then((e) => e.track);
  const [atA, atB] = [remoteOf(p.a), remoteOf(p.b)];
  await connect(p);
  const [fromB, fromA] = [await atA, await atB];
  // Attached before any renegotiation, as an app does in ontrack.
  const early = { a: sinkOn(t, fromB), b: sinkOn(t, fromA) };
  await Promise.all([next(early.a, 'frame'), next(early.b, 'frame')]);
  const transceiver = p.a.getTransceivers()[0] ?? assert.fail();

  for (let round = 1; round <= 6; round++) {
    // a stops and resumes sending: sendrecv -> recvonly -> sendrecv. The
    // first is the change that recreates a's video receive stream (the
    // removeTrack race). Offers alternate between the sides.
    const sending = round % 2 === 0;
    if (sending) {
      await sender.replaceTrack(ma.video);
      transceiver.direction = 'sendrecv';
    } else {
      p.a.removeTrack(sender);
    }
    if (round % 4 < 2) await negotiate(p.a, p.b);
    else await negotiate(p.b, p.a);
    assert.equal(transceiver.currentDirection, sending ? 'sendrecv' : 'recvonly', `round ${round}`);
    // b's video still reaches a, through the early sink and a new one.
    await Promise.all([next(early.a, 'frame'), next(sinkOn(t, fromB), 'frame')]);
    if (sending) await next(early.b, 'frame');
  }
});

test('after each SLD and SRD, every video receiver gets its sink set again', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wrtc-sink-reassert-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('./sink-reassert-child.ts', import.meta.url));
  const log = join(dir, 'libwebrtc.log');
  const env = {
    ...process.env,
    WRTC_LOG: 'SetSink: ssrc',
    WRTC_LOG_FILE: log,
    RENEGOTIATIONS: '3',
  };
  const { code, stdout } = await new Promise<{ code: number | string; stdout: string }>(
    (resolve) => {
      execFile(process.execPath, [script], { env, timeout: 30_000 }, (error, out) => {
        resolve({ code: error ? (error.signal ?? error.code ?? 'error') : 0, stdout: out });
      });
    },
  );
  assert.equal(code, 0, `the child ended with ${code} (SIGTERM: it hung)`);
  const counts = JSON.parse(stdout) as number[];
  // Without the re-assert, libwebrtc sets the sink once (receiver setup)
  // and never again while the SSRC stays the same: counts would be all 1.
  assert.deepEqual(counts, [3, 5, 7, 9]);
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  // The log hook passes only matching lines, prefixed with time and thread.
  for (const line of lines) {
    assert.match(
      line,
      /^RTCLOG \d+\.\d{6} \[\S+\] \(webrtc_video_engine\.cc:\d+\): SetSink: ssrc:/,
    );
  }
  // All for the one SSRC b receives; the last one is close() clearing it.
  assert.equal(new Set(lines.map((l) => l.match(/ssrc:(\d+)/)?.[1])).size, 1);
  assert.match(lines.at(-1) ?? '', / nullptr$/);
});
