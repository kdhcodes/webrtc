// Data channel throughput through a mediasoup SFU: a sender client process
// -> mediasoup worker -> a receiver client process. Each client is its own
// Node process (own libwebrtc network thread); this driver hosts the SFU's
// Node side (mediasoup's worker is a process of its own) and the signaling
// (HTTP on 127.0.0.1), and never loads our addon.
//
//   MEDIASOUP_DIR=... node dc-throughput.mjs [options]
//     --size N            message size (k/m suffix; default 64k)
//     --strategy burst|one  as bench/datachannel.mjs (default burst)
//     --high N --low N    burst watermarks (default 1m / 256k)
//     --duration S        seconds of sending (default 5)
//     --unordered         unordered channel
//     --send-buffer N     SFU sctpSendBufferSize (default: mediasoup's)
//     --handler NAME      mediasoup-client handler (default Safari12)
//     --sfu-rwnd N        mediasoup >= 3.20: sctpMaxReceiverWindowBufferSize
//     --json              print the full result as JSON
//
// Reports MiB/s and msg/s at the receiver, messages the SFU dropped (its
// DataConsumer's 'sctpsendbufferfull'), pauses of 50 ms or more between
// received messages (400 ms ones are SCTP retransmission timeouts), the
// clients' transport packet counts, kernel UDP socket-buffer drops
// (netstat -s -p udp, system-wide), the worker's CPU, and the candidate pairs.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  createClient,
  createSfu,
  httpRpc,
  installWrtcGlobals,
  once,
  selectedPair,
  serveHttp,
  udpBufferDrops,
} from './common.mjs';

const THIS = fileURLToPath(import.meta.url);

function parseSize(v) {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(String(v));
  if (!m) throw new Error(`bad size ${v}`);
  return Math.round(Number(m[1]) * { '': 1, k: 1024, K: 1024, m: 1048576, M: 1048576 }[m[2]]);
}
function parseArgs(argv) {
  const o = {
    size: 65536,
    strategy: 'burst',
    high: 1048576,
    low: 262144,
    duration: 5,
    unordered: false,
    sendBuffer: 0,
    handler: 'Safari12',
    json: false,
    role: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--size') o.size = parseSize(v());
    else if (a === '--strategy') o.strategy = v();
    else if (a === '--high') o.high = parseSize(v());
    else if (a === '--low') o.low = parseSize(v());
    else if (a === '--duration') o.duration = Number(v());
    else if (a === '--unordered') o.unordered = true;
    else if (a === '--send-buffer') o.sendBuffer = parseSize(v());
    else if (a === '--handler') o.handler = v();
    else if (a === '--sfu-rwnd') o.rwnd = parseSize(v());
    else if (a === '--json') o.json = true;
    else if (a === '--role') o.role = v();
    else if (a === '--rpc') o.rpc = v();
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}
const o = parseArgs(process.argv.slice(2));
const now = () => performance.now();

// ---------------------------------------------------------------------------
// Child: one client. Talks to the driver in JSON lines (stdin/stdout).

async function child() {
  const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const inbox = [];
  let waiter = null;
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (l) => {
    inbox.push(JSON.parse(l));
    waiter?.();
  });
  // The driver going away (even SIGKILL) closes stdin: exit then. After a
  // normal finish the process must exit on its own instead.
  let finished = false;
  rl.on('close', () => {
    if (!finished) process.exit(3);
  });
  const next = (t) =>
    new Promise((res) => {
      const check = () => {
        const i = inbox.findIndex((m) => m.t === t);
        if (i < 0) return;
        waiter = null;
        res(inbox.splice(i, 1)[0]);
      };
      waiter = check;
      check();
    });

  await installWrtcGlobals();
  const rpc = httpRpc(o.rpc);
  const sender = o.role === 'sender';
  const client = await createClient({
    rpc,
    name: o.role,
    handlerName: o.handler,
    send: sender,
    recv: !sender,
  });
  const transport = sender ? client.sendTransport : client.recvTransport;
  const transportStats = async () => {
    const r = await transport.getStats();
    for (const s of r.values()) {
      if (s.type === 'transport') {
        return {
          packetsSent: s.packetsSent,
          packetsReceived: s.packetsReceived,
          bytesSent: s.bytesSent,
          bytesReceived: s.bytesReceived,
        };
      }
    }
    return null;
  };

  if (sender) {
    const dp = await client.sendTransport.produceData({ label: 'bench', ordered: !o.unordered });
    if (dp.readyState !== 'open') await once(dp, 'open', { timeoutMs: 20000 });
    out({ t: 'producer', id: dp.id, transportId: transport.id });
    await next('go');
    const dc = dp._dataChannel;
    const before = await transportStats();
    const payload = new Uint8Array(o.size);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const one = o.strategy === 'one';
    const high = one ? 1 : o.high;
    const low = one ? 0 : o.low;
    dc.bufferedAmountLowThreshold = low;
    const waitLow = (ms) =>
      new Promise((res) => {
        const done = () => {
          dc.removeEventListener('bufferedamountlow', done);
          clearTimeout(timer);
          res();
        };
        const timer = setTimeout(done, Math.max(0, ms));
        dc.addEventListener('bufferedamountlow', done);
      });
    let messages = 0;
    let waits = 0;
    const t0 = now();
    const end = t0 + o.duration * 1000;
    while (now() < end && dc.readyState === 'open') {
      while (dc.bufferedAmount < high && dc.readyState === 'open') {
        dc.send(payload);
        messages++;
        if (now() >= end) break;
      }
      if (now() >= end) break;
      if (dc.bufferedAmount > low) {
        waits++;
        await waitLow(end - now());
      }
    }
    const sendLoopMs = now() - t0;
    const drainEnd = now() + 30000;
    dc.bufferedAmountLowThreshold = 0;
    while (dc.bufferedAmount > 0 && now() < drainEnd) await waitLow(drainEnd - now());
    const drainedMs = now() - t0;
    out({ t: 'sent', messages, sendLoopMs, drainedMs, waits, state: dc.readyState });
    await next('fin');
    const after = await transportStats();
    out({ t: 'result', before, after, pair: await selectedPair(transport) });
    dp.close();
  } else {
    const { producerId } = await next('consume');
    const consumer = await client.consumeData(producerId);
    if (consumer.readyState !== 'open') await once(consumer, 'open', { timeoutMs: 20000 });
    const dc = consumer._dataChannel;
    dc.binaryType = 'arraybuffer';
    let received = 0;
    let bytes = 0;
    let first = 0;
    let last = 0;
    const gaps = [];
    const buckets = [];
    dc.addEventListener('message', (m) => {
      const t = now();
      if (received === 0) first = t;
      else if (t - last >= 50) gaps.push(Math.round(t - last));
      last = t;
      received++;
      const n = typeof m.data === 'string' ? m.data.length : m.data.byteLength;
      bytes += n;
      const b = Math.floor((t - first) / 100);
      while (buckets.length <= b) buckets.push(0);
      buckets[b] += n;
    });
    const before = await transportStats();
    out({ t: 'ready', transportId: transport.id });
    const { messages: expected } = await next('sent');
    // Messages the SFU dropped never come; stop once nothing has arrived for 2 s.
    const deadline = now() + 30000;
    while (received < expected && now() < deadline) {
      const mark = received;
      await new Promise((r) => setTimeout(r, 2000));
      if (received === mark) break;
    }
    const after = await transportStats();
    out({
      t: 'result',
      received,
      bytes,
      elapsedMs: last - first,
      gaps,
      timeline: buckets.map((b) => Math.round(b / 1024)),
      before,
      after,
      pair: await selectedPair(transport),
    });
    consumer.close();
  }
  client.close();
  finished = true;
  rl.close();
  setTimeout(
    () =>
      console.error(`[${o.role}] still alive 5 s after closing:`, process.getActiveResourcesInfo()),
    5000,
  ).unref();
}

// ---------------------------------------------------------------------------
// Driver

function spawnChild(role, rpcUrl) {
  const args = [
    THIS,
    '--role',
    role,
    '--rpc',
    rpcUrl,
    '--size',
    String(o.size),
    '--strategy',
    o.strategy,
    '--high',
    String(o.high),
    '--low',
    String(o.low),
    '--duration',
    String(o.duration),
    '--handler',
    o.handler,
  ];
  if (o.unordered) args.push('--unordered');
  const p = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  const inbox = [];
  let waiter = null;
  createInterface({ input: p.stdout }).on('line', (l) => {
    try {
      inbox.push(JSON.parse(l));
    } catch {
      console.error(`[${role}] ${l}`);
      return;
    }
    waiter?.();
  });
  const exited = new Promise((res) => p.on('exit', (code, sig) => res({ code, sig })));
  return {
    p,
    exited,
    send: (m) => p.stdin.write(`${JSON.stringify(m)}\n`),
    next: (t) =>
      new Promise((res) => {
        const check = () => {
          const i = inbox.findIndex((m) => m.t === t);
          if (i < 0) return;
          waiter = null;
          res(inbox.splice(i, 1)[0]);
        };
        waiter = check;
        check();
      }),
  };
}

async function driver() {
  const sfu = await createSfu({
    sctp: { sendBufferSize: o.sendBuffer || undefined, receiverWindow: o.rwnd },
  });
  const { url, server } = await serveHttp(sfu.rpc);
  const watchdog = setTimeout(
    () => {
      console.error('timeout; killing children');
      for (const c of [snd, rcv]) c?.p.kill('SIGKILL');
      process.exit(2);
    },
    (o.duration + 90) * 1000,
  );
  const snd = spawnChild('sender', url);
  const rcv = spawnChild('receiver', url);
  const { id: producerId, transportId: sendTid } = await snd.next('producer');
  rcv.send({ t: 'consume', producerId });
  const { transportId: recvTid } = await rcv.next('ready');
  const sfuTransportStats = async () => {
    const a = (await sfu.rpc('getStats', { kind: 'transport', id: sendTid }))[0];
    const b = (await sfu.rpc('getStats', { kind: 'transport', id: recvTid }))[0];
    return { inFromSender: a.bytesReceived, outToReceiver: b.bytesSent };
  };
  const sfu0 = await sfuTransportStats();
  const drops0 = udpBufferDrops();
  const ru0 = await sfu.worker.getResourceUsage();
  snd.send({ t: 'go' });
  const sent = await snd.next('sent');
  rcv.send({ t: 'sent', messages: sent.messages });
  const rx = await rcv.next('result');
  const drops1 = udpBufferDrops();
  const sfu1 = await sfuTransportStats();
  const ru1 = await sfu.worker.getResourceUsage();
  snd.send({ t: 'fin' });
  const tx = await snd.next('result');
  const events = await sfu.rpc('events');
  const sendBufferFull = events.filter((e) => e.ev === 'sctpsendbufferfull').length;
  const [sc, rc] = await Promise.all([snd.exited, rcv.exited]);
  clearTimeout(watchdog);
  server.close();
  sfu.close();

  const MiB = 1048576;
  const secs = Math.max(rx.elapsedMs, sent.sendLoopMs) / 1000;
  const d = (a, b, k) => (a && b ? a[k] - b[k] : null);
  const r = {
    label: `${sfu.version} ${o.handler} ${o.size}B ${o.strategy}${o.strategy === 'burst' ? ` ${o.high}/${o.low}` : ''} ${o.unordered ? 'unordered' : 'ordered'} sfuSendBuffer=${o.sendBuffer || 'default'}${o.rwnd ? ` sfuRwnd=${o.rwnd}` : ''}`,
    mibps: rx.bytes / MiB / secs,
    msgps: rx.received / secs,
    sent: sent.messages,
    received: rx.received,
    lostPct: (100 * (sent.messages - rx.received)) / sent.messages,
    sfuSendBufferFullEvents: sendBufferFull,
    gaps: rx.gaps,
    timeouts400: rx.gaps.filter((g) => g >= 390).length,
    senderWaits: sent.waits,
    sendLoopS: sent.sendLoopMs / 1000,
    rxSpanS: rx.elapsedMs / 1000,
    senderPackets: d(tx.after, tx.before, 'packetsSent'),
    senderBytes: d(tx.after, tx.before, 'bytesSent'),
    receiverBytes: d(rx.after, rx.before, 'bytesReceived'),
    receiverPackets: d(rx.after, rx.before, 'packetsReceived'),
    udpBufferDrops: drops0 === null ? null : drops1 - drops0,
    // Per leg, in bytes (mediasoup has no packet counts): what one end sent
    // that the other never counted.
    sfuInFromSender: sfu1.inFromSender - sfu0.inFromSender,
    sfuOutToReceiver: sfu1.outToReceiver - sfu0.outToReceiver,
    workerCpuPct:
      (100 * (ru1.ru_utime - ru0.ru_utime + (ru1.ru_stime - ru0.ru_stime))) / (secs * 1000),
    pairs: { sender: tx.pair, receiver: rx.pair },
    childExit: { sender: sc, receiver: rc },
    timeline: rx.timeline,
  };
  if (o.json) console.log(JSON.stringify(r));
  else {
    const f = (x, n = 2) => (x == null ? '-' : Number(x).toFixed(n));
    console.log(r.label);
    console.log(
      `  ${f(r.mibps)} MiB/s, ${f(r.msgps, 0)} msg/s; received ${r.received}/${r.sent} (${f(r.lostPct)}% lost at the SFU, ${r.sfuSendBufferFullEvents} sctpsendbufferfull)`,
    );
    console.log(
      `  send loop ${f(r.sendLoopS)} s, receiver span ${f(r.rxSpanS)} s, sender waited ${r.senderWaits}x; worker CPU ${f(r.workerCpuPct, 0)}%`,
    );
    console.log(
      `  packets: sender sent ${r.senderPackets}, receiver got ${r.receiverPackets}; kernel UDP drops ${r.udpBufferDrops}`,
    );
    const leg = (a, b) =>
      `${(a / 1048576).toFixed(1)} MiB sent, ${(b / 1048576).toFixed(1)} MiB arrived (${f((100 * (a - b)) / a)}% short)`;
    console.log(
      `  legs: sender->SFU ${leg(r.senderBytes, r.sfuInFromSender)}; SFU->receiver ${leg(r.sfuOutToReceiver, r.receiverBytes)}`,
    );
    console.log(
      `  gaps >= 50 ms: ${r.gaps.length ? r.gaps.join(', ') : 'none'} (${r.timeouts400} of ~400 ms)`,
    );
    console.log(
      `  pairs: sender ${r.pairs.sender?.local} -> ${r.pairs.sender?.remote}; receiver ${r.pairs.receiver?.local} -> ${r.pairs.receiver?.remote}${r.pairs.sender?.vpn || r.pairs.receiver?.vpn ? ' (VPN!)' : ''}`,
    );
    console.log(`  timeline KiB/100ms: ${r.timeline.join(' ')}`);
    console.log(`  children exited: sender ${JSON.stringify(sc)}, receiver ${JSON.stringify(rc)}`);
  }
}

if (o.role) await child();
else await driver();
