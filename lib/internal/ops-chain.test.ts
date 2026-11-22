import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperationsChain } from './ops-chain.ts';

/** A promise and its settle functions. */
function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

/** 'pending', 'resolved: <v>' or 'rejected: <name>' after the microtask queue drains. */
async function stateOf(promise: Promise<unknown>): Promise<string> {
  let state = 'pending';
  promise.then(
    (v) => {
      state = `resolved: ${v}`;
    },
    (e: Error) => {
      state = `rejected: ${e.name}`;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  return state;
}

function chain(closed = { value: false }, onEmpty = () => {}) {
  return new OperationsChain(() => closed.value, onEmpty);
}

test('the first operation runs synchronously, later ones after the previous settles', async () => {
  const ops = chain();
  const log: string[] = [];
  const first = deferred<string>();
  const a = ops.chain('a', () => {
    log.push('a starts');
    return first.promise;
  });
  const b = ops.chain('b', async () => {
    log.push('b starts');
    return 'b';
  });
  assert.deepEqual(log, ['a starts']);
  first.resolve('a');
  assert.equal(await a, 'a');
  assert.equal(await b, 'b');
  assert.deepEqual(log, ['a starts', 'b starts']);
});

test("the next operation starts after the caller's reactions to the previous result", async () => {
  const ops = chain();
  const log: string[] = [];
  ops.chain('a', async () => 'a').then(() => log.push('caller sees a'));
  await ops.chain('b', async () => {
    log.push('b starts');
  });
  assert.deepEqual(log, ['caller sees a', 'b starts']);
});

test('a rejected operation rejects its promise and the chain continues', async () => {
  const ops = chain();
  const a = ops.chain('a', async () => {
    throw new DOMException('x', 'InvalidStateError');
  });
  const b = ops.chain('b', async () => 'b');
  await assert.rejects(a, { name: 'InvalidStateError' });
  assert.equal(await b, 'b');
});

test('a synchronous throw from an operation becomes a rejection', async () => {
  const ops = chain();
  const result = ops.chain('a', () => {
    throw new TypeError('bad');
  });
  await assert.rejects(result, { name: 'TypeError', message: 'bad' });
});

test('chaining on a closed connection rejects with InvalidStateError naming the method', async () => {
  const ops = chain({ value: true });
  await assert.rejects(
    ops.chain('createOffer', async () => 'x'),
    {
      name: 'InvalidStateError',
      message: /'createOffer'.*closed/,
    },
  );
});

test('after close, results of operations in flight never settle and the chain stops', async () => {
  const closed = { value: false };
  const ops = chain(closed);
  const first = deferred<string>();
  let secondRan = false;
  const a = ops.chain('a', () => first.promise);
  const b = ops.chain('b', async () => {
    secondRan = true;
  });
  closed.value = true;
  first.resolve('a');
  assert.equal(await stateOf(a), 'pending');
  assert.equal(await stateOf(b), 'pending');
  assert.equal(secondRan, false);
});

test('a rejection dropped by close is not reported as unhandled', async (t) => {
  const closed = { value: false };
  const ops = chain(closed);
  const first = deferred<string>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  void ops.chain('a', () => first.promise);
  closed.value = true;
  first.reject(new Error('late'));
  await stateOf(first.promise.catch(() => {}));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

// The deliberate difference from the spec's "upon rejection of p" step
// (see the comment in chain()): advancing must not mark p as handled.
test('a rejection nobody handles is still reported as unhandled', async (t) => {
  const ops = chain();
  const unhandled: unknown[] = [];
  // node:test fails the test on an unhandled rejection; this one is expected.
  const runners = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (reason) => unhandled.push(reason));
  t.after(() => {
    process.removeAllListeners('unhandledRejection');
    for (const listener of runners) process.on('unhandledRejection', listener);
  });
  const error = new DOMException('ignored', 'InvalidStateError');
  void ops.chain('a', async () => {
    throw error;
  });
  // The chain still advances past it.
  assert.equal(await ops.chain('b', async () => 'b'), 'b');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, [error]);
});

test('onEmpty runs each time the last queued operation settles', async () => {
  let empties = 0;
  const ops = chain({ value: false }, () => empties++);
  const a = ops.chain('a', async () => {});
  const b = ops.chain('b', async () => {});
  assert.equal(ops.length, 2);
  await a;
  await b;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(empties, 1);
  assert.equal(ops.length, 0);
});
