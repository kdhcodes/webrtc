import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  toRTCConfiguration,
  toRTCDataChannelInit,
  toRTCIceServer,
  toRTCRtpTransceiverDirection,
  toRTCSessionDescriptionInit,
} from './generated/idl.ts';
import * as webidl from './webidl.ts';

test('integer conversion: modulo, clamp, enforceRange', () => {
  assert.equal(webidl.unsignedShort(65537, 'x'), 1);
  assert.equal(webidl.unsignedShort(-1, 'x'), 65535);
  assert.equal(webidl.unsignedShort(70000, 'x', { clamp: true }), 65535);
  assert.equal(webidl.unsignedShort(2.5, 'x', { clamp: true }), 2);
  assert.equal(webidl.unsignedShort(3.5, 'x', { clamp: true }), 4);
  assert.equal(webidl.unsignedShort(Number.NaN, 'x'), 0);
  assert.throws(() => webidl.unsignedShort(70000, 'x', { enforceRange: true }), {
    name: 'TypeError',
    message: 'x: is outside the range [0, 65535]',
  });
  assert.throws(() => webidl.unsignedShort(Number.NaN, 'x', { enforceRange: true }), {
    name: 'TypeError',
    message: 'x: is not a finite number',
  });
  assert.equal(webidl.long(2 ** 31, 'x'), -(2 ** 31));
});

test('double rejects non-finite values; unrestricted does not', () => {
  assert.throws(() => webidl.double(Number.POSITIVE_INFINITY, 'x'), {
    name: 'TypeError',
    message: 'x: is not a finite number',
  });
  assert.equal(webidl.unrestrictedDouble(Number.POSITIVE_INFINITY, 'x'), Number.POSITIVE_INFINITY);
});

test('enums reject unknown values with a contextual TypeError', () => {
  assert.equal(toRTCRtpTransceiverDirection('sendonly', 'd'), 'sendonly');
  assert.throws(
    () => toRTCRtpTransceiverDirection('sideways', 'init.direction'),
    /init\.direction: 'sideways' is not a valid value for enumeration RTCRtpTransceiverDirection/,
  );
});

test('RTCConfiguration gets its defaults from undefined', () => {
  const config = toRTCConfiguration(undefined);
  assert.equal(config.bundlePolicy, 'balanced');
  assert.equal(config.iceTransportPolicy, 'all');
  assert.equal(config.rtcpMuxPolicy, 'require');
  assert.equal(config.iceCandidatePoolSize, 0);
  assert.deepEqual(config.certificates, []);
});

test('RTCConfiguration rejects non-objects and bad members', () => {
  assert.throws(() => toRTCConfiguration(42), /RTCConfiguration: is not an object/);
  assert.throws(
    () => toRTCConfiguration({ bundlePolicy: 'nope' }),
    /RTCConfiguration\.bundlePolicy/,
  );
  assert.throws(
    () => toRTCConfiguration({ iceCandidatePoolSize: 1000 }),
    /RTCConfiguration\.iceCandidatePoolSize: is outside the range/,
  );
});

test('nonstandard RTCConfiguration members (wrtc)', () => {
  const config = toRTCConfiguration({
    portRange: { min: 10000, max: 20000 },
    sdpSemantics: 'unified-plan',
  });
  assert.deepEqual(config.portRange, { min: 10000, max: 20000 });
  assert.equal(config.sdpSemantics, 'unified-plan');
  assert.throws(() => toRTCConfiguration({ sdpSemantics: 'plan-b' }), {
    name: 'TypeError',
    message:
      "RTCConfiguration.sdpSemantics: 'plan-b' is not a valid value for enumeration RTCSdpSemantics",
  });
});

test('RTCIceServer.urls is a (USVString or sequence<USVString>) union', () => {
  assert.equal(toRTCIceServer({ urls: 'stun:a.example' }).urls, 'stun:a.example');
  assert.deepEqual(toRTCIceServer({ urls: ['stun:a', 'stun:b'] }).urls, ['stun:a', 'stun:b']);
  assert.deepEqual(toRTCIceServer({ urls: new Set(['stun:c']) }).urls, ['stun:c']);
  assert.throws(() => toRTCIceServer({}), /required member 'urls' is undefined/);
});

test('sequence errors carry the element index', () => {
  assert.throws(
    () => toRTCConfiguration({ iceServers: [{ urls: 'stun:a' }, {}] }),
    /RTCConfiguration\.iceServers\[1\]: required member 'urls'/,
  );
});

test('dictionary members are read in lexicographic order, once each', () => {
  const reads: string[] = [];
  const source = new Proxy(
    { maxRetransmits: 3, ordered: false, protocol: 'p' },
    {
      get(target, key, receiver) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const init = toRTCDataChannelInit(source);
  assert.deepEqual(reads, [...reads].sort());
  assert.equal(new Set(reads).size, reads.length);
  assert.equal(init.ordered, false);
  assert.equal(init.maxRetransmits, 3);
  assert.equal(init.protocol, 'p');
  assert.equal(init.negotiated, false);
});

test('RTCSessionDescriptionInit requires type', () => {
  assert.throws(() => toRTCSessionDescriptionInit({ sdp: '' }), /required member 'type'/);
  assert.deepEqual(toRTCSessionDescriptionInit({ type: 'offer' }), { type: 'offer', sdp: '' });
});

test('interface types use brand checks and reject unregistered interfaces', () => {
  class Thing {
    readonly #brand = true;
    static is(value: object): boolean {
      return #brand in value;
    }
  }
  webidl.registerInterface('TestThing', (v) => Thing.is(v));
  const convert = webidl.interfaceType('TestThing');
  const thing = new Thing();
  assert.equal(convert(thing, 'x'), thing);
  assert.throws(() => convert(Object.create(Thing.prototype), 'x'), /is not a TestThing/);
  assert.throws(() => convert({}, 'x'), /is not a TestThing/);
  assert.throws(
    () => webidl.interfaceType('NotRegistered')({}, 'x'),
    /NotRegistered is not implemented yet/,
  );
});

test('interfaceBrandCheck returns the registered check, or undefined', () => {
  const brand = new WeakSet<object>();
  const isGizmo = (value: object) => brand.has(value);
  webidl.registerInterface('TestGizmo', isGizmo);
  assert.equal(webidl.interfaceBrandCheck('TestGizmo'), isGizmo);
  assert.equal(webidl.interfaceBrandCheck('NotRegistered'), undefined);
});

test("requireArguments throws WebIDL's TypeError only when too few arguments are given", () => {
  webidl.requireArguments(1, 1, 'go', 'Thing');
  webidl.requireArguments(3, 2, 'go', 'Thing');
  assert.throws(() => webidl.requireArguments(0, 1, 'go', 'Thing'), {
    name: 'TypeError',
    message: "Failed to execute 'go' on 'Thing': 1 argument required, but only 0 present.",
  });
  assert.throws(() => webidl.requireArguments(1, 2, 'go', 'Thing'), {
    name: 'TypeError',
    message: "Failed to execute 'go' on 'Thing': 2 arguments required, but only 1 present.",
  });
});

test('every interface the generated converters reference is registered', async (t) => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./generated/idl.ts', import.meta.url), 'utf8');
  const names = new Set(
    [...source.matchAll(/interfaceType\('(\w+)'\)|name: '(\w+)'/g)].map((m) => m[1] ?? m[2]),
  );
  // Classes register themselves when their module loads.
  await import('../index.ts');
  const missing = [...names].filter((n) => n && !webidl.isInterfaceRegistered(n)).sort();
  if (missing.length > 0) {
    // Expected until the WPs implement these classes; make it visible.
    t.todo(`not registered yet: ${missing.join(', ')}`);
  }
});

test('integer conversion of -0.5 gives +0, not -0 (WPT compares with SameValue)', () => {
  assert.ok(Object.is(webidl.unsignedShort(-0.5, 'x', { enforceRange: true }), 0));
  assert.ok(Object.is(webidl.long(-0.5, 'x'), 0));
});

test('ByteString rejects code units above 255', () => {
  assert.throws(() => webidl.ByteString('Ā', 'x'), {
    name: 'TypeError',
    message: 'x: contains a code unit above 255',
  });
});

test('float rounds to single precision and rejects values outside its range', () => {
  assert.equal(webidl.float(0.1, 'x'), Math.fround(0.1));
  assert.throws(() => webidl.float(1e40, 'x'), {
    name: 'TypeError',
    message: 'x: is outside the range of a float',
  });
});

test('BufferSource rejects views on shared memory', () => {
  assert.throws(() => webidl.BufferSource(new Uint8Array(new SharedArrayBuffer(4)), 'x'), {
    name: 'TypeError',
    message: 'x: is not an ArrayBuffer or ArrayBufferView',
  });
});

test('a record keeps a "__proto__" key as an own key', () => {
  const rec = webidl.record(webidl.DOMString)(JSON.parse('{"__proto__": "p", "a": "b"}'), 'r');
  assert.deepEqual(Object.keys(rec), ['__proto__', 'a']);
  assert.equal(Object.getPrototypeOf(rec), Object.prototype);
});

test('a union reads @@iterator once', () => {
  let reads = 0;
  const iterable = {
    get [Symbol.iterator]() {
      reads++;
      return function* () {
        yield 'stun:a';
      };
    },
  };
  assert.deepEqual(toRTCIceServer({ urls: iterable }).urls, ['stun:a']);
  assert.equal(reads, 1);
});
