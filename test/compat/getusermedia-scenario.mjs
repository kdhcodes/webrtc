// getUserMedia and mediaDevices against one implementation; prints the
// observable results as JSON. getusermedia.test.ts runs it once per
// implementation, each in its own process: never load @roamhq/wrtc and our
// addon into the same process. It leaves gUM tracks live at the end and
// must then exit on its own.
//
//   node getusermedia-scenario.mjs wrtc|ours
import { writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { errorName } from './errors.mjs';

/** Synchronous stdout (see two-pc-media-scenario.mjs). */
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
const { getUserMedia, mediaDevices } = w;
const { RTCAudioSink, RTCVideoSink } = w.nonstandard;
const out = {};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How a call ended: sync throw, rejection, or the track kinds it resolved with. */
async function outcome(fn) {
  let promise;
  try {
    promise = fn();
  } catch (error) {
    return { threw: errorName(error) };
  }
  try {
    const stream = await promise;
    const kinds = stream.getTracks().map((track) => track.kind);
    for (const track of stream.getTracks()) track.stop();
    return { resolved: kinds };
  } catch (error) {
    return { rejected: errorName(error) };
  }
}

// --- validation ---------------------------------------------------------------
const cases = {
  '()': [],
  undefined: [undefined],
  null: [null],
  string: ['audio'],
  number: [1],
  '{}': [{}],
  function: [() => {}],
  'audio:false video:false': [{ audio: false, video: false }],
  'audio:null': [{ audio: null }],
  'audio:true': [{ audio: true }],
  'video:true': [{ video: true }],
  'audio+video': [{ audio: true, video: true }],
  'audio:"x"': [{ audio: 'x' }],
  'audio:0 video:1': [{ audio: 0, video: 1 }],
  'video:{} audio:{}': [{ video: {}, audio: {} }],
  'video exact 320x240': [{ video: { width: { exact: 320 }, height: { exact: 240 } } }],
  'video min huge': [{ video: { width: { min: 100000 } } }],
  'audio deviceId exact bogus': [{ audio: { deviceId: { exact: 'bogus' } } }],
};
out.validation = {};
for (const [name, args] of Object.entries(cases)) {
  out.validation[name] = await outcome(() => getUserMedia(...args));
}
out.validation['via mediaDevices'] = await outcome(() =>
  mediaDevices.getUserMedia({ video: true }),
);
out.validation['detached mediaDevices.getUserMedia'] = await outcome(() => {
  const { getUserMedia: detached } = mediaDevices;
  return detached({ audio: true });
});

// getDisplayMedia: wrtc's is its getUserMedia under another name.
out.displayMedia = {};
for (const name of ['()', '{}', 'string', 'audio:true', 'video:true', 'audio+video']) {
  out.displayMedia[name] = await outcome(() => mediaDevices.getDisplayMedia(...cases[name]));
}
const displayStream = await mediaDevices.getDisplayMedia({ video: { width: 1920 } });
out.displayMedia.settings = displayStream.getTracks().map((track) => track.getSettings());
for (const track of displayStream.getTracks()) track.stop();

// --- tracks and streams -------------------------------------------------------
const stream = await getUserMedia({
  audio: { sampleRate: 16000, channelCount: 2 },
  video: { width: 320, height: 240, frameRate: 15, facingMode: 'environment' },
});
const [audio] = stream.getAudioTracks();
const [video] = stream.getVideoTracks();
const shape = (track) => ({
  ctor: track.constructor.name,
  kind: track.kind,
  idIsUuid: uuid.test(track.id),
  enabled: track.enabled,
  readyState: track.readyState,
  muted: track.muted,
  label: track.label,
});
out.audioTrack = shape(audio);
out.videoTrack = shape(video);
// Constraints are ignored: these are the fixed formats either way.
out.audioSettings = audio.getSettings();
out.videoSettings = video.getSettings();
out.stream = {
  ctor: stream.constructor.name,
  idIsUuid: uuid.test(stream.id),
  active: stream.active,
  kinds: stream.getTracks().map((track) => track.kind),
};

// --- media on local sinks (wrtc's tracks carry none) ---------------------------
/** Events a local sink gets: until `want` arrive, or 1 s passes. */
function count(Sink, track, type, want) {
  return new Promise((resolve) => {
    const sink = new Sink(track);
    const seen = [];
    const done = () => {
      clearTimeout(timer);
      sink.stop();
      resolve(seen);
    };
    const timer = setTimeout(done, 1000);
    sink.addEventListener(type, (event) => {
      seen.push(event);
      if (seen.length === want) done();
    });
  });
}
const [audioEvents, videoEvents] = await Promise.all([
  count(RTCAudioSink, audio, 'data', 3),
  count(RTCVideoSink, video, 'frame', 3),
]);
out.localMedia = {
  audio: audioEvents.map((e) => `${e.sampleRate}/${e.channelCount}/${e.numberOfFrames}`),
  video: videoEvents.map((e) => `${e.frame.width}x${e.frame.height}`),
};

// --- clone and stop -------------------------------------------------------------
const clone = video.clone();
out.clone = { newId: clone.id !== video.id, readyState: clone.readyState, label: clone.label };
video.stop();
out.stopOne = {
  stopped: video.readyState,
  clone: clone.readyState,
  streamActive: stream.active,
};
audio.stop();
clone.stop();
out.stopAll = {
  readyStates: stream.getTracks().map((track) => track.readyState),
  enabled: stream.getTracks().map((track) => track.enabled),
  active: stream.active,
};

// --- mediaDevices ---------------------------------------------------------------
out.mediaDevices = {
  sameFunction: mediaDevices.getUserMedia === getUserMedia,
  supportedConstraints: mediaDevices.getSupportedConstraints(),
  enumerateDevices: await (async () => {
    let promise;
    try {
      promise = mediaDevices.enumerateDevices();
    } catch (error) {
      return { threw: errorName(error) };
    }
    return { resolved: JSON.parse(JSON.stringify(await promise)) };
  })(),
};

// --- lifetime -------------------------------------------------------------------
// Live gUM tracks, no sinks, no peer connection: the process must exit.
globalThis.keep = await getUserMedia({ audio: true, video: true });
writeAll(JSON.stringify(out));
