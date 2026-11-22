// Media through a mediasoup SFU, with Whereby's produce settings. A producer
// client process sends a 440 Hz tone (RTCAudioSource) and 3-layer VP8
// simulcast 1280x720 video (RTCVideoSource); a consumer client process
// receives them into RTCAudioSink / RTCVideoSink. This driver hosts the SFU
// and signaling, and never loads our addon.
//
//   MEDIASOUP_DIR=... node media.mjs [--handler Safari12|Chrome111] [--series 1,5,10,20]
//                                    [--max 20] [--skip-series] [--json]
//
// Checks: an audible 440 Hz tone; frame sizes; simulcast layer switching via
// consumer.setPreferredLayers (320x180, 640x360, 1280x720 at the sink);
// getStats on both clients and mediasoup's producer/consumer stats; the cost
// of each consume round (mediasoup-client's receive(): SRD, createAnswer,
// SLD on the receiving PC) as consumers accumulate on one transport; and
// that both client processes exit on their own after closing.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  createClient,
  createSfu,
  httpRpc,
  installWrtcGlobals,
  pcTimings,
  selectedPair,
  serveHttp,
  sleep,
} from './common.mjs';

const THIS = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const role = arg('--role', null);
const handlerName = arg('--handler', 'Safari12');
const MAX_CONSUMERS = Number(arg('--max', 20));

// Whereby's settings (@whereby.com/media mediaSettings.ts).
const AUDIO_SETTINGS = {
  codecOptions: { opusDtx: true, opusFec: true },
  encodings: [{ dtx: true }],
};
const VIDEO_SETTINGS_HD = {
  codecOptions: { videoGoogleStartBitrate: 500 },
  encodings: [
    { scaleResolutionDownBy: 4, maxBitrate: 150000 },
    { scaleResolutionDownBy: 2, maxBitrate: 500000 },
    { scaleResolutionDownBy: 1, maxBitrate: 1000000 },
  ],
};
const W = 1280;
const H = 720;

// ---------------------------------------------------------------------------
// Child processes: commands from the driver as JSON lines.

async function child() {
  const wrtc = await installWrtcGlobals();
  const { RTCAudioSource, RTCVideoSource, RTCAudioSink, RTCVideoSink } = wrtc.nonstandard;
  const rpc = httpRpc(arg('--rpc'));
  const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  let closing = false;
  const rl = createInterface({ input: process.stdin });
  // Driver gone without a close command: don't linger.
  rl.on('close', () => {
    if (!closing) process.exit(3);
  });
  const handlers = {};
  rl.on('line', async (l) => {
    const { id, cmd, args } = JSON.parse(l);
    try {
      out({ id, result: (await handlers[cmd](args ?? {})) ?? null });
    } catch (e) {
      out({ id, error: String(e?.stack ?? e) });
    }
  });

  if (role === 'producer') {
    const client = await createClient({ rpc, name: 'producer', handlerName, recv: false });
    const audioSource = new RTCAudioSource();
    const videoSource = new RTCVideoSource();
    const audioTrack = audioSource.createTrack();
    const videoTrack = videoSource.createTrack();
    // A 16x16-block noise texture panning 8 px per frame: every frame changes,
    // so the encoder has work to do, but motion search can follow it.
    const frames = [];
    const NF = 30;
    const BW = W + NF * 8;
    const base = new Uint8Array(BW * H);
    for (let by = 0; by < H / 16; by++) {
      for (let bx = 0; bx < BW / 16; bx++) {
        const v = (Math.random() * 200 + 28) | 0;
        for (let y = 0; y < 16; y++)
          base.fill(v, (by * 16 + y) * BW + bx * 16, (by * 16 + y) * BW + bx * 16 + 16);
      }
    }
    for (let f = 0; f < NF; f++) {
      const data = new Uint8Array((W * H * 3) / 2).fill(128);
      for (let y = 0; y < H; y++)
        data.set(base.subarray(y * BW + f * 8, y * BW + f * 8 + W), y * W);
      frames.push({ width: W, height: H, data });
    }
    const start = performance.now();
    let audioChunks = 0;
    let videoFrames = 0;
    const pump = setInterval(() => {
      const elapsed = performance.now() - start;
      while (audioChunks < Math.floor(elapsed / 10)) {
        const samples = new Int16Array(480);
        for (let i = 0; i < 480; i++) {
          samples[i] = Math.round(
            8000 * Math.sin((2 * Math.PI * 440 * (audioChunks * 480 + i)) / 48000),
          );
        }
        audioSource.onData({ samples, sampleRate: 48000 });
        audioChunks++;
      }
      while (videoFrames < Math.floor(elapsed / (1000 / 30))) {
        videoSource.onFrame(frames[videoFrames % frames.length]);
        videoFrames++;
      }
    }, 5);
    let mic;
    let cam;
    handlers.produce = async () => {
      mic = await client.sendTransport.produce({
        track: audioTrack,
        stopTracks: false,
        disableTrackOnPause: false,
        ...AUDIO_SETTINGS,
      });
      cam = await client.sendTransport.produce({
        track: videoTrack,
        stopTracks: false,
        disableTrackOnPause: false,
        ...VIDEO_SETTINGS_HD,
      });
      return {
        audioId: mic.id,
        videoId: cam.id,
        videoEncodings: cam.rtpParameters.encodings,
        videoCodec: cam.rtpParameters.codecs[0].mimeType,
      };
    };
    // mediasoup-client does it with sender.getParameters()/setParameters().
    handlers.setMaxSpatialLayer = async ({ spatialLayer }) => {
      await cam.setMaxSpatialLayer(spatialLayer);
    };
    handlers.stats = async () => {
      const r = await cam.getStats();
      const outbound = [];
      for (const s of r.values()) {
        if (s.type === 'outbound-rtp') {
          outbound.push({
            rid: s.rid,
            ssrc: s.ssrc,
            frameWidth: s.frameWidth,
            frameHeight: s.frameHeight,
            fps: s.framesPerSecond,
            framesEncoded: s.framesEncoded,
            kbps: null,
            bytesSent: s.bytesSent,
            qualityLimitationReason: s.qualityLimitationReason,
            encoder: s.encoderImplementation,
            active: s.active,
            nackCount: s.nackCount,
            pliCount: s.pliCount,
            firCount: s.firCount,
          });
        }
      }
      const a = await mic.getStats();
      let audioOut = null;
      for (const s of a.values())
        if (s.type === 'outbound-rtp')
          audioOut = { packetsSent: s.packetsSent, bytesSent: s.bytesSent };
      return {
        video: outbound.sort((x, y) => String(x.rid).localeCompare(String(y.rid))),
        audio: audioOut,
        pair: await selectedPair(client.sendTransport),
        audioChunks,
        videoFrames,
      };
    };
    handlers.close = async () => {
      closing = true;
      clearInterval(pump);
      mic.close();
      cam.close();
      audioTrack.stop();
      videoTrack.stop();
      client.close();
      rl.close();
      setTimeout(() => {
        console.error('[producer] still alive 5 s after close:', process.getActiveResourcesInfo());
      }, 5000).unref();
    };
  } else {
    const client = await createClient({ rpc, name: 'consumer', handlerName, send: false });
    const live = { audio: null, video: null, audioSink: null, videoSink: null };
    const frameLog = { count: 0, width: 0, height: 0, sizes: {} };
    let audioBuf = [];
    let audioMeta = null;
    handlers.consume = async ({ audioId, videoId }) => {
      live.audio = await client.consume(audioId);
      live.video = await client.consume(videoId);
      live.audioSink = new RTCAudioSink(live.audio.track);
      live.videoSink = new RTCVideoSink(live.video.track);
      live.audioSink.addEventListener('data', (e) => {
        audioMeta = {
          sampleRate: e.sampleRate,
          channelCount: e.channelCount,
          numberOfFrames: e.numberOfFrames,
          bitsPerSample: e.bitsPerSample,
        };
        if (audioBuf) {
          const ch = e.channelCount;
          for (let i = 0; i < e.numberOfFrames; i++) audioBuf.push(e.samples[i * ch]);
        }
      });
      live.videoSink.addEventListener('frame', (e) => {
        frameLog.count++;
        frameLog.width = e.frame.width;
        frameLog.height = e.frame.height;
        const k = `${e.frame.width}x${e.frame.height}`;
        frameLog.sizes[k] = (frameLog.sizes[k] ?? 0) + 1;
      });
      return { audioConsumerId: live.audio.id, videoConsumerId: live.video.id };
    };
    handlers.audioCheck = async () => {
      audioBuf = [];
      await sleep(1000);
      const s = audioBuf;
      audioBuf = null;
      let crossings = 0;
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < s.length; i++) {
        sumSq += s[i] * s[i];
        peak = Math.max(peak, Math.abs(s[i]));
        if (i && s[i - 1] < 0 !== s[i] < 0) crossings++;
      }
      const secs = s.length / (audioMeta?.sampleRate ?? 48000);
      return {
        ...audioMeta,
        samples: s.length,
        freqHz: crossings / 2 / secs,
        rms: Math.sqrt(sumSq / s.length),
        peak,
      };
    };
    handlers.frames = async () => ({ ...frameLog, sizes: { ...frameLog.sizes } });
    handlers.resetFrames = async () => {
      frameLog.sizes = {};
      return null;
    };
    handlers.stats = async () => {
      const pick = async (consumer) => {
        const r = await consumer.getStats();
        for (const s of r.values()) {
          if (s.type === 'inbound-rtp') {
            return {
              kind: s.kind,
              packetsReceived: s.packetsReceived,
              packetsLost: s.packetsLost,
              jitterMs: s.jitter * 1000,
              frameWidth: s.frameWidth,
              frameHeight: s.frameHeight,
              fps: s.framesPerSecond,
              framesDecoded: s.framesDecoded,
              framesDropped: s.framesDropped,
              keyFramesDecoded: s.keyFramesDecoded,
              nackCount: s.nackCount,
              pliCount: s.pliCount,
              firCount: s.firCount,
              decoder: s.decoderImplementation,
              totalAudioEnergy: s.totalAudioEnergy,
              concealedSamples: s.concealedSamples,
              totalSamplesReceived: s.totalSamplesReceived,
            };
          }
        }
        return null;
      };
      return {
        audio: await pick(live.audio),
        video: await pick(live.video),
        pair: await selectedPair(client.recvTransport),
      };
    };

    // The consume-round cost: a fresh receive transport, consumers added one
    // at a time; each consume() is one mediasoup-client receive() round.
    const series = [];
    handlers.consumeSeries = async ({ producerId, n, paused }) => {
      const c2 = await createClient({
        rpc,
        name: `series-${series.length}`,
        handlerName,
        send: false,
      });
      const rows = [];
      const consumers = [];
      for (let i = 1; i <= n; i++) {
        const mark = pcTimings.length;
        const t0 = performance.now();
        const cpu0 = process.cpuUsage();
        const consumer = await c2.consume(producerId, { paused });
        const cpu = process.cpuUsage(cpu0);
        const wallMs = performance.now() - t0;
        const steps = pcTimings.slice(mark);
        const by = (m) => steps.filter((s) => s.m === m).reduce((a, s) => a + s.ms, 0);
        rows.push({
          i,
          wallMs,
          srdMs: by('setRemoteDescription'),
          answerMs: by('createAnswer'),
          sldMs: by('setLocalDescription'),
          cpuMs: (cpu.user + cpu.system) / 1000,
          steps: steps.length,
        });
        consumers.push(consumer);
      }
      // Steady state with n consumers: process CPU over 3 s.
      const c0 = process.cpuUsage();
      const t0 = performance.now();
      await sleep(3000);
      const c = process.cpuUsage(c0);
      const steadyCpuPct = (100 * (c.user + c.system)) / 1000 / (performance.now() - t0);
      // Are they all decoding (live) or all silent (paused)?
      const decoded = async () => {
        const r = await c2.recvTransport.getStats();
        return [...r.values()]
          .filter((s) => s.type === 'inbound-rtp')
          .map((s) => s.framesDecoded ?? s.packetsReceived ?? 0);
      };
      const d0 = await decoded();
      await sleep(1000);
      const d1 = await decoded();
      const flowing = d1.filter((v, i) => v > (d0[i] ?? 0)).length;
      series.push({ c2, consumers });
      return {
        rows,
        steadyCpuPct,
        inboundStreams: d1.length,
        flowing,
        serverConsumerIds: consumers.map((x) => x.id),
      };
    };
    handlers.closeSeries = async () => {
      for (const { c2, consumers } of series.splice(0)) {
        for (const c of consumers) c.close();
        c2.close();
      }
      return null;
    };
    handlers.close = async () => {
      closing = true;
      live.audioSink?.stop();
      live.videoSink?.stop();
      live.audio?.close();
      live.video?.close();
      await handlers.closeSeries();
      client.close();
      rl.close();
      setTimeout(() => {
        console.error('[consumer] still alive 5 s after close:', process.getActiveResourcesInfo());
      }, 5000).unref();
    };
  }
  out({ id: 0, result: 'ready' });
}

// ---------------------------------------------------------------------------
// Driver

function spawnChild(name, rpcUrl) {
  const p = spawn(
    process.execPath,
    [THIS, '--role', name, '--rpc', rpcUrl, '--handler', handlerName],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
    },
  );
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: p.stdout }).on('line', (l) => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      console.error(`[${name}] ${l}`);
      return;
    }
    const w = pending.get(m.id);
    if (!w) return;
    pending.delete(m.id);
    if (m.error) w.reject(new Error(`${name}: ${m.error}`));
    else w.resolve(m.result);
  });
  const ready = new Promise((resolve) => pending.set(0, { resolve, reject: resolve }));
  const exited = new Promise((res) =>
    p.on('exit', (code, sig) => res({ code, sig, at: performance.now() })),
  );
  return {
    p,
    ready,
    exited,
    call: (cmd, args) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        p.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
      }),
  };
}

async function driver() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`,
    );
  };
  const sfu = await createSfu();
  const { url, server } = await serveHttp(sfu.rpc);
  console.log(`mediasoup ${sfu.version}, handler ${handlerName}`);
  const P = spawnChild('producer', url);
  const C = spawnChild('consumer', url);
  const watchdog = setTimeout(() => {
    console.error('media: timed out; killing children');
    P.p.kill('SIGKILL');
    C.p.kill('SIGKILL');
    process.exit(2);
  }, 300_000);
  await Promise.all([P.ready, C.ready]);

  const prod = await P.call('produce');
  check('produce audio + 3-layer simulcast video', prod.videoEncodings.length === 3, {
    codec: prod.videoCodec,
    encodings: prod.videoEncodings.map((e) => e.rid ?? e.ssrc),
  });
  const cons = await C.call('consume', { audioId: prod.audioId, videoId: prod.videoId });

  // Wait for the full layer stack (sender BWE ramps from 500 kbps).
  const t0 = performance.now();
  let layers = null;
  while (performance.now() - t0 < 20000) {
    layers = (await sfu.rpc('consumerState', { consumerId: cons.videoConsumerId })).currentLayers;
    if (layers?.spatialLayer === 2) break;
    await sleep(250);
  }
  check('SFU consumer reaches spatial layer 2', layers?.spatialLayer === 2, {
    afterMs: Math.round(performance.now() - t0),
    layers,
  });

  const audio = await C.call('audioCheck');
  check('audible 440 Hz tone', Math.abs(audio.freqHz - 440) < 10 && audio.rms > 1000, audio);

  const expected = { 0: [320, 180], 1: [640, 360], 2: [1280, 720] };
  for (const spatialLayer of [0, 1, 2, 0, 2]) {
    await sfu.rpc('setPreferredLayers', {
      consumerId: cons.videoConsumerId,
      spatialLayer,
      temporalLayer: 2,
    });
    const s0 = performance.now();
    let f;
    while (performance.now() - s0 < 10000) {
      f = await C.call('frames');
      if (f.width === expected[spatialLayer][0] && f.height === expected[spatialLayer][1]) break;
      await sleep(50);
    }
    const okSize = f.width === expected[spatialLayer][0] && f.height === expected[spatialLayer][1];
    const state = await sfu.rpc('consumerState', { consumerId: cons.videoConsumerId });
    check(
      `preferred spatial layer ${spatialLayer} -> sink ${expected[spatialLayer].join('x')}`,
      okSize,
      {
        switchMs: Math.round(performance.now() - s0),
        sink: `${f.width}x${f.height}`,
        frames: f.count,
        currentLayers: state.currentLayers,
      },
    );
    await sleep(1000);
  }

  // The producer caps its own layers; the consumer still prefers layer 2.
  // Re-enabling must bring back the original layer sizes: the round trip
  // through getParameters() mustn't pin the scales.
  for (const maxLayer of [0, 2]) {
    await P.call('setMaxSpatialLayer', { spatialLayer: maxLayer });
    const s0 = performance.now();
    let f;
    while (performance.now() - s0 < 20000) {
      f = await C.call('frames');
      if (f.width === expected[maxLayer][0] && f.height === expected[maxLayer][1]) break;
      await sleep(50);
    }
    const sizes = (await P.call('stats')).video
      .filter((v) => v.active !== false)
      .map((v) => `${v.frameWidth}x${v.frameHeight}`)
      .sort();
    check(
      `producer setMaxSpatialLayer(${maxLayer}) -> sink ${expected[maxLayer].join('x')}`,
      f.width === expected[maxLayer][0] && f.height === expected[maxLayer][1],
      { switchMs: Math.round(performance.now() - s0), sink: `${f.width}x${f.height}`, sizes },
    );
  }
  const layerSizes = (await P.call('stats')).video.map((v) => `${v.frameWidth}x${v.frameHeight}`);
  check(
    'producer layers keep their sizes after setMaxSpatialLayer',
    ['1280x720', '320x180', '640x360'].every((size) => layerSizes.includes(size)),
    layerSizes,
  );

  // Stats: both clients and mediasoup.
  await sleep(1000);
  const ps = await P.call('stats');
  const cs = await C.call('stats');
  const msProducer = await sfu.rpc('getStats', { kind: 'producer', id: prod.videoId });
  const msConsumer = await sfu.rpc('getStats', { kind: 'consumer', id: cons.videoConsumerId });
  const msAudioConsumer = await sfu.rpc('getStats', { kind: 'consumer', id: cons.audioConsumerId });
  check(
    'producer getStats: 3 outbound-rtp, each encoding',
    ps.video.length === 3 && ps.video.every((v) => v.framesEncoded > 0),
    ps.video.map(
      (v) =>
        `${v.rid}: ${v.frameWidth}x${v.frameHeight} @${v.fps}fps enc=${v.framesEncoded} ${v.encoder} ql=${v.qualityLimitationReason}`,
    ),
  );
  check(
    'consumer getStats: video decoding, audio received',
    cs.video?.framesDecoded > 0 && cs.audio?.packetsReceived > 0,
    { video: cs.video, audio: cs.audio },
  );
  check(
    'mediasoup producer stats: 3 streams with score',
    msProducer.length === 3,
    msProducer.map((s) => ({
      rid: s.rid,
      score: s.score,
      bitrate: s.bitrate,
      packetsLost: s.packetsLost,
      nackCount: s.nackCount,
      pliCount: s.pliCount,
    })),
  );
  check(
    'mediasoup consumer stats',
    msConsumer.length >= 1,
    msConsumer
      .map((s) => ({
        type: s.type,
        score: s.score,
        bitrate: s.bitrate,
        packetsLost: s.packetsLost,
        nackCount: s.nackCount,
        pliCount: s.pliCount,
        firCount: s.firCount,
      }))
      .concat(msAudioConsumer.map((s) => ({ type: s.type, score: s.score, bitrate: s.bitrate }))),
  );
  check('candidate pairs avoid the VPN', !ps.pair?.vpn && !cs.pair?.vpn, {
    producer: `${ps.pair?.local} -> ${ps.pair?.remote}`,
    consumer: `${cs.pair?.local} -> ${cs.pair?.remote}`,
  });

  // Consume-round cost.
  const seriesOut = {};
  if (!argv.includes('--skip-series')) {
    for (const [label, producerId, paused] of [
      ['video, paused', prod.videoId, true],
      ['video, live', prod.videoId, false],
      ['audio, live', prod.audioId, false],
    ]) {
      const s = await C.call('consumeSeries', { producerId, n: MAX_CONSUMERS, paused });
      seriesOut[label] = s;
      const pickRows = s.rows.filter(
        (r) => [1, 2, 5, 10, 15, 20].includes(r.i) || r.i === MAX_CONSUMERS,
      );
      console.log(
        `consume series (${label}): steady CPU with ${MAX_CONSUMERS}: ${s.steadyCpuPct.toFixed(0)}%, inbound streams ${s.inboundStreams}, flowing ${s.flowing}`,
      );
      console.log('  n | wall ms | SRD ms | createAnswer ms | SLD ms | CPU ms');
      for (const r of pickRows)
        console.log(
          `  ${r.i} | ${r.wallMs.toFixed(1)} | ${r.srdMs.toFixed(1)} | ${r.answerMs.toFixed(1)} | ${r.sldMs.toFixed(1)} | ${r.cpuMs.toFixed(1)}`,
        );
      check(
        `consume series (${label}): ${MAX_CONSUMERS} consumers`,
        s.rows.length === MAX_CONSUMERS && (paused ? true : s.flowing === MAX_CONSUMERS),
        { flowing: s.flowing, inbound: s.inboundStreams },
      );
      await C.call('closeSeries');
      await sleep(500);
    }
  }

  // Close everything; the children must then exit on their own.
  await C.call('close');
  await P.call('close');
  const closedAt = performance.now();
  P.p.stdin.end();
  C.p.stdin.end();
  const exits = await Promise.race([
    Promise.all([P.exited, C.exited]),
    sleep(15000).then(() => null),
  ]);
  if (!exits) {
    check('both client processes exit on their own', false, 'still running 15 s after close');
    P.p.kill('SIGKILL');
    C.p.kill('SIGKILL');
  } else {
    check(
      'both client processes exit on their own',
      exits.every((e) => e.code === 0),
      exits.map((e) => ({ code: e.code, sig: e.sig, afterMs: Math.round(e.at - closedAt) })),
    );
  }
  clearTimeout(watchdog);
  server.close();
  sfu.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  if (argv.includes('--json')) console.error(JSON.stringify({ results, series: seriesOut }));
  process.exitCode = failed ? 1 : 0;
}

if (role) await child();
else await driver();
