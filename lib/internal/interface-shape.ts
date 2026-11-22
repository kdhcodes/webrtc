/**
 * Gives the hand-written interface classes the property shape WebIDL defines
 * (https://webidl.spec.whatwg.org/#es-interfaces), which `class` syntax
 * doesn't:
 * - attributes and operations on the prototype (and static operations on
 *   the class) are enumerable;
 * - each operation's `length` is its shortest overload's required argument
 *   count, and the class's `length` its constructor's (0 without one);
 * - `on<event>` attributes throw a TypeError for a receiver that isn't an
 *   instance (the other members already do, by reading a private field;
 *   a member that reads none does `this.#x;` itself);
 * - a promise-returning operation rejects instead of throwing, e.g. for that
 *   brand check's TypeError;
 * - `@@toStringTag` is a data property;
 * - a maplike's `@@iterator` is its `entries`.
 *
 * Applied once to each exported class (lib/index.ts), driven by the
 * generated IDL shapes, and only to members the class defines itself:
 * members the class lacks stay missing, nonstandard members keep class
 * defaults, and own properties of instances are untouched. Event classes
 * are no exception: their payload attributes are prototype getters that
 * read private fields, made enumerable here like any other attribute.
 */
import { type InterfaceShape, interfaceShapes } from './generated/interfaces.ts';
import { type BrandCheck, interfaceBrandCheck } from './webidl.ts';

// biome-ignore lint/complexity/noBannedTypes: any class, abstract or not.
type Class = Function & { prototype: object };

const shaped = new WeakSet<Class>();

function illegalInvocation(name: string, member: string): TypeError {
  return new TypeError(
    `Illegal invocation: ${name}.${member} called on an object that is not a ${name}`,
  );
}

/** `desc`'s accessor wrapped so each call brand-checks `this` first. */
function brandChecked(
  desc: PropertyDescriptor,
  name: string,
  member: string,
  isInstance: BrandCheck,
): PropertyDescriptor {
  const get = desc.get as (this: object) => unknown;
  const set = desc.set as ((this: object, value: unknown) => void) | undefined;
  // Object literal accessors, so the functions are named `get x` / `set x`
  // with lengths 0 and 1, as WebIDL's are.
  const wrapped = Object.getOwnPropertyDescriptor(
    {
      get [member]() {
        if (typeof this !== 'object' || this === null || !isInstance(this)) {
          throw illegalInvocation(name, member);
        }
        return get.call(this);
      },
      set [member](value: unknown) {
        if (typeof this !== 'object' || this === null || !isInstance(this)) {
          throw illegalInvocation(name, member);
        }
        set?.call(this, value);
      },
    },
    member,
  ) as PropertyDescriptor;
  if (!set) wrapped.set = undefined;
  return wrapped;
}

/**
 * `fn` (a promise-returning operation) wrapped so that whatever it throws
 * synchronously, such as the TypeError of a private field read on a foreign
 * receiver, rejects the returned promise instead, as WebIDL's operations do.
 * Returns `fn`'s own promise otherwise, so it adds no ticks.
 */
function rejecting(
  fn: (...args: unknown[]) => unknown,
  member: string,
): (...args: unknown[]) => unknown {
  // A method, so it has `member` as its name and no `prototype`.
  return {
    [member](this: unknown, ...args: unknown[]) {
      try {
        return fn.apply(this, args);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  }[member] as (...args: unknown[]) => unknown;
}

/**
 * Applies `shape` (interface `name`'s) to `cls`. `isInstance` is required
 * when the class defines an event handler attribute. Idempotent.
 */
export function applyInterfaceShape(
  cls: Class,
  name: string,
  shape: InterfaceShape,
  isInstance: BrandCheck | undefined,
): void {
  if (shaped.has(cls)) return;
  shaped.add(cls);
  const proto = cls.prototype;
  const own = (target: object, key: string) => Object.getOwnPropertyDescriptor(target, key);

  for (const attribute of shape.attributes) {
    if (own(proto, attribute)?.get) Object.defineProperty(proto, attribute, { enumerable: true });
  }
  for (const handler of shape.eventHandlers) {
    const desc = own(proto, handler);
    if (!desc?.get) continue;
    if (!isInstance) {
      throw new Error(`${name}.${handler}: no brand check registered (registerInterface)`);
    }
    Object.defineProperty(proto, handler, {
      ...brandChecked(desc, name, handler, isInstance),
      enumerable: true,
      configurable: true,
    });
  }
  const operations = (
    target: object,
    lengths: Readonly<Record<string, number>>,
    promises: readonly string[],
  ) => {
    for (const [operation, length] of Object.entries(lengths)) {
      let fn = own(target, operation)?.value;
      if (typeof fn !== 'function') continue;
      if (promises.includes(operation)) fn = rejecting(fn, operation);
      Object.defineProperty(target, operation, { value: fn, enumerable: true });
      Object.defineProperty(fn, 'length', { value: length });
    }
  };
  operations(proto, shape.operations, shape.promiseOperations);
  operations(cls, shape.staticOperations, shape.staticPromiseOperations);
  if (shape.maplike && typeof own(proto, 'entries')?.value === 'function') {
    Object.defineProperty(proto, Symbol.iterator, {
      value: own(proto, 'entries')?.value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  Object.defineProperty(proto, Symbol.toStringTag, {
    value: name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(cls, 'length', { value: shape.length });
}

/**
 * Applies interface `name`'s IDL shape to `cls`, with the brand check the
 * class registered (webidl.registerInterface). For a module that needs the
 * shape before lib/index.ts applies it (one that binds prototype methods at
 * load, say). Idempotent; does nothing for a name with no IDL shape.
 */
export function shapeInterface(cls: Class, name: string): void {
  const shape = Object.hasOwn(interfaceShapes, name) ? interfaceShapes[name] : undefined;
  if (shape) applyInterfaceShape(cls, name, shape, interfaceBrandCheck(name));
}

/**
 * Applies its IDL shape to every class in `exports` (a module namespace)
 * that is exported under its interface's name.
 */
export function applyInterfaceShapes(exports: Readonly<Record<string, unknown>>): void {
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value === 'function' && value.name === name) shapeInterface(value as Class, name);
  }
}
