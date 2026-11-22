// The RTP wrappers' own rules. Behaviour driven by RTCPeerConnection
// (addTrack, replaceTrack chaining, snapshots) is in RTCPeerConnection.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakePeerConnection, nativeError, useFakeNative } from './internal/testing/fake-native.ts';
import { RTCPeerConnection } from './RTCPeerConnection.ts';
import { RTCRtpReceiver } from './RTCRtpReceiver.ts';
import { RTCRtpSender } from './RTCRtpSender.ts';
import { RTCRtpTransceiver } from './RTCRtpTransceiver.ts';

test('the RTP classes are not constructible from JS', () => {
  for (const C of [RTCRtpTransceiver, RTCRtpSender, RTCRtpReceiver]) {
    assert.throws(() => new (C as unknown as new () => unknown)(), {
      name: 'TypeError',
      message: 'Illegal constructor',
    });
  }
});

test('getCapabilities comes from libwebrtc, and is null for an unknown kind', () => {
  const audio = RTCRtpSender.getCapabilities('audio');
  assert.ok(audio?.codecs.some((c) => c.mimeType === 'audio/opus'));
  assert.ok(
    RTCRtpReceiver.getCapabilities('video')?.codecs.some((c) => c.mimeType === 'video/VP8'),
  );
  assert.equal(RTCRtpSender.getCapabilities('data'), null);
});

test('getCapabilities() needs its argument (a wrtc divergence); undefined is an unknown kind', () => {
  for (const [C, name] of [
    [RTCRtpSender, 'RTCRtpSender'],
    [RTCRtpReceiver, 'RTCRtpReceiver'],
  ] as const) {
    assert.throws(() => (C.getCapabilities as () => unknown)(), {
      name: 'TypeError',
      message: `Failed to execute 'getCapabilities' on '${name}': 1 argument required, but only 0 present.`,
    });
    assert.equal(C.getCapabilities(undefined as never), null);
  }
});

test('replaceTrack() with no argument rejects, as in wrtc; replaceTrack(undefined) clears the track', async (t) => {
  useFakeNative(t, { PeerConnection: FakePeerConnection });
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  const { sender } = pc.addTransceiver('audio');
  await assert.rejects((sender.replaceTrack as () => Promise<void>)(), {
    name: 'TypeError',
    message:
      "Failed to execute 'replaceTrack' on 'RTCRtpSender': 1 argument required, but only 0 present.",
  });
  await sender.replaceTrack(undefined as never);
  assert.equal(sender.track, null);
});

test('stop() sets direction stopped at once, and ends the receiver track in a queued task with ended', async (t) => {
  useFakeNative(t, { PeerConnection: FakePeerConnection });
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  const transceiver = pc.addTransceiver('audio');
  const { track } = transceiver.receiver;
  let ended = 0;
  track.onended = () => ended++;
  transceiver.stop();
  transceiver.stop();
  assert.equal(transceiver.direction, 'stopped');
  assert.equal(transceiver.currentDirection, null);
  // webrtc-pc "stop sending and receiving": ends the track, which Media
  // Capture does in a queued task (WPT RTCRtpTransceiver-stopping).
  assert.equal(track.readyState, 'live');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(track.readyState, 'ended');
  assert.equal(ended, 1);
});

test('setCodecPreferences converts codecs and maps libwebrtc rejections', (t) => {
  const fakes = useFakeNative(t, { PeerConnection: FakePeerConnection });
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  const transceiver = pc.addTransceiver('audio');
  const fake = fakes.last('PeerConnection').transceivers[0];
  assert.ok(fake);
  assert.throws(() => transceiver.setCodecPreferences([{ mimeType: 'audio/opus' } as never]), {
    name: 'TypeError',
    message: /required member 'clockRate'/,
  });
  transceiver.setCodecPreferences([{ mimeType: 'audio/opus', clockRate: 48000, channels: 2 }]);
  assert.deepEqual(fake.callsTo('setCodecPreferences'), [
    [[{ mimeType: 'audio/opus', clockRate: 48000, channels: 2 }]],
  ]);
  fake.stub('setCodecPreferences', () => {
    throw nativeError('INVALID_MODIFICATION', 'unsupported codec');
  });
  assert.throws(() => transceiver.setCodecPreferences([]), {
    name: 'InvalidModificationError',
    message: 'unsupported codec',
  });
});

test("getSynchronizationSources() and getContributingSources() split libwebrtc's sources by type, with spec timestamps and audio levels", (t) => {
  const fakes = useFakeNative(t, { PeerConnection: FakePeerConnection });
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  const audio = pc.addTransceiver('audio').receiver;
  const video = pc.addTransceiver('video').receiver;
  const [fakeAudio, fakeVideo] = fakes.last('PeerConnection').transceivers;
  assert.ok(fakeAudio && fakeVideo);
  fakeAudio.receiver.sources = [
    { source: 1, type: 'ssrc', age: 250, rtpTimestamp: 4294967295, audioLevel: 20 },
    { source: 2, type: 'csrc', age: 0, rtpTimestamp: 7, audioLevel: 127 },
    { source: 3, type: 'csrc', age: 5, rtpTimestamp: 8 },
  ];
  // libwebrtc never has an audio level for video; one would be dropped.
  fakeVideo.receiver.sources = [
    { source: 4, type: 'ssrc', age: 10, rtpTimestamp: 9, audioLevel: 0 },
  ];

  const before = performance.timeOrigin + performance.now();
  const ssrcs = audio.getSynchronizationSources();
  const csrcs = audio.getContributingSources();
  const after = performance.timeOrigin + performance.now();

  const [ssrc] = ssrcs;
  assert.ok(ssrc && ssrcs.length === 1);
  assert.ok(ssrc.timestamp >= before - 250 && ssrc.timestamp <= after - 250, `${ssrc.timestamp}`);
  assert.deepEqual(
    { ...ssrc, timestamp: 0 },
    { timestamp: 0, source: 1, rtpTimestamp: 4294967295, audioLevel: 0.1 }, // -20 dBov
  );
  assert.deepEqual(
    csrcs.map(({ timestamp: _, ...rest }) => rest),
    [
      { source: 2, rtpTimestamp: 7, audioLevel: 0 }, // 127 is silence
      { source: 3, rtpTimestamp: 8 }, // no extension, no audioLevel
    ],
  );
  assert.deepEqual(
    video.getSynchronizationSources().map(({ timestamp: _, ...rest }) => rest),
    [{ source: 4, rtpTimestamp: 9 }],
  );
  assert.deepEqual(video.getContributingSources(), []);
  assert.throws(() => RTCRtpReceiver.prototype.getSynchronizationSources.call({}), TypeError);
});
