// The WP0 native skeleton: every contract class and function is exported,
// and the simple parts work. (Every stub has since been implemented.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { native } from '../../lib/internal/native.ts';

test('every contract class and function is exported', () => {
  for (const name of [
    'PeerConnection',
    'DataChannel',
    'Track',
    'Transceiver',
    'Sender',
    'Receiver',
    'AudioSource',
    'VideoSource',
    'AudioSink',
    'VideoSink',
    'getRtpCapabilities',
    'i420ToRgba',
    'rgbaToI420',
  ]) {
    assert.equal(typeof native[name as keyof typeof native], 'function', name);
  }
});

test('handles that only native code creates are not constructible', () => {
  const Track = native.Track as unknown as new () => unknown;
  assert.throws(() => new Track(), TypeError);
});

// Accessors reach our SafeObjectWrap::Unwrap (methods are rejected by V8's
// signature check first): it must be the one node-addon-api calls, since
// ObjectWrap's own aborts once a worker is being terminated.
test('accessors on a non-native this throw TypeError Illegal invocation', () => {
  const accessor = (ctor: unknown, name: string) => {
    const proto = (ctor as { prototype: object }).prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    assert.ok(descriptor, name);
    return { descriptor, fake: Object.create(proto) as object };
  };
  const state = accessor(native.PeerConnection, 'signalingState');
  assert.throws(() => state.descriptor.get?.call(state.fake), {
    name: 'TypeError',
    message: 'Illegal invocation',
  });
  const enabled = accessor(native.Track, 'enabled');
  assert.throws(() => enabled.descriptor.set?.call(enabled.fake, false), {
    name: 'TypeError',
    message: 'Illegal invocation',
  });
});

test('PeerConnection: simple contract members work', () => {
  const pc = new native.PeerConnection({}, () => {});
  try {
    assert.equal(pc.iceGatheringState, 'new');
    assert.equal(pc.iceConnectionState, 'new');
    pc.restartIce();
  } finally {
    pc.close();
  }
});
