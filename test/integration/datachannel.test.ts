// Data channels between two RTCPeerConnections through the public API,
// against real libwebrtc: in-band and negotiated channels, every message
// type, ordering, size limits, flow control, closing and lifetime.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Worker } from 'node:worker_threads';
import type {
  RTCDataChannel,
  RTCDataChannelEvent,
  RTCDataChannelInit,
  RTCErrorEvent,
} from '../../lib/index.ts';
import { builtPackage } from './built-package.ts';
import { connect, next, type Pair, pair } from './harness.ts';

interface Channels extends Pair {
  local: RTCDataChannel;
  remote: RTCDataChannel;
}

/** `a` creates an in-band channel; resolves once both ends have fired `open`. */
async function inBand(t: TestContext, init: RTCDataChannelInit = {}): Promise<Channels> {
  const p = pair(t);
  const local = p.a.createDataChannel('chat', init);
  const localOpen = next(local, 'open');
  // Chained at once: the remote `open` comes in a later task than `datachannel`.
  const remote = next<RTCDataChannelEvent>(p.b, 'datachannel').then(async ({ channel }) => {
    await next(channel, 'open');
    return channel;
  });
  await connect(p);
  await localOpen;
  return { ...p, local, remote: await remote };
}

/** Resolves with the data of the next `count` messages on `channel`. */
function messages(channel: RTCDataChannel, count: number): Promise<unknown[]> {
  const received: unknown[] = [];
  return next<MessageEvent>(channel, 'message', (e) => {
    received.push(e.data);
    return received.length === count;
  }).then(() => received);
}

test('an in-band channel opens on both sides with matching settings and ids', async (t) => {
  const p = pair(t);
  const local = p.a.createDataChannel('chat', {
    ordered: false,
    maxRetransmits: 2,
    protocol: 'p1',
  });
  assert.equal(local.id, null, 'no id before the DTLS role is known');
  const log: string[] = [];
  const remote = next<RTCDataChannelEvent>(p.b, 'datachannel').then(({ channel }) => {
    log.push(`datachannel ${channel.readyState}`);
    return next(channel, 'open').then(() => {
      log.push('remote open');
      return channel;
    });
  });
  const localOpen = next(local, 'open');
  await connect(p);
  await localOpen;
  const channel = await remote;
  assert.deepEqual(log, ['datachannel open', 'remote open']);
  const settings = (c: RTCDataChannel) => [
    c.label,
    c.ordered,
    c.maxPacketLifeTime,
    c.maxRetransmits,
    c.protocol,
    c.negotiated,
    c.id,
  ];
  assert.deepEqual(settings(channel), settings(local));
  assert.equal(typeof local.id, 'number');
});

test('a mediasoup-style negotiated channel with a high id carries messages both ways', async (t) => {
  const p = pair(t);
  // As mediasoup-client's handlers create them, unset members included.
  const init: RTCDataChannelInit = {
    negotiated: true,
    id: 65534,
    ordered: false,
    maxPacketLifeTime: 3000,
    maxRetransmits: undefined,
    protocol: 'chat',
  };
  const a = p.a.createDataChannel('ms', init);
  const b = p.b.createDataChannel('ms', init);
  b.binaryType = 'arraybuffer';
  const opened = Promise.all([next(a, 'open'), next(b, 'open')]);
  let announced = false;
  p.b.ondatachannel = () => {
    announced = true;
  };
  await connect(p);
  await opened;
  assert.deepEqual(
    [a.id, b.id, a.negotiated, a.maxPacketLifeTime, a.ordered],
    [65534, 65534, true, 3000, false],
  );
  const atB = messages(b, 1);
  const atA = messages(a, 1);
  a.send('hello');
  b.send(new Uint8Array([1, 2, 3]));
  assert.deepEqual(await atB, ['hello']);
  assert.deepEqual([...new Uint8Array((await atA)[0] as ArrayBuffer)], [1, 2, 3]);
  assert.equal(announced, false, 'a negotiated channel is never announced');
});

test('every message type arrives, as binaryType says, in send order across Blobs', async (t) => {
  const { local, remote } = await inBand(t);
  const received = messages(remote, 7);
  local.send('text é');
  local.send(new Blob(['blob one']));
  local.send(new Uint8Array([1, 2, 3]).buffer);
  local.send(new Uint8Array([9, 4, 5, 9]).subarray(1, 3));
  local.send(new Blob([new Uint8Array([6])]));
  local.send('after the blobs');
  local.send('');
  const data = await received;
  const decoded = data.map((d) =>
    typeof d === 'string' ? d : [...new Uint8Array(d as ArrayBuffer)],
  );
  assert.deepEqual(decoded, [
    'text é',
    [...Buffer.from('blob one')],
    [1, 2, 3],
    [4, 5],
    [6],
    'after the blobs',
    '',
  ]);

  local.binaryType = 'blob';
  const asBlob = messages(local, 2);
  remote.send(new Uint8Array([7, 8]));
  remote.send('still text');
  const [blob, text] = await asBlob;
  assert.ok(blob instanceof Blob);
  assert.deepEqual([...(await blob.bytes())], [7, 8]);
  assert.equal(text, 'still text');
});

test('a message of exactly maxMessageSize arrives whole; one byte more is a TypeError', async (t) => {
  const { a, local, remote } = await inBand(t);
  const max = a.sctp?.maxMessageSize;
  assert.equal(max, 262144);
  const big = new Uint8Array(262144).map((_, i) => i % 251);
  const received = messages(remote, 1);
  local.send(big);
  assert.throws(() => local.send(new Uint8Array(262145)), { name: 'TypeError' });
  assert.throws(() => local.send('x'.repeat(262145)), { name: 'TypeError' });
  const [data] = await received;
  assert.ok(Buffer.from(data as ArrayBuffer).equals(Buffer.from(big)));
  assert.equal(local.readyState, 'open');
});

test('bufferedAmount drains to 0 with a bufferedamountlow, and everything arrives', async (t) => {
  const { local, remote } = await inBand(t);
  local.bufferedAmountLowThreshold = 0;
  const chunk = new Uint8Array(65536);
  // 512 KiB: more than SCTP takes at once (about 100 KB), so most of it
  // waits in libwebrtc's queue. Loopback SCTP in one process manages only
  // about 1 MiB/s (wrtc too), so this stays small.
  const count = 8;
  const received = messages(remote, count);
  const low = next(local, 'bufferedamountlow');
  for (let i = 0; i < count; i++) local.send(chunk);
  assert.equal(local.bufferedAmount, count * chunk.byteLength, 'grows synchronously');
  await low;
  assert.equal(local.bufferedAmount, 0);
  assert.equal((await received).length, count);
});

// Two PCs' events share one order, the order libwebrtc reported them in:
// the sender's bufferedAmount decrease (reported when SCTP takes the
// message) always reaches JS before the receiver's message, even when both
// are queued by the time JS looks. With one queue per PC, libuv's polling
// order decided, and the message came first about half the time here.
test("a receiver's message never reaches JS before the sender's bufferedAmount decrease", async (t) => {
  const { local, remote } = await inBand(t);
  const early: number[] = [];
  for (let i = 0; i < 40; i++) {
    const received = next<MessageEvent>(remote, 'message');
    local.send('hello');
    // Keep JS busy until both events are queued.
    const until = performance.now() + 3;
    while (performance.now() < until);
    await received;
    if (local.bufferedAmount !== 0) {
      early.push(i);
      await next(local, 'bufferedamountlow');
    }
  }
  assert.deepEqual(early, [], 'messages that arrived before the sender saw them sent');
});

test('unordered and partially reliable channels keep their settings at both ends', async (t) => {
  const p = pair(t);
  const lossy = p.a.createDataChannel('lossy', { ordered: false, maxRetransmits: 0 });
  const timed = p.a.createDataChannel('timed', { maxPacketLifeTime: 150 });
  const remotes = new Map<string, RTCDataChannel>();
  const announced = new Promise<void>((resolve) => {
    p.b.ondatachannel = ({ channel }) => {
      remotes.set(channel.label, channel);
      if (remotes.size === 2) resolve();
    };
  });
  const opened = Promise.all([next(lossy, 'open'), next(timed, 'open')]);
  await connect(p);
  await Promise.all([announced, opened]);
  const remoteLossy = remotes.get('lossy') as RTCDataChannel;
  const remoteTimed = remotes.get('timed') as RTCDataChannel;
  assert.deepEqual(
    [remoteLossy.ordered, remoteLossy.maxRetransmits, remoteLossy.maxPacketLifeTime],
    [false, 0, null],
  );
  assert.deepEqual(
    [remoteTimed.ordered, remoteTimed.maxRetransmits, remoteTimed.maxPacketLifeTime],
    [true, null, 150],
  );
  // Loopback loses nothing, so each still delivers.
  const got = Promise.all([messages(remoteLossy, 1), messages(remoteTimed, 1)]);
  lossy.send('u');
  timed.send('t');
  assert.deepEqual(await got, [['u'], ['t']]);
});

for (const side of ['local', 'remote'] as const) {
  test(`close() on the ${side} end: closing fires only on the other end, then close on both`, async (t) => {
    const channels = await inBand(t);
    const closer = channels[side];
    const other = side === 'local' ? channels.remote : channels.local;
    const log: string[] = [];
    for (const [name, c] of [
      ['closer', closer],
      ['other', other],
    ] as const) {
      for (const type of ['closing', 'close', 'error']) {
        c.addEventListener(type, () => log.push(`${name} ${type}`));
      }
    }
    const closed = Promise.all([next(closer, 'close'), next(other, 'close')]);
    closer.close();
    assert.equal(closer.readyState, 'closing');
    await closed;
    assert.deepEqual(
      log.filter((l) => l.startsWith('closer')),
      ['closer close'],
    );
    assert.deepEqual(
      log.filter((l) => l.startsWith('other')),
      ['other closing', 'other close'],
    );
    assert.deepEqual([closer.readyState, other.readyState], ['closed', 'closed']);
  });
}

// The spec fires no `closing` for an abrupt close; libwebrtc reports
// closing before closed either way, and Chrome fires `closing` for every
// close the channel's own side didn't start, as we do.
test('pc.close() closes its channels silently; the remote ends get closing, error (sctp-failure), close', async (t) => {
  const { a, local, remote } = await inBand(t);
  const log: string[] = [];
  for (const type of ['closing', 'close', 'error']) {
    local.addEventListener(type, () => log.push(`local ${type}`));
    remote.addEventListener(type, () => log.push(`remote ${type}`));
  }
  const error = next<RTCErrorEvent>(remote, 'error');
  const closed = next(remote, 'close');
  a.close();
  assert.equal(local.readyState, 'closed');
  assert.equal(a.sctp?.state, 'closed');
  await closed;
  const { error: rtcError } = await error;
  assert.deepEqual(
    [rtcError.name, rtcError.errorDetail, rtcError.sctpCauseCode],
    ['OperationError', 'sctp-failure', 12],
  );
  assert.deepEqual(log, ['remote closing', 'remote error', 'remote close']);
});

test('many channels, in-band and negotiated, all open and carry a message', async (t) => {
  const p = pair(t);
  const count = 40;
  const inBandChannels = Array.from({ length: count }, (_, i) => p.a.createDataChannel(`ib${i}`));
  const negotiated = Array.from({ length: count }, (_, i) => [
    p.a.createDataChannel(`n${i}`, { negotiated: true, id: 1000 + i }),
    p.b.createDataChannel(`n${i}`, { negotiated: true, id: 1000 + i }),
  ]);
  const remote = new Map<string, RTCDataChannel>();
  const announced = new Promise<void>((resolve) => {
    p.b.ondatachannel = ({ channel }) => {
      remote.set(channel.label, channel);
      if (remote.size === count) resolve();
    };
  });
  const opened = Promise.all([...inBandChannels, ...negotiated.flat()].map((c) => next(c, 'open')));
  await connect(p);
  await Promise.all([announced, opened]);
  const ids = new Set(inBandChannels.map((c) => c.id));
  assert.equal(ids.size, count, 'distinct in-band ids');
  const received = [
    ...inBandChannels.map((c) => messages(remote.get(c.label) as RTCDataChannel, 1)),
    ...negotiated.map(([, b]) => messages(b as RTCDataChannel, 1)),
  ];
  for (const c of inBandChannels) c.send(c.label);
  for (const [a] of negotiated) a?.send(a.label);
  const labels = (await Promise.all(received)).map(([d]) => d);
  assert.deepEqual(labels, [
    ...inBandChannels.map((c) => c.label),
    ...negotiated.map(([a]) => a?.label),
  ]);
});

test('pc.sctp reports the connected transport, its DTLS and ICE transports', async (t) => {
  const p = pair(t);
  const dc = p.a.createDataChannel('x');
  const before = p.a.sctp;
  assert.equal(before, null);
  const opened = next(dc, 'open');
  await connect(p);
  const sctp = p.a.sctp;
  assert.ok(sctp);
  await opened;
  // SCTP's 'connected' and the channel's 'open' arrive in either order.
  if (sctp.state !== 'connected') {
    await next(sctp, 'statechange', () => sctp.state === 'connected');
  }
  assert.deepEqual(
    [sctp.state, sctp.maxMessageSize, sctp.maxChannels],
    ['connected', 262144, 65535],
  );
  assert.equal(sctp.transport.state, 'connected');
  // libwebrtc's own state for the transport: never 'completed', though the
  // controlling side's connection can be by now (seen on Linux).
  assert.equal(sctp.transport.iceTransport.state, 'connected');
  const [der] = sctp.transport.getRemoteCertificates();
  assert.ok(der && der.byteLength > 0);
});

test('getStats reports a data-channel entry per channel', async (t) => {
  const { a, local, remote } = await inBand(t);
  const received = messages(remote, 2);
  local.send('one');
  local.send(new Uint8Array(10));
  await received;
  const entries = [...(await a.getStats()).values()].filter((s) => s.type === 'data-channel');
  assert.equal(entries.length, 1);
  const [entry] = entries as Record<string, unknown>[];
  assert.deepEqual(
    [entry?.label, entry?.protocol, entry?.dataChannelIdentifier, entry?.state],
    ['chat', '', local.id, 'open'],
  );
  assert.equal(entry?.messagesSent, 2);
  assert.equal(entry?.bytesSent, 13);
});

// The app keeps no reference to either channel; their connections hold them
// (an open connection is itself held by the addon) until they close.
test('channels the app keeps no reference to keep delivering across GCs', async (t) => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const p = pair(t);
  const received = (() => {
    const dc = p.a.createDataChannel('gc');
    const answered = new Promise<string>((resolve) => {
      dc.onmessage = (e) => resolve(e.data as string);
    });
    dc.onopen = () => dc.send('ping');
    p.b.ondatachannel = ({ channel }) => {
      channel.onmessage = (e) => channel.send(`${e.data} pong`);
    };
    return answered;
  })();
  await connect(p);
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(await received, 'ping pong');
});

test('terminating a worker with busy open data channels is clean', async (t) => {
  // Plain JavaScript on the compiled package, not lib/'s TypeScript: see
  // built-package.ts.
  const { entry } = builtPackage(t);
  const worker = new Worker(
    `
    (async () => {
      const { parentPort } = require('node:worker_threads');
      const { RTCPeerConnection } = await import(${JSON.stringify(entry)});
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate).catch(() => {});
      b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate).catch(() => {});
      const dc = a.createDataChannel('busy');
      b.ondatachannel = ({ channel }) => {
        // Echo everything, so messages are in flight both ways at teardown.
        channel.onmessage = ({ data }) => channel.send(data);
      };
      dc.onmessage = () => {};
      dc.onopen = () => {
        setInterval(() => dc.send(new Uint8Array(4096)), 1);
        parentPort.postMessage('open');
      };
      await a.setLocalDescription();
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription();
      await a.setRemoteDescription(b.localDescription);
    })();
    `,
    { eval: true },
  );
  const opened = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    setTimeout(() => reject(new Error('the channel never opened in the worker')), 15_000).unref();
  });
  try {
    await opened;
  } finally {
    // Never closed: termination must tear down the PCs and their channels.
    assert.equal(await worker.terminate(), 1);
  }
  const { local, remote } = await inBand(t);
  const got = messages(remote, 1);
  local.send('still works');
  assert.deepEqual(await got, ['still works']);
});

test('open channels do not keep the process alive once their connections are closed', async () => {
  const script = fileURLToPath(new URL('./datachannel-exit.ts', import.meta.url));
  const { code, stdout } = await new Promise<{ code: number | string; stdout: string }>(
    (resolve) => {
      execFile(process.execPath, [script], { timeout: 20_000 }, (error, out) => {
        resolve({ code: error ? (error.signal ?? error.code ?? 'error') : 0, stdout: out });
      });
    },
  );
  assert.equal(code, 0, `the child ended with ${code} (SIGTERM: it hung)`);
  assert.equal(stdout.trim(), 'open open');
});
