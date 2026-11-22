// The video send path at many source sizes: an RTCVideoSource producer
// through a mediasoup SFU with mediasoup-client's Safari12 handler (what
// @whereby.com/media uses in Node) and Whereby's camera settings
// (VIDEO_SETTINGS_HD: three layers, legacy SDP simulcast under Safari12).
// Each size runs in a child process of its own, with its own SFU worker.
//
//   MEDIASOUP_DIR=... node video-sizes.mjs [--sizes 160x120,640x480,...]
//       [--settings HD|SD|ONE] [--cap kbps] [--maxfr N] [--apply-maxbitrate]
//       [--screencast] [--degradation balanced] [--content noise|ramp] [--warmup s] [--seconds s] [--json]
//
// The tables in SPEC-LAYER-PLAN.md ("Video send path") come from
//   node video-sizes.mjs --content ramp
// plus the --maxfr 15, --apply-maxbitrate and --settings ONE --cap 300
// (--warmup 25) variants at --sizes 1280x720(,1920x1080).
//
// Per size it prints each layer (SSRC) as the sender encoded it over the
// window: size, fps, kbps and quality limitation; the SFU's receive
// bitrate per layer; and the producer process's CPU (our library plus
// mediasoup-client and frame pushing; the worker is a separate process).
//   --cap: the SFU's setMaxIncomingBitrate on the send transport (kbps)
//   --maxfr: setParameters maxFramerate on every encoding after produce
//   --apply-maxbitrate: setParameters with Whereby's per-layer maxBitrate,
//     which Safari12 never applies itself (see docs/sfu-test.md)
//   --degradation: setParameters degradationPreference (balanced,
//     maintain-framerate) after produce; senders default to
//     maintain-resolution
//   --content: what is pushed. noise (default): 16x16 random blocks
//     panning 4 px a frame, the hard case (libvpx drops frames to hold
//     the bitrate). ramp: a panning luma ramp, easy like a steady camera.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient, createSfu, installWrtcGlobals, sleep } from './common.mjs';

const THIS = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);
const warmup = Number(arg('--warmup', 10));
const seconds = Number(arg('--seconds', 5));

// @whereby.com/media mediaSettings.ts.
const SETTINGS = {
  HD: {
    codecOptions: { videoGoogleStartBitrate: 500 },
    encodings: [
      { scaleResolutionDownBy: 4, maxBitrate: 150000 },
      { scaleResolutionDownBy: 2, maxBitrate: 500000 },
      { scaleResolutionDownBy: 1, maxBitrate: 1000000 },
    ],
  },
  SD: {
    codecOptions: { videoGoogleStartBitrate: 500 },
    encodings: [
      { scaleResolutionDownBy: 2, maxBitrate: 150000 },
      { scaleResolutionDownBy: 1, maxBitrate: 500000 },
    ],
  },
  ONE: { encodings: [{}] },
};

/** A 16x16-block noise texture panning 4 px a frame: real work for the encoder. */
function makeFrames(w, h, n) {
  const step = 4;
  const bw = w + n * step;
  const base = new Uint8Array(bw * h);
  for (let by = 0; by < Math.ceil(h / 16); by++) {
    for (let bx = 0; bx < Math.ceil(bw / 16); bx++) {
      const v = (Math.random() * 200 + 28) | 0;
      for (let y = by * 16; y < Math.min(h, by * 16 + 16); y++)
        base.fill(v, y * bw + bx * 16, Math.min(y * bw + bw, y * bw + bx * 16 + 16));
    }
  }
  const chroma = ((w + 1) >> 1) * ((h + 1) >> 1);
  return Array.from({ length: n }, (_, f) => {
    const data = new Uint8Array(w * h + 2 * chroma).fill(128);
    for (let y = 0; y < h; y++)
      data.set(base.subarray(y * bw + f * step, y * bw + f * step + w), y * w);
    return { width: w, height: h, data };
  });
}

/**
 * Easy content: a diagonal luma ramp (period 256 px) panning 4 px a frame,
 * with mild colour. Motion search follows it, as with a steady camera.
 */
function makeRamp(w, h, n) {
  const cw = (w + 1) >> 1;
  const ch = (h + 1) >> 1;
  return Array.from({ length: n }, (_, f) => {
    const data = new Uint8Array(w * h + 2 * cw * ch);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) data[y * w + x] = 40 + (((x + y + 4 * f) & 255) * 5) / 8;
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        data[w * h + y * cw + x] = 112 + (x * 32) / cw;
        data[w * h + cw * ch + y * cw + x] = 112 + (y * 32) / ch;
      }
    return { width: w, height: h, data };
  });
}

async function child() {
  const [W, H] = arg('--size').split('x').map(Number);
  const settings = SETTINGS[arg('--settings', 'HD')];
  const cap = arg('--cap', null);
  const maxfr = arg('--maxfr', null);
  const wrtc = await installWrtcGlobals();
  const sfu = await createSfu();
  const serverTransports = [];
  sfu.router.observer.on('newtransport', (t) => serverTransports.push(t));
  const client = await createClient({
    rpc: sfu.rpc,
    name: 'producer',
    handlerName: 'Safari12',
    recv: false,
    sctp: false,
  });
  const source = new wrtc.nonstandard.RTCVideoSource({ isScreencast: has('--screencast') });
  const track = source.createTrack();
  const frames = arg('--content', 'noise') === 'ramp' ? makeRamp(W, H, 15) : makeFrames(W, H, 15);
  const start = performance.now();
  let n = 0;
  // 30 fps on a drift-free clock, never more than one frame per tick.
  const pump = setInterval(() => {
    const due = Math.floor(((performance.now() - start) * 30) / 1000);
    if (n < due) {
      source.onFrame(frames[n % frames.length]);
      n = due;
    }
  }, 4);
  const result = { size: `${W}x${H}` };
  try {
    const producer = await client.sendTransport.produce({
      track,
      stopTracks: false,
      disableTrackOnPause: false,
      ...settings,
    });
    if (cap) await serverTransports[0].setMaxIncomingBitrate(Number(cap) * 1000);
    if (maxfr || has('--apply-maxbitrate') || arg('--degradation', null)) {
      const p = producer.rtpSender.getParameters();
      p.encodings.forEach((e, i) => {
        if (maxfr) e.maxFramerate = Number(maxfr);
        const maxBitrate = settings.encodings[i]?.maxBitrate;
        if (has('--apply-maxbitrate') && maxBitrate) e.maxBitrate = maxBitrate;
      });
      if (arg('--degradation', null)) p.degradationPreference = arg('--degradation');
      await producer.rtpSender.setParameters(p);
    }
    const outbound = async () => {
      const out = [];
      (await client.sendTransport.getStats()).forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') out.push(s);
      });
      return out.sort((a, b) => a.ssrc - b.ssrc);
    };
    const sfuInbound = async () =>
      ((await sfu.rpc('getStats', { kind: 'producer', id: producer.id })) ?? [])
        .filter((s) => s.type === 'inbound-rtp')
        .sort((a, b) => a.ssrc - b.ssrc);
    await sleep(warmup * 1000);
    const sizes = new Map();
    const a = await outbound();
    const sfuA = await sfuInbound();
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    for (let i = 0; i < seconds; i++) {
      await sleep(1000);
      for (const s of await outbound()) {
        if (!sizes.has(s.ssrc)) sizes.set(s.ssrc, new Set());
        if (s.frameWidth) sizes.get(s.ssrc).add(`${s.frameWidth}x${s.frameHeight}`);
      }
    }
    const wall = performance.now() - t0;
    const cpu = process.cpuUsage(c0);
    const b = await outbound();
    const sfuB = await sfuInbound();
    result.cpuPct = Math.round(((cpu.user + cpu.system) / 1000 / wall) * 100);
    result.layers = b.map((x) => {
      const p = a.find((y) => y.ssrc === x.ssrc) ?? {};
      const dt = (x.timestamp - (p.timestamp ?? x.timestamp)) / 1000 || seconds;
      return {
        size: x.frameWidth ? `${x.frameWidth}x${x.frameHeight}` : null,
        sizesSeen: [...(sizes.get(x.ssrc) ?? [])],
        fps: +(((x.framesEncoded ?? 0) - (p.framesEncoded ?? 0)) / dt).toFixed(1),
        kbps: Math.round((((x.bytesSent ?? 0) - (p.bytesSent ?? 0)) * 8) / dt / 1000),
        limitation: x.qualityLimitationReason,
        encoder: x.encoderImplementation,
      };
    });
    result.sfuKbps = sfuB.map((x) => {
      const p = sfuA.find((y) => y.ssrc === x.ssrc) ?? {};
      return Math.round((((x.byteCount ?? 0) - (p.byteCount ?? 0)) * 8) / (wall / 1000) / 1000);
    });
    producer.close();
  } catch (e) {
    result.error = String(e?.stack ?? e);
  }
  clearInterval(pump);
  track.stop();
  client.close();
  sfu.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** Runs one size in a child process, killed if it outlives its budget. */
function runSize(size) {
  const forward = argv.filter(
    (a, i) => a !== '--sizes' && argv[i - 1] !== '--sizes' && a !== '--json',
  );
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [THIS, '--child', '--size', size, ...forward], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), (warmup + seconds + 60) * 1000);
    p.on('exit', (code, sig) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop();
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ size, error: `child exited (${code ?? sig}) without a result` });
      }
    });
  });
}

async function driver() {
  const sizes = arg('--sizes', '160x120,320x240,321x241,640x360,640x480,1280x720,1920x1080').split(
    ',',
  );
  const all = [];
  for (const size of sizes) {
    const r = await runSize(size);
    all.push(r);
    if (r.error) {
      console.log(`${size}: ERROR ${r.error.split('\n')[0]}`);
      continue;
    }
    const layers = r.layers
      .map(
        (l) =>
          `${l.size ?? '-'}@${l.fps}fps/${l.kbps}k${l.sizesSeen.length > 1 ? ` (seen ${l.sizesSeen.join(',')})` : ''}${l.limitation && l.limitation !== 'none' ? ` [${l.limitation}]` : ''}`,
      )
      .join('  ');
    console.log(
      `${size.padEnd(9)} ${layers} | SFU ${r.sfuKbps.join('/')}k | CPU ${r.cpuPct}% | ${r.layers[0]?.encoder ?? ''}`,
    );
  }
  if (has('--json')) console.error(JSON.stringify(all));
}

if (has('--child')) await child();
else await driver();
