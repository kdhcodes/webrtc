import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atLeastDelayTimers } from './timers.ts';

/** A fake clock whose timers fire when told to, at whatever time `clock` says. */
function fake() {
  const clock = { now: 0 };
  const armed: { callback: () => void; ms: number; cancelled: boolean }[] = [];
  const timers = atLeastDelayTimers(
    (callback, ms) => {
      const entry = { callback, ms, cancelled: false };
      armed.push(entry);
      return entry;
    },
    (handle) => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    () => clock.now,
  );
  /** Fires the latest armed timer at `at`. */
  const fire = (at: number) => {
    clock.now = at;
    const entry = armed.at(-1);
    assert.ok(entry && !entry.cancelled, 'a live timer is armed');
    entry.callback();
  };
  return { clock, armed, timers, fire };
}

test('a timeout that fires on time runs its callback with its arguments', () => {
  const { timers, fire } = fake();
  const calls: unknown[][] = [];
  timers.setTimeout((...args: unknown[]) => calls.push(args), 500, 'a', 1);
  fire(500);
  assert.deepEqual(calls, [['a', 1]]);
});

test('a timeout that fires early re-arms for the rest, then runs', () => {
  const { timers, fire, armed } = fake();
  let runs = 0;
  timers.setTimeout(() => runs++, 500);
  fire(499.4);
  assert.equal(runs, 0);
  assert.equal(armed.length, 2);
  assert.ok(Math.abs((armed[1]?.ms ?? 0) - 0.6) < 1e-9, 're-armed for the 0.6 ms left');
  fire(500.1);
  assert.equal(runs, 1);
});

test('clearTimeout cancels a timeout, also after it re-armed', () => {
  const { timers, fire, armed } = fake();
  let runs = 0;
  const id = timers.setTimeout(() => runs++, 100);
  fire(99.5);
  timers.clearTimeout(id);
  assert.equal(armed.at(-1)?.cancelled, true);
  assert.equal(runs, 0);
  timers.clearTimeout(id); // twice, and unknown ids, are no-ops
  timers.clearTimeout(12345);
  timers.clearTimeout(undefined);
});

test('the delay converts as a WebIDL long, negative counting as 0; ids are distinct', () => {
  const { timers, armed } = fake();
  const delays = [Number.NaN, -5, Number.POSITIVE_INFINITY, 2 ** 31, 2 ** 32 + 7, 12.9, '40'];
  const ids = delays.map((delay) => timers.setTimeout(() => {}, delay));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    armed.map((entry) => entry.ms),
    [0, 0, 0, 0, 7, 12, 40],
  );
});

test('a huge delay runs at once instead of re-arming forever', () => {
  const { timers, fire, armed } = fake();
  let runs = 0;
  timers.setTimeout(() => runs++, Number.POSITIVE_INFINITY);
  fire(0);
  assert.equal(runs, 1);
  assert.equal(armed.length, 1);
});
