import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertEventAttributes } from './internal/testing/event-attributes.ts';
import { RTCIceCandidate } from './RTCIceCandidate.ts';
import { RTCPeerConnectionIceErrorEvent } from './RTCPeerConnectionIceErrorEvent.ts';
import { RTCPeerConnectionIceEvent } from './RTCPeerConnectionIceEvent.ts';

test('icecandidate: candidate and url are prototype getters, defaulting to null', () => {
  const candidate = new RTCIceCandidate({ candidate: '', sdpMid: '0' });
  const event = new RTCPeerConnectionIceEvent('icecandidate', { candidate, url: 'stun:x' });
  assertEventAttributes(event, { candidate, url: 'stun:x' });
  assertEventAttributes(new RTCPeerConnectionIceEvent('icecandidate'), {
    candidate: null,
    url: null,
  });
  const { candidate: destructured } = event;
  assert.equal(destructured, candidate, 'destructuring still works');
  assert.throws(() => new RTCPeerConnectionIceEvent('icecandidate', { candidate: {} as never }), {
    name: 'TypeError',
    message: /is not a RTCIceCandidate/,
  });
});

test('icecandidate: the type argument is required (WPT RTCPeerConnectionIceEvent-constructor)', () => {
  assert.throws(() => new (RTCPeerConnectionIceEvent as unknown as new () => Event)(), {
    name: 'TypeError',
    message: /1 argument required/,
  });
  assert.equal(new RTCPeerConnectionIceEvent(undefined as never).type, 'undefined');
});

test('icecandidateerror: fields are prototype getters with spec defaults; errorCode is required', () => {
  const event = new RTCPeerConnectionIceErrorEvent('icecandidateerror', { errorCode: 701 });
  assertEventAttributes(event, {
    address: null,
    port: null,
    url: '',
    errorCode: 701,
    errorText: '',
  });
  assert.throws(() => new RTCPeerConnectionIceErrorEvent('icecandidateerror', {} as never), {
    name: 'TypeError',
    message: /required member 'errorCode'/,
  });
});
