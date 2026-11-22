// Smoke test for the installed package, run by scripts/smoke-install.sh in a
// fresh directory where only the tarballs are installed. Dependency-free.
//
//   node smoke.mjs <package name>
//
// Two RTCPeerConnections over loopback: a tone and grey frames from the
// nonstandard sources reach nonstandard sinks on the remote tracks. Exits 0
// on its own once everything is closed; exits 1 on a failure, a timeout, or
// a handle that keeps the process alive afterwards.
//
// The test runs in a child process that this one SIGKILLs if it hasn't exited
// after 60 s: a deadlock in native teardown can't be caught from inside.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const [name, role] = process.argv.slice(2);
if (!name) throw new Error('usage: node smoke.mjs <package name>');
let guard;

function supervise() {
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, name, '--child'], { stdio: 'inherit' });
  const timer = setTimeout(() => {
    console.error('smoke: FAIL, still running after 60 s (deadlock?); killing it');
    child.kill('SIGKILL');
  }, 60_000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    process.exit(code ?? 1);
  });
}

function fail(error) {
  console.error('smoke: FAIL', error);
  process.exit(1);
}

/** Resolves with the first `type` event on `target` that matches `pred`. */
function next(target, type, pred = () => true) {
  return new Promise((resolve) => {
    const listener = (event) => {
      if (!pred(event)) return;
      target.removeEventListener(type, listener);
      resolve(event);
    };
    target.addEventListener(type, listener);
  });
}

async function main() {
  const triple = `${process.platform}-${process.arch}`;
  const addon = createRequire(import.meta.url).resolve(`${name}-${triple}/wrtc.node`);
  console.log(`smoke: node ${process.version} on ${triple}, addon ${addon}`);

  // The default export is the whole namespace, as with `import wrtc from '@roamhq/wrtc'`.
  const namespace = await import(name);
  const wrtc = namespace.default;
  assert.equal(wrtc.RTCPeerConnection, namespace.RTCPeerConnection);
  const { RTCPeerConnection, MediaStream, nonstandard } = wrtc;

  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  for (const [from, to] of [
    [a, b],
    [b, a],
  ]) {
    from.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) to.addIceCandidate(candidate).catch(fail);
    });
  }

  const audioSource = new nonstandard.RTCAudioSource();
  const videoSource = new nonstandard.RTCVideoSource();
  const width = 320;
  const height = 240;
  const frame = { width, height, data: new Uint8Array((width * height * 3) / 2).fill(128) };
  let tick = 0;
  const pump = setInterval(() => {
    const samples = new Int16Array(480);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (tick * 480 + i)) / 48_000));
    }
    audioSource.onData({ samples, sampleRate: 48_000 });
    if (tick % 3 === 0) videoSource.onFrame(frame);
    tick++;
  }, 10);
  const audioTrack = audioSource.createTrack();
  const videoTrack = videoSource.createTrack();
  const stream = new MediaStream();
  a.addTrack(audioTrack, stream);
  a.addTrack(videoTrack, stream);

  const tracks = [];
  b.ontrack = ({ track }) => tracks.push(track);
  const connected = Promise.all(
    [a, b].map((pc) => next(pc, 'connectionstatechange', () => pc.connectionState === 'connected')),
  );
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  await connected;
  assert.deepEqual(
    tracks.map((t) => t.kind),
    ['audio', 'video'],
  );

  const audioSink = new nonstandard.RTCAudioSink(tracks[0]);
  const videoSink = new nonstandard.RTCVideoSink(tracks[1]);
  const [heard, seen] = await Promise.all([
    next(audioSink, 'data', (e) => e.samples.some((s) => Math.abs(s) > 1000)),
    next(videoSink, 'frame', (e) => e.frame.width === width && e.frame.height === height),
  ]);
  assert.deepEqual([heard.sampleRate, heard.channelCount, heard.numberOfFrames], [48_000, 1, 480]);
  assert.equal(seen.frame.data.length, (width * height * 3) / 2);
  console.log(
    `smoke: audio ${heard.sampleRate} Hz x${heard.channelCount}, ` +
      `video ${seen.frame.width}x${seen.frame.height}`,
  );

  audioSink.stop();
  videoSink.stop();
  clearInterval(pump);
  audioTrack.stop();
  videoTrack.stop();
  a.close();
  b.close();
  clearTimeout(guard);
  // Doesn't keep the process alive itself: it only fires if something else does.
  setTimeout(
    () => fail(new Error('did not exit 5 s after closing (leaked handle?)')),
    5000,
  ).unref();
  console.log('smoke: ok, closed; waiting for the process to exit');
}

if (role === '--child') {
  guard = setTimeout(() => fail(new Error('timed out after 30 s')), 30_000);
  main().catch(fail);
} else {
  supervise();
}
