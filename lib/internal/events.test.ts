import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventHandler, setEventHandler } from './events.ts';

/** Dispatches a `ping` and returns the names logged by the listeners. */
function dispatch(target: EventTarget, log: string[], type = 'ping'): string[] {
  log.length = 0;
  target.dispatchEvent(new Event(type));
  return [...log];
}

test('the handler starts as null and reads back the function that was set', () => {
  const target = new EventTarget();
  const handler = () => {};
  assert.equal(getEventHandler(target, 'ping'), null);
  setEventHandler(target, 'ping', handler);
  assert.equal(getEventHandler(target, 'ping'), handler);
});

test('the handler is called with the target as this and the event as its argument', () => {
  const target = new EventTarget();
  const calls: [unknown, unknown][] = [];
  setEventHandler(target, 'ping', function (this: unknown, event: Event) {
    calls.push([this, event]);
  });
  const event = new Event('ping');
  target.dispatchEvent(event);
  assert.deepEqual(calls, [[target, event]]);
});

test('assigning a non-function clears the handler and its listener', () => {
  for (const value of [null, undefined, 'code', 42, { handleEvent() {} }]) {
    const target = new EventTarget();
    const log: string[] = [];
    setEventHandler(target, 'ping', () => log.push('handler'));
    setEventHandler(target, 'ping', value);
    assert.equal(getEventHandler(target, 'ping'), null, `after assigning ${String(value)}`);
    assert.deepEqual(dispatch(target, log), [], `after assigning ${String(value)}`);
  }
});

test('the handler runs in the order it was first set, among listeners (HTML)', () => {
  const target = new EventTarget();
  const log: string[] = [];
  target.addEventListener('ping', () => log.push('listener 1'));
  setEventHandler(target, 'ping', () => log.push('handler'));
  target.addEventListener('ping', () => log.push('listener 2'));
  assert.deepEqual(dispatch(target, log), ['listener 1', 'handler', 'listener 2']);
});

test('replacing the handler keeps its place in the listener order', () => {
  const target = new EventTarget();
  const log: string[] = [];
  setEventHandler(target, 'ping', () => log.push('first handler'));
  target.addEventListener('ping', () => log.push('listener'));
  setEventHandler(target, 'ping', () => log.push('second handler'));
  assert.deepEqual(dispatch(target, log), ['second handler', 'listener']);
});

test('a handler set again after clearing moves to the end of the listener order', () => {
  const target = new EventTarget();
  const log: string[] = [];
  setEventHandler(target, 'ping', () => log.push('first handler'));
  target.addEventListener('ping', () => log.push('listener'));
  setEventHandler(target, 'ping', null);
  setEventHandler(target, 'ping', () => log.push('second handler'));
  assert.deepEqual(dispatch(target, log), ['listener', 'second handler']);
});

test('a function used both as handler and as listener runs once for each', () => {
  const target = new EventTarget();
  const log: string[] = [];
  const both = () => log.push('both');
  setEventHandler(target, 'ping', both);
  target.addEventListener('ping', both);
  assert.deepEqual(dispatch(target, log), ['both', 'both']);
});

test('handlers are separate per target and per event type', () => {
  const a = new EventTarget();
  const b = new EventTarget();
  const log: string[] = [];
  setEventHandler(a, 'ping', () => log.push('a ping'));
  setEventHandler(a, 'pong', () => log.push('a pong'));
  setEventHandler(b, 'ping', () => log.push('b ping'));

  assert.deepEqual(dispatch(a, log, 'ping'), ['a ping']);
  assert.deepEqual(dispatch(a, log, 'pong'), ['a pong']);
  assert.deepEqual(dispatch(b, log, 'ping'), ['b ping']);
  assert.equal(getEventHandler(b, 'pong'), null);
});
