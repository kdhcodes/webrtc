// The built package loaded with require(), as CommonJS code that aliases
// @roamhq/wrtc to it does (`const wrtc = require('@roamhq/wrtc')`). Node 24
// can require() our ESM build as long as nothing in it awaits at the top
// level. Builds its own dist/ into a temporary node_modules (built-package.ts),
// so it never touches the checkout's dist/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtPackage, packageName as name } from './built-package.ts';

const consumer = `
const wrtc = require(${JSON.stringify(name)});
(async () => {
  const stream = await wrtc.getUserMedia({ audio: true, video: true });
  const { getUserMedia, enumerateDevices } = wrtc.mediaDevices;
  const detached = await getUserMedia({ audio: true });
  const devices = await enumerateDevices();
  const sink = new wrtc.nonstandard.RTCVideoSink(stream.getVideoTracks()[0]);
  const frame = await new Promise((resolve) => {
    sink.onframe = ({ frame }) => resolve(frame.width + 'x' + frame.height);
  });
  sink.stop();
  for (const track of [...stream.getTracks(), ...detached.getTracks()]) track.stop();
  process.stdout.write(JSON.stringify({
    types: ['getUserMedia', 'mediaDevices', 'MediaStream', 'RTCPeerConnection', 'nonstandard']
      .map((key) => key + ':' + typeof wrtc[key]),
    defaultIsNamespace: wrtc.default.getUserMedia === wrtc.getUserMedia,
    streams: [stream, detached].map((s) => s.getTracks().map((t) => t.kind).join(',')),
    devices: devices.map((d) => d.kind + ':' + d.deviceId),
    frame,
  }));
})();
`;

test("require() of the built package has wrtc's CommonJS shape, getUserMedia included", (t) => {
  const { root } = builtPackage(t);
  writeFileSync(join(root, 'consumer.cjs'), consumer);

  const out = execFileSync(process.execPath, [join(root, 'consumer.cjs')], {
    cwd: root,
    encoding: 'utf8',
    // Failure guard only: the consumer exits once its tracks are stopped.
    timeout: 30_000,
  });
  assert.deepEqual(JSON.parse(out), {
    types: [
      'getUserMedia:function',
      'mediaDevices:object',
      'MediaStream:function',
      'RTCPeerConnection:function',
      'nonstandard:object',
    ],
    defaultIsNamespace: true,
    streams: ['audio,video', 'audio'],
    devices: ['audioinput:FakeAudioDevice', 'videoinput:FakeVideoDevice'],
    frame: '640x480',
  });
});
