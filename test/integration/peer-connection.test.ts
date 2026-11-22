// Two RTCPeerConnections through the public API, against real libwebrtc:
// the milestone 1 path (nonstandard sources -> PCs -> nonstandard sinks on
// the remote tracks) and the standard calls wrtc users make around it.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import {
  MediaStream,
  type MediaStreamTrack,
  type MediaStreamTrackEvent,
  nonstandard,
  RTCPeerConnection,
  type RTCPeerConnectionIceEvent,
  type RTCTrackEvent,
} from '../../lib/index.ts';
import { builtPackage } from './built-package.ts';
import { audible, connect, media, negotiate, next, pair, reaches } from './harness.ts';

/** Resolves with the first audio data event matching `pred` on a sink of `track`. */
async function audioOn(t: TestContext, track: MediaStreamTrack, pred = audible) {
  const sink = new nonstandard.RTCAudioSink(track);
  t.after(() => sink.stop());
  const event = await next<nonstandard.RTCAudioDataEvent>(sink, 'data', (e) => pred(e.samples));
  sink.stop();
  return event;
}

/** Resolves with the first frame of `width` x `height` on a sink of `track`. */
async function frameOn(t: TestContext, track: MediaStreamTrack, width: number, height: number) {
  const sink = new nonstandard.RTCVideoSink(track);
  t.after(() => sink.stop());
  const { frame } = await next<nonstandard.RTCVideoFrameEvent>(
    sink,
    'frame',
    (e) => e.frame.width === width && e.frame.height === height,
  );
  sink.stop();
  return frame;
}

test('negotiation with trickle ICE connects, ending gathering in spec order', async (t) => {
  const p = pair(t);
  const log: string[] = [];
  const onIce = (e: Event) => {
    const { candidate } = e as RTCPeerConnectionIceEvent;
    if (candidate === null) log.push('null');
    else if (candidate.candidate === '') log.push(`end ${candidate.sdpMid}`);
  };
  p.a.addEventListener('icecandidate', onIce);
  p.a.addEventListener('icegatheringstatechange', () => log.push(p.a.iceGatheringState));
  p.a.addTransceiver('audio');
  const gathered = next(
    p.a,
    'icecandidate',
    (e) => (e as RTCPeerConnectionIceEvent).candidate === null,
  );

  await connect(p);
  await gathered;
  assert.deepEqual(log, ['gathering', 'end 0', 'complete', 'null']);
  assert.deepEqual(p.iceErrors, []);
  assert.equal(p.a.signalingState, 'stable');
  assert.equal(p.b.canTrickleIceCandidates, true);
  assert.equal(p.a.currentRemoteDescription?.type, 'answer');
  assert.equal(p.b.currentLocalDescription?.type, 'answer');
  // The local description has picked up the trickled candidates.
  assert.match(p.a.localDescription?.sdp ?? '', /^a=candidate:/m);
});

test('nonstandard sources reach nonstandard sinks on the tracks of ontrack, with their stream', async (t) => {
  const p = pair(t);
  const m = media(t);
  const stream = new MediaStream();
  const audioSender = p.a.addTrack(m.audio, stream);
  const videoSender = p.a.addTrack(m.video, stream);
  assert.equal(audioSender.track, m.audio);
  const events: RTCTrackEvent[] = [];
  p.b.ontrack = (e) => events.push(e);

  await connect(p);
  assert.deepEqual(
    events.map((e) => e.track.kind),
    ['audio', 'video'],
  );
  const [audioEvent, videoEvent] = events as [RTCTrackEvent, RTCTrackEvent];
  const [remoteStream] = audioEvent.streams;
  assert.equal(remoteStream?.id, stream.id);
  assert.equal(videoEvent.streams[0], remoteStream, 'one MediaStream per stream id');
  assert.deepEqual(remoteStream?.getTracks(), [audioEvent.track, videoEvent.track]);
  assert.deepEqual(p.b.getReceivers(), [audioEvent.receiver, videoEvent.receiver]);

  const [heard, frame] = await Promise.all([
    audioOn(t, audioEvent.track),
    frameOn(t, videoEvent.track, 320, 240),
  ]);
  // A remote track's sink sees the playout format, not the pushed one.
  assert.deepEqual([heard.sampleRate, heard.numberOfFrames, heard.channelCount], [48_000, 480, 1]);
  assert.equal(frame.data.length, 320 * 240 * 1.5);
  assert.ok(videoSender.track === m.video);
});

test('addTrack skips a stopping transceiver, which libwebrtc would fail on (spec)', async (t) => {
  const pc = new RTCPeerConnection();
  t.after(() => pc.close());
  const m = media(t);
  const stopping = pc.addTransceiver('audio', { direction: 'recvonly' });
  stopping.stop();
  const sender = pc.addTrack(m.audio);
  const added = pc.getTransceivers()[1];
  assert.equal(added?.sender, sender);
  assert.equal(added?.direction, 'sendrecv');
  assert.equal(sender.track, m.audio);

  // With a free transceiver after the stopping one, that one is reused,
  // and negotiates as a sender.
  const p = pair(t);
  p.a.addTransceiver('video', { direction: 'recvonly' }).stop();
  const free = p.a.addTransceiver('video', { direction: 'recvonly' });
  assert.equal(p.a.addTrack(m.video), free.sender);
  assert.equal(free.direction, 'sendrecv');
  assert.equal(p.a.getTransceivers().length, 2);
  const tracked = next<RTCTrackEvent>(p.b, 'track');
  await connect(p);
  assert.equal(free.currentDirection, 'sendonly');
  await frameOn(t, (await tracked).track, 320, 240);
});

test('replaceTrack switches the sent media without renegotiation', async (t) => {
  const p = pair(t);
  const first = media(t);
  const second = media(t, 176, 144);
  const sender = p.a.addTrack(first.video);
  const track = next<RTCTrackEvent>(p.b, 'track');
  await connect(p);
  const remote = (await track).track;
  await frameOn(t, remote, 320, 240);

  await sender.replaceTrack(second.video);
  assert.equal(sender.track, second.video);
  await frameOn(t, remote, 176, 144);
  await assert.rejects(sender.replaceTrack(first.audio), { name: 'TypeError' });
});

test('removeTrack and renegotiation take the remote track out of its stream', async (t) => {
  const p = pair(t);
  const m = media(t);
  const stream = new MediaStream();
  const sender = p.a.addTrack(m.audio, stream);
  const tracked = next<RTCTrackEvent>(p.b, 'track');
  await connect(p);
  const { track, streams } = await tracked;
  const remoteStream = streams[0] as MediaStream;
  const removed = next<MediaStreamTrackEvent>(remoteStream, 'removetrack');

  p.a.removeTrack(sender);
  assert.equal(sender.track, null);
  assert.equal(p.a.getTransceivers()[0]?.direction, 'recvonly');
  await negotiate(p.a, p.b);
  assert.equal((await removed).track, track);
  assert.deepEqual(remoteStream.getTracks(), []);
  assert.equal(p.a.getTransceivers()[0]?.currentDirection, 'inactive');
});

test('a direction change takes effect in currentDirection on both sides after renegotiation', async (t) => {
  const p = pair(t);
  const transceiver = p.a.addTransceiver('video');
  await connect(p);
  const [remote] = p.b.getTransceivers();
  assert.deepEqual(
    [transceiver.currentDirection, remote?.currentDirection],
    ['sendonly', 'recvonly'],
  );

  assert.ok(remote);
  transceiver.direction = 'recvonly';
  assert.equal(transceiver.currentDirection, 'sendonly', 'unchanged until negotiated');
  remote.direction = 'sendrecv';
  await negotiate(p.a, p.b);
  assert.deepEqual(
    [transceiver.currentDirection, remote?.currentDirection],
    ['recvonly', 'sendonly'],
  );
});

test('restartIce fires negotiationneeded and the next offer has new ICE credentials', async (t) => {
  const p = pair(t);
  p.a.addTransceiver('audio');
  await connect(p);
  const ufrag = () => /^a=ice-ufrag:(.+)$/m.exec(p.a.localDescription?.sdp ?? '')?.[1];
  const before = ufrag();

  const needed = next(p.a, 'negotiationneeded');
  p.a.restartIce();
  await needed;
  await negotiate(p.a, p.b);
  assert.ok(before);
  assert.notEqual(ufrag(), before);
  await reaches(p.a, 'connected');
});

test('getStats reports the media flowing, per connection and per sender/receiver', async (t) => {
  const p = pair(t);
  const m = media(t);
  const sender = p.a.addTrack(m.audio);
  const tracked = next<RTCTrackEvent>(p.b, 'track');
  await connect(p);
  const { receiver, track } = await tracked;
  await audioOn(t, track);

  const report = await p.a.getStats();
  for (const [id, stats] of report) assert.equal(stats.id, id, 'keyed by stats id');
  const types = new Set([...report.values()].map((s) => s.type));
  for (const type of ['peer-connection', 'outbound-rtp', 'transport', 'candidate-pair']) {
    assert.ok(types.has(type), `${type} in ${[...types].join()}`);
  }
  const outbound = [...(await sender.getStats()).values()].find((s) => s.type === 'outbound-rtp');
  assert.ok(outbound.packetsSent > 0);
  assert.equal(outbound.mediaType, 'audio', 'wrtc-era code reads mediaType');
  const inbound = [...(await receiver.getStats()).values()].find((s) => s.type === 'inbound-rtp');
  assert.ok(inbound.packetsReceived > 0);
  const viaTrack = [...(await p.b.getStats(track)).values()].map((s) => s.type);
  assert.ok(viaTrack.includes('inbound-rtp'));
});

test("a nonstandard video source's media-source stats carry the pushed frame size", async (t) => {
  const p = pair(t);
  const m = media(t, 320, 240);
  p.a.addTrack(m.video);
  const tracked = next<RTCTrackEvent>(p.b, 'track');
  await connect(p);
  await frameOn(t, (await tracked).track, 320, 240);

  const source = [...(await p.a.getStats()).values()].find(
    (s) => s.type === 'media-source' && s.kind === 'video',
  );
  assert.equal(source?.trackIdentifier, m.video.id);
  assert.deepEqual([source.width, source.height], [320, 240]);
});

test('close(): no events, in-flight operations never settle, getStats still works', async (t) => {
  const p = pair(t);
  p.a.addTransceiver('audio', { streams: [] });
  const offer = await p.a.createOffer();
  let events = 0;
  for (const type of ['signalingstatechange', 'track', 'connectionstatechange']) {
    p.b.addEventListener(type, () => events++);
  }
  let settled = false;
  const srd = p.b.setRemoteDescription(offer).finally(() => {
    settled = true;
  });
  p.b.close();
  // getStats completes on the same native queue, after the SRD's completion.
  const report = await p.b.getStats();
  assert.ok([...report.values()].some((s) => s.type === 'peer-connection'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(events, 0);
  assert.equal(p.b.signalingState, 'closed');
  void srd;
});

test('close() ends the remote tracks, with ended; the transceivers stay listed', async (t) => {
  const p = pair(t);
  const m = media(t);
  p.a.addTrack(m.audio);
  const tracked = next<RTCTrackEvent>(p.b, 'track');
  await connect(p);
  const { track, transceiver } = await tracked;
  const ended = next(track, 'ended');
  p.b.close();
  await ended;
  assert.equal(track.readyState, 'ended');
  assert.deepEqual(p.b.getTransceivers(), [transceiver]);
  assert.equal(transceiver.receiver.track, track);
  assert.deepEqual(p.b.getReceivers(), []);
  assert.throws(() => p.b.addTransceiver('audio'), { name: 'InvalidStateError' });
});

test('clones of remote tracks end with them, with ended: when the remote stops sending, and on close()', async (t) => {
  const p = pair(t);
  const m = media(t);
  p.a.addTrack(m.audio);
  p.a.addTrack(m.video);
  const tracks: MediaStreamTrack[] = [];
  p.b.ontrack = (e) => tracks.push(e.track);
  await connect(p);
  const clones = tracks.map((track) => track.clone());
  const states = () => [...tracks, ...clones].map((track) => track.readyState);
  const endedOf = (i: number) =>
    Promise.all([tracks[i], clones[i]].map((track) => next(track ?? assert.fail(), 'ended')));

  const videoEnded = endedOf(1);
  p.a.getTransceivers()[1]?.stop();
  await negotiate(p.a, p.b);
  await videoEnded;
  assert.deepEqual(states(), ['live', 'ended', 'live', 'ended']);
  const audioEnded = endedOf(0);
  p.b.close();
  await audioEnded;
  assert.deepEqual(states(), ['ended', 'ended', 'ended', 'ended']);
});

test('a never-closed peer connection keeps the process alive; closing it lets it exit', async () => {
  const { execFile } = await import('node:child_process');
  const index = new URL('../../lib/index.ts', import.meta.url).href;
  // The unref'd timer only fires while something else keeps the event loop
  // alive; with nothing left, the process exits first and prints nothing.
  const run = (close: boolean) =>
    new Promise<string>((resolve, reject) => {
      const script = `
        const { RTCPeerConnection } = await import(${JSON.stringify(index)});
        const pc = new RTCPeerConnection();
        pc.addTransceiver('audio');
        await pc.setLocalDescription();
        ${close ? 'pc.close();' : ''}
        setTimeout(() => {
          process.stdout.write('kept alive');
          process.exit(0);
        }, 200).unref();
      `;
      execFile(
        process.execPath,
        ['--input-type=module', '-e', script],
        { timeout: 15_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  assert.deepEqual(await Promise.all([run(false), run(true)]), ['kept alive', '']);
});

test('terminating a worker mid-call with open peer connections and sinks is clean', async (t) => {
  const { Worker } = await import('node:worker_threads');
  // Plain JavaScript on the compiled package, not lib/'s TypeScript: see
  // built-package.ts.
  const { entry } = builtPackage(t);
  const worker = new Worker(
    `
    (async () => {
      const { parentPort } = require('node:worker_threads');
      const { RTCPeerConnection, nonstandard } = await import(${JSON.stringify(entry)});
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate).catch(() => {});
      b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate).catch(() => {});
      const audio = new nonstandard.RTCAudioSource();
      const video = new nonstandard.RTCVideoSource();
      const samples = new Int16Array(480).map((_, i) => 8000 * Math.sin(i / 5));
      const frame = { width: 320, height: 240, data: new Uint8Array(320 * 240 * 1.5).fill(128) };
      setInterval(() => {
        audio.onData({ samples, sampleRate: 48000 });
        video.onFrame(frame);
      }, 10);
      a.addTrack(audio.createTrack());
      a.addTrack(video.createTrack());
      const tracks = [];
      b.ontrack = (e) => tracks.push(e.track);
      await a.setLocalDescription();
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription();
      await a.setRemoteDescription(b.localDescription);
      const sinks = [new nonstandard.RTCAudioSink(tracks[0]), new nonstandard.RTCVideoSink(tracks[1])];
      sinks[0].ondata = () => parentPort.postMessage('media');
    })();
    `,
    { eval: true },
  );
  const media = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    setTimeout(() => reject(new Error('no media in the worker')), 15_000).unref();
  });
  try {
    await media;
  } finally {
    // Never closed: termination must tear down the PCs and sinks.
    assert.equal(await worker.terminate(), 1);
  }
  // The main thread's addon state is unaffected.
  const pc = new RTCPeerConnection();
  pc.addTransceiver('audio');
  await pc.setLocalDescription();
  pc.close();
});

test('a process that loads the addon only in workers survives their exit', async () => {
  // In a child process, so that its main thread never loads the addon (this
  // one has): see worker-only-exit.ts. Without the fix it dies of SIGSEGV on Linux.
  const { execFile } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('./worker-only-exit.ts', import.meta.url));
  const { code, stdout, stderr } = await new Promise<{
    code: number | string;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    execFile(process.execPath, [script], { timeout: 30_000 }, (error, out, err) => {
      resolve({
        code: error ? (error.signal ?? error.code ?? 'error') : 0,
        stdout: out,
        stderr: err,
      });
    });
  });
  assert.equal(
    code,
    0,
    `the child ended with ${code} (SIGTERM: it hung); stdout: ${stdout}; stderr: ${stderr}`,
  );
  assert.equal(stdout, 'worker 0\nworker 0\n');
});
