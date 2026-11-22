// RTCDataChannel and createDataChannel() against the fake native addon:
// validation and error types, the JS-side state (readyState, id,
// bufferedAmount), send ordering and event order. End-to-end behaviour is
// in test/integration/datachannel.test.ts.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { NativeErrorInfo } from './internal/native-types.ts';
import { negotiateData } from './internal/testing/data-channel.ts';
import { assertEventAttributes } from './internal/testing/event-attributes.ts';
import {
  FakeDataChannel,
  FakePeerConnection,
  nativeError,
  useFakeNative,
} from './internal/testing/fake-native.ts';
import { RTCDataChannel } from './RTCDataChannel.ts';
import { RTCDataChannelEvent } from './RTCDataChannelEvent.ts';
import { RTCError } from './RTCError.ts';
import { RTCErrorEvent } from './RTCErrorEvent.ts';
import { RTCPeerConnection } from './RTCPeerConnection.ts';

function setup(t: TestContext) {
  const fakes = useFakeNative(t, { PeerConnection: FakePeerConnection });
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  return { pc, fake: fakes.last('PeerConnection') };
}

/** A channel whose native side reported 'open', and its fake. */
async function openChannel(t: TestContext, init = {}) {
  const { pc, fake } = setup(t);
  await negotiateData(pc, fake);
  const channel = pc.createDataChannel('chat', init);
  const native = fake.dataChannels.at(-1) as FakeDataChannel;
  fake.emit({ kind: 'dc:state', channelKey: native.key, state: 'open' });
  await fake.flush();
  assert.equal(channel.readyState, 'open');
  return { pc, fake, channel, native };
}

function record(target: EventTarget, types: string[], log: string[]): void {
  for (const type of types) target.addEventListener(type, () => log.push(type));
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// ---------------------------------------------------------------------------
// createDataChannel()

test('createDataChannel passes the converted init to libwebrtc, dropping an in-band id', (t) => {
  const { pc, fake } = setup(t);
  pc.createDataChannel('a', { id: 7, ordered: false, maxRetransmits: 3, protocol: 'p' });
  pc.createDataChannel('b', { negotiated: true, id: 9, maxPacketLifeTime: 100 });
  assert.deepEqual(fake.callsTo('createDataChannel'), [
    ['a', { ordered: false, protocol: 'p', negotiated: false, maxRetransmits: 3 }],
    ['b', { ordered: true, protocol: '', negotiated: true, maxPacketLifeTime: 100, id: 9 }],
  ]);
});

test('a new channel reports its settings, connecting, with no id until in-band ids are known', (t) => {
  const { pc } = setup(t);
  const inBand = pc.createDataChannel('chat', { ordered: false, maxPacketLifeTime: 500 });
  const negotiated = pc.createDataChannel('ms', { negotiated: true, id: 1023, protocol: 'x' });
  assert.deepEqual(
    [
      inBand.label,
      inBand.ordered,
      inBand.maxPacketLifeTime,
      inBand.maxRetransmits,
      inBand.protocol,
      inBand.negotiated,
      inBand.id,
      inBand.readyState,
      inBand.bufferedAmount,
      inBand.bufferedAmountLowThreshold,
      inBand.binaryType,
    ],
    ['chat', false, 500, null, '', false, null, 'connecting', 0, 0, 'arraybuffer'],
  );
  assert.deepEqual([negotiated.negotiated, negotiated.id, negotiated.protocol], [true, 1023, 'x']);
  assert.ok(inBand instanceof RTCDataChannel);
});

test('an in-band channel created once the DTLS role is known has its id at once', (t) => {
  const { pc, fake } = setup(t);
  fake.stub('createDataChannel', (label) => {
    const channel = new FakeDataChannel(fake.stream, { key: 1, label });
    channel.id = 3;
    return channel;
  });
  assert.equal(pc.createDataChannel('late').id, 3);
});

test('createDataChannel throws the spec exceptions for invalid arguments', (t) => {
  const { pc } = setup(t);
  const create = pc.createDataChannel.bind(pc) as (...args: unknown[]) => RTCDataChannel;
  const long = 'é'.repeat(32768); // 65536 bytes, 32768 characters
  const cases: [string, unknown[], string][] = [
    ['no label', [], 'TypeError'],
    ['label over 65535 bytes', [long], 'TypeError'],
    ['protocol over 65535 bytes', ['x', { protocol: long }], 'TypeError'],
    ['both reliability limits', ['x', { maxPacketLifeTime: 1, maxRetransmits: 1 }], 'TypeError'],
    ['negotiated without id', ['x', { negotiated: true }], 'TypeError'],
    ['id 65535', ['x', { negotiated: true, id: 65535 }], 'TypeError'],
    ['id 65536 (EnforceRange)', ['x', { negotiated: true, id: 65536 }], 'TypeError'],
    ['maxRetransmits -1 (EnforceRange)', ['x', { maxRetransmits: -1 }], 'TypeError'],
  ];
  const results = cases.map(([what, args]) => {
    try {
      create(...args);
      return [what, 'no error'];
    } catch (error) {
      return [what, (error as Error).name];
    }
  });
  assert.deepEqual(
    results,
    cases.map(([what, , name]) => [what, name]),
  );
  // 65535 bytes is still fine.
  assert.equal(create(`${'é'.repeat(32767)}a`).label.length, 32768);
});

test('createDataChannel on a closed connection throws InvalidStateError before checking the label', (t) => {
  const { pc } = setup(t);
  pc.close();
  assert.throws(() => pc.createDataChannel('x'.repeat(70000)), { name: 'InvalidStateError' });
});

test('a negotiated id libwebrtc has reserved is an OperationError', (t) => {
  const { pc } = setup(t);
  pc.createDataChannel('a', { negotiated: true, id: 5 });
  assert.throws(() => pc.createDataChannel('b', { negotiated: true, id: 5 }), {
    name: 'OperationError',
    message: 'StreamId reserved.',
  });
});

test("a negotiated id not below a connected transport's maxChannels is an OperationError", async (t) => {
  const { pc, fake } = setup(t);
  await negotiateData(pc, fake);
  fake.emit({
    kind: 'sctp:state',
    transport: 1,
    state: 'connected',
    maxMessageSize: 262144,
    maxChannels: 16,
  });
  await fake.flush();
  assert.throws(() => pc.createDataChannel('x', { negotiated: true, id: 16 }), {
    name: 'OperationError',
  });
  assert.equal(pc.createDataChannel('y', { negotiated: true, id: 15 }).id, 15);
});

test('RTCDataChannel is not constructible', () => {
  assert.throws(() => new (RTCDataChannel as unknown as new () => unknown)(), {
    name: 'TypeError',
    message: 'Illegal constructor',
  });
});

// ---------------------------------------------------------------------------
// State and events

test('open sets readyState, assigns an in-band id and fires open once', async (t) => {
  const { pc, fake } = setup(t);
  const channel = pc.createDataChannel('chat');
  const native = fake.dataChannels[0] as FakeDataChannel;
  const log: string[] = [];
  channel.onopen = () => log.push(`open ${channel.readyState} ${channel.id}`);
  native.id = 1;
  fake.emit({ kind: 'dc:state', channelKey: native.key, state: 'open' });
  await fake.flush();
  assert.deepEqual(log, ['open open 1']);
});

test('in-band ids are assigned when SCTP connects, before its statechange', async (t) => {
  const { pc, fake } = setup(t);
  const channel = pc.createDataChannel('chat');
  await negotiateData(pc, fake);
  const ids: (number | null)[] = [];
  pc.sctp?.addEventListener('statechange', () => ids.push(channel.id));
  (fake.dataChannels[0] as FakeDataChannel).id = 4;
  fake.emit({
    kind: 'sctp:state',
    transport: 1,
    state: 'connected',
    maxMessageSize: 262144,
    maxChannels: 1024,
  });
  await fake.flush();
  assert.deepEqual(ids, [4]);
});

test('a remote channel is open in its datachannel event; open fires in a later task', async (t) => {
  const { pc, fake } = setup(t);
  const native = new FakeDataChannel(fake.stream, {
    key: 7,
    label: 'remote',
    ordered: false,
    maxRetransmits: 2,
    protocol: 'proto',
  });
  native.id = 2;
  const log: string[] = [];
  pc.ondatachannel = (event) => {
    const { channel } = event;
    log.push(`datachannel ${channel.readyState}`);
    assert.ok(event instanceof RTCDataChannelEvent);
    assert.deepEqual(
      [channel.label, channel.ordered, channel.maxRetransmits, channel.protocol, channel.id],
      ['remote', false, 2, 'proto', 2],
    );
    // Sending from the handler works: the channel is already open.
    channel.send('hi');
    record(channel, ['open'], log);
  };
  fake.emit({ kind: 'datachannel', channel: native, channelKey: 7 });
  fake.emit({ kind: 'dc:state', channelKey: 7, state: 'open' });
  await fake.flush();
  assert.deepEqual(log, ['datachannel open', 'open']);
  assert.deepEqual(
    native.sent.map(([bytes]) => text(bytes)),
    ['hi'],
  );
});

test('close() goes to closing at once without an event; close fires when closed', async (t) => {
  const { fake, channel, native } = await openChannel(t);
  const log: string[] = [];
  record(channel, ['closing', 'close', 'error'], log);
  channel.close();
  channel.close();
  assert.equal(channel.readyState, 'closing');
  assert.equal(native.callsTo('close').length, 1);
  fake.emit({ kind: 'dc:state', channelKey: native.key, state: 'closing' });
  fake.emit({ kind: 'dc:state', channelKey: native.key, state: 'closed' });
  await fake.flush();
  assert.deepEqual(log, ['close']);
  assert.equal(channel.readyState, 'closed');
});

test('a close the remote started fires closing, then close', async (t) => {
  const { fake, channel, native } = await openChannel(t);
  const log: string[] = [];
  record(channel, ['closing', 'close', 'error'], log);
  fake.emit({ kind: 'dc:state', channelKey: native.key, state: 'closing' });
  await fake.flush();
  assert.equal(channel.readyState, 'closing');
  fake.emit({ kind: 'dc:state', channelKey: native.key, state: 'closed' });
  await fake.flush();
  assert.deepEqual(log, ['closing', 'close']);
});

test('an abrupt close fires error with the RTCError, then close', async (t) => {
  const { fake, channel, native } = await openChannel(t);
  const log: string[] = [];
  let error: RTCError | undefined;
  channel.onerror = (event) => {
    assert.ok(event instanceof RTCErrorEvent);
    error = event.error;
    log.push('error');
  };
  channel.onclose = () => log.push('close');
  const info: NativeErrorInfo = {
    errorType: 'OPERATION_ERROR_WITH_DATA',
    message: 'User-Initiated Abort, reason=Close called',
    errorDetail: 'SCTP_FAILURE',
    sctpCauseCode: 12,
  };
  fake.emit({ kind: 'dc:state', channelKey: native.key, state: 'closed', error: info });
  await fake.flush();
  assert.deepEqual(log, ['error', 'close']);
  assert.ok(error instanceof RTCError);
  assert.deepEqual(
    [error.name, error.errorDetail, error.sctpCauseCode, error.message],
    ['OperationError', 'sctp-failure', 12, info.message],
  );
});

test('an abrupt close without a detail reports data-channel-failure', async (t) => {
  const { fake, channel, native } = await openChannel(t);
  const errors: RTCError[] = [];
  channel.addEventListener('error', (event) => errors.push(event.error));
  fake.emit({
    kind: 'dc:state',
    channelKey: native.key,
    state: 'closed',
    error: {
      errorType: 'NETWORK_ERROR',
      message: 'Failure to send data',
      errorDetail: null,
      sctpCauseCode: null,
    },
  });
  await fake.flush();
  assert.deepEqual(
    errors.map((e) => [e.errorDetail, e.sctpCauseCode]),
    [['data-channel-failure', null]],
  );
});

test('closing the connection closes its channels at once, with no events then or later', async (t) => {
  const { pc, fake, channel, native } = await openChannel(t);
  const connecting = pc.createDataChannel('second');
  const log: string[] = [];
  for (const c of [channel, connecting]) record(c, ['open', 'closing', 'close', 'error'], log);
  pc.close();
  assert.deepEqual([channel.readyState, connecting.readyState], ['closed', 'closed']);
  fake.emit({ kind: 'dc:state', channelKey: native.key, state: 'closed' });
  await fake.flush();
  assert.deepEqual(log, []);
  assert.throws(() => channel.send('x'), { name: 'InvalidStateError' });
  channel.close();
  assert.equal(native.callsTo('close').length, 0);
});

// ---------------------------------------------------------------------------
// send() and bufferedAmount

test('send throws InvalidStateError unless open', async (t) => {
  const { pc, fake } = setup(t);
  const channel = pc.createDataChannel('chat');
  assert.throws(() => channel.send('x'), {
    name: 'InvalidStateError',
    message:
      "Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'.",
  });
  assert.equal(fake.dataChannels[0]?.callsTo('send').length, 0);
});

test('send passes each type as bytes plus a binary flag, and counts its size', async (t) => {
  const { channel, native } = await openChannel(t);
  const buffer = new Uint8Array([9, 1, 2, 3, 9]);
  channel.send('héllo');
  channel.send(buffer.buffer);
  channel.send(buffer.subarray(1, 4));
  channel.send(new DataView(buffer.buffer, 4, 1));
  channel.send('');
  assert.deepEqual(
    native.sent.map(([bytes, binary]) => [[...bytes], binary]),
    [
      [[...Buffer.from('héllo')], false],
      [[9, 1, 2, 3, 9], true],
      [[1, 2, 3], true],
      [[9], true],
      [[], false],
    ],
  );
  assert.equal(channel.bufferedAmount, 6 + 5 + 3 + 1);
});

test('a lone surrogate is sent as U+FFFD (USVString)', async (t) => {
  const { channel, native } = await openChannel(t);
  channel.send('a\uD800');
  assert.equal(text(native.sent[0]?.[0] ?? new Uint8Array()), 'a�');
});

test('sends after a Blob wait for it, so everything leaves in call order', async (t) => {
  const { fake, channel, native } = await openChannel(t);
  channel.send('first');
  channel.send(new Blob(['blob-1']));
  channel.send('after');
  const bytes = new Uint8Array([1]);
  channel.send(bytes);
  bytes[0] = 2; // sent as it was at send() time
  channel.send(new Blob(['blob-2']));
  assert.deepEqual(
    native.sent.map(([b]) => text(b)),
    ['first'],
    'nothing after the Blob goes out synchronously',
  );
  assert.equal(channel.bufferedAmount, 5 + 6 + 5 + 1 + 6);
  await fake.flush();
  assert.deepEqual(
    native.sent.map(([b, binary]) => [binary ? [...b] : text(b), binary]),
    [
      ['first', false],
      [[...Buffer.from('blob-1')], true],
      ['after', false],
      [[1], true],
      [[...Buffer.from('blob-2')], true],
    ],
  );
});

test('close() lets pending Blob sends go out first', async (t) => {
  const { fake, channel, native } = await openChannel(t);
  channel.send(new Blob(['last words']));
  channel.close();
  assert.equal(native.callsTo('close').length, 0);
  await fake.flush();
  assert.deepEqual(
    native.calls.map((call) => call.method),
    ['send', 'close'],
  );
});

test("a message over the SCTP transport's maxMessageSize is a TypeError", async (t) => {
  const { pc, fake } = setup(t);
  await negotiateData(pc, fake, 1000);
  assert.equal(pc.sctp?.maxMessageSize, 1000);
  const channel = pc.createDataChannel('chat');
  const native = fake.dataChannels[0] as FakeDataChannel;
  fake.emit({ kind: 'dc:state', channelKey: native.key, state: 'open' });
  await fake.flush();
  channel.send(new Uint8Array(1000));
  assert.throws(() => channel.send(new Uint8Array(1001)), { name: 'TypeError' });
  assert.throws(() => channel.send(new Blob([new Uint8Array(1001)])), { name: 'TypeError' });
  assert.equal(native.sent.length, 1);
  assert.equal(channel.bufferedAmount, 1000);
});

test("a send that would overflow libwebrtc's send queue is an OperationError", async (t) => {
  const { pc, fake } = setup(t);
  await negotiateData(pc, fake);
  fake.stub('createDataChannel', (label) => {
    const channel = new FakeDataChannel(fake.stream, { key: 1, label });
    channel.maxSendQueueSize = 10;
    fake.dataChannels.push(channel);
    return channel;
  });
  const channel = pc.createDataChannel('chat');
  fake.emit({ kind: 'dc:state', channelKey: 1, state: 'open' });
  await fake.flush();
  channel.send(new Uint8Array(6));
  assert.throws(() => channel.send(new Uint8Array(5)), { name: 'OperationError' });
  channel.send(new Uint8Array(4));
  assert.equal(channel.bufferedAmount, 10);
});

// libwebrtc refuses once its channel is closing, before our readyState
// (one event behind) shows it.
test('a send libwebrtc refuses is dropped without throwing and is not counted', async (t) => {
  const { channel, native } = await openChannel(t);
  native.sendResult = false;
  channel.send('x');
  assert.equal(channel.bufferedAmount, 0);
});

test('a pending send libwebrtc refuses is dropped and uncounted', async (t) => {
  const { fake, channel, native } = await openChannel(t);
  native.sendResult = false;
  channel.send(new Blob(['abc']));
  channel.send('de');
  assert.equal(channel.bufferedAmount, 5);
  await fake.flush();
  assert.equal(native.sent.length, 2, 'both were tried');
  assert.equal(channel.bufferedAmount, 0);
});

test('bufferedAmount shrinks as bytes are sent; bufferedamountlow fires on crossing the threshold', async (t) => {
  const { fake, channel, native } = await openChannel(t);
  channel.bufferedAmountLowThreshold = 100;
  const log: number[] = [];
  channel.onbufferedamountlow = () => log.push(channel.bufferedAmount);
  channel.send(new Uint8Array(300));
  const sent = (bytes: number) =>
    fake.emit({ kind: 'dc:bufferedamount', channelKey: native.key, sent: bytes });
  sent(150); // 150: still above
  sent(100); // 50: crossed
  sent(50); // 0: already below
  await fake.flush();
  assert.deepEqual(log, [50]);
  assert.equal(channel.bufferedAmount, 0);
});

test('bufferedAmountLowThreshold is an [EnforceRange] unsigned long', async (t) => {
  const { pc } = setup(t);
  const channel = pc.createDataChannel('chat');
  channel.bufferedAmountLowThreshold = 2 ** 32 - 1;
  assert.equal(channel.bufferedAmountLowThreshold, 2 ** 32 - 1);
  assert.throws(() => {
    channel.bufferedAmountLowThreshold = -1;
  }, TypeError);
  assert.throws(() => {
    channel.bufferedAmountLowThreshold = 2 ** 32;
  }, TypeError);
});

// ---------------------------------------------------------------------------
// Receiving

test('messages arrive as strings, ArrayBuffers or Blobs, per binaryType', async (t) => {
  const { fake, channel, native } = await openChannel(t);
  const received: unknown[] = [];
  channel.onmessage = (event) => received.push(event.data);
  const deliver = (data: Buffer, binary: boolean) =>
    fake.emit({ kind: 'dc:message', channelKey: native.key, data, binary });
  deliver(Buffer.from('héllo'), false);
  deliver(Buffer.from([1, 2, 3]), true);
  await fake.flush();
  channel.binaryType = 'blob';
  deliver(Buffer.from([4, 5]), true);
  await fake.flush();
  assert.equal(received[0], 'héllo');
  assert.ok(received[1] instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(received[1] as ArrayBuffer)], [1, 2, 3]);
  assert.ok(received[2] instanceof Blob);
  assert.deepEqual([...(await (received[2] as Blob).bytes())], [4, 5]);
});

test('a message in a slice of a larger buffer arrives as just its bytes', async (t) => {
  const { fake, channel, native } = await openChannel(t);
  let data: ArrayBuffer | undefined;
  channel.onmessage = (event) => {
    data = event.data;
  };
  const backing = Buffer.from([0, 7, 8, 0]);
  fake.emit({
    kind: 'dc:message',
    channelKey: native.key,
    data: backing.subarray(1, 3),
    binary: true,
  });
  await fake.flush();
  assert.deepEqual([...new Uint8Array(data ?? new ArrayBuffer(0))], [7, 8]);
});

test('binaryType ignores values that are not a BinaryType', (t) => {
  const { pc } = setup(t);
  const channel = pc.createDataChannel('chat');
  channel.binaryType = 'blob';
  (channel as { binaryType: string }).binaryType = 'text';
  assert.equal(channel.binaryType, 'blob');
});

test('messages are discarded unless the channel is open', async (t) => {
  const { fake, channel, native } = await openChannel(t);
  const received: unknown[] = [];
  channel.onmessage = (event) => received.push(event.data);
  channel.close();
  fake.emit({
    kind: 'dc:message',
    channelKey: native.key,
    data: Buffer.from('late'),
    binary: false,
  });
  await fake.flush();
  assert.deepEqual(received, []);
});

// ---------------------------------------------------------------------------
// Events

test('RTCDataChannelEvent needs a channel and exposes it as a prototype getter', async (t) => {
  const { pc } = setup(t);
  const channel = pc.createDataChannel('chat');
  assertEventAttributes(new RTCDataChannelEvent('datachannel', { channel }), { channel });
  assert.throws(() => new RTCDataChannelEvent('datachannel', {} as never), TypeError);
  assert.throws(() => new RTCDataChannelEvent('datachannel', { channel: {} as never }), TypeError);
});

test('RTCErrorEvent needs an RTCError and exposes it as a prototype getter', () => {
  const error = new RTCError({ errorDetail: 'sctp-failure' }, 'gone');
  assertEventAttributes(new RTCErrorEvent('error', { error }), { error });
  assert.throws(() => new RTCErrorEvent('error', { error: new Error('x') as never }), TypeError);
});

test('a native failure creating the channel keeps its message', (t) => {
  const { pc, fake } = setup(t);
  fake.stub('createDataChannel', () => {
    throw nativeError('RESOURCE_EXHAUSTED', 'no ids left');
  });
  assert.throws(() => pc.createDataChannel('x'), {
    name: 'OperationError',
    message: 'no ids left',
  });
});
