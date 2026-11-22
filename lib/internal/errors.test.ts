import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RTCError } from '../RTCError.ts';
import { article, describe, fromNative, fromNativeDescriptionError, mustBe } from './errors.ts';
import { nativeError } from './testing/fake-native.ts';

test('native error types map to the spec exceptions, keeping the message', () => {
  const cases = [
    ['INVALID_STATE', 'InvalidStateError', DOMException],
    ['INVALID_MODIFICATION', 'InvalidModificationError', DOMException],
    ['INVALID_PARAMETER', 'InvalidAccessError', DOMException],
    ['INVALID_RANGE', 'RangeError', RangeError],
    ['INTERNAL_ERROR', 'OperationError', DOMException],
  ] as const;
  for (const [type, name, ctor] of cases) {
    const error = fromNative(nativeError(type, 'why')) as Error;
    assert.ok(error instanceof ctor, type);
    assert.equal(error.name, name, type);
    assert.equal(error.message, 'why');
  }
});

test('overrides replace the default for one step, and non-native errors pass through', () => {
  const error = fromNative(nativeError('INVALID_PARAMETER', 'x'), {
    INVALID_PARAMETER: 'TypeError',
  });
  assert.ok(error instanceof TypeError);
  const own = new TypeError('a JS-layer bug');
  assert.equal(fromNative(own), own);
});

test('an SDP parse failure becomes an RTCError with the offending line number', () => {
  const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\nm=audio notaport UDP 0\r\n';
  const error = fromNativeDescriptionError(
    nativeError('SYNTAX_ERROR', 'failed to parse SDP: bad port', 'm=audio notaport UDP 0'),
    sdp,
  );
  assert.ok(error instanceof RTCError);
  assert.ok(error instanceof DOMException);
  assert.equal(error.name, 'OperationError');
  assert.equal(error.errorDetail, 'sdp-syntax-error');
  assert.equal(error.sdpLineNumber, 3);
  assert.equal(error.message, 'failed to parse SDP: bad port');
});

test('sdpLineNumber of a repeated line: the first occurrence, or the first repeat in a section when repeating is the error', () => {
  const sdp = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=fingerprint:sha-256 zz',
    'a=simulcast:send h;l',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=fingerprint:sha-256 zz',
    'a=simulcast:send h;l',
    'a=simulcast:send h;l',
    '',
  ].join('\r\n');
  const lineOf = (message: string, line: string) =>
    (fromNativeDescriptionError(nativeError('SYNTAX_ERROR', message, line), sdp) as RTCError)
      .sdpLineNumber;
  // libwebrtc's own messages for these two cases.
  assert.equal(
    lineOf(
      'failed to parse SDP: Failed to create fingerprint from the digest.',
      sdp.split('\r\n')[2] as string,
    ),
    3,
  );
  assert.equal(
    lineOf('failed to parse SDP: Multiple Simulcast attributes specified.', 'a=simulcast:send h;l'),
    8,
  );
});

test('a duplicate msid, which libwebrtc reports as a parse failure, is a plain OperationError', () => {
  const error = fromNativeDescriptionError(
    nativeError('SYNTAX_ERROR', 'failed to parse SDP: Duplicate a=msid lines detected', ''),
    'v=0\r\n',
  );
  assert.ok(!(error instanceof RTCError));
  assert.equal((error as Error).constructor, DOMException);
  assert.equal((error as Error).name, 'OperationError');
  assert.equal((error as Error).message, 'failed to parse SDP: Duplicate a=msid lines detected');
});

test('description errors: invalid content is InvalidAccessError, a line not found leaves sdpLineNumber null', () => {
  assert.equal(
    (fromNativeDescriptionError(nativeError('INVALID_PARAMETER', 'x'), '') as Error).name,
    'InvalidAccessError',
  );
  const error = fromNativeDescriptionError(nativeError('SYNTAX_ERROR', 'x', 'nope'), 'v=0');
  assert.equal((error as RTCError).sdpLineNumber, null);
});

test('RTCError has no httpRequestStatusCode (WPT RTCError)', () => {
  assert.equal('httpRequestStatusCode' in RTCError.prototype, false);
});

test('RTCError requires an errorDetail from the enum', () => {
  assert.throws(() => new RTCError({} as never), { name: 'TypeError', message: /errorDetail/ });
  const error = new RTCError({ errorDetail: 'dtls-failure', sentAlert: 40 }, 'boom');
  assert.deepEqual(
    [error.name, error.message, error.errorDetail, error.sentAlert, error.receivedAlert],
    ['OperationError', 'boom', 'dtls-failure', 40, null],
  );
});

test("describe() gives a value's type, or a primitive's value, without running user code", () => {
  class Frame {}
  const trapped = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('trap ran');
      },
    },
  );
  const values = [undefined, null, true, -4, Number.NaN, 2n, 'x'.repeat(41), Symbol('s'), () => {}];
  const objects = [
    {},
    Object.create(null),
    [],
    new DataView(new ArrayBuffer(1)),
    new Frame(),
    trapped,
  ];
  assert.deepEqual(values.concat(objects).map(describe), [
    'undefined',
    'null',
    'true',
    '-4',
    'NaN',
    'the BigInt 2n',
    `the string "${'x'.repeat(40)}..."`,
    'a symbol',
    'a function',
    'an object',
    'an object',
    'an array',
    'a DataView',
    'a Frame',
    'an object',
  ]);
});

test('mustBe() says what a value must be and what it was, or that it is missing', () => {
  assert.equal(mustBe('api: x.n', 'a number', null), 'api: x.n must be a number, not null');
  assert.equal(
    mustBe('api: x.n', 'a number', undefined),
    'api: x.n is missing: it must be a number',
  );
});

test('describe() never runs user code or throws, whatever it is given', () => {
  let trapped = 0;
  const trap = () => {
    trapped++;
    throw new Error('trap ran');
  };
  const { proxy: revoked, revoke } = Proxy.revocable([], {});
  revoke();
  const { proxy: revokedFunction, revoke: revokeFunction } = Proxy.revocable(() => {}, {});
  revokeFunction();
  const proxyProto = Object.create(
    new Proxy({}, { getOwnPropertyDescriptor: trap, get: trap, getPrototypeOf: trap }),
  );
  class Named {
    static get name(): string {
      return trap();
    }
    readonly instance = true;
  }
  const proto = {};
  Object.defineProperty(proto, 'constructor', { value: new Proxy(function F() {}, { get: trap }) });
  const values = [revoked, revokedFunction, proxyProto, new Named(), Object.create(proto)];
  assert.deepEqual(values.map(describe), [
    'an object',
    'a function',
    'an object',
    'an object',
    'an object',
  ]);
  assert.equal(trapped, 0);
});

test('describe() caps BigInts and constructor names as it does strings', () => {
  assert.equal(describe(10n ** 2000n), `the BigInt 1${'0'.repeat(39)}...n`);
  const Long = { [`L${'o'.repeat(60)}ng`]: class {} };
  const name = Object.keys(Long)[0] as string;
  assert.equal(describe(new (Long[name] as new () => object)()), `a ${name.slice(0, 40)}...`);
});

test('article() says "a" for a leading U said "you"', () => {
  assert.deepEqual(
    [
      'Uint8Array',
      'Uint8ClampedArray',
      'URL',
      'array',
      'object',
      'Int16Array',
      'undefined',
      'Error',
    ].map(article),
    [
      'a Uint8Array',
      'a Uint8ClampedArray',
      'a URL',
      'an array',
      'an object',
      'an Int16Array',
      'an undefined',
      'an Error',
    ],
  );
});
