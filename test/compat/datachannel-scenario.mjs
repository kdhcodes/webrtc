// The data channel scenario: two peer connections with in-band and
// negotiated (mediasoup-style) channels, every message type, flow control,
// size limits, closing from either side and with the connection, and the
// errors createDataChannel and send() throw. Prints the observable outcomes
// as JSON. datachannel.test.ts runs it once per implementation, each in its
// own process: never load @roamhq/wrtc and our addon into the same process.
//
//   node datachannel-scenario.mjs wrtc|ours
import { writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { errorName as nameOf } from './errors.mjs';

/** Writes `text` to stdout synchronously (see two-pc-media-scenario.mjs). */
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

const impl = process.argv[2];
const w =
  impl === 'wrtc'
    ? createRequire(import.meta.url)('@roamhq/wrtc')
    : await import('../../lib/index.ts');
const { RTCPeerConnection } = w;

/** Resolves with the next matching `type` event; rejects after 10 s (failure guard). */
function next(target, type, pred = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${impl}: no ${type} event`)), 10_000);
    const listener = (event) => {
      if (!pred(event)) return;
      clearTimeout(timer);
      target.removeEventListener(type, listener);
      resolve(event);
    };
    target.addEventListener(type, listener);
  });
}

/** The data of the next `count` messages on `channel`. */
function messages(channel, count) {
  const received = [];
  return next(channel, 'message', (e) => {
    received.push(e.data);
    return received.length === count;
  }).then(() => received);
}

/** A received message's type and content. */
async function describe(data) {
  if (typeof data === 'string') return { type: 'string', value: data };
  if (data instanceof ArrayBuffer) return { type: 'ArrayBuffer', value: [...new Uint8Array(data)] };
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return { type: 'Blob', value: [...new Uint8Array(await data.arrayBuffer())] };
  }
  return { type: data?.constructor?.name ?? typeof data };
}

/** The name of what `fn()` throws, or 'no error'. */
function errorName(fn) {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return nameOf(error);
  }
}

const settings = (c) => ({
  label: c.label,
  ordered: c.ordered,
  maxPacketLifeTime: c.maxPacketLifeTime,
  maxRetransmits: c.maxRetransmits,
  protocol: c.protocol,
  negotiated: c.negotiated,
  id: c.id,
  readyState: c.readyState,
  bufferedAmount: c.bufferedAmount,
  bufferedAmountLowThreshold: c.bufferedAmountLowThreshold,
  binaryType: c.binaryType,
});

/**
 * Logs `name type` for each lifecycle event of `channel`. (bufferedamountlow
 * is checked on its own: with the default threshold of 0 it fires whenever
 * the channel drains, at times that vary.)
 */
function record(channel, name, log) {
  for (const type of ['open', 'closing', 'close', 'error']) {
    channel.addEventListener(type, () => log.push(`${name} ${type}`));
  }
}

const out = {};
const a = new RTCPeerConnection();
const b = new RTCPeerConnection();
a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate).catch(() => {});
b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate).catch(() => {});

// --- createDataChannel --------------------------------------------------------
const negotiationNeeded = next(a, 'negotiationneeded').then(() => true);
const chat = a.createDataChannel('chat');
const lossy = a.createDataChannel('lossy', { ordered: false, maxRetransmits: 0, protocol: 'p' });
const timed = a.createDataChannel('timed', { maxPacketLifeTime: 150, id: 77 });
// mediasoup-client's shape: negotiated with an id, unset members included.
const msInit = {
  negotiated: true,
  id: 1023,
  ordered: false,
  maxPacketLifeTime: 3000,
  maxRetransmits: undefined,
  protocol: 'ms',
};
const msA = a.createDataChannel('ms', msInit);
const msB = b.createDataChannel('ms', msInit);
out.create = {
  chat: settings(chat),
  lossy: settings(lossy),
  timed: settings(timed),
  negotiated: settings(msA),
};
out.errors = {
  noArguments: errorName(() => a.createDataChannel()),
  bothLimits: errorName(() =>
    a.createDataChannel('x', { maxPacketLifeTime: 1, maxRetransmits: 1 }),
  ),
  negotiatedWithoutId: errorName(() => a.createDataChannel('x', { negotiated: true })),
  id65535: errorName(() => a.createDataChannel('x', { negotiated: true, id: 65535 })),
  idInUse: errorName(() => a.createDataChannel('x', { negotiated: true, id: 1023 })),
  longLabel: errorName(() => a.createDataChannel('x'.repeat(65536))),
  sendWhileConnecting: errorName(() => chat.send('x')),
};
out.signaling = { negotiationneeded: await negotiationNeeded };

// --- negotiate and open -------------------------------------------------------
// One log per channel: events of different connections, and of different
// channels, interleave unpredictably.
const logA = [];
const logB = [];
const announcements = [];
record(chat, 'chat', logA);
const remote = new Map();
let datachannelEvent;
const announced = new Promise((resolve) => {
  b.ondatachannel = (event) => {
    datachannelEvent ??= event;
    const { channel } = event;
    remote.set(channel.label, channel);
    announcements.push(`${channel.label} ${channel.readyState}`);
    if (channel.label === 'chat') {
      logB.push('chat datachannel');
      record(channel, 'chat', logB);
    }
    if (['chat', 'lossy', 'timed'].every((label) => remote.has(label))) resolve();
  };
});
const opened = Promise.all([chat, lossy, timed, msA, msB].map((c) => next(c, 'open')));
await a.setLocalDescription(await a.createOffer());
await b.setRemoteDescription(a.localDescription);
await b.setLocalDescription(await b.createAnswer());
await a.setRemoteDescription(b.localDescription);
await Promise.all([opened, announced]);
const bChat = remote.get('chat');
const sameId = (c) => c.id === [chat, lossy, timed].find((l) => l.label === c.label)?.id;
out.open = {
  idsAssigned: [chat, lossy, timed].map((c) => typeof c.id === 'number'),
  remote: Object.fromEntries(
    ['chat', 'lossy', 'timed'].map((label) => {
      const c = remote.get(label);
      return [label, { ...settings(c), id: sameId(c) }];
    }),
  ),
  sctp: a.sctp
    ? {
        state: a.sctp.state,
        maxMessageSize: a.sctp.maxMessageSize,
        maxChannels: a.sctp.maxChannels,
      }
    : a.sctp,
  // What Object.keys (and so a spread) sees of the event: wrtc's is a plain
  // object, ours a WebIDL event with the payload on the prototype.
  datachannelEventKeys: Object.keys(datachannelEvent).filter((k) => k !== 'type' && k !== 'target'),
  datachannelEventChannel: datachannelEvent.channel instanceof w.RTCDataChannel,
};

// --- messages -----------------------------------------------------------------
const types = messages(bChat, 4);
chat.send('text é');
chat.send(new Uint8Array([1, 2, 3]).buffer);
chat.send(new Uint8Array([9, 4, 5, 9]).subarray(1, 3));
chat.send('');
out.messages = { arraybuffer: await Promise.all((await types).map(describe)) };
// The remote channel's open (if any) came in an earlier task than its first
// message, so the opening events are all in by now.
out.open.a = [...logA];
out.open.b = [...logB];
out.open.announced = [...announcements];

out.messages.sendBlob = errorName(() => chat.send(new Blob(['blob'])));
if (out.messages.sendBlob === 'no error') {
  const blobOrder = messages(bChat, 2);
  chat.send('after blob');
  out.messages.blobOrder = await Promise.all((await blobOrder).map(describe));
}
out.messages.setBinaryTypeBlob = errorName(() => {
  bChat.binaryType = 'blob';
});
out.messages.setBinaryTypeNonsense = errorName(() => {
  bChat.binaryType = 'nonsense';
});
out.messages.binaryType = bChat.binaryType;
const asBlob = messages(bChat, 1);
chat.send(new Uint8Array([7, 8]));
out.messages.withBinaryType = await Promise.all((await asBlob).map(describe));
bChat.binaryType = 'arraybuffer';

const msGot = Promise.all([messages(msB, 1), messages(msA, 1)]);
msA.send('to b');
msB.send(new Uint8Array([5]));
out.negotiated = {
  messages: await Promise.all((await msGot).flat().map(describe)),
};

// --- flow control and size limits ---------------------------------------------
chat.bufferedAmountLowThreshold = 1000;
const chunk = new Uint8Array(65536);
const drained = messages(bChat, 8);
const lows = [];
chat.addEventListener('bufferedamountlow', () => lows.push(chat.bufferedAmount));
for (let i = 0; i < 8; i++) chat.send(chunk);
out.flow = { bufferedAmountRightAfterSends: chat.bufferedAmount };
out.flow.delivered = (await drained).length;
// Every byte was handed to SCTP before b could receive it, so ours has
// queued all its bufferedamount events before this getStats completes.
await a.getStats();
out.flow.bufferedamountlow = lows.map((amount) => amount <= 1000);
out.flow.bufferedAmountDrained = chat.bufferedAmount;

const exact = messages(bChat, 1);
chat.send(new Uint8Array(262144));
out.size = {
  maxMessageSizeArrives: ((await exact)[0]?.byteLength ?? 0) === 262144,
  oneByteMore: errorName(() => chat.send(new Uint8Array(262145))),
};
await a.getStats();
out.size.readyStateAfter = chat.readyState;

// --- closing ------------------------------------------------------------------
const bTimed = remote.get('timed');
const closer = [];
const other = [];
record(timed, 'timed', closer);
record(bTimed, 'timed', other);
const timedClosed = Promise.all([next(timed, 'close'), next(bTimed, 'close')]);
timed.close();
out.close = { readyStateAfterClose: timed.readyState };
await timedClosed;
out.close.local = { closer, other };
out.close.readyStates = [timed.readyState, bTimed.readyState];

const bLossy = remote.get('lossy');
const remoteCloser = [];
const remoteOther = [];
record(bLossy, 'lossy', remoteCloser);
record(lossy, 'lossy', remoteOther);
const lossyClosed = Promise.all([next(lossy, 'close'), next(bLossy, 'close')]);
bLossy.close();
await lossyClosed;
out.close.remote = { closer: remoteCloser, other: remoteOther };

// --- the connection closes ----------------------------------------------------
logA.length = 0;
logB.length = 0;
// b's chat is recorded since its datachannel event.
record(msA, 'ms', logA);
const remoteClosed = next(bChat, 'close');
a.close();
out.pcClose = {
  localReadyStates: [chat.readyState, msA.readyState],
  sendAfter: errorName(() => chat.send('x')),
};
await remoteClosed;
for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
out.pcClose.a = [...logA];
out.pcClose.b = [...logB];
out.pcClose.remoteReadyState = bChat.readyState;
b.close();

writeAll(JSON.stringify(out));
// wrtc's own threads keep its process alive; ours must exit on its own.
if (impl === 'wrtc') process.exit(0);
