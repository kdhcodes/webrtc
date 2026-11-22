/**
 * WebIDL value conversions (https://webidl.spec.whatwg.org/#es-type-mapping)
 * used by the generated dictionary/enum converters in ./generated/ and by the
 * hand-written interfaces. Errors are TypeErrors whose messages start with a
 * context string such as "RTCConfiguration.iceServers[0].urls".
 */

export type Converter<T> = (value: unknown, context: string) => T;

export interface IntegerOptions {
  clamp?: boolean;
  enforceRange?: boolean;
}

function fail(context: string, message: string): never {
  throw new TypeError(`${context}: ${message}`);
}

export function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

// ---------------------------------------------------------------------------
// Primitives

export function any(value: unknown, _context?: string): unknown {
  return value;
}

export function object(value: unknown, context: string): object {
  if (!isObject(value)) fail(context, 'is not an object');
  return value;
}

export function callback(value: unknown, context: string): (...args: never[]) => unknown {
  if (typeof value !== 'function') fail(context, 'is not a function');
  return value as (...args: never[]) => unknown;
}

export function boolean(value: unknown, _context?: string): boolean {
  return Boolean(value);
}

export function DOMString(value: unknown, context: string): string {
  if (typeof value === 'symbol') fail(context, 'cannot convert a Symbol to a string');
  return String(value);
}

export function USVString(value: unknown, context: string): string {
  return DOMString(value, context).toWellFormed();
}

export function ByteString(value: unknown, context: string): string {
  const s = DOMString(value, context);
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 255) fail(context, 'contains a code unit above 255');
  }
  return s;
}

function toNumber(value: unknown, context: string): number {
  if (typeof value === 'symbol' || typeof value === 'bigint') {
    fail(context, `cannot convert a ${typeof value} to a number`);
  }
  return Number(value);
}

export function unrestrictedDouble(value: unknown, context: string): number {
  return toNumber(value, context);
}

export function double(value: unknown, context: string): number {
  const x = toNumber(value, context);
  if (!Number.isFinite(x)) fail(context, 'is not a finite number');
  return x;
}

export function unrestrictedFloat(value: unknown, context: string): number {
  return Math.fround(toNumber(value, context));
}

export function float(value: unknown, context: string): number {
  const x = double(value, context);
  const y = Math.fround(x);
  if (!Number.isFinite(y)) fail(context, 'is outside the range of a float');
  return y;
}

/** https://webidl.spec.whatwg.org/#abstract-opdef-converttoint */
export function integer(
  value: unknown,
  context: string,
  bitLength: 8 | 16 | 32 | 64,
  signed: boolean,
  options: IntegerOptions = {},
): number {
  let lower: number;
  let upper: number;
  if (bitLength === 64) {
    upper = Number.MAX_SAFE_INTEGER;
    lower = signed ? Number.MIN_SAFE_INTEGER : 0;
  } else if (signed) {
    lower = -(2 ** (bitLength - 1));
    upper = 2 ** (bitLength - 1) - 1;
  } else {
    lower = 0;
    upper = 2 ** bitLength - 1;
  }

  let x = toNumber(value, context);
  if (Object.is(x, -0)) x = 0;

  if (options.enforceRange) {
    if (!Number.isFinite(x)) fail(context, 'is not a finite number');
    // `+ 0` turns -0 (e.g. from trunc(-0.5)) into +0; WPT compares with
    // SameValue.
    x = Math.trunc(x) + 0;
    if (x < lower || x > upper) fail(context, `is outside the range [${lower}, ${upper}]`);
    return x;
  }
  if (!Number.isNaN(x) && options.clamp) {
    x = Math.min(Math.max(x, lower), upper);
    // Round half to even.
    const floor = Math.floor(x);
    const diff = x - floor;
    x = diff > 0.5 || (diff === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
    return Object.is(x, -0) ? 0 : x;
  }
  if (!Number.isFinite(x) || x === 0) return 0;
  x = Math.trunc(x) + 0;
  if (bitLength === 64) {
    // Precision beyond 2^53 is lost in JS anyway; wrap like BigInt.asIntN.
    const big = signed ? BigInt.asIntN(64, BigInt(x)) : BigInt.asUintN(64, BigInt(x));
    return Number(big);
  }
  const modulo = 2 ** bitLength;
  x = ((x % modulo) + modulo) % modulo;
  if (signed && x >= 2 ** (bitLength - 1)) x -= modulo;
  return x;
}

export const byte = (v: unknown, c: string, o?: IntegerOptions) => integer(v, c, 8, true, o);
export const octet = (v: unknown, c: string, o?: IntegerOptions) => integer(v, c, 8, false, o);
export const short = (v: unknown, c: string, o?: IntegerOptions) => integer(v, c, 16, true, o);
export const unsignedShort = (v: unknown, c: string, o?: IntegerOptions) =>
  integer(v, c, 16, false, o);
export const long = (v: unknown, c: string, o?: IntegerOptions) => integer(v, c, 32, true, o);
export const unsignedLong = (v: unknown, c: string, o?: IntegerOptions) =>
  integer(v, c, 32, false, o);
export const longLong = (v: unknown, c: string, o?: IntegerOptions) => integer(v, c, 64, true, o);
export const unsignedLongLong = (v: unknown, c: string, o?: IntegerOptions) =>
  integer(v, c, 64, false, o);

export function BufferSource(value: unknown, context: string): ArrayBuffer | ArrayBufferView {
  // [AllowShared] isn't used by these specs, so shared memory is rejected.
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value) && !(value.buffer instanceof SharedArrayBuffer)) return value;
  return fail(context, 'is not an ArrayBuffer or ArrayBufferView');
}

// ---------------------------------------------------------------------------
// Compound types

export function nullable<T>(convert: Converter<T>): Converter<T | null> {
  return (value, context) =>
    value === null || value === undefined ? null : convert(value, context);
}

export type IteratorMethod = (this: object) => Iterator<unknown>;

export interface SequenceConverter<T> extends Converter<T[]> {
  /**
   * Creates the sequence from an already-fetched @@iterator method, so a
   * union that checked for one doesn't read it a second time.
   */
  fromMethod(value: object, method: IteratorMethod, context: string): T[];
}

export function getIteratorMethod(value: object): IteratorMethod | undefined {
  const method = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  return typeof method === 'function' ? (method as IteratorMethod) : undefined;
}

export function sequence<T>(convert: Converter<T>): SequenceConverter<T> {
  const fromMethod = (value: object, method: IteratorMethod, context: string): T[] => {
    const iterator = method.call(value);
    // Read `next` once, as the spec's GetIteratorFromMethod does.
    const next = iterator.next;
    const out: T[] = [];
    for (let i = 0; ; i++) {
      const step = next.call(iterator);
      if (step.done) return out;
      out.push(convert(step.value, `${context}[${i}]`));
    }
  };
  const converter = (value: unknown, context: string): T[] => {
    if (!isObject(value)) fail(context, 'is not an iterable object');
    const method = getIteratorMethod(value);
    if (method === undefined) fail(context, 'is not iterable');
    return fromMethod(value, method, context);
  };
  return Object.assign(converter, { fromMethod });
}

export function record<T>(convert: Converter<T>): Converter<Record<string, T>> {
  return (value, context) => {
    if (!isObject(value)) fail(context, 'is not an object');
    const out: Record<string, T> = {};
    for (const key of Reflect.ownKeys(value)) {
      const desc = Reflect.getOwnPropertyDescriptor(value, key);
      if (!desc?.enumerable || typeof key === 'symbol') continue;
      const converted = convert(
        (value as Record<string, unknown>)[key],
        `${context}[${JSON.stringify(key)}]`,
      );
      // defineProperty, not assignment, so a "__proto__" key stays a key.
      Object.defineProperty(out, key, {
        value: converted,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
}

export function enumeration<T extends string>(name: string, values: readonly T[]): Converter<T> {
  const allowed = new Set<string>(values);
  return (value, context) => {
    const s = DOMString(value, context);
    if (!allowed.has(s)) fail(context, `'${s}' is not a valid value for enumeration ${name}`);
    return s as T;
  };
}

/**
 * Returns the object to read dictionary members from, or null when the value
 * is undefined/null (all members then take their defaults).
 */
export function dictionarySource(value: unknown, context: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) fail(context, 'is not an object');
  return value as Record<string, unknown>;
}

/**
 * WebIDL overload resolution's TypeError when an operation gets fewer than
 * its `required` arguments (for operations whose conversions would accept
 * a missing argument).
 */
export function requireArguments(
  given: number,
  required: number,
  operation: string,
  iface: string,
): void {
  if (given >= required) return;
  const s = required === 1 ? '' : 's';
  fail(
    `Failed to execute '${operation}' on '${iface}'`,
    `${required} argument${s} required, but only ${given} present.`,
  );
}

export function requiredMember(context: string, member: string): never {
  return fail(context, `required member '${member}' is undefined`);
}

// ---------------------------------------------------------------------------
// Interface types. Hand-written classes register a brand check so generated
// converters can recognise their instances without importing them (avoids
// cycles). Use a real brand check, e.g. `(v) => #native in v` inside the
// class, not `instanceof`: `Object.create(Foo.prototype)` passes
// `instanceof` but isn't a Foo.

export type BrandCheck = (value: object) => boolean;

const interfaces = new Map<string, BrandCheck>();

export function registerInterface(name: string, isInstance: BrandCheck): void {
  interfaces.set(name, isInstance);
}

/** Interface names that converters reference but no class has registered. */
export function isInterfaceRegistered(name: string): boolean {
  return interfaces.has(name);
}

/** The brand check registered for interface `name`, if any. */
export function interfaceBrandCheck(name: string): BrandCheck | undefined {
  return interfaces.get(name);
}

function implementsInterface(name: string, value: unknown): boolean {
  const isInstance = interfaces.get(name);
  return isInstance !== undefined && isObject(value) && isInstance(value);
}

export function interfaceType(name: string): Converter<object> {
  return (value, context) => {
    if (!interfaces.has(name)) fail(context, `is not a ${name} (${name} is not implemented yet)`);
    if (!implementsInterface(name, value)) fail(context, `is not a ${name}`);
    return value as object;
  };
}

// ---------------------------------------------------------------------------
// Unions. A simplified version of
// https://webidl.spec.whatwg.org/#es-union that covers the unions used by the
// WebRTC and Media Capture IDL: it picks the first matching flattened member
// type in the spec's order of precedence.

export interface UnionMembers {
  interfaces?: { name: string; convert: Converter<unknown> }[];
  sequence?: SequenceConverter<unknown>;
  dictionary?: Converter<unknown>;
  record?: Converter<unknown>;
  string?: Converter<unknown>;
  number?: Converter<unknown>;
  boolean?: Converter<unknown>;
  nullable?: boolean;
}

export function union<T>(name: string, members: UnionMembers): Converter<T> {
  return (value, context) => {
    if (members.nullable && (value === null || value === undefined)) return null as T;
    if ((value === null || value === undefined) && members.dictionary) {
      return members.dictionary(value, context) as T;
    }
    if (isObject(value)) {
      for (const iface of members.interfaces ?? []) {
        if (implementsInterface(iface.name, value)) return iface.convert(value, context) as T;
      }
      if (members.sequence) {
        const method = getIteratorMethod(value);
        if (method !== undefined) return members.sequence.fromMethod(value, method, context) as T;
      }
      if (members.dictionary) return members.dictionary(value, context) as T;
      if (members.record) return members.record(value, context) as T;
    }
    if (typeof value === 'boolean' && members.boolean) return members.boolean(value, context) as T;
    if (typeof value === 'number' && members.number) return members.number(value, context) as T;
    if (members.string) return members.string(value, context) as T;
    if (members.number) return members.number(value, context) as T;
    if (members.boolean) return members.boolean(value, context) as T;
    return fail(context, `is not a valid ${name}`);
  };
}
