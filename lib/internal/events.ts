/**
 * Event helpers shared by every class that dispatches events.
 *
 * `on<event>` attributes (HTML's event handler IDL attributes, simplified):
 * setting a function registers one listener at that point in the listener
 * order; setting anything else removes it. The handler runs with `this` set
 * to the target.
 */
type Handler = (this: EventTarget, event: Event) => unknown;

interface Slot {
  handler: Handler;
  listener: (event: Event) => void;
}

const slots = new WeakMap<EventTarget, Map<string, Slot>>();

export function getEventHandler(target: EventTarget, type: string): Handler | null {
  return slots.get(target)?.get(type)?.handler ?? null;
}

export function setEventHandler(target: EventTarget, type: string, value: unknown): void {
  let byType = slots.get(target);
  const existing = byType?.get(type);
  if (typeof value !== 'function') {
    if (existing) {
      target.removeEventListener(type, existing.listener);
      byType?.delete(type);
    }
    return;
  }
  if (existing) {
    existing.handler = value as Handler;
    return;
  }
  if (!byType) {
    byType = new Map();
    slots.set(target, byType);
  }
  const slot: Slot = {
    handler: value as Handler,
    listener: (event) => {
      slot.handler.call(target, event);
    },
  };
  byType.set(type, slot);
  target.addEventListener(type, slot.listener);
}

/**
 * What an `on<event>` setter takes. Declared through a method signature so
 * its parameter is compared bivariantly: a handler annotated with the DOM's
 * event type can be assigned too, while an unannotated one sees ours.
 */
export type EventHandler<E> = { bivarianceHack(event: E): unknown }['bivarianceHack'] | null;

/**
 * What an `on<event>` getter returns: a handler of any event, declared
 * through a method signature so its parameter is compared bivariantly.
 * Assignability between our classes and lib.dom's interfaces goes through
 * the getter's type (the setter's isn't compared), and it must hold both
 * ways (test/dom-compat/):
 * - ours to the DOM's: lib.dom's handler type, e.g. `(this: MediaStream,
 *   ev: MediaStreamTrackEvent) => any`, compares parameters strictly, so ours
 *   must take every DOM event of that type. `Event` does; our own event
 *   classes (MediaStreamTrackEvent) don't, as the DOM's aren't assignable to
 *   them.
 * - the DOM's to ours: lib.dom's handler only takes its own event type,
 *   which `Event` isn't assignable to. The bivariant comparison accepts it
 *   because that event type is assignable to `Event`.
 *
 * Reading a handler back is rare; calling it with any event type-checks.
 */
export type AnyEventHandler = { bivarianceHack(event: Event): unknown }['bivarianceHack'] | null;

// The global EventTarget's own parameter types (Node's or the DOM's,
// depending on the consumer's lib).
export type AddListenerOptions = Parameters<EventTarget['addEventListener']>[2];
export type RemoveListenerOptions = Parameters<EventTarget['removeEventListener']>[2];
export type AnyListener = Parameters<EventTarget['addEventListener']>[1];

/** A listener for an event of type `E` on a `T`, for typed addEventListener overloads. */
export type Listener<T, E> =
  | { bivarianceHack(this: T, event: E): unknown }['bivarianceHack']
  | { handleEvent(event: E): unknown };
