import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RTCSessionDescription } from './RTCSessionDescription.ts';

test('takes type and sdp; sdp defaults to ""', () => {
  const d = new RTCSessionDescription({ type: 'rollback' });
  assert.equal(d.type, 'rollback');
  assert.equal(d.sdp, '');
});

test('type is required and must be an RTCSdpType', () => {
  assert.throws(() => new RTCSessionDescription({} as never), {
    name: 'TypeError',
    message: /required member 'type'/,
  });
  assert.throws(() => new RTCSessionDescription({ type: 'bogus' } as never), {
    name: 'TypeError',
    message: /not a valid value for enumeration RTCSdpType/,
  });
});

test('serialises to {type, sdp} (what signaling code sends)', () => {
  const d = new RTCSessionDescription({ type: 'offer', sdp: 'v=0\r\n' });
  assert.deepEqual(JSON.parse(JSON.stringify(d)), { type: 'offer', sdp: 'v=0\r\n' });
});
