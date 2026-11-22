// Data channels between our RTCPeerConnection and Chromium's: in-band
// channels created by either side, negotiated (mediasoup-style) channels,
// every message type both ways, the largest message, and closing a channel
// or the connection from either side.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import type { RTCDataChannel, RTCDataChannelEvent, RTCErrorEvent } from '../../lib/index.ts';
import {
  type Call,
  type ChromePeer,
  call,
  connect,
  launch,
  next,
  type PageEvent,
} from './chrome.ts';

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(() => browser?.close());

/** A 'dc' event from the page (chrome-peer.js watchChannel). */
interface ChromeChannelEvent {
  label: string;
  type: 'open' | 'closing' | 'close' | 'error' | 'message';
  readyState: string;
  id?: number;
  /** For messages. */
  value?: string | number[];
  errorDetail?: string;
}

/** A remote channel's settings as Chrome reports them (chrome-peer.js channelInfo). */
interface ChromeChannelInfo {
  label: string;
  ordered: boolean;
  maxPacketLifeTime: number | null;
  maxRetransmits: number | null;
  protocol: string;
  negotiated: boolean;
  id: number | null;
  readyState: string;
}

/** Collects Chrome's data channel events from the start of the call. */
class ChromeChannels {
  readonly events: ChromeChannelEvent[] = [];
  readonly announced: ChromeChannelInfo[] = [];
  readonly #chrome: ChromePeer;

  constructor(chrome: ChromePeer) {
    this.#chrome = chrome;
    chrome.addEventListener('dc', (e) => {
      this.events.push((e as PageEvent<ChromeChannelEvent>).detail);
    });
    chrome.addEventListener('datachannel', (e) => {
      this.announced.push((e as PageEvent<ChromeChannelInfo>).detail);
    });
  }

  of(label: string): ChromeChannelEvent[] {
    return this.events.filter((e) => e.label === label);
  }

  /** Resolves once channel `label` has had `count` events of `type`. */
  async waitFor(
    label: string,
    type: ChromeChannelEvent['type'],
    count = 1,
  ): Promise<ChromeChannelEvent[]> {
    const matching = () => this.of(label).filter((e) => e.type === type);
    if (matching().length < count) {
      await next(this.#chrome, 'dc', () => matching().length >= count);
    }
    return matching();
  }
}

/** Resolves with the data of the next `count` messages on `channel`. */
function messages(channel: RTCDataChannel, count: number): Promise<unknown[]> {
  const received: unknown[] = [];
  return next<MessageEvent>(channel, 'message', (e) => {
    received.push(e.data);
    return received.length === count;
  }).then(() => received);
}

/** A message as chrome-peer.js describes them: text, or an array of bytes. */
async function describe(data: unknown): Promise<string | number[]> {
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return [...(await data.bytes())];
  return [...new Uint8Array(data as ArrayBuffer)];
}

/** Our channel `label` from a `datachannel` event, once it is open. */
function announcedToUs(c: Call, label: string): Promise<RTCDataChannel> {
  return next<RTCDataChannelEvent>(c.pc, 'datachannel', (e) => e.channel.label === label).then(
    async ({ channel }) => {
      await next(channel, 'open');
      return channel;
    },
  );
}

const settings = (dc: RTCDataChannel | ChromeChannelInfo) => ({
  label: dc.label,
  ordered: dc.ordered,
  maxPacketLifeTime: dc.maxPacketLifeTime,
  maxRetransmits: dc.maxRetransmits,
  protocol: dc.protocol,
  negotiated: dc.negotiated,
  id: dc.id,
});

/** Node to Chrome: every type, in call order across a Blob. */
async function nodeToChrome(channels: ChromeChannels, dc: RTCDataChannel): Promise<void> {
  const before = channels.of(dc.label).filter((e) => e.type === 'message').length;
  dc.send('from node é');
  dc.send(new Uint8Array([1, 2, 3]).buffer);
  dc.send(new Blob([new Uint8Array([4, 5])]));
  dc.send(new Uint8Array([0, 6, 7, 0]).subarray(1, 3));
  dc.send('');
  const received = (await channels.waitFor(dc.label, 'message', before + 5)).slice(before);
  assert.deepEqual(
    received.map((e) => e.value),
    ['from node é', [1, 2, 3], [4, 5], [6, 7], ''],
  );
}

/** Chrome to Node: every type, received as ArrayBuffers and then as Blobs. */
async function chromeToNode(c: Call, dc: RTCDataChannel): Promise<void> {
  const received = messages(dc, 4);
  await c.chrome.call('send', dc.label, { string: 'from chrome é' });
  await c.chrome.call('send', dc.label, { bytes: [1, 2] });
  await c.chrome.call('send', dc.label, { view: [3, 4] });
  await c.chrome.call('send', dc.label, { blob: [5, 6] });
  const data = await received;
  assert.deepEqual(
    data.map((d) => (typeof d === 'string' ? 'string' : d?.constructor.name)),
    ['string', 'ArrayBuffer', 'ArrayBuffer', 'ArrayBuffer'],
  );
  assert.deepEqual(await Promise.all(data.map(describe)), [
    'from chrome é',
    [1, 2],
    [3, 4],
    [5, 6],
  ]);
  dc.binaryType = 'blob';
  const asBlob = messages(dc, 1);
  await c.chrome.call('send', dc.label, { bytes: [7] });
  const [blob] = await asBlob;
  assert.ok(blob instanceof Blob);
  assert.deepEqual(await describe(blob), [7]);
  dc.binaryType = 'arraybuffer';
}

test('an in-band channel we create opens in Chrome with our settings; messages both ways', async (t) => {
  const c = await call(t, browser);
  const channels = new ChromeChannels(c.chrome);
  const dc = c.pc.createDataChannel('node-chat', {
    ordered: false,
    maxRetransmits: 2,
    protocol: 'proto',
  });
  const opened = next(dc, 'open');
  await connect(c, c.nodeOffers);
  await opened;
  await channels.waitFor('node-chat', 'open');
  assert.deepEqual(channels.announced.map(settings), [settings(dc)]);
  assert.equal(typeof dc.id, 'number');
  await nodeToChrome(channels, dc);
  await chromeToNode(c, dc);
  await c.checkCandidates();
});

test('an in-band channel Chrome creates opens here with its settings; messages both ways', async (t) => {
  const c = await call(t, browser);
  const channels = new ChromeChannels(c.chrome);
  const created = await c.chrome.call<ChromeChannelInfo>('createDataChannel', 'chrome-chat', {
    maxPacketLifeTime: 500,
    protocol: 'p2',
  });
  const announced = announcedToUs(c, 'chrome-chat');
  await connect(c, c.chromeOffers);
  const dc = await announced;
  await channels.waitFor('chrome-chat', 'open');
  const info = await c.chrome.call<ChromeChannelInfo>('channelInfo', 'chrome-chat');
  assert.deepEqual(settings(dc), settings(info));
  assert.deepEqual([created.id, info.id === dc.id], [null, true]);
  await nodeToChrome(channels, dc);
  await chromeToNode(c, dc);
  await c.checkCandidates();
});

test('negotiated channels (mediasoup-style, id 1023) carry messages both ways, unannounced', async (t) => {
  const c = await call(t, browser);
  const channels = new ChromeChannels(c.chrome);
  const init = { negotiated: true, id: 1023, ordered: false, maxPacketLifeTime: 3000 };
  const dc = c.pc.createDataChannel('ms', init);
  await c.chrome.call('createDataChannel', 'ms', init);
  let announced = false;
  c.pc.ondatachannel = () => {
    announced = true;
  };
  const opened = next(dc, 'open');
  await connect(c, c.nodeOffers);
  await opened;
  const [chromeOpen] = await channels.waitFor('ms', 'open');
  assert.equal(chromeOpen?.id, 1023);
  await nodeToChrome(channels, dc);
  await chromeToNode(c, dc);
  assert.deepEqual([announced, channels.announced.length], [false, 0]);
  await c.checkCandidates();
});

test('the largest message each side allows arrives whole, both ways', async (t) => {
  const c = await call(t, browser);
  const channels = new ChromeChannels(c.chrome);
  const dc = c.pc.createDataChannel('big');
  const opened = next(dc, 'open');
  await connect(c, c.nodeOffers);
  await opened;
  await channels.waitFor('big', 'open');
  const ours = c.pc.sctp?.maxMessageSize;
  const chromes = (await c.chrome.call<{ maxMessageSize: number }>('sctp')).maxMessageSize;
  t.diagnostic(`maxMessageSize: ours ${ours}, Chrome's ${chromes}`);
  assert.equal(ours, 262144);
  const pattern = (size: number) => new Uint8Array(size).map((_, i) => i % 251);

  dc.send(pattern(ours));
  assert.throws(() => dc.send(new Uint8Array(ours + 1)), { name: 'TypeError' });
  const [atChrome] = await channels.waitFor('big', 'message');
  assert.ok(Buffer.from(atChrome?.value as number[]).equals(Buffer.from(pattern(ours))));

  const size = Math.min(chromes, 262144);
  const atNode = messages(dc, 1);
  await c.chrome.call('sendLarge', 'big', size);
  const [data] = await atNode;
  assert.ok(Buffer.from(data as ArrayBuffer).equals(Buffer.from(pattern(size))));
  await c.checkCandidates();
});

test('our close(): Chrome sees closing, then close; we see only close', async (t) => {
  const c = await call(t, browser);
  const channels = new ChromeChannels(c.chrome);
  const dc = c.pc.createDataChannel('bye');
  const opened = next(dc, 'open');
  await connect(c, c.nodeOffers);
  await opened;
  await channels.waitFor('bye', 'open');
  const ours: string[] = [];
  for (const type of ['closing', 'close', 'error'])
    dc.addEventListener(type, () => ours.push(type));
  const closed = next(dc, 'close');
  dc.close();
  assert.equal(dc.readyState, 'closing');
  await closed;
  await channels.waitFor('bye', 'close');
  assert.deepEqual(ours, ['close']);
  assert.deepEqual(
    channels.of('bye').map((e) => e.type),
    ['open', 'closing', 'close'],
  );
  await c.checkCandidates();
});

test("Chrome's close(): we see closing, then close", async (t) => {
  const c = await call(t, browser);
  const channels = new ChromeChannels(c.chrome);
  const dc = c.pc.createDataChannel('bye');
  const opened = next(dc, 'open');
  await connect(c, c.nodeOffers);
  await opened;
  await channels.waitFor('bye', 'open');
  const ours: string[] = [];
  for (const type of ['closing', 'close', 'error'])
    dc.addEventListener(type, () => ours.push(type));
  const closed = next(dc, 'close');
  await c.chrome.call('closeChannel', 'bye');
  await closed;
  await channels.waitFor('bye', 'close');
  assert.deepEqual(ours, ['closing', 'close']);
  assert.deepEqual(
    channels.of('bye').map((e) => e.type),
    ['open', 'close'],
  );
  await c.checkCandidates();
});

test('our pc.close(): our channel closes silently; Chrome gets an sctp-failure error and close', async (t) => {
  const c = await call(t, browser);
  const channels = new ChromeChannels(c.chrome);
  const dc = c.pc.createDataChannel('gone');
  const opened = next(dc, 'open');
  await connect(c, c.nodeOffers);
  await opened;
  await channels.waitFor('gone', 'open');
  const ours: string[] = [];
  for (const type of ['closing', 'close', 'error'])
    dc.addEventListener(type, () => ours.push(type));
  await c.checkCandidates();
  c.pc.close();
  assert.equal(dc.readyState, 'closed');
  await channels.waitFor('gone', 'close');
  const chromeEvents = channels.of('gone').slice(1);
  t.diagnostic(`Chrome: ${chromeEvents.map((e) => e.type).join(', ')}`);
  // Chrome, like us, fires closing before an abrupt close's error.
  assert.deepEqual(
    chromeEvents.map((e) => e.type),
    ['closing', 'error', 'close'],
  );
  assert.equal(chromeEvents.find((e) => e.type === 'error')?.errorDetail, 'sctp-failure');
  assert.deepEqual(ours, []);
});

test("Chrome's pc.close(): our channel gets closing, an sctp-failure error, then close", async (t) => {
  const c = await call(t, browser);
  const channels = new ChromeChannels(c.chrome);
  const dc = c.pc.createDataChannel('gone');
  const opened = next(dc, 'open');
  await connect(c, c.nodeOffers);
  await opened;
  await channels.waitFor('gone', 'open');
  const ours: string[] = [];
  let detail: string | undefined;
  dc.addEventListener('error', (e) => {
    detail = (e as RTCErrorEvent).error.errorDetail;
  });
  for (const type of ['closing', 'close', 'error'])
    dc.addEventListener(type, () => ours.push(type));
  await c.checkCandidates();
  const closed = next(dc, 'close');
  await c.chrome.call('close');
  await closed;
  assert.deepEqual(ours, ['closing', 'error', 'close']);
  assert.equal(detail, 'sctp-failure');
});
