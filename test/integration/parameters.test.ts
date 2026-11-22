// RTCRtpSender parameters against libwebrtc: what a getParameters() /
// setParameters() round trip, as mediasoup-client does to switch layers,
// does to the encoded simulcast layers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RTCPeerConnection, type RTCRtpSender } from '../../lib/index.ts';
import { media, pair, reaches, WAIT_MS } from './harness.ts';

interface Layer {
  width: number | undefined;
  frames: number;
}

/** Each rid's last encoded width and frame count, from outbound-rtp stats. */
async function layers(sender: RTCRtpSender): Promise<Record<string, Layer>> {
  const result: Record<string, Layer> = {};
  for (const stats of (await sender.getStats()).values()) {
    if (stats.type !== 'outbound-rtp') continue;
    result[stats.rid] = { width: stats.frameWidth, frames: stats.framesEncoded ?? 0 };
  }
  return result;
}

/** Polls the stats until `done` holds for them; WAIT_MS is a failure guard. */
async function until(
  sender: RTCRtpSender,
  done: (layers: Record<string, Layer>) => boolean,
): Promise<Record<string, Layer>> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const current = await layers(sender);
    if (done(current)) return current;
    if (Date.now() > deadline) assert.fail(`stats never matched: ${JSON.stringify(current)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a getParameters/setParameters round trip keeps libwebrtc's default simulcast scaling", async (t) => {
  // 640x360 is too small for three layers, so libwebrtc sends two. With its
  // default scaling those are 320 and 640 wide; explicit 4/2/1 scales would
  // make them 160 and 320.
  const { video } = media(t, 640, 360);
  const p = pair(t);
  const { sender } = p.a.addTransceiver(video, {
    direction: 'sendonly',
    sendEncodings: [{ rid: 'l' }, { rid: 'm' }, { rid: 'h' }],
  });
  await p.a.setLocalDescription();
  await p.b.setRemoteDescription(p.a.localDescription ?? assert.fail('no offer'));
  await p.b.setLocalDescription();
  // libwebrtc doesn't answer simulcast; accept the three layers by hand.
  const answer = (p.b.localDescription?.sdp ?? '').replace(
    /(m=video[\s\S]*?a=mid:[^\r]*\r\n)/,
    '$1a=rid:l recv\r\na=rid:m recv\r\na=rid:h recv\r\na=simulcast:recv l;m;h\r\n',
  );
  await p.a.setRemoteDescription({ type: 'answer', sdp: answer });
  await reaches(p.a, 'connected');

  const before = await until(sender, (s) => (s.l?.width ?? 0) > 0 && (s.m?.width ?? 0) > 0);
  assert.deepEqual([before.l?.width, before.m?.width], [320, 640]);

  const parameters = sender.getParameters();
  assert.deepEqual(
    parameters.encodings.map((e) => [e.rid, e.scaleResolutionDownBy]),
    [
      ['l', 4],
      ['m', 2],
      ['h', 1],
    ],
  );
  await sender.setParameters(parameters);
  const after = await until(sender, (s) => (s.l?.frames ?? 0) >= (before.l?.frames ?? 0) + 15);
  assert.deepEqual([after.l?.width, after.m?.width], [320, 640]);
});

/**
 * What setParameters() does with what getParameters() returned when
 * `between` runs in between: true if it applies, else the error's name.
 */
async function acrossCall(sender: RTCRtpSender, between: () => Promise<unknown>) {
  const parameters = sender.getParameters();
  await between();
  return sender.setParameters(parameters).then(
    () => true,
    (error: Error) => error.name,
  );
}

test('errors the addon returns at once leave the parameters usable; a delivered result does not', async (t) => {
  // No candidates are forwarded: each addIceCandidate() that libwebrtc
  // completes would be a real task in between.
  const p = { a: new RTCPeerConnection(), b: new RTCPeerConnection() };
  t.after(() => {
    p.a.close();
    p.b.close();
  });
  const { sender } = p.a.addTransceiver('audio');
  const { sender: other } = p.b.addTransceiver('audio');
  await p.a.setLocalDescription();
  await p.b.setRemoteDescription(p.a.localDescription ?? assert.fail('no offer'));

  assert.equal(
    await acrossCall(sender, () =>
      p.b.setRemoteDescription({ type: 'offer', sdp: 'v=0\r\nbogus\r\n' }).catch(() => {}),
    ),
    true,
    "another connection's unparsable description",
  );
  assert.equal(
    await acrossCall(sender, () =>
      p.b.addIceCandidate({ candidate: 'candidate:garbage', sdpMid: '0' }).catch(() => {}),
    ),
    true,
    'an unparsable candidate',
  );
  assert.equal(
    await acrossCall(sender, () => {
      const q = other.getParameters();
      (q.encodings[0] as { maxBitrate: number }).maxBitrate = 3e9;
      return other.setParameters(q).catch(() => {});
    }),
    true,
    "another sender's out-of-range maxBitrate",
  );
  // libwebrtc's offer comes back in a task of its own.
  assert.equal(
    await acrossCall(sender, () => p.a.createOffer()),
    'InvalidStateError',
    'a created offer',
  );
});

test('the task getParameters() queues runs after native events already queued, of any connection', async (t) => {
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  const { sender } = pc.addTransceiver('audio');
  // In a native result's task, as WPT's tests run.
  await pc.createOffer();
  // WPT's queueAWebrtcTask() (setParameters-encodings): libwebrtc queues
  // the new connection's negotiationneeded before getParameters()'s blocking
  // call to the signaling thread returns. A setImmediate() clearing the
  // parameters ran before that event reached JS.
  const other = new RTCPeerConnection();
  t.after(() => other.close());
  other.addTransceiver('audio');
  const negotiationNeeded = new Promise((resolve) => {
    other.onnegotiationneeded = resolve;
  });
  assert.equal(await acrossCall(sender, () => negotiationNeeded), true);
});
