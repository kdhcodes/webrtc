// Shared by the event class unit tests: the WebIDL shape of an event's
// payload (SPEC-LAYER-PLAN.md, "Events"). Not part of the published build.
import assert from 'node:assert/strict';

/**
 * Asserts that each of `expected`'s keys is an attribute of `event`'s
 * class: a getter on the prototype, not an own property of the event, that
 * reads the expected value (compared with `Object.is`) and throws a
 * TypeError for a receiver of another class. Enumerability comes from
 * lib/index.ts's shape pass (lib/index.test.ts checks it).
 */
export function assertEventAttributes(event: Event, expected: Record<string, unknown>): void {
  // String keys only: Node's Event keeps its own state under symbols.
  assert.deepEqual(Object.getOwnPropertyNames(event), [], 'the event has no own properties');
  const proto = Object.getPrototypeOf(event) as object;
  const foreign = new Event(event.type);
  for (const [name, value] of Object.entries(expected)) {
    const get = Object.getOwnPropertyDescriptor(proto, name)?.get;
    assert.equal(typeof get, 'function', `${name} is a getter on the prototype`);
    assert.equal(Reflect.get(event, name), value, `${name} reads the init value`);
    assert.throws(() => get?.call(foreign), TypeError, `${name} brand-checks its receiver`);
  }
}
