// Data channel correctness through a mediasoup SFU. Two mediasoup-client
// clients (A, B) on our RTCPeerConnection in this process; mediasoup's worker
// is its own process.
//
//   MEDIASOUP_DIR=... node dc-correctness.mjs [--handler Safari12|Chrome111] [--channels N]
//
// Checks:
// - A DataProducer -> SFU -> B DataConsumer, and B -> A: ordered, unordered,
//   unreliable (maxRetransmits 0); strings (empty, multi-byte, near max) and
//   binary (empty, offset views, up to the max message size); exact content
//   and, for ordered channels, order
// - a message over maxMessageSize throws TypeError and the channel stays open
// - many channels (DataProducers) at once
// - closing: client closes its DataProducer / DataConsumer, the SFU closes a
//   DataConsumer / DataProducer, a client transport closes, an SFU transport
//   closes. Records the events our RTCDataChannels fire on both clients.
// - no uncaught exceptions or unhandled rejections; the process exits on
//   its own afterwards.
import {
  channelLog,
  createClient,
  createSfu,
  installWrtcGlobals,
  once,
  selectedPair,
  sleep,
} from './common.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const handlerName = arg('--handler', 'Safari12');
const NUM_CHANNELS = Number(arg('--channels', 200));
// mediasoup drops a DataConsumer's message when its SCTP send buffer is full
// (it emits 'sctpsendbufferfull' and still counts the message as sent). The
// 3.19 default (256 KiB) can't hold back-to-back near-max messages, so the
// content checks run with a bigger buffer; --send-buffer 0 keeps the default.
const SEND_BUFFER = Number(arg('--send-buffer', 4 * 1024 * 1024));

const uncaught = [];
process.on('uncaughtException', (e) => uncaught.push(`uncaughtException: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => uncaught.push(`unhandledRejection: ${e?.stack ?? e}`));

const results = [];
async function check(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(
      `PASS ${name} (${Math.round(performance.now() - t0)} ms)${detail ? ` ${JSON.stringify(detail)}` : ''}`,
    );
  } catch (e) {
    results.push({ name, ok: false, detail: String(e?.stack ?? e) });
    console.log(`FAIL ${name}: ${e?.stack ?? e}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

await installWrtcGlobals();
const sfu = await createSfu({ sctp: { sendBufferSize: SEND_BUFFER || undefined } });
console.log(
  `mediasoup ${sfu.version}, handler ${handlerName}, SFU sctpSendBufferSize ${SEND_BUFFER || 'default'}`,
);
const A = await createClient({ rpc: sfu.rpc, name: 'A', handlerName });
const B = await createClient({ rpc: sfu.rpc, name: 'B', handlerName });

/** A DataProducer on `from`, consumed by `to`; both open. */
async function pipe(from, to, opts) {
  const dp = await from.sendTransport.produceData(opts);
  if (dp.readyState !== 'open') await once(dp, 'open');
  const dc = await to.consumeData(dp.id);
  if (dc.readyState !== 'open') await once(dc, 'open');
  dc.binaryType = 'arraybuffer';
  return { dp, dc };
}

const enc = new TextEncoder();
function pattern(n, seed) {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * 31 + seed * 7) & 0xff;
  return u;
}
function messagesFor(max) {
  // [kind, value, expected] where expected is what the receiver must get.
  const out = [];
  const str = (s) => out.push({ send: s, want: s });
  const bin = (u) => out.push({ send: u, want: u });
  str('');
  str('a');
  str('héllo ✓ 🌍 '.repeat(80));
  str('x'.repeat(max)); // exactly max bytes
  str('✓'.repeat(Math.floor(max / 3))); // multi-byte, just under max
  bin(new Uint8Array(0));
  bin(pattern(1, 1));
  bin(pattern(1024, 2));
  bin(pattern(65536, 3));
  bin(pattern(max - 1, 4));
  bin(pattern(max, 5));
  // A view into a bigger buffer: only the view's bytes go out.
  const big = pattern(4096, 6);
  out.push({ send: new Uint8Array(big.buffer, 100, 1000), want: big.subarray(100, 1100) });
  // An ArrayBuffer (not a view) and a DataView.
  const ab = pattern(2048, 7);
  out.push({ send: ab.buffer.slice(0), want: ab });
  out.push({ send: new DataView(ab.buffer, 10, 20), want: ab.subarray(10, 30) });
  return out;
}
function equalMsg(got, want) {
  if (typeof want === 'string') return got === want;
  if (!(got instanceof ArrayBuffer)) return false;
  const g = new Uint8Array(got);
  if (g.length !== want.length) return false;
  for (let i = 0; i < g.length; i++) if (g[i] !== want[i]) return false;
  return true;
}
const describe = (m) =>
  typeof m === 'string' ? `str(${enc.encode(m).length})` : `bin(${m.byteLength ?? m.length})`;

async function transferCheck(from, to, opts) {
  const { dp, dc } = await pipe(from, to, opts);
  const pc = from.sendTransport._handler._pc;
  const max = pc.sctp?.maxMessageSize;
  assert(max > 0, `no maxMessageSize (${max})`);
  const msgs = messagesFor(max);
  const got = [];
  dc.on('message', (m) => got.push(m));
  for (const m of msgs) dp.send(m.send);
  const t0 = performance.now();
  while (got.length < msgs.length && performance.now() - t0 < 10000) await sleep(20);
  const ordered = opts.ordered !== false;
  const problems = [];
  if (got.length !== msgs.length) problems.push(`received ${got.length}/${msgs.length}`);
  if (ordered) {
    msgs.forEach((m, i) => {
      if (i < got.length && !equalMsg(got[i], m.want)) {
        problems.push(`#${i} ${describe(m.want)} got ${describe(got[i])}`);
      }
    });
  } else {
    const left = [...got];
    for (const m of msgs) {
      const j = left.findIndex((g) => equalMsg(g, m.want));
      if (j < 0) problems.push(`missing ${describe(m.want)}`);
      else left.splice(j, 1);
    }
  }
  // Over the max: TypeError, channel stays open, next message still arrives.
  let overErr = null;
  try {
    dp.send(new Uint8Array(max + 1));
  } catch (e) {
    overErr = e;
  }
  if (!(overErr instanceof TypeError)) problems.push(`over-max send: ${overErr ?? 'no error'}`);
  const after = once(dc, 'message');
  dp.send('after');
  if ((await after) !== 'after') problems.push('message after over-max send lost');
  if (dp.readyState !== 'open') problems.push(`producer ${dp.readyState} after over-max`);
  dp.close();
  dc.close();
  await sfu.rpc('closeDataProducer', { dataProducerId: dp.id });
  assert(problems.length === 0, problems.join('; '));
  return { messages: msgs.length, maxMessageSize: max };
}

const configs = [
  ['ordered', { ordered: true }],
  ['unordered', { ordered: false }],
  ['unreliable maxRetransmits 0', { ordered: false, maxRetransmits: 0 }],
  ['maxPacketLifeTime 1000', { ordered: false, maxPacketLifeTime: 1000 }],
];
for (const [label, opts] of configs) {
  await check(`A->B ${label}`, () => transferCheck(A, B, { label, ...opts }));
  await check(`B->A ${label}`, () => transferCheck(B, A, { label, ...opts }));
}

await check('candidate pairs avoid the VPN', async () => {
  const pairs = {
    'A send': await selectedPair(A.sendTransport),
    'A recv': await selectedPair(A.recvTransport),
    'B send': await selectedPair(B.sendTransport),
    'B recv': await selectedPair(B.recvTransport),
  };
  for (const [k, p] of Object.entries(pairs)) assert(p && !p.vpn, `${k}: ${JSON.stringify(p)}`);
  return Object.fromEntries(
    Object.entries(pairs).map(([k, p]) => [k, `${p.local} -> ${p.remote}`]),
  );
});

await check(`${NUM_CHANNELS} channels A->B at once`, async () => {
  const pipes = [];
  for (let i = 0; i < NUM_CHANNELS; i++) pipes.push(await pipe(A, B, { label: `many-${i}` }));
  const perChannel = 5;
  const got = pipes.map(() => []);
  pipes.forEach(({ dc }, i) => {
    dc.on('message', (m) => got[i].push(m));
  });
  for (let k = 0; k < perChannel; k++) {
    pipes.forEach(({ dp }, i) => {
      dp.send(k % 2 ? `ch${i}-m${k}` : pattern(100 + i, k));
    });
  }
  const total = NUM_CHANNELS * perChannel;
  const t0 = performance.now();
  const count = () => got.reduce((s, g) => s + g.length, 0);
  while (count() < total && performance.now() - t0 < 15000) await sleep(20);
  const bad = [];
  got.forEach((g, i) => {
    if (g.length !== perChannel) bad.push(`ch${i}: ${g.length} msgs`);
    g.forEach((m, k) => {
      const want = k % 2 ? `ch${i}-m${k}` : pattern(100 + i, k);
      if (!equalMsg(m, want)) bad.push(`ch${i} m${k} wrong`);
    });
  });
  const streamIds = pipes.map(({ dp }) => dp.sctpStreamParameters.streamId);
  for (const { dp, dc } of pipes) {
    dp.close();
    dc.close();
    await sfu.rpc('closeDataProducer', { dataProducerId: dp.id });
  }
  assert(bad.length === 0, bad.slice(0, 10).join('; '));
  return { messages: count(), maxStreamId: Math.max(...streamIds) };
});

// Closing. The raw RTCDataChannel behind each mediasoup-client object is its
// `_dataChannel`; `__log` holds the events it fired (common.mjs).
const evs = (ch) =>
  ch.__log.map((e) => (e.type === 'error' ? `error(${e.detail}:${e.cause})` : e.type));
const waitClosed = async (ch, ms = 5000) => {
  const t0 = performance.now();
  while (ch.readyState !== 'closed' && performance.now() - t0 < ms) await sleep(10);
  // Let any trailing events land.
  await sleep(50);
  return ch.readyState;
};

await check('client closes its DataProducer, then the app closes it on the SFU', async () => {
  const { dp, dc } = await pipe(A, B, { label: 'close-dp' });
  const dpCh = dp._dataChannel;
  const dcCh = dc._dataChannel;
  const dcClosed = once(dc, 'close');
  dp.close();
  await waitClosed(dpCh);
  await sleep(300);
  const sfuStillHasIt = await sfu.rpc('has', { kind: 'dataProducer', id: dp.id });
  const consumerStateBefore = dcCh.readyState;
  await sfu.rpc('closeDataProducer', { dataProducerId: dp.id });
  await dcClosed;
  await waitClosed(dcCh);
  const r = {
    producerChannel: evs(dpCh),
    consumerChannelBeforeSfuClose: consumerStateBefore,
    consumerChannel: evs(dcCh),
    sfuKeptDataProducerAfterReset: sfuStillHasIt,
  };
  assert(dpCh.readyState === 'closed' && dcCh.readyState === 'closed', JSON.stringify(r));
  assert(evs(dpCh).at(-1) === 'close' && evs(dcCh).at(-1) === 'close', JSON.stringify(r));
  assert(!evs(dcCh).some((e) => e.startsWith('error')), JSON.stringify(r));
  return r;
});

await check('client closes its DataConsumer; producer keeps sending', async () => {
  const { dp, dc } = await pipe(A, B, { label: 'close-dc' });
  const dpCh = dp._dataChannel;
  const dcCh = dc._dataChannel;
  dc.close();
  await waitClosed(dcCh);
  await sleep(300);
  const sfuStillHasIt = await sfu.rpc('has', { kind: 'dataConsumer', id: dc.id });
  const consumers = await sfu.rpc('events');
  await sfu.rpc('closeDataConsumer', { dataConsumerId: dc.id });
  for (let i = 0; i < 50; i++) dp.send(`after-${i}`);
  await sleep(200);
  const r = {
    consumerChannel: evs(dcCh),
    producerChannel: evs(dpCh),
    producerState: dpCh.readyState,
    sfuKeptDataConsumerAfterReset: sfuStillHasIt,
    sfuEvents: consumers.filter((e) => e.id === dc.id).map((e) => e.ev),
  };
  assert(dcCh.readyState === 'closed' && evs(dcCh).at(-1) === 'close', JSON.stringify(r));
  assert(dpCh.readyState === 'open', JSON.stringify(r));
  dp.close();
  await sfu.rpc('closeDataProducer', { dataProducerId: dp.id });
  return r;
});

await check('SFU closes a DataConsumer: consumer channel fires close', async () => {
  const { dp, dc } = await pipe(A, B, { label: 'sfu-close-dc' });
  const dcCh = dc._dataChannel;
  const closed = once(dc, 'close');
  await sfu.rpc('closeDataConsumer', { dataConsumerId: dc.id });
  await closed;
  await waitClosed(dcCh);
  const r = { consumerChannel: evs(dcCh), producerState: dp.readyState };
  assert(evs(dcCh).at(-1) === 'close', JSON.stringify(r));
  dp.close();
  await sfu.rpc('closeDataProducer', { dataProducerId: dp.id });
  return r;
});

await check('SFU closes a DataProducer: both channels close', async () => {
  const { dp, dc } = await pipe(A, B, { label: 'sfu-close-dp' });
  const dpCh = dp._dataChannel;
  const dcCh = dc._dataChannel;
  const closed = once(dc, 'close');
  await sfu.rpc('closeDataProducer', { dataProducerId: dp.id });
  await closed;
  await waitClosed(dcCh);
  await sleep(500);
  const r = {
    consumerChannel: evs(dcCh),
    producerChannel: evs(dpCh),
    producerState: dpCh.readyState,
  };
  // Sending on the producer the SFU dropped must not throw or error.
  try {
    if (dpCh.readyState === 'open') dp.send('into the void');
  } catch (e) {
    r.sendAfterSfuClose = String(e);
  }
  await sleep(200);
  r.producerChannelAfterSend = evs(dpCh);
  assert(evs(dcCh).at(-1) === 'close', JSON.stringify(r));
  dp.close();
  await waitClosed(dpCh);
  r.producerChannelFinal = evs(dpCh);
  return r;
});

await check('client closes its recv transport (pc.close): its channels end closed', async () => {
  const C = await createClient({ rpc: sfu.rpc, name: 'C', handlerName });
  const pipes = [await pipe(A, C, { label: 'tc-1' }), await pipe(A, C, { label: 'tc-2' })];
  const recvId = C.recvTransport.id;
  C.recvTransport.close();
  const r = {};
  for (const [i, { dc }] of pipes.entries()) {
    const ch = dc._dataChannel;
    await waitClosed(ch, 1000);
    r[`consumer${i}`] = { state: ch.readyState, events: evs(ch), closedFlag: dc.closed };
  }
  // The SFU sees the association go away (SCTP ABORT on pc.close()).
  await sleep(500);
  r.sfuSctpState = await sfu.rpc('transportSctpState', { transportId: recvId });
  // A's producers keep working with C gone.
  for (const { dp } of pipes) dp.send('still here');
  await sleep(200);
  r.producers = pipes.map(({ dp }) => dp.readyState);
  for (const { dp } of pipes) {
    dp.close();
    await sfu.rpc('closeDataProducer', { dataProducerId: dp.id });
  }
  await sfu.rpc('closeTransport', { transportId: recvId });
  C.close();
  for (const k of ['consumer0', 'consumer1']) assert(r[k].state === 'closed', JSON.stringify(r));
  assert(
    r.producers.every((s) => s === 'open'),
    JSON.stringify(r),
  );
  return r;
});

await check('SFU closes a client transport: the client channels close', async () => {
  const D = await createClient({ rpc: sfu.rpc, name: 'D', handlerName });
  const { dp, dc } = await pipe(D, B, { label: 'sfu-tc' });
  const { dp: dp2, dc: dc2 } = await pipe(A, D, { label: 'sfu-tc-recv' });
  const dpCh = dp._dataChannel;
  const dc2Ch = dc2._dataChannel;
  const pc = D.sendTransport._handler._pc;
  const states = [];
  pc.addEventListener('connectionstatechange', () => states.push(pc.connectionState));
  const consumerClosed = once(dc, 'close', { timeoutMs: 15000 });
  await sfu.rpc('closeTransport', { transportId: D.sendTransport.id });
  await consumerClosed; // B's consumer of D's producer: the SFU closes it
  // D's own channel on the closed transport: does it learn of it?
  const t0 = performance.now();
  await waitClosed(dpCh, 40000);
  const r = {
    dSendChannel: evs(dpCh),
    dSendChannelState: dpCh.readyState,
    secondsToClose: ((performance.now() - t0) / 1000).toFixed(1),
    dSendPcStates: states,
    bConsumerChannel: evs(dc._dataChannel),
  };
  // D's recv transport is untouched and still delivers.
  const m = once(dc2, 'message');
  dp2.send('recv side ok');
  r.dRecvStillWorks = (await m) === 'recv side ok';
  dp2.close();
  await sfu.rpc('closeDataProducer', { dataProducerId: dp2.id });
  r.dc2 = evs(dc2Ch);
  D.close();
  assert(r.dRecvStillWorks, JSON.stringify(r));
  return r;
});

// Teardown.
A.close();
B.close();
await sleep(200);
const leftOpen = channelLog.filter((c) => c.readyState !== 'closed').length;
const errorsFired = channelLog.flatMap((c) => c.__log.filter((e) => e.type === 'error'));
sfu.close();
console.log(
  JSON.stringify({
    channels: channelLog.length,
    leftOpen,
    errorEvents: errorsFired.map((e) => `${e.detail}:${e.cause}:${e.message}`),
    uncaught,
  }),
);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed; uncaught: ${uncaught.length}`);
process.exitCode = failed || uncaught.length ? 1 : 0;
// The process must now exit on its own (checked by the caller).
