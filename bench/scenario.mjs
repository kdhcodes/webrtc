// One benchmark run against one implementation, in its own process: never
// load @roamhq/wrtc and our addon into the same process. bench/run.mjs
// starts it once per run and parses the JSON it prints.
//
//   node bench/scenario.mjs ours|wrtc '<config JSON>'
//
// Config: { kind: 'media' | 'local' | 'control', pairs, audio, width, height,
// fps, warmupS, durationS, iterations }. See CONFIGS in run.mjs.
import { writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';

const impl = process.argv[2];
const config = JSON.parse(process.argv[3]);
const loadStarted = performance.now();
const w =
  impl === 'wrtc'
    ? createRequire(import.meta.url)('@roamhq/wrtc')
    : // Compiled dist/ by default, as an installed package runs; `src: true`
      // loads lib/ through Node's type stripping, which costs memory and
      // startup time a real install doesn't pay.
      await import(config.src ? '../lib/index.ts' : '../dist/index.js');
const loadMs = performance.now() - loadStarted;
const { RTCPeerConnection, MediaStream, nonstandard } = w;
const { RTCAudioSource, RTCAudioSink, RTCVideoSource, RTCVideoSink } = nonstandard;

/** stdout synchronously, retrying EAGAIN (see test/compat/two-pc-media-scenario.mjs). */
function writeAll(text) {
  const bytes = Buffer.from(text);
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(1, bytes, written);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with the next matching `type` event; rejects after `ms` (failure guard). */
function next(target, type, pred = () => true, ms = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${impl}: no ${type} event`)), ms);
    const listener = (event) => {
      if (!pred(event)) return;
      clearTimeout(timer);
      target.removeEventListener(type, listener);
      resolve(event);
    };
    target.addEventListener(type, listener);
  });
}

const connected = (pc) =>
  pc.connectionState === 'connected'
    ? Promise.resolve()
    : next(pc, 'connectionstatechange', () => pc.connectionState === 'connected');

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
const median = (values) => percentile(values, 50);
const sum = (values) => values.reduce((a, b) => a + b, 0);

// --- Content: a moving texture with a frame counter in the corner -----------
// A deterministic texture larger than the frame; each frame is a window into
// it that moves a few pixels per frame, so the encoder does real motion
// search, and generating a frame is just row copies (identical cost for
// both implementations, and measured separately as `genMsPerS`).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PAD = 256;
function makeTexture(width, height) {
  const random = rng(42);
  const tw = width + PAD;
  const th = height + PAD;
  const luma = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      luma[y * tw + x] =
        128 + 50 * Math.sin(x / 17) * Math.cos(y / 23) + 30 * Math.sin((x + 2 * y) / 41);
    }
  }
  for (let i = 0; i < (tw * th) / 2000; i++) {
    const rw = 8 + Math.floor(random() * 60);
    const rh = 8 + Math.floor(random() * 60);
    const rx = Math.floor(random() * (tw - rw));
    const ry = Math.floor(random() * (th - rh));
    const value = Math.floor(random() * 256);
    for (let y = ry; y < ry + rh; y++) luma.fill(value, y * tw + rx, y * tw + rx + rw);
  }
  const cw = tw / 2;
  const ch = th / 2;
  const u = new Uint8Array(cw * ch);
  const v = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      u[y * cw + x] = 128 + 40 * Math.sin(x / 29);
      v[y * cw + x] = 128 + 40 * Math.cos(y / 31);
    }
  }
  return { tw, th, luma, u, v };
}

// The counter: 24 cells of 16x16 (macroblock-aligned, so they survive VP8
// at low bitrates), 6 columns by 4 rows at the top left. Bits 0-15 are the
// frame number, bits 16-23 a check byte.
const CELL = 16;
const COLS = 6;
const ROWS = 4;
const check = (n) => ((n & 0xff) ^ (n >> 8) ^ 0xa5) & 0xff;

function makeFramer(width, height) {
  const texture = makeTexture(width, height);
  const cw = width / 2;
  const ch = height / 2;
  const data = new Uint8Array(width * height + 2 * cw * ch);
  const frame = { width, height, data };
  return (n) => {
    const ox = (n * 3) % PAD;
    const oy = (n * 2) % PAD;
    const { tw, luma, u, v } = texture;
    for (let y = 0; y < height; y++) {
      const from = (y + oy) * tw + ox;
      data.set(luma.subarray(from, from + width), y * width);
    }
    const ctw = tw / 2;
    const uBase = width * height;
    const vBase = uBase + cw * ch;
    for (let y = 0; y < ch; y++) {
      const from = (y + oy / 2) * ctw + Math.floor(ox / 2);
      data.set(u.subarray(from, from + cw), uBase + y * cw);
      data.set(v.subarray(from, from + cw), vBase + y * cw);
    }
    const bits = (n & 0xffff) | (check(n & 0xffff) << 16);
    for (let cell = 0; cell < COLS * ROWS; cell++) {
      const value = (bits >> cell) & 1 ? 235 : 16;
      const x0 = (cell % COLS) * CELL;
      const y0 = Math.floor(cell / COLS) * CELL;
      for (let y = y0; y < y0 + CELL; y++) data.fill(value, y * width + x0, y * width + x0 + CELL);
    }
    for (let y = 0; y < (ROWS * CELL) / 2; y++) {
      data.fill(128, uBase + y * cw, uBase + y * cw + (COLS * CELL) / 2);
      data.fill(128, vBase + y * cw, vBase + y * cw + (COLS * CELL) / 2);
    }
    return frame;
  };
}

/** The frame number in a received frame (scaled if the encoder downscaled), or null. */
function readCounter(frame, sentWidth) {
  const { width, height, data } = frame;
  const scale = width / sentWidth;
  let bits = 0;
  for (let cell = 0; cell < COLS * ROWS; cell++) {
    const x = Math.floor(((cell % COLS) * CELL + CELL / 2) * scale);
    const y = Math.floor((Math.floor(cell / COLS) * CELL + CELL / 2) * scale);
    if (x >= width || y >= height) return null;
    const luma = (data[y * width + x] + data[y * width + x - 1] + data[(y - 1) * width + x]) / 3;
    if (luma > 128) bits |= 1 << cell;
  }
  const n = bits & 0xffff;
  return bits >>> 16 === check(n) ? n : null;
}

// --- Measurement ---------------------------------------------------------------
const ELD_RESOLUTION_MS = 10;

/** Time spent inside this script's own sink handlers (onframe/ondata), in ms. */
const handlers = { ms: 0 };

/** Starts every process-level measurement; stop() returns the metrics for the window. */
function startWindow() {
  handlers.ms = 0;
  const elu = performance.eventLoopUtilization();
  const eld = monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS });
  eld.enable();
  const gc = { count: 0, ms: 0, major: 0, minor: 0 };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count++;
      gc.ms += entry.duration;
      // NODE_PERFORMANCE_GC_MAJOR = 4, _MINOR = 1
      if (entry.detail?.kind === 4) gc.major++;
      if (entry.detail?.kind === 1) gc.minor++;
    }
  });
  observer.observe({ entryTypes: ['gc'] });
  const memory = [];
  const sample = () => {
    const m = process.memoryUsage();
    memory.push(m);
  };
  sample();
  const sampler = setInterval(sample, 500);
  const cpu = process.cpuUsage();
  // The JS (main) thread's own CPU time: unlike event-loop utilization,
  // which is wall-clock, it isn't inflated when the thread is preempted.
  const mainCpu = process.threadCpuUsage();
  const started = performance.now();
  return {
    stop() {
      const elapsedS = (performance.now() - started) / 1000;
      const used = process.cpuUsage(cpu);
      const usedMain = process.threadCpuUsage(mainCpu);
      const busy = performance.eventLoopUtilization(elu);
      const handlerMs = handlers.ms;
      clearInterval(sampler);
      sample();
      eld.disable();
      observer.disconnect();
      const delay = (p) => Math.max(0, eld.percentile(p) / 1e6 - ELD_RESOLUTION_MS);
      const mb = (values) => values.map((v) => v / 2 ** 20);
      return {
        windowS: elapsedS,
        cpuPct: ((used.user + used.system) / 1e3 / elapsedS / 1000) * 100,
        cpuUserPct: (used.user / 1e3 / elapsedS / 1000) * 100,
        cpuSysPct: (used.system / 1e3 / elapsedS / 1000) * 100,
        rssMedianMB: median(mb(memory.map((m) => m.rss))),
        rssMaxMB: Math.max(...mb(memory.map((m) => m.rss))),
        maxRssMB: (process.resourceUsage().maxRSS * 1024) / 2 ** 20,
        heapUsedMedianMB: median(mb(memory.map((m) => m.heapUsed))),
        heapUsedMaxMB: Math.max(...mb(memory.map((m) => m.heapUsed))),
        externalMedianMB: median(mb(memory.map((m) => m.external))),
        eldP50Ms: delay(50),
        eldP99Ms: delay(99),
        eldMaxMs: Math.max(0, eld.max / 1e6 - ELD_RESOLUTION_MS),
        gcPerS: gc.count / elapsedS,
        gcMajorPerS: gc.major / elapsedS,
        gcMsPerS: gc.ms / elapsedS,
        // The JS thread's busy time (event-loop utilization), and the part
        // of it spent in this script's own sink handlers.
        jsBusyMsPerS: busy.active / elapsedS,
        mainThreadCpuMsPerS: (usedMain.user + usedMain.system) / 1e3 / elapsedS,
        handlerMsPerS: handlerMs / elapsedS,
      };
    },
  };
}

/** Wraps a sink handler so its time counts into `handlers.ms`. */
const timed = (fn) => (event) => {
  const t0 = performance.now();
  try {
    fn(event);
  } finally {
    handlers.ms += performance.now() - t0;
  }
};

// --- Media on a drift-corrected clock -------------------------------------------
/**
 * Pushes 10 ms of audio to every audio source and, at `fps`, one frame to
 * every video source, on deadlines computed from the start time (so timer
 * jitter doesn't accumulate). Late audio is caught up (it must be
 * continuous); a video frame more than one interval late is skipped.
 */
function startPump({ audioSources, videoSources, width, height, fps, sentAt = new Map() }) {
  const framer = videoSources.length > 0 ? makeFramer(width, height) : null;
  const samples = new Int16Array(480);
  const stats = {
    audioPushes: 0,
    videoPushes: 0,
    videoSkipped: 0,
    lateMs: [],
    pushMs: 0,
    genMs: 0,
    frame: 0,
  };
  const start = performance.now();
  const frameMs = 1000 / fps;
  let audioN = 0;
  let videoN = 0;
  let timer = null;
  let running = true;
  const tick = () => {
    if (!running) return;
    const now = performance.now();
    stats.lateMs.push(
      now - Math.min(start + audioN * 10, framer ? start + videoN * frameMs : 1e15),
    );
    while (start + audioN * 10 <= now) {
      const base = audioN * 480;
      const g0 = performance.now();
      for (let i = 0; i < 480; i++) {
        samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (base + i)) / 48_000));
      }
      const p0 = performance.now();
      for (const source of audioSources) source.onData({ samples, sampleRate: 48_000 });
      const p1 = performance.now();
      stats.genMs += p0 - g0;
      stats.pushMs += p1 - p0;
      stats.audioPushes++;
      audioN++;
    }
    if (framer) {
      if (start + (videoN + 1) * frameMs <= now) {
        const due = Math.floor((now - start) / frameMs);
        stats.videoSkipped += due - videoN;
        videoN = due;
      }
      if (start + videoN * frameMs <= now) {
        const n = stats.frame++;
        const g0 = performance.now();
        const frame = framer(n);
        const p0 = performance.now();
        sentAt.set(n & 0xffff, p0);
        for (const source of videoSources) source.onFrame(frame);
        const p1 = performance.now();
        stats.genMs += p0 - g0;
        stats.pushMs += p1 - p0;
        stats.videoPushes++;
        videoN++;
      }
    }
    const nextAudio = start + audioN * 10;
    const nextVideo = framer ? start + videoN * frameMs : Infinity;
    timer = setTimeout(tick, Math.max(0, Math.min(nextAudio, nextVideo) - performance.now()));
  };
  tick();
  return {
    stats,
    sentAt,
    resetStats() {
      stats.audioPushes = 0;
      stats.videoPushes = 0;
      stats.videoSkipped = 0;
      stats.lateMs = [];
      stats.pushMs = 0;
      stats.genMs = 0;
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
  };
}

/**
 * Counts a sink's deliveries, decodes the counter and records latency.
 * `expectedWidth` is the width this sink should see (a simulcast layer's).
 */
function watchVideo(sink, sentWidth, sentAt, expectedWidth = sentWidth) {
  const w = {
    frames: 0,
    seen: new Set(),
    latencies: [],
    undecodable: 0,
    fullRes: 0,
    sizes: {},
    first: null,
  };
  w.first = new Promise((resolve) => {
    sink.onframe = timed(({ frame }) => {
      const now = performance.now();
      w.frames++;
      const size = `${frame.width}x${frame.height}`;
      w.sizes[size] = (w.sizes[size] ?? 0) + 1;
      if (frame.width === expectedWidth) w.fullRes++;
      const n = readCounter(frame, sentWidth);
      if (n === null) {
        w.undecodable++;
      } else {
        w.seen.add(n);
        const sent = sentAt.get(n);
        if (sent !== undefined) w.latencies.push(now - sent);
      }
      resolve();
    });
  });
  w.reset = () => {
    w.frames = 0;
    w.seen = new Set();
    w.latencies = [];
    w.undecodable = 0;
    w.fullRes = 0;
    w.sizes = {};
  };
  return w;
}

function watchAudio(sink) {
  const a = { callbacks: 0, samples: 0, first: null };
  a.first = new Promise((resolve) => {
    sink.ondata = timed(({ samples }) => {
      a.callbacks++;
      a.samples += samples.length;
      resolve();
    });
  });
  a.reset = () => {
    a.callbacks = 0;
    a.samples = 0;
  };
  return a;
}

/** The SDP with VP8 listed first in every video m-line, so both sides prefer it. */
function preferVp8(sdp) {
  const vp8 = new Set([...sdp.matchAll(/^a=rtpmap:(\d+) VP8\/90000/gm)].map((match) => match[1]));
  return sdp.replace(/^(m=video \d+ [A-Z/]+) ([\d ]+)$/gm, (_, head, pts) => {
    const list = pts.split(' ');
    return `${head} ${[...list.filter((p) => vp8.has(p)), ...list.filter((p) => !vp8.has(p))].join(' ')}`;
  });
}

/**
 * Trickles candidates both ways. `mids` translates a candidate's sdpMid for
 * the other side, where munged SDP gives the sides different mids.
 */
function trickle(a, b, mids = { toB: (mid) => mid, toA: (mid) => mid }) {
  const forward = (to, map) => (e) => {
    const { candidate } = e;
    if (!candidate?.candidate) return;
    const init = {
      candidate: candidate.candidate,
      sdpMid: map(candidate.sdpMid),
      sdpMLineIndex: candidate.sdpMLineIndex,
    };
    to.addIceCandidate(init).catch(() => {});
  };
  a.addEventListener('icecandidate', forward(b, mids.toB));
  b.addEventListener('icecandidate', forward(a, mids.toA));
}

// Simulcast between two libwebrtc peers. libwebrtc doesn't receive
// simulcast on one m-line peer to peer, so (as test/interop/codecs.interop.ts
// and WPT's simulcast tests do) the sender's one simulcast m-line becomes
// one m-line per rid for the receiver, with the rid header extension
// relabelled as the mid one, and the receiver's answer is folded back into
// one m-line receiving the rids. RTX is dropped (repaired-rid can't be
// reinterpreted).
const RID_EXT = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';
const RRID_EXT = 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id';
const MID_EXT = 'urn:ietf:params:rtp-hdrext:sdes:mid';
const sdpSections = (sdp) => {
  const [session, ...media] = sdp.trim().split(/\r\n(?=m=)/);
  return [session.split('\r\n'), ...media.map((m) => m.split('\r\n'))];
};
const sdpJoin = (lines) => `${lines.join('\r\n')}\r\n`;
const bundle = (session, mids) =>
  session.map((l) => (l.startsWith('a=group:BUNDLE') ? `a=group:BUNDLE ${mids.join(' ')}` : l));
const isCandidate = (line) => /^a=(candidate|end-of-candidates)/.test(line);

/** An offer with one simulcast video m-line -> one m-line per rid. */
function simulcastOfferToMids(sdp, rids) {
  const [session, video] = sdpSections(sdp);
  const rtx = video.flatMap((l) => /^a=rtpmap:(\d+) rtx\//.exec(l)?.[1] ?? []);
  const isRtx = (line) =>
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
    sdpJoin(bundle(session, rids)) +
    rids.map((rid) => sdpJoin([...base, `a=mid:${rid}`, `a=msid:simulcast ${rid}`])).join('')
  );
}

/** The answer with one m-line per rid -> one m-line receiving the rids. */
function midsAnswerToSimulcast(sdp, mid, rids) {
  const [session, first] = sdpSections(sdp);
  const media = first
    .filter((l) => !isCandidate(l))
    .map((l) =>
      l.startsWith('a=mid:') ? `a=mid:${mid}` : l.replace(` ${MID_EXT}`, ` ${RID_EXT}`),
    );
  return sdpJoin([
    ...bundle(session, [mid]),
    ...media,
    ...rids.map((rid) => `a=rid:${rid} recv`),
    `a=simulcast:recv ${rids.join(';')}`,
  ]);
}

/** Simulcast negotiation: a sends one m-line with `rids`, b receives one m-line per rid. */
async function negotiateSimulcast(a, b, rids) {
  const offer = await a.createOffer();
  const local = { type: 'offer', sdp: preferVp8(offer.sdp) };
  if (!/^a=simulcast:send /m.test(local.sdp)) {
    throw new Error(`${impl}: the offer has no a=simulcast line (sendEncodings with rids ignored)`);
  }
  await a.setLocalDescription(local);
  await b.setRemoteDescription({ type: 'offer', sdp: simulcastOfferToMids(local.sdp, rids) });
  await b.setLocalDescription(await b.createAnswer());
  const mid = /^a=mid:(.+)$/m.exec(local.sdp)[1];
  await a.setRemoteDescription({
    type: 'answer',
    sdp: midsAnswerToSimulcast(b.localDescription.sdp, mid, rids),
  });
}

/** Offer from a, answer from b. Returns each step's duration in ms. */
async function negotiate(a, b) {
  const steps = {};
  let t = performance.now();
  const lap = (name) => {
    const now = performance.now();
    steps[name] = now - t;
    t = now;
  };
  const offer = await a.createOffer();
  lap('createOffer');
  // Not a duration: how much SDP each step parses and serializes.
  steps.offerBytes = offer.sdp.length;
  steps.videoPayloadTypes = /^m=video \d+ [A-Z/]+ ([\d ]+)$/m
    .exec(offer.sdp)?.[1]
    .split(' ').length;
  const munged = { type: 'offer', sdp: preferVp8(offer.sdp) };
  await a.setLocalDescription(munged);
  lap('sldOffer');
  await b.setRemoteDescription(munged);
  lap('srdOffer');
  const answer = await b.createAnswer();
  lap('createAnswer');
  await b.setLocalDescription(answer);
  lap('sldAnswer');
  await a.setRemoteDescription(b.localDescription);
  lap('srdAnswer');
  return steps;
}

const SUMMED = {
  outbound: [
    'bytesSent',
    'packetsSent',
    'framesEncoded',
    'totalEncodeTime',
    'qpSum',
    'totalPacketSendDelay',
  ],
  inbound: [
    'framesDecoded',
    'framesDropped',
    'totalDecodeTime',
    'packetsLost',
    'jitterBufferDelay',
    'jitterBufferEmittedCount',
    'totalProcessingDelay',
  ],
};

/**
 * a's outbound and b's inbound RTP stats per kind, summed over streams
 * (several tracks, simulcast layers). A member counts as present only if
 * every stream reports it.
 */
async function rtpStats(a, b) {
  const out = {};
  const collect = (report, type, suffix, extra) => {
    for (const s of report.values()) {
      if (s.type !== type) continue;
      const key = `${s.kind}${suffix}`;
      out[key] ??= { streams: 0, codecs: [] };
      const group = out[key];
      group.streams++;
      for (const member of SUMMED[type === 'outbound-rtp' ? 'outbound' : 'inbound']) {
        const value = s[member];
        if (group.streams === 1) group[member] = typeof value === 'number' ? value : null;
        else if (group[member] !== null) {
          group[member] = typeof value === 'number' ? group[member] + value : null;
        }
      }
      const codec = report.get(s.codecId)?.mimeType;
      if (!group.codecs.includes(codec ?? 'unknown')) group.codecs.push(codec ?? 'unknown');
      extra(group, s);
    }
  };
  try {
    collect(await a.getStats(), 'outbound-rtp', 'Out', (group, s) => {
      group.encoderImplementation ??= s.encoderImplementation;
      group.qualityLimitationReason ??= s.qualityLimitationReason;
    });
  } catch (error) {
    out.sendError = `${error?.name}: ${error?.message}`;
  }
  try {
    collect(await b.getStats(), 'inbound-rtp', 'In', (group, s) => {
      group.decoderImplementation ??= s.decoderImplementation;
    });
  } catch (error) {
    out.receiveError = `${error?.name}: ${error?.message}`;
  }
  return out;
}

const delta = (end, start, path) => {
  const [group, key] = path.split('.');
  const x = end[group]?.[key];
  const y = start[group]?.[key];
  return typeof x === 'number' && typeof y === 'number' ? x - y : null;
};

// --- Scenarios -------------------------------------------------------------------
/** N loopback pairs: a sends audio and/or video from the nonstandard sources, b sinks it. */
async function media() {
  const { pairs: count, audio, width, height, fps, warmupS, durationS } = config;
  const videoTracks = config.videoTracks ?? 1;
  // [{ rid, scaleResolutionDownBy }], sent as one simulcast m-line (video only).
  const layers = config.simulcast ?? null;
  const rids = layers?.map((l) => l.rid);
  const video = width > 0;
  const audioSources = [];
  const videoSources = [];
  const pairs = [];
  const sinks = [];
  for (let i = 0; i < count; i++) {
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    // Simulcast: a's one m-line (mid 0) is b's m-lines `rids`, bundled on the first.
    trickle(a, b, layers ? { toB: () => rids[0], toA: () => '0' } : undefined);
    const stream = new MediaStream();
    const tracks = [];
    if (audio) {
      const source = new RTCAudioSource();
      audioSources.push(source);
      tracks.push(source.createTrack());
    }
    for (let k = 0; video && k < videoTracks; k++) {
      const source = new RTCVideoSource();
      videoSources.push(source);
      tracks.push(source.createTrack());
    }
    if (layers) {
      a.addTransceiver(tracks[0], {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: layers.map(({ rid, scaleResolutionDownBy }) => ({
          rid,
          scaleResolutionDownBy,
        })),
      });
    } else {
      for (const track of tracks) a.addTrack(track, stream);
    }
    const remote = [];
    b.addEventListener('track', (e) => remote.push({ track: e.track, mid: e.transceiver?.mid }));
    pairs.push({ a, b, tracks, remote });
  }
  // Media flows before negotiation so the first frames are there on connect.
  const pump = startPump({ audioSources, videoSources, width, height, fps });
  for (const pair of pairs) {
    if (layers) await negotiateSimulcast(pair.a, pair.b, rids);
    else await negotiate(pair.a, pair.b);
    await Promise.all([connected(pair.a), connected(pair.b)]);
    pair.audio = [];
    pair.video = [];
    for (const { track, mid } of pair.remote) {
      if (track.kind === 'audio') {
        const sink = new RTCAudioSink(track);
        sinks.push(sink);
        pair.audio.push(watchAudio(sink));
      } else {
        const sink = new RTCVideoSink(track);
        sinks.push(sink);
        const layer = layers?.find((l) => l.rid === mid);
        const expected = layer ? width / layer.scaleResolutionDownBy : width;
        pair.video.push(watchVideo(sink, width, pump.sentAt, expected));
      }
    }
  }
  const watchers = pairs.flatMap((p) => [...p.audio, ...p.video]);
  let guard = null;
  await Promise.race([
    Promise.all(watchers.map((x) => x.first)),
    new Promise((_, reject) => {
      guard = setTimeout(
        () => reject(new Error(`${impl}: no media at some sink after 20 s`)),
        20_000,
      );
    }),
  ]);
  clearTimeout(guard);
  await sleep(warmupS * 1000);

  const statsStart = await Promise.all(pairs.map((p) => rtpStats(p.a, p.b)));
  for (const x of watchers) x.reset();
  pump.resetStats();
  const firstFrame = pump.stats.frame;
  const window = startWindow();
  const windowStarted = performance.now();
  await sleep(durationS * 1000);
  const process_ = window.stop();
  const windowS = (performance.now() - windowStarted) / 1000;
  const lastFrame = pump.stats.frame;
  const counted = {
    audioCallbacks: pairs.flatMap((p) => p.audio).map((x) => x.callbacks),
    video: pairs
      .flatMap((p) => p.video)
      .map((x) => ({
        frames: x.frames,
        latencies: x.latencies,
        undecodable: x.undecodable,
        fullRes: x.fullRes,
        sizes: x.sizes,
      })),
  };
  const pumpStats = { ...pump.stats, lateMs: pump.stats.lateMs };
  const statsEnd = await Promise.all(pairs.map((p) => rtpStats(p.a, p.b)));
  // The comparison is VP8 against VP8: fail the run if any pair negotiated
  // something else (or its stats don't say).
  if (video) {
    for (const [i, end] of statsEnd.entries()) {
      const codecs = end.videoOut?.codecs ?? [];
      if (codecs.length !== 1 || codecs[0] !== 'video/VP8') {
        throw new Error(`${impl}: pair ${i} sent ${JSON.stringify(codecs)}, not only VP8`);
      }
    }
  }
  // Frames pushed late in the window may still be in flight: wait before
  // deciding which of the window's frames never arrived.
  await sleep(1000);
  const videoWatchers = pairs.flatMap((p) => p.video);
  let missing = 0;
  for (const x of videoWatchers) {
    for (let n = firstFrame; n < lastFrame; n++) if (!x.seen.has(n & 0xffff)) missing++;
  }

  const teardownStarted = performance.now();
  pump.stop();
  for (const sink of sinks) sink.stop();
  for (const p of pairs) {
    p.a.close();
    p.b.close();
    for (const t of p.tracks) t.stop();
  }
  const teardownMs = performance.now() - teardownStarted;

  const latencies = counted.video.flatMap((x) => x.latencies);
  const sentFrames = lastFrame - firstFrame;
  const perPair = statsStart.map((start, i) => {
    const end = statsEnd[i];
    const encoded = delta(end, start, 'videoOut.framesEncoded');
    const encodeS = delta(end, start, 'videoOut.totalEncodeTime');
    const decoded = delta(end, start, 'videoIn.framesDecoded');
    const decodeS = delta(end, start, 'videoIn.totalDecodeTime');
    const qp = delta(end, start, 'videoOut.qpSum');
    const videoBytes = delta(end, start, 'videoOut.bytesSent');
    const audioBytes = delta(end, start, 'audioOut.bytesSent');
    // Latency attribution: per-frame and per-packet averages over the window.
    const perUnit = (num, den) => {
      const n = delta(end, start, num);
      const d = delta(end, start, den);
      return n !== null && d ? (n * 1000) / d : null;
    };
    return {
      videoKbps: videoBytes === null ? null : (videoBytes * 8) / 1000 / windowS,
      audioKbps: audioBytes === null ? null : (audioBytes * 8) / 1000 / windowS,
      encodeMsPerFrame: encoded ? (encodeS * 1000) / encoded : null,
      decodeMsPerFrame: decoded ? (decodeS * 1000) / decoded : null,
      jitterBufferMsPerFrame: perUnit(
        'videoIn.jitterBufferDelay',
        'videoIn.jitterBufferEmittedCount',
      ),
      processingMsPerFrame: perUnit('videoIn.totalProcessingDelay', 'videoIn.framesDecoded'),
      packetSendDelayMs: perUnit('videoOut.totalPacketSendDelay', 'videoOut.packetsSent'),
      audioPacketSendDelayMs: perUnit('audioOut.totalPacketSendDelay', 'audioOut.packetsSent'),
      qpAvg: encoded ? qp / encoded : null,
      framesEncodedPerS: encoded === null ? null : encoded / windowS,
      streams: end.videoOut?.streams ?? 0,
      codec: end.videoOut?.codecs.join(',') ?? end.audioOut?.codecs.join(',') ?? null,
      encoder: end.videoOut?.encoderImplementation ?? null,
      decoder: end.videoIn?.decoderImplementation ?? null,
      qualityLimitation: end.videoOut?.qualityLimitationReason ?? null,
      statsErrors: [end.sendError, end.receiveError].filter(Boolean),
    };
  });
  const mean = (values) => {
    const numbers = values.filter((v) => typeof v === 'number');
    return numbers.length ? sum(numbers) / numbers.length : null;
  };
  const sizes = {};
  for (const x of counted.video) {
    for (const [k, v] of Object.entries(x.sizes)) sizes[k] = (sizes[k] ?? 0) + v;
  }
  const videoSinks = counted.video.length;
  const pushMsPerS = pumpStats.pushMs / windowS;
  const genMsPerS = pumpStats.genMs / windowS;
  return {
    ...process_,
    pushMsPerS,
    genMsPerS,
    // The JS thread's time outside this script's own work (content
    // generation, pushes, sink handlers): the bindings' delivery of sink
    // events, their other callbacks, timers and GC.
    jsOtherMsPerS: process_.jsBusyMsPerS - pushMsPerS - genMsPerS - process_.handlerMsPerS,
    // The same, from the main thread's CPU time (approximate: the parts
    // subtracted are wall-clock, measured around short synchronous calls).
    mainThreadOtherCpuMsPerS:
      process_.mainThreadCpuMsPerS - pushMsPerS - genMsPerS - process_.handlerMsPerS,
    pumpLateP99Ms: percentile(pumpStats.lateMs, 99),
    audioPushesPerS: pumpStats.audioPushes / windowS,
    videoPushesPerS: pumpStats.videoPushes / windowS,
    videoSkippedPushes: pumpStats.videoSkipped,
    audioCallbacksPerS: audio ? mean(counted.audioCallbacks) / windowS : null,
    videoFpsPerSink: video ? mean(counted.video.map((x) => x.frames)) / windowS : null,
    videoFpsMinSink: video ? Math.min(...counted.video.map((x) => x.frames)) / windowS : null,
    videoSinks,
    videoStreamsSent: sum(perPair.map((p) => p.streams)),
    videoDroppedPct: video && sentFrames > 0 ? (100 * missing) / (sentFrames * videoSinks) : null,
    videoUndecodable: video ? sum(counted.video.map((x) => x.undecodable)) : null,
    videoFullResPct: video
      ? (100 * sum(counted.video.map((x) => x.fullRes))) /
        Math.max(1, sum(counted.video.map((x) => x.frames)))
      : null,
    videoSizes: video ? sizes : null,
    latencyP50Ms: video ? percentile(latencies, 50) : null,
    latencyP99Ms: video ? percentile(latencies, 99) : null,
    latencyMaxMs: video && latencies.length ? Math.max(...latencies) : null,
    lateFramesPct:
      video && latencies.length
        ? (100 * latencies.filter((l) => l > 100).length) / latencies.length
        : null,
    videoKbps: mean(perPair.map((p) => p.videoKbps)),
    audioKbps: mean(perPair.map((p) => p.audioKbps)),
    encodeMsPerFrame: mean(perPair.map((p) => p.encodeMsPerFrame)),
    decodeMsPerFrame: mean(perPair.map((p) => p.decodeMsPerFrame)),
    jitterBufferMsPerFrame: mean(perPair.map((p) => p.jitterBufferMsPerFrame)),
    processingMsPerFrame: mean(perPair.map((p) => p.processingMsPerFrame)),
    packetSendDelayMs: mean(perPair.map((p) => p.packetSendDelayMs)),
    audioPacketSendDelayMs: mean(perPair.map((p) => p.audioPacketSendDelayMs)),
    qpAvg: mean(perPair.map((p) => p.qpAvg)),
    framesEncodedPerS: mean(perPair.map((p) => p.framesEncodedPerS)),
    // Process CPU per encoded frame, over every stream of every pair: fair
    // when the two encoders drop different numbers of frames.
    cpuMsPerEncodedFrame: (() => {
      const encodedPerS = sum(perPair.map((p) => p.framesEncodedPerS ?? 0));
      return encodedPerS > 0 ? (process_.cpuPct * 10) / encodedPerS : null;
    })(),
    codec: perPair[0].codec,
    encoder: perPair[0].encoder,
    decoder: perPair[0].decoder,
    qualityLimitation: [...new Set(perPair.map((p) => p.qualityLimitation))].join(','),
    statsErrors: [...new Set(perPair.flatMap((p) => p.statsErrors))],
    teardownMs,
  };
}

/**
 * The binding alone: local sources pushed straight into local sinks, no
 * peer connection, encoder or network. What's left is push validation,
 * the copies, and delivery to JS.
 */
async function local() {
  const { pairs: count, width, height, fps, warmupS, durationS } = config;
  const audioSources = [];
  const videoSources = [];
  const sinks = [];
  const tracks = [];
  const watchers = [];
  const sentAt = new Map();
  for (let i = 0; i < count; i++) {
    const audioSource = new RTCAudioSource();
    const videoSource = new RTCVideoSource();
    audioSources.push(audioSource);
    videoSources.push(videoSource);
    const audioTrack = audioSource.createTrack();
    const videoTrack = videoSource.createTrack();
    tracks.push(audioTrack, videoTrack);
    const audioSink = new RTCAudioSink(audioTrack);
    const videoSink = new RTCVideoSink(videoTrack);
    sinks.push(audioSink, videoSink);
    watchers.push(watchAudio(audioSink));
    watchers.push(watchVideo(videoSink, width, sentAt));
  }
  const pump = startPump({ audioSources, videoSources, width, height, fps, sentAt });
  await Promise.all(watchers.map((x) => x.first));
  await sleep(warmupS * 1000);
  for (const x of watchers) x.reset();
  pump.resetStats();
  const window = startWindow();
  const started = performance.now();
  await sleep(durationS * 1000);
  const process_ = window.stop();
  const windowS = (performance.now() - started) / 1000;
  pump.stop();
  for (const sink of sinks) sink.stop();
  for (const track of tracks) track.stop();
  const audio = watchers.filter((x) => 'samples' in x);
  const video = watchers.filter((x) => 'latencies' in x);
  const latencies = video.flatMap((x) => x.latencies);
  return {
    ...process_,
    pushMsPerS: pump.stats.pushMs / windowS,
    genMsPerS: pump.stats.genMs / windowS,
    jsOtherMsPerS:
      process_.jsBusyMsPerS -
      (pump.stats.pushMs + pump.stats.genMs) / windowS -
      process_.handlerMsPerS,
    mainThreadOtherCpuMsPerS:
      process_.mainThreadCpuMsPerS -
      (pump.stats.pushMs + pump.stats.genMs) / windowS -
      process_.handlerMsPerS,
    pumpLateP99Ms: percentile(pump.stats.lateMs, 99),
    audioCallbacksPerS: sum(audio.map((x) => x.callbacks)) / audio.length / windowS,
    videoFpsPerSink: sum(video.map((x) => x.frames)) / video.length / windowS,
    videoUndecodable: sum(video.map((x) => x.undecodable)),
    latencyP50Ms: percentile(latencies, 50),
    latencyP99Ms: percentile(latencies, 99),
  };
}

/** Control-plane timings, `iterations` times plus one discarded warm-up. */
async function control() {
  const timings = {
    constructMs: [],
    createOfferMs: [],
    offerToConnectedMs: [],
    renegotiateMs: [],
    renegotiateTrackMs: [],
    reneg_createOfferMs: [],
    reneg_sldOfferMs: [],
    reneg_srdOfferMs: [],
    reneg_createAnswerMs: [],
    reneg_sldAnswerMs: [],
    reneg_srdAnswerMs: [],
    offerSdpBytes: [],
    videoPayloadTypes: [],
    getStatsMs: [],
    closeMs: [],
  };
  const notes = new Set();
  for (let i = 0; i <= config.iterations; i++) {
    const keep = i > 0;
    const t = {};
    const c0 = performance.now();
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    t.constructMs = (performance.now() - c0) / 2;
    trickle(a, b);
    const audioSource = new RTCAudioSource();
    const videoSource = new RTCVideoSource();
    const tracks = [audioSource.createTrack(), videoSource.createTrack()];
    const stream = new MediaStream();
    for (const track of tracks) a.addTrack(track, stream);
    const remote = [];
    b.addEventListener('track', (e) => remote.push(e.track));
    const pump = startPump({
      audioSources: [audioSource],
      videoSources: [videoSource],
      width: 320,
      height: 240,
      fps: 30,
    });

    const o0 = performance.now();
    t.createOfferMs = (await negotiate(a, b)).createOffer;
    await Promise.all([connected(a), connected(b)]);
    t.offerToConnectedMs = performance.now() - o0;

    // Media flows, so getStats has RTP streams to report.
    const sink = new RTCVideoSink(remote.find((track) => track.kind === 'video'));
    await next(sink, 'frame');
    await sleep(300);

    // Renegotiation: add a second video track, until its track event.
    const extraSource = new RTCVideoSource();
    const extra = extraSource.createTrack();
    tracks.push(extra);
    const r0 = performance.now();
    const trackEvent = next(b, 'track');
    a.addTrack(extra, stream);
    const steps = await negotiate(a, b);
    t.renegotiateMs = performance.now() - r0;
    const { offerBytes, videoPayloadTypes, ...durations } = steps;
    for (const [step, ms] of Object.entries(durations)) t[`reneg_${step}Ms`] = ms;
    t.offerSdpBytes = offerBytes;
    t.videoPayloadTypes = videoPayloadTypes;
    await trackEvent;
    t.renegotiateTrackMs = performance.now() - r0;

    // libwebrtc caches a stats report for 50 ms: space the calls so each
    // one collects afresh, as a 1 s stats poll would.
    t.getStatsMs = [];
    for (let k = 0; k < 5; k++) {
      await sleep(60);
      const s0 = performance.now();
      try {
        await a.getStats();
        t.getStatsMs.push(performance.now() - s0);
      } catch (error) {
        notes.add(`getStats rejected: ${error?.name}: ${error?.message}`);
      }
    }

    pump.stop();
    sink.stop();
    const x0 = performance.now();
    a.close();
    b.close();
    t.closeMs = (performance.now() - x0) / 2;
    for (const track of tracks) track.stop();
    if (keep) {
      for (const [key, value] of Object.entries(t)) {
        if (Array.isArray(value)) timings[key].push(...value);
        else timings[key].push(value);
      }
    }
  }
  const out = { loadMs };
  for (const [key, values] of Object.entries(timings)) {
    out[`${key}P50`] = percentile(values, 50);
    out[`${key}P99`] = key === 'getStatsMs' ? percentile(values, 99) : undefined;
    if (out[`${key}P99`] === undefined) delete out[`${key}P99`];
  }
  out.notes = [...notes];
  return out;
}

const scenarios = { media, local, control };
const result = await scenarios[config.kind]();
// The parent times the exit from reading this line.
writeAll(`${JSON.stringify({ impl, result })}\n`);
// Everything is closed now, so the process should exit within ms. If it
// doesn't, say what keeps the loop alive (on stderr, which the parent
// keeps). Unreferenced, so it doesn't keep the process alive itself; if
// the JS thread is blocked, it never fires, which is evidence too.
setTimeout(() => {
  const names = (list) => list.map((h) => h?.constructor?.name ?? typeof h);
  const info = {
    activeResources: process.getActiveResourcesInfo(),
    handles: names(process._getActiveHandles()),
    requests: names(process._getActiveRequests()),
  };
  process.stderr.write(`bench-hang-diag ${JSON.stringify(info)}\n`);
}, 3000).unref();
// wrtc's threads keep its process alive: in media runs, exit as the compat
// scenarios do. In control runs the parent waits for a natural exit (and
// records a hang or crash) as part of the measurement.
if (impl === 'wrtc' && config.kind !== 'control') process.exit(0);
