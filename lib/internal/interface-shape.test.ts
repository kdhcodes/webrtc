import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventHandler, setEventHandler } from './events.ts';
import type { InterfaceShape } from './generated/interfaces.ts';
import { applyInterfaceShape, applyInterfaceShapes } from './interface-shape.ts';

const emptyShape: InterfaceShape = {
  length: 0,
  attributes: [],
  eventHandlers: [],
  operations: {},
  promiseOperations: [],
  staticOperations: {},
  staticPromiseOperations: [],
  maplike: false,
};

/** A fresh class shaped like the hand-written interfaces (private state, class syntax). */
function makeWidget(shape: Partial<InterfaceShape> = {}) {
  class Widget extends EventTarget {
    #size = 3;
    static isWidget = (value: object) => #size in value;
    constructor(..._args: unknown[]) {
      super();
    }
    static create(..._args: unknown[]) {
      return new Widget();
    }
    get size() {
      return this.#size;
    }
    get nonstandard() {
      return this.#size;
    }
    resize(..._args: unknown[]) {
      this.#size++;
    }
    load(value: unknown): Promise<number> {
      if (value === 'bad') throw new RangeError('bad value');
      return Promise.resolve(this.#size);
    }
    get onping() {
      return getEventHandler(this, 'ping');
    }
    set onping(value: unknown) {
      setEventHandler(this, 'ping', value);
    }
  }
  applyInterfaceShape(Widget, 'Widget', { ...emptyShape, ...shape }, Widget.isWidget);
  return Widget;
}

const widgetShape: Partial<InterfaceShape> = {
  length: 1,
  attributes: ['size', 'missing'],
  eventHandlers: ['onping'],
  operations: { resize: 2, load: 1, missingOperation: 0 },
  promiseOperations: ['load'],
  staticOperations: { create: 1 },
};

test('IDL attributes and operations become enumerable; other members keep class defaults', () => {
  const Widget = makeWidget(widgetShape);
  const proto = Widget.prototype;
  for (const key of ['size', 'onping', 'resize', 'load']) {
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    assert.equal(desc?.enumerable, true, key);
    assert.equal(desc?.configurable, true, key);
  }
  assert.equal(Object.getOwnPropertyDescriptor(Widget, 'create')?.enumerable, true);
  assert.equal(Object.getOwnPropertyDescriptor(proto, 'nonstandard')?.enumerable, false);
  // Members the IDL has but the class doesn't stay missing.
  assert.equal('missing' in proto, false);
  assert.equal('missingOperation' in proto, false);
});

test("instances' own properties don't change: Object.keys and JSON.stringify see nothing new", () => {
  const Widget = makeWidget(widgetShape);
  const widget = new Widget();
  assert.deepEqual(Object.keys(widget), []);
  assert.equal(JSON.stringify(widget), '{}');
  assert.deepEqual(Object.keys({ ...widget }), []);
});

test('operation and class lengths come from the IDL', () => {
  const Widget = makeWidget(widgetShape);
  assert.equal(Widget.length, 1);
  assert.equal(Widget.prototype.resize.length, 2);
  assert.equal(Widget.prototype.load.length, 1);
  assert.equal(Widget.create.length, 1);
  assert.equal(Widget.prototype.load.name, 'load');
});

test('an event handler attribute throws a TypeError for a foreign receiver and works on instances', () => {
  const Widget = makeWidget(widgetShape);
  const desc = Object.getOwnPropertyDescriptor(Widget.prototype, 'onping');
  assert.ok(desc?.get && desc.set);
  assert.equal(desc.get.name, 'get onping');
  assert.equal(desc.set.name, 'set onping');
  const message = 'Illegal invocation: Widget.onping called on an object that is not a Widget';
  for (const receiver of [Widget.prototype, {}, new EventTarget(), null, 1]) {
    assert.throws(() => desc.get?.call(receiver), { name: 'TypeError', message });
    assert.throws(() => desc.set?.call(receiver, () => {}), { name: 'TypeError', message });
  }
  const widget = new Widget();
  const calls: Event[] = [];
  const handler = (event: Event) => calls.push(event);
  widget.onping = handler;
  assert.equal(widget.onping, handler);
  widget.dispatchEvent(new Event('ping'));
  assert.equal(calls.length, 1);
});

test('a promise-returning operation rejects with what it throws, and otherwise returns its own promise', async () => {
  const Widget = makeWidget(widgetShape);
  const load = Widget.prototype.load;
  await assert.rejects(load.call({}, 1) as Promise<number>, TypeError);
  await assert.rejects(load.call(null, 1) as Promise<number>, TypeError);
  await assert.rejects(new Widget().load('bad'), { name: 'RangeError', message: 'bad value' });
  assert.equal(await new Widget().load(1), 3);
  // The operation's own promise, not a chained one (no extra ticks).
  const pending = Promise.resolve(7);
  class Holder {
    get() {
      return pending;
    }
  }
  applyInterfaceShape(
    Holder,
    'Holder',
    { ...emptyShape, operations: { get: 0 }, promiseOperations: ['get'] },
    undefined,
  );
  assert.equal(new Holder().get(), pending);
  // Not wrapped: an operation that doesn't return a promise still throws.
  assert.throws(() => Widget.prototype.resize.call({}), TypeError);
});

test('@@toStringTag is a non-enumerable data property naming the interface', () => {
  const Widget = makeWidget(widgetShape);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Widget.prototype, Symbol.toStringTag), {
    value: 'Widget',
    writable: false,
    enumerable: false,
    configurable: true,
  });
  assert.equal(Object.prototype.toString.call(new Widget()), '[object Widget]');
});

test("a maplike's @@iterator is its entries", () => {
  class Report {
    entries() {
      return [].values();
    }
    *[Symbol.iterator]() {}
  }
  applyInterfaceShape(Report, 'Report', { ...emptyShape, maplike: true }, undefined);
  assert.equal(Report.prototype[Symbol.iterator], Report.prototype.entries);
  assert.equal(
    Object.getOwnPropertyDescriptor(Report.prototype, Symbol.iterator)?.enumerable,
    false,
  );
});

test('applying a shape twice changes nothing more (event handlers are wrapped once)', () => {
  const Widget = makeWidget(widgetShape);
  const before = Object.getOwnPropertyDescriptor(Widget.prototype, 'onping');
  applyInterfaceShape(Widget, 'Widget', { ...emptyShape, ...widgetShape }, Widget.isWidget);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Widget.prototype, 'onping'), before);
});

test('an event handler attribute without a registered brand check fails loudly', () => {
  class Gadget extends EventTarget {
    get onping() {
      return null;
    }
    set onping(_value: unknown) {}
  }
  assert.throws(
    () =>
      applyInterfaceShape(
        Gadget,
        'Gadget',
        { ...emptyShape, eventHandlers: ['onping'] },
        undefined,
      ),
    /Gadget\.onping: no brand check registered/,
  );
});

test('applyInterfaceShapes shapes only classes exported under their interface name', () => {
  class RTCSessionDescription {
    toJSON() {
      return {};
    }
  }
  class Renamed {
    toJSON() {
      return {};
    }
  }
  applyInterfaceShapes({ RTCSessionDescription, RTCIceCandidate: Renamed, value: 1 });
  const enumerable = (cls: { prototype: object }) =>
    Object.getOwnPropertyDescriptor(cls.prototype, 'toJSON')?.enumerable;
  assert.equal(enumerable(RTCSessionDescription), true);
  assert.equal(enumerable(Renamed), false);
});

test('a static promise-returning operation rejects with what it throws', async () => {
  class Factory {
    readonly id = 'certificate';
    static make(kind: unknown): Promise<string> {
      if (kind === undefined) throw new TypeError('kind is required');
      return Promise.resolve(String(kind));
    }
  }
  applyInterfaceShape(
    Factory,
    'Factory',
    { ...emptyShape, staticOperations: { make: 1 }, staticPromiseOperations: ['make'] },
    undefined,
  );
  await assert.rejects(Factory.make(undefined), { name: 'TypeError', message: 'kind is required' });
  assert.equal(await Factory.make('rsa'), 'rsa');
  assert.equal(Factory.make.length, 1);
  assert.equal(Factory.make.name, 'make');
});
