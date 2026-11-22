// Runs the nonstandard media scenarios against one implementation and prints
// the observable results as JSON. nonstandard.test.ts runs it once per
// implementation, each in its own process: never load @roamhq/wrtc and our
// addon into the same process.
//
//   node nonstandard-scenario.mjs wrtc|ours
import { writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { errorName } from './errors.mjs';

/**
 * Writes `text` to stdout synchronously. process.stdout.write to a pipe is
 * async on macOS, so the process.exit() that follows for wrtc could cut the
 * results short. The pipe can be non-blocking: retry partial writes and
 * EAGAIN until the parent has read it all.
 */
function writeAll(text) {
  const bytes = Buffer.from(text);
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(1, bytes, written);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
    }
  }
}

const impl = process.argv[2];
const w =
  impl === 'wrtc'
    ? createRequire(import.meta.url)('@roamhq/wrtc')
    : await import('../../lib/index.ts');
const { RTCAudioSource, RTCAudioSink, RTCVideoSource, RTCVideoSink } = w.nonstandard;

const sinks = [];
const audioSink = (track) => {
  const sink = new RTCAudioSink(track);
  sinks.push(sink);
  return sink;
};
const videoSink = (track) => {
  const sink = new RTCVideoSink(track);
  sinks.push(sink);
  return sink;
};

function outcome(fn) {
  try {
    const value = fn();
    return { ok: value === undefined ? null : value };
  } catch (error) {
    return { name: errorName(error) };
  }
}

/** Resolves with the next `type` event; rejects after 5 s (failure guard). */
function next(target, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} event`)), 5000);
    target.addEventListener(type, function listener(event) {
      clearTimeout(timer);
      target.removeEventListener(type, listener);
      resolve(event);
    });
  });
}

// wrtc dispatches on process.nextTick after its uv callback, we dispatch in
// the TSFN callback; either way every sink signalled by one push has been
// drained once a check phase has run after the witness's event.
const afterDrain = () => new Promise((resolve) => setImmediate(resolve));

const pcm = (length) => Int16Array.from({ length }, (_, i) => ((i * 7919) % 65536) - 32768);
const i420Size = (width, height) =>
  width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
const i420 = (width, height) =>
  Uint8Array.from({ length: i420Size(width, height) }, (_, i) => (i * 31 + 7) & 0xff);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const out = {};
const audio = new RTCAudioSource();
const audioTrack = audio.createTrack();
const video = new RTCVideoSource();
const videoTrack = video.createTrack();

// --- Validation -----------------------------------------------------------
const s80 = new Int16Array(80);
/** `view` with its buffer detached (it then reads as empty). */
const detach = (view) => {
  view.buffer.transfer();
  return view;
};
/** `view` with overriding own buffer, byteOffset and byteLength, which wrtc ignores. */
const overridden = (view) =>
  Object.defineProperties(view, {
    buffer: { value: new ArrayBuffer(999) },
    byteOffset: { value: 2 },
    byteLength: { value: 998 },
  });

const onDataCases = {
  'no argument': undefined,
  string: 'x',
  'empty object': {},
  'samples array': { samples: [0], sampleRate: 8000 },
  'samples DataView': { samples: new DataView(new ArrayBuffer(160)), sampleRate: 8000 },
  'samples ArrayBuffer': { samples: new ArrayBuffer(160), sampleRate: 8000 },
  'samples Uint8Array': { samples: new Uint8Array(160), sampleRate: 8000 },
  'samples Float32Array': { samples: new Float32Array(40), sampleRate: 8000 },
  'no sampleRate': { samples: s80 },
  'sampleRate string': { samples: s80, sampleRate: '8000' },
  'sampleRate 65536': { samples: s80, sampleRate: 65536 },
  'sampleRate -1': { samples: s80, sampleRate: -1 },
  'sampleRate fractional': { samples: s80, sampleRate: 8000.7 },
  'sampleRate NaN': { samples: new Int16Array(0), sampleRate: Number.NaN },
  'sampleRate 44100': { samples: new Int16Array(441), sampleRate: 44100 },
  'sampleRate 22050': { samples: new Int16Array(220), sampleRate: 22050 },
  'bitsPerSample 8': { samples: s80, sampleRate: 8000, bitsPerSample: 8 },
  'bitsPerSample 256': { samples: s80, sampleRate: 8000, bitsPerSample: 256 },
  'bitsPerSample null': { samples: s80, sampleRate: 8000, bitsPerSample: null },
  'bitsPerSample and channelCount bad': {
    samples: s80,
    sampleRate: 8000,
    bitsPerSample: 'x',
    channelCount: 'y',
  },
  'channelCount 256': { samples: s80, sampleRate: 8000, channelCount: 256 },
  'channelCount string': { samples: new Int16Array(160), sampleRate: 8000, channelCount: '2' },
  'channelCount 3': { samples: new Int16Array(240), sampleRate: 8000, channelCount: 3 },
  'numberOfFrames 20 ms': { samples: new Int16Array(160), sampleRate: 8000, numberOfFrames: 160 },
  'numberOfFrames null': { samples: s80, sampleRate: 8000, numberOfFrames: null },
  'numberOfFrames matching': { samples: s80, sampleRate: 8000, numberOfFrames: 80 },
  'numberOfFrames and byteLength bad': {
    samples: new Int16Array(3),
    sampleRate: 8000,
    numberOfFrames: 81,
  },
  'byteLength short': { samples: new Int16Array(79), sampleRate: 8000 },
  'byteLength stereo short': { samples: s80, sampleRate: 8000, channelCount: 2 },
  'samples offset view': { samples: new Int16Array(100).subarray(10, 90), sampleRate: 8000 },
  'samples detached': { samples: detach(new Int16Array(80)), sampleRate: 8000 },
  'samples detached, empty frame': { samples: detach(new Int16Array(80)), sampleRate: 99 },
  'samples overridden view properties': {
    samples: overridden(new Int16Array(80)),
    sampleRate: 8000,
  },
};
out.onData = Object.fromEntries(
  Object.entries(onDataCases).map(([name, data]) => [name, outcome(() => audio.onData(data))]),
);

const d24 = new Uint8Array(24);
const onFrameCases = {
  'no argument': undefined,
  null: null,
  'empty object': {},
  'width string': { width: '4', height: 4, data: d24 },
  'no height': { width: 4, data: d24 },
  'no data': { width: 4, height: 4 },
  'data array': { width: 4, height: 4, data: Array(24).fill(0) },
  'data ArrayBuffer': { width: 4, height: 4, data: new ArrayBuffer(24) },
  'data Uint8ClampedArray': { width: 4, height: 4, data: new Uint8ClampedArray(24) },
  'data Int16Array': { width: 4, height: 4, data: new Int16Array(12) },
  'data DataView': { width: 4, height: 4, data: new DataView(new ArrayBuffer(24)) },
  'width fractional': { width: 4.5, height: 4, data: d24 },
  'width 2^31': { width: 2 ** 31, height: 4, data: d24 },
  'short data': { width: 4, height: 4, data: new Uint8Array(23) },
  'long data': { width: 4, height: 4, data: new Uint8Array(25) },
  'odd size short': { width: 3, height: 3, data: new Uint8Array(13) },
  'odd size exact': { width: 3, height: 3, data: new Uint8Array(17) },
  'negative width': { width: -4, height: 4, data: d24 },
  'negative height': { width: 4, height: -3, data: d24 },
  'huge size': { width: 50000, height: 50000, data: d24 },
  'zero size': { width: 0, height: 0, data: new Uint8Array(0) },
  'zero by negative': { width: 0, height: -3, data: new Uint8Array(0) },
  'negative by zero': { width: -3, height: 0, data: new Uint8Array(0) },
  'zero by negative, with data': { width: 0, height: -3, data: new Uint8Array(4) },
  'rotation 45': { width: 4, height: 4, data: d24, rotation: 45 },
  'data offset view': { width: 4, height: 4, data: new Uint8Array(30).subarray(3, 27) },
  'data detached': { width: 4, height: 4, data: detach(new Uint8Array(24)) },
  'data detached, 0x0': { width: 0, height: 0, data: detach(new Uint8Array(24)) },
  'data overridden view properties': { width: 4, height: 4, data: overridden(new Uint8Array(24)) },
};
out.onFrame = Object.fromEntries(
  Object.entries(onFrameCases).map(([name, frame]) => [name, outcome(() => video.onFrame(frame))]),
);

const initCases = {
  none: [],
  undefined: [undefined],
  empty: [{}],
  null: [null],
  string: ['x'],
  screencast: [{ isScreencast: true }],
  'truthy values': [{ isScreencast: 1, needsDenoising: 'x' }],
  'needsDenoising false': [{ needsDenoising: false }],
  'needsDenoising null': [{ needsDenoising: null }],
};
out.videoSourceInit = Object.fromEntries(
  Object.entries(initCases).map(([name, args]) => [
    name,
    outcome(() => {
      const source = new RTCVideoSource(...args);
      return { isScreencast: source.isScreencast, needsDenoising: source.needsDenoising };
    }),
  ]),
);

out.sinkConstructor = {
  'audio, no track': outcome(() => audioSink()),
  'audio, null': outcome(() => audioSink(null)),
  'audio, plain object': outcome(() => audioSink({ id: 'x', kind: 'audio' })),
  'audio, video track': outcome(() => audioSink(videoTrack) && 'constructed'),
  'video, audio track': outcome(() => videoSink(audioTrack) && 'constructed'),
  'audio, function': outcome(() => audioSink(() => {})),
};
out.trackConstructor = outcome(() => new w.MediaStreamTrack());

// --- Tracks ---------------------------------------------------------------
const describeTrack = (track) => ({
  idIsUuid: uuid.test(track.id),
  kind: track.kind,
  label: track.label,
  enabled: track.enabled,
  muted: track.muted,
  readyState: track.readyState,
  settings: track.getSettings(),
});
out.audioTrack = describeTrack(audioTrack);
out.videoTrack = describeTrack(videoTrack);
out.createTrackTwice = (() => {
  const a = audio.createTrack();
  const b = audio.createTrack();
  return { same: a === b, sameId: a.id === b.id };
})();
out.trackStop = (() => {
  const track = audio.createTrack();
  track.stop();
  track.stop();
  const readyState = track.readyState;
  track.enabled = false;
  return { readyState, enabledAfterSet: track.enabled };
})();
out.clone = (() => {
  const track = audio.createTrack();
  track.enabled = false;
  const clone = track.clone();
  track.stop();
  const endedClone = track.clone();
  return {
    sameId: clone.id === track.id,
    kind: clone.kind,
    readyState: clone.readyState,
    enabled: clone.enabled,
    endedCloneReadyState: endedClone.readyState,
  };
})();

// --- Sinks ----------------------------------------------------------------
out.sinkShape = (() => {
  const sink = audioSink(audioTrack);
  const result = { stopped: sink.stopped, ondata: sink.ondata };
  sink.stop();
  sink.stop();
  result.stoppedAfterStop = sink.stopped;
  return result;
})();

const describeAudioEvent = (event, pushed) => ({
  ownType: Object.keys(event).includes('type'),
  keys: Object.keys(event).filter((key) => key !== 'type'),
  samplesType: event.samples.constructor.name,
  samplesFresh: event.samples.buffer !== pushed.buffer,
  samplesEqual:
    event.samples.length === pushed.length && event.samples.every((v, i) => v === pushed[i]),
  bitsPerSample: event.bitsPerSample,
  sampleRate: event.sampleRate,
  channelCount: event.channelCount,
  numberOfFrames: event.numberOfFrames,
});

out.audioEvents = {};
for (const [sampleRate, channelCount] of [
  [8000, 1],
  [16000, 2],
  [44100, 1],
  [48000, 2],
]) {
  const sink = audioSink(audioTrack);
  const samples = pcm((sampleRate / 100) * channelCount);
  const event = next(sink, 'data');
  audio.onData({ samples, sampleRate, channelCount });
  out.audioEvents[`${sampleRate}/${channelCount}`] = describeAudioEvent(await event, samples);
  sink.stop();
}

out.videoEvents = {};
for (const [width, height, rotation] of [
  [4, 4, 0],
  [321, 241, 0],
  [321, 241, 90],
]) {
  const sink = videoSink(videoTrack);
  const data = i420(width, height);
  const event = next(sink, 'frame');
  video.onFrame({ width, height, data, rotation });
  const { frame } = await event;
  out.videoEvents[`${width}x${height} r${rotation}`] = {
    ownType: Object.keys(await event).includes('type'),
    keys: Object.keys(await event).filter((key) => key !== 'type'),
    frameKeys: Object.keys(frame),
    dataType: frame.data.constructor.name,
    dataEqual: frame.data.length === data.length && frame.data.every((v, i) => v === data[i]),
    width: frame.width,
    height: frame.height,
    rotation: frame.rotation,
  };
  sink.stop();
}

// `ondata` is set before the listener is added, which is where the
// implementations differ: ours runs handlers in registration order (HTML's
// event handler semantics), wrtc always runs `ondata` after the listeners.
out.listeners = await (async () => {
  const sink = audioSink(audioTrack);
  const order = [];
  const thisIsSink = {};
  sink.ondata = function () {
    order.push('ondata');
    thisIsSink.ondata = this === sink;
  };
  sink.addEventListener('data', function () {
    order.push('listener');
    thisIsSink.listener = this === sink;
  });
  const event = next(sink, 'data');
  audio.onData({ samples: s80, sampleRate: 8000 });
  await event;
  await afterDrain();
  sink.stop();
  return { order, thisIsSink };
})();

out.stopDropsQueued = await (async () => {
  const witness = audioSink(audioTrack);
  const sink = audioSink(audioTrack);
  let count = 0;
  sink.ondata = () => count++;
  const done = next(witness, 'data');
  audio.onData({ samples: s80, sampleRate: 8000 });
  sink.stop();
  await done;
  await afterDrain();
  witness.stop();
  return count;
})();

out.mediaAfterTrackStop = await (async () => {
  const track = audio.createTrack();
  const sink = audioSink(track);
  track.stop();
  const sinkStopped = sink.stopped;
  let received = false;
  sink.addEventListener('data', () => {
    received = true;
  });
  audio.onData({ samples: s80, sampleRate: 8000 });
  // Local data arrives within a task or two; wait well past that.
  await new Promise((resolve) => setTimeout(resolve, 300));
  sink.stop();
  return { received, sinkStopped };
})();

out.disabledAudioTrack = await (async () => {
  const track = audio.createTrack();
  track.enabled = false;
  const sink = audioSink(track);
  const event = next(sink, 'data');
  audio.onData({ samples: new Int16Array(80).fill(1000), sampleRate: 8000 });
  const { samples } = await event;
  sink.stop();
  return samples.every((v) => v === 1000) ? 'unchanged' : 'altered';
})();

// A disabled local video track delivers black frames (libwebrtc's
// VideoBroadcaster), pixel for pixel.
out.disabledVideoTrack = {};
for (const [width, height] of [
  [4, 4],
  [3, 3],
]) {
  const track = video.createTrack();
  track.enabled = false;
  const sink = videoSink(track);
  const event = next(sink, 'frame');
  video.onFrame({ width, height, data: i420(width, height) });
  const { frame } = await event;
  sink.stop();
  out.disabledVideoTrack[`${width}x${height}`] = {
    width: frame.width,
    height: frame.height,
    rotation: frame.rotation,
    data: Array.from(frame.data),
  };
}

// --- Remote tracks ----------------------------------------------------------
// Sinks on received tracks, and on a clone of one, across two peer
// connections. Remote audio comes out of the playout mixer, so the first
// audible event is compared (wrtc's very first, pre-packet event differs).
out.remote = await (async () => {
  const a = new w.RTCPeerConnection();
  const b = new w.RTCPeerConnection();
  a.onicecandidate = ({ candidate }) => candidate?.candidate && b.addIceCandidate(candidate);
  b.onicecandidate = ({ candidate }) => candidate?.candidate && a.addIceCandidate(candidate);
  const stream = new w.MediaStream();
  a.addTrack(audio.createTrack(), stream);
  a.addTrack(video.createTrack(), stream);
  const received = [];
  // Read in the event, before any media can have arrived: ours starts a
  // remote track muted (the spec, Chrome); wrtc's is never muted.
  const mutedInOntrack = [];
  b.ontrack = ({ track }) => {
    received.push(track);
    mutedInOntrack.push(track.muted);
  };
  const connected = next(b, 'connectionstatechange').then(function wait() {
    return b.connectionState === 'connected' ? null : next(b, 'connectionstatechange').then(wait);
  });
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  await connected;

  const tone = Int16Array.from({ length: 480 }, (_, i) => Math.round(8000 * Math.sin(i / 3)));
  const pump = setInterval(() => {
    audio.onData({ samples: tone, sampleRate: 48000 });
    video.onFrame({ width: 64, height: 48, data: i420(64, 48) });
  }, 10);
  const audible = (event) => event.samples.some((s) => Math.abs(s) > 1000);
  const firstAudible = (track) =>
    new Promise((resolve, reject) => {
      const sink = audioSink(track);
      const timer = setTimeout(() => reject(new Error('no audible remote audio')), 10000);
      sink.addEventListener('data', function listener(event) {
        if (!audible(event)) return;
        clearTimeout(timer);
        sink.stop();
        resolve(event);
      });
    });
  const [remoteAudio, remoteVideo] = received;
  // Ours unmutes when the first packet arrives, through the peer
  // connection's event stream, which isn't ordered with the sinks' events.
  const unmuted = received.map((track) =>
    track.muted ? next(track, 'unmute').then(() => track.muted) : track.muted,
  );
  const clone = remoteAudio.clone();
  const [heard, heardOnClone, { frame }] = await Promise.all([
    firstAudible(remoteAudio),
    firstAudible(clone),
    next(videoSink(remoteVideo), 'frame'),
  ]);
  const mutedAfterUnmute = await Promise.all(unmuted);
  clearInterval(pump);
  const live = {
    readyState: remoteAudio.readyState,
    enabled: remoteAudio.enabled,
    muted: remoteAudio.muted,
  };
  let endedEvents = 0;
  for (const track of [remoteAudio, remoteVideo, clone]) {
    track.addEventListener('ended', () => endedEvents++);
  }
  a.close();
  b.close();
  const readyStateAfterClose = remoteAudio.readyState;
  // Ours ends a closed PC's remote tracks in a queued task (the spec).
  await new Promise((resolve) => setImmediate(resolve));
  return {
    kinds: received.map((track) => track.kind),
    mutedInOntrack,
    mutedAfterUnmute,
    track: live,
    readyStateAfterClose,
    readyStateAfterTask: remoteAudio.readyState,
    endedEventsOnClose: endedEvents,
    audio: {
      keys: Object.keys(heard).filter((key) => key !== 'type'),
      samplesType: heard.samples.constructor.name,
      sampleRate: heard.sampleRate,
      numberOfFrames: heard.numberOfFrames,
      channelCount: heard.channelCount,
      bitsPerSample: heard.bitsPerSample,
    },
    clone: {
      sameId: clone.id === remoteAudio.id,
      sampleRate: heardOnClone.sampleRate,
      numberOfFrames: heardOnClone.numberOfFrames,
    },
    video: {
      frameKeys: Object.keys(frame),
      dataType: frame.data.constructor.name,
      width: frame.width,
      height: frame.height,
    },
  };
})();

for (const sink of sinks) sink.stop();

// --- Process lifetime -----------------------------------------------------
// Every other sink is stopped, so an unstopped sink is the only thing left
// that can keep the event loop alive, and the unref'd timer below only
// fires while something does. If it never fires, the process exits without
// printing anything, and the test reports that.
const keepAlive = audioSink(audioTrack);
setTimeout(() => {
  out.lifetime = { unstoppedSinkKeptProcessAlive: true };
  keepAlive.stop();
  writeAll(JSON.stringify(out));
  // wrtc's own threads keep its process alive regardless; ours must now
  // exit on its own (nonstandard.test.ts checks that).
  if (impl === 'wrtc') process.exit(0);
}, 50).unref();
