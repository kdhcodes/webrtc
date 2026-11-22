// Shared pieces of the mediasoup SFU tests: loading mediasoup (from a scratch
// install), the WebRTC polyfills that put our library on globalThis the way
// Whereby's Node polyfills do, a tiny SFU with a JSON RPC surface (in-process
// or over HTTP on 127.0.0.1), and a mediasoup-client wrapper.
//
// Opt-in: not run by `pnpm test` or `test:exit`. See docs/sfu-test.md.
//
// Environment:
//   MEDIASOUP_DIR  directory whose node_modules has mediasoup and
//                  mediasoup-client (a scratch install outside the repo)
//   WRTC_ENTRY     our library's entry (default: <repo>/lib/index.ts)
//   SFU_LISTEN_IP  IP mediasoup listens on (default 127.0.0.1)
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function mediasoupDir() {
  const dir = process.env.MEDIASOUP_DIR;
  if (!dir) throw new Error('set MEDIASOUP_DIR to a directory with mediasoup installed');
  return resolve(dir);
}

function msRequire() {
  return createRequire(join(mediasoupDir(), 'package.json'));
}

export function loadMediasoup() {
  const req = msRequire();
  const ms = req('mediasoup');
  return { ms, version: ms.version };
}

export function loadMediasoupClient() {
  const req = msRequire();
  const msc = req('mediasoup-client');
  return { msc, version: msc.version };
}

export function wrtcEntry() {
  return process.env.WRTC_ENTRY
    ? resolve(process.env.WRTC_ENTRY)
    : resolve(HERE, '../../lib/index.ts');
}

// ---------------------------------------------------------------------------
// Polyfills (modelled on whereby-sdk-trial apps/libwebrtc-trial/src/polyfills.ts)

/** Per-call timings of the RTCPeerConnection methods a consume round uses. */
export const pcTimings = [];
export const peerConnections = new Set();
/** Every RTCDataChannel created through the polyfilled RTCPeerConnection. */
export const channelLog = [];

export async function installWrtcGlobals() {
  const wrtc = (await import(wrtcEntry())).default;
  const g = globalThis;
  if (typeof g.navigator === 'undefined' || !g.navigator.userAgent) {
    Object.defineProperty(g, 'navigator', {
      value: { userAgent: 'Node.js/24' },
      writable: false,
      enumerable: true,
      configurable: true,
    });
  }
  class RTCPeerConnection extends wrtc.RTCPeerConnection {
    constructor(...args) {
      super(...args);
      peerConnections.add(this);
    }
    close() {
      peerConnections.delete(this);
      return super.close();
    }
    // Every channel mediasoup-client creates gets an event log (`__log`):
    // the lifecycle events our RTCDataChannel fires, in order.
    createDataChannel(label, options) {
      const ch = super.createDataChannel(label, options);
      ch.__log = [];
      for (const type of ['open', 'closing', 'close', 'error']) {
        ch.addEventListener(type, (e) => {
          const entry = { type, state: ch.readyState, t: performance.now() };
          if (type === 'error') {
            entry.detail = e.error?.errorDetail;
            entry.cause = e.error?.sctpCauseCode;
            entry.message = e.error?.message;
          }
          ch.__log.push(entry);
        });
      }
      channelLog.push(ch);
      return ch;
    }
  }
  // Time the signaling calls (wall and process CPU) so a consume round can be
  // broken down. CPU is process-wide (all threads), from process.cpuUsage().
  for (const m of ['createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription']) {
    const orig = wrtc.RTCPeerConnection.prototype[m];
    RTCPeerConnection.prototype[m] = async function (...args) {
      const t0 = performance.now();
      const c0 = process.cpuUsage();
      try {
        return await orig.apply(this, args);
      } finally {
        const c = process.cpuUsage(c0);
        pcTimings.push({ m, ms: performance.now() - t0, cpuMs: (c.user + c.system) / 1000 });
      }
    };
  }
  g.MediaStream = wrtc.MediaStream;
  g.MediaStreamTrack = wrtc.MediaStreamTrack;
  g.RTCDataChannel = wrtc.RTCDataChannel;
  g.RTCDataChannelEvent = wrtc.RTCDataChannelEvent;
  g.RTCDtlsTransport = wrtc.RTCDtlsTransport;
  g.RTCIceCandidate = wrtc.RTCIceCandidate;
  g.RTCIceTransport = wrtc.RTCIceTransport;
  g.RTCPeerConnection = RTCPeerConnection;
  g.RTCPeerConnectionIceEvent = wrtc.RTCPeerConnectionIceEvent;
  g.RTCRtpReceiver = wrtc.RTCRtpReceiver;
  g.RTCRtpSender = wrtc.RTCRtpSender;
  g.RTCRtpTransceiver = wrtc.RTCRtpTransceiver;
  g.RTCSctpTransport = wrtc.RTCSctpTransport;
  g.RTCSessionDescription = wrtc.RTCSessionDescription;
  return wrtc;
}

// ---------------------------------------------------------------------------
// SFU

export const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
];

/**
 * A minimal mediasoup SFU: one worker, one router. Returns `{ rpc, close,
 * worker, router, objects }`, where `rpc(method, params)` is the signaling
 * surface the clients use (in-process, or through serveHttp()).
 */
export async function createSfu({ listenIps, sctp = {} } = {}) {
  const { ms, version } = loadMediasoup();
  const major = Number(version.split('.')[1]);
  const worker = await ms.createWorker({ logLevel: 'warn', rtcMinPort: 40000, rtcMaxPort: 49999 });
  worker.on('died', (e) => console.error('[sfu] worker died', e));
  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  const ips = listenIps ?? [process.env.SFU_LISTEN_IP || '127.0.0.1'];
  const transports = new Map();
  const producers = new Map();
  const consumers = new Map();
  const dataProducers = new Map();
  const dataConsumers = new Map();
  const events = [];
  const note = (e) => events.push({ t: performance.now(), ...e });

  // mediasoup 3.20 replaced usrsctp with a built-in stack and renamed the
  // SCTP options.
  const sctpOptions =
    major >= 20
      ? {
          maxSendMessageSize: sctp.maxMessageSize ?? 262144,
          maxReceiveMessageSize: sctp.maxMessageSize ?? 262144,
          ...(sctp.sendBufferSize ? { sctpSendBufferSize: sctp.sendBufferSize } : {}),
          ...(sctp.receiverWindow ? { sctpMaxReceiverWindowBufferSize: sctp.receiverWindow } : {}),
        }
      : {
          numSctpStreams: { OS: 1024, MIS: 1024 },
          maxSctpMessageSize: sctp.maxMessageSize ?? 262144,
          ...(sctp.sendBufferSize ? { sctpSendBufferSize: sctp.sendBufferSize } : {}),
        };

  const methods = {
    getRouterRtpCapabilities: () => router.rtpCapabilities,
    async createTransport({ sctp: wantSctp = true, appData } = {}) {
      const t = await router.createWebRtcTransport({
        listenInfos: ips.map((ip) => ({ protocol: 'udp', ip })),
        enableUdp: true,
        enableTcp: false,
        preferUdp: true,
        enableSctp: wantSctp,
        ...(wantSctp ? sctpOptions : {}),
        initialAvailableOutgoingBitrate: 1_000_000,
        appData,
      });
      transports.set(t.id, t);
      t.on('sctpstatechange', (s) => note({ ev: 'sctpstatechange', transport: t.id, s }));
      t.on('dtlsstatechange', (s) => note({ ev: 'dtlsstatechange', transport: t.id, s }));
      t.on('icestatechange', (s) => note({ ev: 'icestatechange', transport: t.id, s }));
      t.observer.on('close', () => {
        transports.delete(t.id);
        note({ ev: 'transportclose', transport: t.id });
      });
      return {
        id: t.id,
        iceParameters: t.iceParameters,
        iceCandidates: t.iceCandidates,
        dtlsParameters: t.dtlsParameters,
        sctpParameters: t.sctpParameters,
      };
    },
    async connectTransport({ transportId, dtlsParameters }) {
      await transports.get(transportId).connect({ dtlsParameters });
    },
    async produce({ transportId, kind, rtpParameters, appData }) {
      const p = await transports.get(transportId).produce({ kind, rtpParameters, appData });
      producers.set(p.id, p);
      p.observer.on('close', () => producers.delete(p.id));
      return { id: p.id };
    },
    async consume({ transportId, producerId, rtpCapabilities, paused = false }) {
      if (!router.canConsume({ producerId, rtpCapabilities })) throw new Error('cannot consume');
      const c = await transports.get(transportId).consume({ producerId, rtpCapabilities, paused });
      consumers.set(c.id, c);
      c.observer.on('close', () => consumers.delete(c.id));
      c.on('layerschange', (l) => note({ ev: 'layerschange', consumer: c.id, l }));
      return {
        id: c.id,
        producerId,
        kind: c.kind,
        rtpParameters: c.rtpParameters,
        type: c.type,
      };
    },
    async resumeConsumer({ consumerId }) {
      await consumers.get(consumerId).resume();
    },
    async setPreferredLayers({ consumerId, spatialLayer, temporalLayer }) {
      await consumers.get(consumerId).setPreferredLayers({ spatialLayer, temporalLayer });
    },
    consumerState({ consumerId }) {
      const c = consumers.get(consumerId);
      return {
        paused: c.paused,
        producerPaused: c.producerPaused,
        currentLayers: c.currentLayers ?? null,
        preferredLayers: c.preferredLayers ?? null,
      };
    },
    async produceData({ transportId, sctpStreamParameters, label, protocol, appData }) {
      const dp = await transports
        .get(transportId)
        .produceData({ sctpStreamParameters, label, protocol, appData });
      dataProducers.set(dp.id, dp);
      dp.observer.on('close', () => {
        dataProducers.delete(dp.id);
        note({ ev: 'dataproducerclose', id: dp.id });
      });
      return { id: dp.id };
    },
    async consumeData({ transportId, dataProducerId }) {
      const dc = await transports.get(transportId).consumeData({ dataProducerId });
      dataConsumers.set(dc.id, dc);
      dc.on('sctpsendbufferfull', () => note({ ev: 'sctpsendbufferfull', id: dc.id }));
      dc.on('dataproducerclose', () => note({ ev: 'dataproducerclose->consumer', id: dc.id }));
      dc.observer.on('close', () => {
        dataConsumers.delete(dc.id);
        note({ ev: 'dataconsumerclose', id: dc.id });
      });
      return {
        id: dc.id,
        dataProducerId,
        sctpStreamParameters: dc.sctpStreamParameters,
        label: dc.label,
        protocol: dc.protocol,
      };
    },
    closeTransport: ({ transportId }) => transports.get(transportId)?.close(),
    closeProducer: ({ producerId }) => producers.get(producerId)?.close(),
    closeConsumer: ({ consumerId }) => consumers.get(consumerId)?.close(),
    closeDataProducer: ({ dataProducerId }) => dataProducers.get(dataProducerId)?.close(),
    closeDataConsumer: ({ dataConsumerId }) => dataConsumers.get(dataConsumerId)?.close(),
    has: ({ kind, id }) =>
      ({
        transport: transports,
        producer: producers,
        consumer: consumers,
        dataProducer: dataProducers,
        dataConsumer: dataConsumers,
      })[kind].has(id),
    async getStats({ kind, id }) {
      const map = {
        transport: transports,
        producer: producers,
        consumer: consumers,
        dataProducer: dataProducers,
        dataConsumer: dataConsumers,
      }[kind];
      return map.get(id)?.getStats() ?? null;
    },
    async dataConsumerBufferedAmount({ dataConsumerId }) {
      return dataConsumers.get(dataConsumerId)?.getBufferedAmount?.() ?? null;
    },
    transportSctpState: ({ transportId }) => transports.get(transportId)?.sctpState ?? null,
    events: () => events,
    workerUsage: () => worker.getResourceUsage(),
    info: () => ({ version, listenIps: ips, workerPid: worker.pid }),
  };

  const rpc = async (method, params = {}) => {
    const fn = methods[method];
    if (!fn) throw new Error(`no such method ${method}`);
    return fn(params);
  };
  const close = () => {
    worker.close();
  };
  return { rpc, close, worker, router, version, events };
}

/** Serves `rpc` over HTTP POST on 127.0.0.1; resolves with the base URL. */
export function serveHttp(rpc) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { method, params } = JSON.parse(body);
      const result = await rpc(method, params);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: result ?? null }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.stack ?? e) }));
    }
  });
  return new Promise((resolveUrl) => {
    server.listen(0, '127.0.0.1', () => {
      resolveUrl({ url: `http://127.0.0.1:${server.address().port}`, server });
    });
  });
}

/** The client side of serveHttp(). */
export function httpRpc(url) {
  return async (method, params = {}) => {
    const r = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ method, params }),
      // A fresh connection per call: no keep-alive socket holds the process open.
      headers: { connection: 'close' },
    });
    const j = await r.json();
    if (j.error) throw new Error(`rpc ${method}: ${j.error}`);
    return j.result;
  };
}

// ---------------------------------------------------------------------------
// Client

/**
 * A mediasoup-client Device plus send and receive transports, signaled
 * through `rpc`. `handlerName` is 'Safari12' (what Whereby uses in Node) or
 * 'Chrome111'.
 */
export async function createClient({
  rpc,
  handlerName = 'Safari12',
  name = 'client',
  send = true,
  recv = true,
  sctp = true,
}) {
  const { msc } = loadMediasoupClient();
  const device = new msc.Device({ handlerName });
  await device.load({ routerRtpCapabilities: await rpc('getRouterRtpCapabilities') });
  const client = { name, device, rpc, sendTransport: null, recvTransport: null };

  const makeTransport = async (direction) => {
    const params = await rpc('createTransport', { sctp, appData: { name, direction } });
    const t =
      direction === 'send'
        ? device.createSendTransport(params)
        : device.createRecvTransport(params);
    t.on('connect', ({ dtlsParameters }, cb, errb) => {
      rpc('connectTransport', { transportId: t.id, dtlsParameters }).then(cb, errb);
    });
    if (direction === 'send') {
      t.on('produce', ({ kind, rtpParameters, appData }, cb, errb) => {
        rpc('produce', { transportId: t.id, kind, rtpParameters, appData }).then(cb, errb);
      });
      t.on('producedata', ({ sctpStreamParameters, label, protocol, appData }, cb, errb) => {
        rpc('produceData', {
          transportId: t.id,
          sctpStreamParameters,
          label,
          protocol,
          appData,
        }).then(cb, errb);
      });
    }
    return t;
  };
  if (send) client.sendTransport = await makeTransport('send');
  if (recv) client.recvTransport = await makeTransport('recv');

  client.consumeData = async (dataProducerId) => {
    const p = await rpc('consumeData', { transportId: client.recvTransport.id, dataProducerId });
    return client.recvTransport.consumeData({
      id: p.id,
      dataProducerId,
      sctpStreamParameters: p.sctpStreamParameters,
      label: p.label,
      protocol: p.protocol,
    });
  };
  client.consume = async (producerId, { paused = false } = {}) => {
    const p = await rpc('consume', {
      transportId: client.recvTransport.id,
      producerId,
      rtpCapabilities: device.rtpCapabilities,
      paused,
    });
    return client.recvTransport.consume({
      id: p.id,
      producerId,
      kind: p.kind,
      rtpParameters: p.rtpParameters,
    });
  };
  client.close = () => {
    client.sendTransport?.close();
    client.recvTransport?.close();
  };
  return client;
}

/** Selected candidate pair of a mediasoup-client transport, from getStats. */
export async function selectedPair(transport) {
  const report = await transport.getStats();
  const all = [...report.values()];
  const byId = new Map(all.map((s) => [s.id, s]));
  const t = all.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
  const pair = t ? byId.get(t.selectedCandidatePairId) : null;
  if (!pair) return null;
  const cand = (id) => {
    const c = byId.get(id);
    return c ? `${c.address ?? c.ip}:${c.port} ${c.networkType ?? ''}`.trim() : null;
  };
  const local = cand(pair.localCandidateId);
  const remote = cand(pair.remoteCandidateId);
  return {
    local,
    remote,
    vpn: /vpn|10\.99\./.test(`${local} ${remote}`),
    rttMs: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
  };
}

/** macOS: UDP datagrams dropped for a full socket buffer (system-wide). */
export function udpBufferDrops() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('netstat', ['-s', '-p', 'udp'], { encoding: 'utf8' });
      const m = /(\d+) dropped due to full socket buffers/.exec(out);
      return m ? Number(m[1]) : null;
    }
  } catch {}
  return null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves with the next `type` event on an EventTarget or EventEmitter matching `pred`. */
export function once(target, type, { pred = () => true, timeoutMs = 10000 } = {}) {
  return new Promise((resolveEv, reject) => {
    const isEmitter =
      typeof target.on === 'function' && typeof target.addEventListener !== 'function';
    const off = () =>
      isEmitter ? target.off(type, listener) : target.removeEventListener(type, listener);
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    function listener(...args) {
      if (!pred(...args)) return;
      clearTimeout(timer);
      off();
      resolveEv(args[0]);
    }
    if (isEmitter) target.on(type, listener);
    else target.addEventListener(type, listener);
  });
}
