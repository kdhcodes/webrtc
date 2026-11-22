// The environment's one delivery order (EventOrder, src/event_sink.h): op
// completions and queued tasks take their place in it like events, each is
// delivered as its own task, and the continuations of a promise settled in
// one run before the next delivery. Each test blocks the JS thread until
// libwebrtc has queued everything it checks, so all of it is delivered in
// one go, as under load.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { native } from '../../lib/internal/native.ts';
import type {
  NativePcEvent,
  NativePeerConnection,
  NativeSessionDescription,
} from '../../lib/internal/native-types.ts';

/** A failure guard only. */
const WAIT_MS = 10_000;

/**
 * What reached JS, in delivery order: signaling and gathering-started
 * events, tasks, and what the test adds. Other events (candidates,
 * transports, a fast gathering's 'complete') are left out: libwebrtc
 * reports them on its own schedule.
 */
class Log {
  readonly entries: string[] = [];
  #waiters: { entry: string; resolve: () => void }[] = [];

  add(entry: string): void {
    this.entries.push(entry);
    for (const w of this.#waiters.filter((w) => w.entry === entry)) w.resolve();
  }

  /** Resolves once `entry` has been added. */
  async until(entry: string): Promise<void> {
    if (this.entries.includes(entry)) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#waiters.push({ entry, resolve });
    const timer = setTimeout(() => reject(new Error(`no "${entry}" in ${this.entries}`)), WAIT_MS);
    try {
      await promise;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A connection logging to `log`; `also` runs in its callback after that. */
function connection(
  t: TestContext,
  name: string,
  log: Log,
  also: (e: NativePcEvent) => void = () => {},
): NativePeerConnection {
  const onEvent = (e: NativePcEvent): void => {
    if (e.kind === 'signalingstatechange') log.add(`${name} ${e.kind} ${e.state}`);
    if (e.kind === 'icegatheringstatechange' && e.state === 'gathering') {
      log.add(`${name} ${e.kind} ${e.state}`);
    }
    if (e.kind === 'task') log.add(`${name} task ${e.id}`);
    also(e);
  };
  const pc = new native.PeerConnection({}, onEvent);
  t.after(() => pc.close());
  return pc;
}

/** An offer to apply locally: gathering starts once it is. */
async function offer(pc: NativePeerConnection): Promise<NativeSessionDescription> {
  pc.addTransceiver('audio');
  return pc.createOffer();
}

/**
 * Blocks the JS thread until `pc` reads iceGatheringState 'gathering'. A
 * live read is a blocking call to the signaling thread, which runs after
 * the task that changed the state, so the event reporting it is queued by
 * then, behind the setLocalDescription() completion (libwebrtc completes
 * it before it starts gathering).
 */
function blockUntilGathering(pc: NativePeerConnection): void {
  const deadline = performance.now() + WAIT_MS;
  while (pc.iceGatheringState !== 'gathering') {
    if (performance.now() > deadline) assert.fail('gathering never started');
  }
}

test("an op's completion is delivered in its place among its connection's events", async (t) => {
  const log = new Log();
  const a = connection(t, 'A', log);
  const sld = a.setLocalDescription(await offer(a)).then(() => log.add('A sld resolved'));
  blockUntilGathering(a);
  await log.until('A icegatheringstatechange gathering');
  await sld;
  assert.deepEqual(log.entries, [
    'A signalingstatechange have-local-offer',
    // Its continuation ran in the completion's task, before the next one.
    'A sld resolved',
    'A icegatheringstatechange gathering',
  ]);
});

test("two connections' completions and events are delivered in the order libwebrtc reported them", async (t) => {
  const log = new Log();
  const a = connection(t, 'A', log);
  const b = connection(t, 'B', log);
  const [offerA, offerB] = [await offer(a), await offer(b)];
  const sldA = a.setLocalDescription(offerA).then(() => log.add('A sld resolved'));
  blockUntilGathering(a);
  const sldB = b.setLocalDescription(offerB).then(() => log.add('B sld resolved'));
  blockUntilGathering(b);
  await log.until('B icegatheringstatechange gathering');
  await Promise.all([sldA, sldB]);
  assert.deepEqual(log.entries, [
    'A signalingstatechange have-local-offer',
    'A sld resolved',
    'A icegatheringstatechange gathering',
    'B signalingstatechange have-local-offer',
    'B sld resolved',
    'B icegatheringstatechange gathering',
  ]);
});

test("queueTask() with next from an event's callback runs right after that event, ahead of libwebrtc's", async (t) => {
  const log = new Log();
  let b: NativePeerConnection | undefined;
  const a = connection(t, 'A', log, (e) => {
    if (e.kind === 'signalingstatechange') b?.queueTask(2, true);
  });
  b = connection(t, 'B', log);
  const sld = a.setLocalDescription(await offer(a)).then(() => {
    log.add('A sld resolved');
    // A microtask of the completion's task is no callback: to the back.
    b?.queueTask(3, true);
  });
  blockUntilGathering(a);
  // Behind A's completion and its gathering event.
  b.queueTask(1, false);
  await log.until('B task 3');
  await sld;
  assert.deepEqual(log.entries, [
    'A signalingstatechange have-local-offer',
    'B task 2',
    'A sld resolved',
    'A icegatheringstatechange gathering',
    'B task 1',
    'B task 3',
  ]);
});

test('queueTask() still delivers once the connection is closed', async (t) => {
  const log = new Log();
  const a = connection(t, 'A', log);
  a.close();
  a.queueTask(1, false);
  await log.until('A task 1');
});
