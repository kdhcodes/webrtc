// The video send path from a pushed RTCVideoSource, against what Chromium 159
// does with a canvas track in the same setup (SPEC-LAYER-PLAN.md,
// "RTCVideoSource"): the source follows the encoder's sink wants (frame
// rate and resolution adaptation) while its own sinks get every frame as
// pushed, and simulcast that one encoder can't do runs one encoder per layer.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import {
  type MediaStreamTrack,
  nonstandard,
  type RTCPeerConnection,
  RTCRtpSender,
  type RTCRtpTransceiver,
} from '../../lib/index.ts';
import { greyFrame, pair, reaches, WAIT_MS } from './harness.ts';

const { RTCVideoSink, RTCVideoSource } = nonstandard;

interface Source {
  track: MediaStreamTrack;
  /** Starts pushing a grey frame every 33 ms, until the test ends. */
  start(): void;
}

function source(t: TestContext, width: number, height: number, isScreencast = false): Source {
  const src = new RTCVideoSource({ isScreencast });
  const track = src.createTrack();
  const frame = { width, height, data: greyFrame(width, height) };
  let pump: NodeJS.Timeout | undefined;
  t.after(() => {
    clearInterval(pump);
    track.stop();
  });
  return {
    track,
    start() {
      pump ??= setInterval(() => src.onFrame(frame), 33);
    },
  };
}

/** Counts the frames a sink on `track` gets, and their sizes. */
function sinkOn(t: TestContext, track: MediaStreamTrack) {
  const sink = new RTCVideoSink(track);
  t.after(() => sink.stop());
  const log = { frames: 0, sizes: new Set<string>(), waiters: [] as (() => void)[] };
  sink.onframe = ({ frame }) => {
    log.frames++;
    log.sizes.add(`${frame.width}x${frame.height}`);
    for (const w of log.waiters.splice(0)) w();
  };
  /** Resolves once `count` more frames have arrived (failure guard: WAIT_MS). */
  const more = async (count: number) => {
    const target = log.frames + count;
    const deadline = Date.now() + WAIT_MS;
    while (log.frames < target) {
      if (Date.now() > deadline) assert.fail(`only ${log.frames} of ${target} frames at the sink`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        log.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  return { log, more };
}

interface Outbound {
  rid: string | undefined;
  width: number | undefined;
  frames: number;
  /** The stats' timestamp, in ms. */
  at: number;
  codec: string | undefined;
  implementation: string | undefined;
  /** Seconds the encoder has been held back by the bandwidth estimate. */
  bandwidthLimited: number;
}

async function outbound(pc: RTCPeerConnection): Promise<Map<string, Outbound>> {
  const report = await pc.getStats();
  const result = new Map<string, Outbound>();
  for (const stats of report.values()) {
    if (stats.type !== 'outbound-rtp' || stats.kind !== 'video') continue;
    result.set(stats.rid ?? '', {
      rid: stats.rid,
      width: stats.frameWidth,
      frames: stats.framesEncoded ?? 0,
      at: stats.timestamp,
      codec: report.get(stats.codecId)?.mimeType,
      implementation: stats.encoderImplementation,
      bandwidthLimited: stats.qualityLimitationDurations?.bandwidth ?? 0,
    });
  }
  return result;
}

/** Polls `pc`'s outbound stats until `done` holds; WAIT_MS is a failure guard. */
async function until(
  pc: RTCPeerConnection,
  done: (layers: Map<string, Outbound>) => boolean,
): Promise<Map<string, Outbound>> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const current = await outbound(pc);
    if (done(current)) return current;
    if (Date.now() > deadline)
      assert.fail(`stats never matched: ${JSON.stringify([...current.values()])}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Negotiates `a` -> `b`. With rids, `b`'s answer is made to accept them on
 * the one m-line (libwebrtc doesn't answer simulcast), so `a` encodes every
 * layer. `answerFmtp` is appended to each video codec's fmtp line.
 */
async function negotiate(
  a: RTCPeerConnection,
  b: RTCPeerConnection,
  { rids = [], answerFmtp }: { rids?: string[]; answerFmtp?: string } = {},
) {
  await a.setLocalDescription();
  await b.setRemoteDescription(a.localDescription ?? assert.fail('no offer'));
  await b.setLocalDescription();
  let sdp = b.localDescription?.sdp ?? '';
  if (rids.length) {
    sdp = sdp.replace(
      /(m=video[\s\S]*?a=mid:[^\r]*\r\n)/,
      `$1${rids.map((rid) => `a=rid:${rid} recv\r\n`).join('')}a=simulcast:recv ${rids.join(';')}\r\n`,
    );
  }
  if (answerFmtp) {
    sdp = sdp.replace(/a=rtpmap:(\d+) VP8\/90000\r\n/g, `$&a=fmtp:$1 ${answerFmtp}\r\n`);
  }
  await a.setRemoteDescription({ type: 'answer', sdp });
  await reaches(a, 'connected');
}

function prefer(transceiver: RTCRtpTransceiver, mimeType: string) {
  const { codecs } = RTCRtpSender.getCapabilities('video') ?? assert.fail('no capabilities');
  const first = codecs.filter((c) => c.mimeType === mimeType);
  assert.ok(first.length, `${mimeType} is supported`);
  transceiver.setCodecPreferences([...first, ...codecs.filter((c) => !first.includes(c))]);
}

/**
 * Each layer's encoded frame rate against wall time (the stats'
 * timestamps), over the time `count` pushed frames take to reach the
 * source's own sink, and that pushed rate. A loaded machine can only lower
 * both, so the caps below are upper bounds with generous lower ones.
 */
async function encodedFps(
  pc: RTCPeerConnection,
  clock: ReturnType<typeof sinkOn>,
  count: number,
): Promise<{ layers: Map<string, number>; pushed: number; bandwidthLimited: number }> {
  const before = await outbound(pc);
  const pushed = clock.log.frames;
  const started = performance.now();
  await clock.more(count);
  const after = await outbound(pc);
  const pushedFps = ((clock.log.frames - pushed) * 1000) / (performance.now() - started);
  const layers = new Map(
    [...after].map(([rid, s]) => {
      const b = before.get(rid);
      return [rid, b ? ((s.frames - b.frames) * 1000) / (s.at - b.at) : -1];
    }),
  );
  // The same for every layer: it's the sender's.
  const bandwidthLimited = Math.max(
    0,
    ...[...after].map(([rid, s]) => s.bandwidthLimited - (before.get(rid)?.bandwidthLimited ?? 0)),
  );
  return { layers, pushed: pushedFps, bandwidthLimited };
}

test('maxFramerate caps the encoded frame rate; the source’s own sink still gets every frame', async (t) => {
  const { track, start } = source(t, 320, 240);
  const local = sinkOn(t, track);
  const p = pair(t);
  const { sender } = p.a.addTransceiver(track, { direction: 'sendonly' });
  start();
  await negotiate(p.a, p.b);
  await until(p.a, (s) => (s.get('')?.frames ?? 0) >= 10);

  const parameters = sender.getParameters();
  const [encoding] = parameters.encodings;
  assert.ok(encoding);
  encoding.maxFramerate = 10;
  await sender.setParameters(parameters);
  await local.more(15); // settle

  // About 30 fps pushed, 10 encoded. Before the source honoured the
  // encoder's wants, every frame was (WPT RTCRtpSender-maxFramerate, which
  // Chrome passes).
  const { layers, pushed } = await encodedFps(p.a, local, 60);
  const fps = layers.get('') ?? -1;
  const shown = `encoded ${fps.toFixed(1)} fps of ${pushed.toFixed(1)} pushed`;
  t.diagnostic(shown);
  assert.ok(fps > 4 && fps < 12.5, shown);
  assert.deepEqual([...local.log.sizes], ['320x240']);
});

test('per-layer maxFramerate on VP8 simulcast keeps VP8, with one encoder per layer (Chrome)', async (t) => {
  // 960x540 is the smallest 16:9 size that gets three layers.
  const { track, start } = source(t, 960, 540);
  const local = sinkOn(t, track);
  const p = pair(t);
  const rids = ['l', 'm', 'h'];
  const { sender } = p.a.addTransceiver(track, {
    direction: 'sendonly',
    sendEncodings: rids.map((rid, i) => ({ rid, scaleResolutionDownBy: 2 ** (2 - i) })),
  });
  start();
  // This is about frame rates, not bandwidth: the simulcast allocator only
  // turns the 960x540 layer on above about 850 kbps, and on a GitHub macOS
  // runner the loopback estimate stayed below that for 15 s. A 1.5 Mbps
  // floor (and start) covers a slow ramp or a moderate dip; severe
  // congestion can still switch the top layer off, hence the retry below.
  await negotiate(p.a, p.b, {
    rids,
    answerFmtp: 'x-google-min-bitrate=1500;x-google-start-bitrate=2000',
  });
  await until(p.a, (s) => rids.every((rid) => (s.get(rid)?.frames ?? 0) >= 10));

  const parameters = sender.getParameters();
  parameters.encodings.forEach((e, i) => {
    e.maxFramerate = [15, 10, 5][i];
  });
  await sender.setParameters(parameters);
  // libvpx's own simulcast needs one frame rate for every layer. Without
  // the SimulcastEncoderAdapter, InitEncode failed and libwebrtc switched the
  // sender to VP9 with a single layer.
  const switched = await until(p.a, (s) => rids.every((rid) => (s.get(rid)?.frames ?? 0) >= 20));
  for (const rid of rids) assert.equal(switched.get(rid)?.codec, 'video/VP8', rid);
  await local.more(15); // settle

  // 15, 10 and 5 of about 30 fps. A layer never goes over its cap. Should
  // the encoder still report a bandwidth limit despite the floor, a slow
  // window that was bandwidth-limited is measured again, up to three times;
  // a slow window with no bandwidth limit fails.
  const windows: string[] = [];
  for (;;) {
    const { layers, pushed, bandwidthLimited } = await encodedFps(p.a, local, 90);
    const [l, m, h] = rids.map((rid) => layers.get(rid) ?? -1) as [number, number, number];
    const shown =
      `encoded fps: l ${l.toFixed(1)}, m ${m.toFixed(1)}, h ${h.toFixed(1)} of ${pushed.toFixed(1)} pushed, ` +
      `${bandwidthLimited.toFixed(1)} s bandwidth-limited`;
    t.diagnostic(shown);
    windows.push(shown);
    assert.ok(l < 17 && m < 12 && h < 6.5, `over a cap: ${shown}`);
    if (l > 7 && m > 4.5 && h > 2 && l > m && m > h) break;
    assert.ok(bandwidthLimited > 0, `out of range, not bandwidth-limited: ${shown}`);
    assert.ok(windows.length < 3, `out of range in every window:\n${windows.join('\n')}`);
  }
  assert.deepEqual([...local.log.sizes], ['960x540']);
});

test('AV1 simulcast with scalabilityMode encodes every layer (Chrome)', async (t) => {
  const { track, start } = source(t, 640, 360);
  const p = pair(t);
  const rids = ['l', 'h'];
  const transceiver = p.a.addTransceiver(track, {
    direction: 'sendonly',
    sendEncodings: rids.map((rid, i) => ({
      rid,
      scaleResolutionDownBy: 2 ** (1 - i),
      scalabilityMode: 'L1T1',
    })),
  });
  prefer(transceiver, 'video/AV1');
  start();
  await negotiate(p.a, p.b, { rids });
  // libaom has no simulcast of its own; it failed every frame before.
  const layers = await until(p.a, (s) => rids.every((rid) => (s.get(rid)?.frames ?? 0) >= 5));
  assert.deepEqual(
    rids.map((rid) => [layers.get(rid)?.codec, layers.get(rid)?.width]),
    [
      ['video/AV1', 320],
      ['video/AV1', 640],
    ],
  );
});

test('AV1 L3T3 keeps encoding, and decoding, with its top spatial layer off', async (t) => {
  // 300 kbps can't carry 1280x720, so the SVC rate allocator turns the top
  // spatial layer off, and libaom's encoder then scales each pushed frame
  // down to the last active layer itself. (Upstream converts a frame that
  // isn't I420 or NV12 before that scaling, which would fail the size
  // check. Our sources only push I420.)
  const { track, start } = source(t, 1280, 720);
  const p = pair(t);
  const transceiver = p.a.addTransceiver(track, {
    direction: 'sendonly',
    sendEncodings: [{ scalabilityMode: 'L3T3', maxBitrate: 300_000 }],
  });
  prefer(transceiver, 'video/AV1');
  start();
  await negotiate(p.a, p.b);
  const sent = await until(p.a, (s) => (s.get('')?.frames ?? 0) >= 60);
  const layer = sent.get('') ?? assert.fail('no outbound video');
  assert.equal(layer.codec, 'video/AV1');
  assert.ok(layer.width !== undefined && layer.width < 1280, `encoded width ${layer.width}`);
  assert.equal(transceiver.sender.getParameters().encodings[0]?.scalabilityMode, 'L3T3');
  // What was encoded decodes: frames keep arriving at the receiver.
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const report = await p.b.getStats();
    const inbound = [...report.values()].find(
      (s) => s.type === 'inbound-rtp' && s.kind === 'video',
    );
    if ((inbound?.framesDecoded ?? 0) >= 30) break;
    if (Date.now() > deadline)
      assert.fail(`receiver decoded ${inbound?.framesDecoded ?? 0} frames`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

test('VP9 simulcast without scalabilityMode sends only the first layer (Chrome)', async (t) => {
  const { track, start } = source(t, 640, 360);
  const p = pair(t);
  const rids = ['l', 'h'];
  const transceiver = p.a.addTransceiver(track, {
    direction: 'sendonly',
    sendEncodings: rids.map((rid, i) => ({ rid, scaleResolutionDownBy: 2 ** (1 - i) })),
  });
  prefer(transceiver, 'video/VP9');
  start();
  await negotiate(p.a, p.b, { rids });
  // libwebrtc's legacy VP9/AV1 path (IsCodecDisabledForSimulcast): one
  // stream unless an encoding has a scalabilityMode.
  const layers = await until(p.a, (s) => (s.get('l')?.frames ?? 0) >= 30);
  assert.equal(layers.get('l')?.width, 320);
  assert.equal(layers.get('h')?.frames ?? 0, 0);
});

/**
 * Starts `track`'s source pushing only once connected, with a 200 kbps start
 * bitrate: the first frame then reaches the encoder with a bandwidth
 * estimate too low for 640x480 (VideoStreamEncoder::DropDueToSize). Under a
 * degradation preference that adapts resolution, the encoder then asks the
 * source for fewer pixels, as in Chrome.
 */
async function lowStart(
  t: TestContext,
  { isScreencast = false, degradationPreference }: LowStartOptions = {},
) {
  const { track, start } = source(t, 640, 480, isScreencast);
  const local = sinkOn(t, track);
  const p = pair(t);
  const { sender } = p.a.addTransceiver(track, { direction: 'sendonly' });
  if (degradationPreference) {
    const parameters = sender.getParameters();
    parameters.degradationPreference = degradationPreference;
    await sender.setParameters(parameters);
  }
  await negotiate(p.a, p.b, { answerFmtp: 'x-google-start-bitrate=200' });
  start();
  return { p, local, sender };
}

interface LowStartOptions {
  isScreencast?: boolean;
  degradationPreference?: 'balanced' | 'maintain-framerate' | 'maintain-resolution';
}

/** The widths the sender encoded until it had encoded `frames`. */
async function widthsUntil(pc: RTCPeerConnection, frames: number): Promise<number[]> {
  const widths = new Set<number>();
  await until(pc, (s) => {
    const width = s.get('')?.width;
    if (width !== undefined) widths.add(width);
    return (s.get('')?.frames ?? 0) >= frames;
  });
  return [...widths];
}

test('by default a single layer keeps the pushed size from its first frames (wrtc; chosen over Chrome)', async (t) => {
  // Chrome (maintain-framerate) would start this at 320x240.
  const { p, sender } = await lowStart(t);
  assert.equal(sender.getParameters().degradationPreference, undefined);
  assert.deepEqual(await widthsUntil(p.a, 30), [640]);
});

test("'balanced' lets the encoder scale a pushed source; its own sink keeps the pushed size; back to the default restores it", async (t) => {
  const { p, local, sender } = await lowStart(t, { degradationPreference: 'balanced' });
  assert.equal(sender.getParameters().degradationPreference, 'balanced');
  const scaled = await until(p.a, (s) => (s.get('')?.width ?? 640) < 640);
  assert.ok((scaled.get('')?.width ?? 0) >= 160, `encoded width ${scaled.get('')?.width}`);
  await local.more(5);
  assert.deepEqual([...local.log.sizes], ['640x480']);
  // The media source reports what was pushed, not what was encoded.
  const report = await p.a.getStats();
  const mediaSource = [...report.values()].find(
    (s) => s.type === 'media-source' && s.kind === 'video',
  );
  assert.deepEqual([mediaSource?.width, mediaSource?.height], [640, 480]);

  // A round trip without degradationPreference goes back to the default.
  const parameters = sender.getParameters();
  delete parameters.degradationPreference;
  await sender.setParameters(parameters);
  assert.equal(sender.getParameters().degradationPreference, undefined);
  await until(p.a, (s) => s.get('')?.width === 640);
});

test('isScreencast keeps the resolution under any preference (no quality scaling)', async (t) => {
  const { p, local } = await lowStart(t, {
    isScreencast: true,
    degradationPreference: 'maintain-framerate',
  });
  // Even with a preference that would scale: screen content has no quality
  // scaling, so the initial frame dropper never acts.
  assert.deepEqual(await widthsUntil(p.a, 30), [640]);
  assert.deepEqual([...local.log.sizes], ['640x480']);
});

test("the default holds for a remote offer's transceiver given a track by replaceTrack", async (t) => {
  const { track, start } = source(t, 640, 480);
  const p = pair(t);
  p.b.addTransceiver('video', { direction: 'recvonly' });
  await p.b.setLocalDescription();
  const offer = (p.b.localDescription?.sdp ?? '').replace(
    /a=rtpmap:(\d+) VP8\/90000\r\n/g,
    '$&a=fmtp:$1 x-google-start-bitrate=200\r\n',
  );
  await p.a.setRemoteDescription({ type: 'offer', sdp: offer });
  const [transceiver] = p.a.getTransceivers();
  assert.ok(transceiver);
  transceiver.direction = 'sendonly';
  await transceiver.sender.replaceTrack(track);
  await p.a.setLocalDescription();
  await p.b.setRemoteDescription(p.a.localDescription ?? assert.fail('no answer'));
  await reaches(p.a, 'connected');
  start();
  // With 'balanced' set here instead, the same run encodes 320x240.
  assert.equal(transceiver.sender.getParameters().degradationPreference, undefined);
  assert.deepEqual(await widthsUntil(p.a, 30), [640]);
});
