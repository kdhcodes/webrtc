// The milestone 1 scenario: two peer connections exchanging audio and video
// from the nonstandard sources (both ways: the answerer adds its own track
// after setRemoteDescription), read back through the nonstandard sinks on
// the remote tracks, with the standard calls wrtc users make around that:
// stats polling, replaceTrack, removeTrack and re-adding, direction,
// transceiver.stop(), clones of remote tracks, and close().
// Prints the observable outcomes as JSON. two-pc-media.test.ts runs it once
// per implementation, each in its own process: never load @roamhq/wrtc and
// our addon into the same process.
//
//   node two-pc-media-scenario.mjs wrtc|ours
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
const { RTCPeerConnection, MediaStream, nonstandard } = w;
const { RTCAudioSource, RTCAudioSink, RTCVideoSource, RTCVideoSink } = nonstandard;

/** Resolves with the next matching `type` event; rejects after 10 s (failure guard). */
function next(target, type, pred = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${impl}: no ${type} event`)), 10_000);
    const listener = (event) => {
      if (!pred(event)) return;
      clearTimeout(timer);
      target.removeEventListener(type, listener);
      resolve(event);
    };
    target.addEventListener(type, listener);
  });
}

async function outcome(fn) {
  try {
    const value = await fn();
    return { ok: value === undefined ? null : value };
  } catch (error) {
    return { name: errorName(error) };
  }
}

const stateOf = {
  signalingstatechange: 'signalingState',
  connectionstatechange: 'connectionState',
  icegatheringstatechange: 'iceGatheringState',
};

/** Logs `type[:state]` for each event, plus markers pushed by the scenario. */
function record(pc) {
  const log = [];
  for (const type of ['signalingstatechange', 'track', 'negotiationneeded']) {
    pc.addEventListener(type, () =>
      log.push(stateOf[type] ? `${type}:${pc[stateOf[type]]}` : type),
    );
  }
  return log;
}

const connected = (pc) =>
  pc.connectionState === 'connected'
    ? Promise.resolve()
    : next(pc, 'connectionstatechange', () => pc.connectionState === 'connected');

async function negotiate(a, b) {
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
}

const ufrag = (pc) => /^a=ice-ufrag:(.+)$/m.exec(pc.localDescription?.sdp ?? '')?.[1];
const directions = (pc) =>
  pc.getTransceivers().map((t) => [t.mid, t.direction, t.currentDirection]);
const audible = (samples) => samples.some((s) => Math.abs(s) > 1000);
const kindsOf = (report) => [...new Set([...report.values()].map((s) => s.type))].sort();

/**
 * The union of keys per stats type (RTP streams per kind), sorted. Of the
 * candidates and candidate pairs, only the selected pair and its two
 * candidates count: which others are listed (TCP candidates, other
 * interfaces) depends on gathering and pruning timing.
 */
function statsKeys(report) {
  const keys = {};
  const transport = [...report.values()].find((s) => s.type === 'transport');
  const pair = report.get(transport?.selectedCandidatePairId);
  const selected = new Set([pair?.id, pair?.localCandidateId, pair?.remoteCandidateId]);
  report.forEach((stats) => {
    if (stats.type.includes('candidate') && !selected.has(stats.id)) return;
    const type = stats.type.endsWith('bound-rtp') ? `${stats.type}/${stats.kind}` : stats.type;
    keys[type] ??= new Set();
    for (const key of Object.keys(stats)) keys[type].add(key);
  });
  return Object.fromEntries(
    Object.entries(keys)
      .sort(([x], [y]) => (x < y ? -1 : 1))
      .map(([type, set]) => [type, [...set].sort()]),
  );
}

// --- Media on a real-time clock ---------------------------------------------
const audioSource = new RTCAudioSource();
const answerSource = new RTCAudioSource();
const videoSource = new RTCVideoSource();
const otherVideoSource = new RTCVideoSource();
const audioTrack = audioSource.createTrack();
const answerTrack = answerSource.createTrack();
const videoTrack = videoSource.createTrack();
const otherVideoTrack = otherVideoSource.createTrack();
const i420 = (width, height) =>
  new Uint8Array(width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2)).fill(128);
let tick = 0;
const pump = setInterval(() => {
  const samples = new Int16Array(480);
  for (let i = 0; i < 480; i++) {
    samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (tick * 480 + i)) / 48_000));
  }
  audioSource.onData({ samples, sampleRate: 48_000 });
  answerSource.onData({ samples, sampleRate: 48_000 });
  if (tick % 3 === 0) {
    videoSource.onFrame({ width: 320, height: 240, data: i420(320, 240) });
    otherVideoSource.onFrame({ width: 176, height: 144, data: i420(176, 144) });
  }
  tick++;
}, 10);

const sinks = [];
async function firstAudio(track) {
  const sink = new RTCAudioSink(track);
  sinks.push(sink);
  const event = await next(sink, 'data', (e) => audible(e.samples));
  sink.stop();
  return event;
}
async function firstFrame(track, width, height) {
  const sink = new RTCVideoSink(track);
  sinks.push(sink);
  const { frame } = await next(
    sink,
    'frame',
    (e) => e.frame.width === width && e.frame.height === height,
  );
  sink.stop();
  return frame;
}

const out = {};
const a = new RTCPeerConnection();
const b = new RTCPeerConnection();
const logA = record(a);
const logB = record(b);

// --- ICE: trickle every candidate to the other side --------------------------
const ice = { a: [], b: [], gatheringAtNull: null, errors: [] };
let firstIceEvent;
const forward = (from, to, list) => (e) => {
  firstIceEvent ??= e;
  const { candidate } = e;
  if (candidate === null) {
    if (from === a) ice.gatheringAtNull = from.iceGatheringState;
    list.push('null');
    return;
  }
  list.push(candidate.candidate === '' ? 'end-of-candidates' : 'candidate');
  if (!ice.shape && candidate.candidate) {
    ice.shape = {
      isRTCIceCandidate: candidate instanceof w.RTCIceCandidate,
      jsonKeys: Object.keys(JSON.parse(JSON.stringify(candidate))).sort(),
      type: candidate.type,
      protocol: candidate.protocol,
      component: candidate.component,
      ufragIsString: typeof candidate.usernameFragment === 'string',
      sdpMid: typeof candidate.sdpMid,
      sdpMLineIndex: typeof candidate.sdpMLineIndex,
      portIsNumber: typeof candidate.port === 'number',
    };
  }
  if (candidate.candidate) to.addIceCandidate(candidate).catch((err) => ice.errors.push(err.name));
};
a.addEventListener('icecandidate', forward(a, b, ice.a));
b.addEventListener('icecandidate', forward(b, a, ice.b));

// --- addTrack and negotiation -----------------------------------------------
const stream = new MediaStream();
const audioSender = a.addTrack(audioTrack, stream);
const videoSender = a.addTrack(videoTrack, stream);
out.addTrack = {
  senderTrackIsTrack: audioSender.track === audioTrack && videoSender.track === videoTrack,
  getSenders: a.getSenders().map((s) => s === audioSender || s === videoSender),
  directions: directions(a),
  stableIdentity: a.getTransceivers().every((t, i) => t === a.getTransceivers()[i]),
};

const trackEvents = [];
b.addEventListener('track', (e) => trackEvents.push(e));
const answererTrackEvents = [];
a.addEventListener('track', (e) => answererTrackEvents.push(e));
const offer = await a.createOffer();
out.offer = { keys: Object.keys(offer).sort(), type: offer.type, sdp: typeof offer.sdp };
const transportBeforeOffer = audioSender.transport;
await a.setLocalDescription(offer);
logA.push('SLD resolved');
const offerTransport = audioSender.transport;
await b.setRemoteDescription(offer);
logB.push('SRD resolved');
out.transportsAtOffer = {
  beforeOffer: transportBeforeOffer,
  sender: offerTransport?.constructor.name,
  dtls: offerTransport?.state,
  ice: offerTransport?.iceTransport.state,
  receiverShares: a.getTransceivers()[0]?.receiver.transport === offerTransport,
  answererReceiver: b.getTransceivers()[0]?.receiver.transport ?? null,
  role: offerTransport?.iceTransport.role,
};
// The server pattern: the answerer adds its own track after the offer.
const answerStream = new MediaStream();
const answerSender = b.addTrack(answerTrack, answerStream);
out.answererAddTrack = {
  reusedOfferedTransceiver: b.getTransceivers().length === 2,
  senderTrack: answerSender.track === answerTrack,
  directions: directions(b),
};
const answer = await b.createAnswer();
await b.setLocalDescription(answer);
logB.push('SLD resolved');
await a.setRemoteDescription(answer);
logA.push('SRD resolved');
await Promise.all([connected(a), connected(b)]);
const gatheredA =
  a.iceGatheringState === 'complete'
    ? null
    : next(a, 'icegatheringstatechange', () => a.iceGatheringState === 'complete');
await gatheredA;

out.descriptions = {
  local: a.localDescription?.constructor.name,
  jsonKeys: Object.keys(JSON.parse(JSON.stringify(a.localDescription))).sort(),
  types: [a.localDescription?.type, a.remoteDescription?.type, b.localDescription?.type],
  current: [a.currentLocalDescription?.type, a.currentRemoteDescription?.type],
  pending: [a.pendingLocalDescription, a.pendingRemoteDescription],
};
out.states = {
  a: [a.signalingState, a.connectionState, a.iceGatheringState],
  b: [b.signalingState, b.connectionState],
  iceConnected: ['connected', 'completed'].includes(a.iceConnectionState),
};
out.transceivers = { a: directions(a), b: directions(b) };
// What Object.keys (and so a spread or JSON.stringify) sees of an event:
// wrtc's are plain objects, ours WebIDL events with the payload on the
// prototype. Reads and destructuring see the payload in both.
const eventKeys = (e) =>
  Object.keys(e)
    .filter((k) => k !== 'type' && k !== 'target')
    .sort();
const allDefined = (...values) => values.every((value) => value !== undefined);
out.eventShapes = {
  trackKeys: eventKeys(trackEvents[0]),
  icecandidateKeys: eventKeys(firstIceEvent),
  trackDestructures: (({ receiver, streams, track, transceiver }) =>
    allDefined(receiver, streams, track, transceiver))(trackEvents[0]),
  icecandidateDestructures: (({ candidate }) => allDefined(candidate))(firstIceEvent),
};
out.trackEvents = trackEvents.map((e) => ({
  kind: e.track.kind,
  streams: e.streams.map((s) => (s.id === stream.id ? 'the sent stream id' : s.id)),
  trackIsReceiverTrack: e.track === e.receiver.track,
  receiverIsTransceiverReceiver: e.transceiver.receiver === e.receiver,
  isMediaStreamTrack: e.track instanceof w.MediaStreamTrack,
  readyState: e.track.readyState,
}));
// String() so wrtc's undefined survives JSON.
out.remoteTrack = { labels: trackEvents.map((e) => String(e.track.label)) };
const [audioEvent, videoEvent] = trackEvents;
const remoteStream = audioEvent.streams[0];
out.answererTrackEvents = answererTrackEvents.map((e) => ({
  kind: e.track.kind,
  streams: e.streams.map((s) => (s.id === answerStream.id ? 'the sent stream id' : s.id)),
  mid: e.transceiver.mid,
}));
out.remoteStream = {
  sameObjectForBothTracks: videoEvent.streams[0] === remoteStream,
  isMediaStream: remoteStream instanceof MediaStream,
  tracks: remoteStream.getTracks().map((t) => t.kind),
  getReceiversMatch: b.getReceivers().every((r, i) => r === trackEvents[i].receiver),
};

// --- Media through the sinks ------------------------------------------------
const heard = await firstAudio(audioEvent.track);
out.remoteAudio = {
  keys: Object.keys(heard).filter((k) => k !== 'type'),
  samples: heard.samples.constructor.name,
  sampleRate: heard.sampleRate,
  numberOfFrames: heard.numberOfFrames,
  channelCount: heard.channelCount,
  bitsPerSample: heard.bitsPerSample,
};
// Through the stream, as wrtc users often reach the track.
const frame = await firstFrame(remoteStream.getVideoTracks()[0], 320, 240);
out.remoteVideo = {
  keys: Object.keys(frame),
  data: frame.data.constructor.name,
  length: frame.data.length,
  rotation: frame.rotation,
};
out.sinkViaStream = remoteStream.getVideoTracks()[0] === videoEvent.track;
const heardBack = await firstAudio(answererTrackEvents[0].track);
out.reverseAudio = { sampleRate: heardBack.sampleRate, numberOfFrames: heardBack.numberOfFrames };

// --- transports -------------------------------------------------------------
// Both have the (BUNDLEd) DTLS transport, connected by now; wrtc's ICE
// transport throws for the candidate getters.
const audioTransport = audioSender.transport;
/** What `fn()` returns: its type, or what it throws. */
const returned = (fn) => {
  try {
    const value = fn();
    return value === null ? null : Array.isArray(value) ? 'array' : typeof value;
  } catch (error) {
    return `throws ${error.constructor.name}`;
  }
};
const iceTransport = audioTransport?.iceTransport;
out.transports = {
  dtls: audioTransport?.state,
  certificates: audioTransport?.getRemoteCertificates().length,
  ice: ['connected', 'completed'].includes(iceTransport?.state),
  gathering: iceTransport?.gatheringState,
  role: iceTransport?.role,
  component: iceTransport?.component,
  shared:
    videoSender.transport === audioTransport &&
    a.getTransceivers().every((t) => t.receiver.transport === audioTransport),
  candidateGetters: [
    returned(() => iceTransport.getSelectedCandidatePair()),
    returned(() => iceTransport.getLocalCandidates()),
    returned(() => iceTransport.getRemoteCandidates()),
    returned(() => iceTransport.getLocalParameters()),
    returned(() => iceTransport.getRemoteParameters()),
  ],
};

// --- getStats ---------------------------------------------------------------
// Some members appear only once media and RTCP have flowed: framesPerSecond
// after a second of frames, remote-inbound-rtp after a receiver report (and
// its roundTripTime only once that report answers one of our sender
// reports), remote-outbound-rtp after a sender report. Audio's first RTCP
// takes about 2.5 s. Poll both peers until they have them, so the stats
// comparison can hold these members (the ones users poll) to a strict match.
const settled = {
  a: [
    'outbound-rtp/video.framesPerSecond',
    'remote-inbound-rtp/audio.roundTripTime',
    'remote-inbound-rtp/video.roundTripTime',
    'remote-outbound-rtp/audio.id',
    'candidate-pair.currentRoundTripTime',
    'candidate-pair.availableOutgoingBitrate',
  ],
  b: [
    'inbound-rtp/video.framesPerSecond',
    'remote-inbound-rtp/audio.roundTripTime',
    'remote-outbound-rtp/audio.id',
    'candidate-pair.currentRoundTripTime',
    'candidate-pair.availableOutgoingBitrate',
  ],
};
async function statsSettled(pc, name) {
  const deadline = Date.now() + 15_000; // a failure guard
  for (;;) {
    const keys = statsKeys(await pc.getStats());
    const missing = settled[name].filter((path) => {
      const [type, member] = path.split('.');
      return !keys[type]?.includes(member);
    });
    if (missing.length === 0) return;
    if (Date.now() > deadline) throw new Error(`${impl}: ${name}'s stats still lack ${missing}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
await Promise.all([statsSettled(a, 'a'), statsSettled(b, 'b')]);

const report = await a.getStats();
const allStats = [...report.values()];
out.getStats = {
  mapSurface:
    ['get', 'has', 'forEach', 'keys', 'values', 'entries'].every(
      (f) => typeof report[f] === 'function',
    ) && typeof report.size === 'number',
  types: ['peer-connection', 'outbound-rtp', 'transport', 'candidate-pair', 'codec'].filter(
    (type) => allStats.some((s) => s.type === type),
  ),
  entryKeys: ['id', 'type', 'timestamp'].every((k) => k in allStats[0]),
  getById: report.get(allStats[0].id) === allStats[0],
  packetsSent: allStats.some((s) => s.type === 'outbound-rtp' && s.packetsSent > 0),
  frozen: Object.isFrozen(allStats[0]),
};
out.getStatsSelector = await outcome(async () => (await a.getStats(audioTrack)).size > 0);
out.getStatsSelectorTypes = {
  sender: kindsOf(await a.getStats(videoTrack)),
  receiver: kindsOf(await b.getStats(videoEvent.track)),
};
out.statsKeys = { a: statsKeys(await a.getStats()), b: statsKeys(await b.getStats()) };
out.statsEntriesMutable = (() => {
  const entry = report.values().next().value;
  entry.note = 1;
  return entry.note === 1;
})();

// --- replaceTrack -------------------------------------------------------------
const replacing = videoSender.replaceTrack(otherVideoTrack);
out.replaceTrack = {
  senderTrackBeforeAwait: videoSender.track === otherVideoTrack,
  result: await outcome(() => replacing),
  senderTrack: videoSender.track === otherVideoTrack,
  remoteSize: await firstFrame(videoEvent.track, 176, 144).then((f) => [f.width, f.height]),
  wrongKind: await outcome(() => videoSender.replaceTrack(audioSource.createTrack())),
};

// --- removeTrack and renegotiation ------------------------------------------
let removedFromStream = 0;
remoteStream.addEventListener?.('removetrack', () => removedFromStream++);
a.removeTrack(audioSender);
out.removeTrack = { senderTrack: audioSender.track, directionNow: directions(a)[0] };
await negotiate(a, b);
out.removeTrack.afterNegotiation = { a: directions(a)[0], b: directions(b)[0] };
out.removeTrack.senders = a.getSenders().length;

// --- direction ----------------------------------------------------------------
a.getTransceivers()[1].direction = 'inactive';
out.direction = { before: directions(a)[1] };
await negotiate(a, b);
out.direction.after = { a: directions(a)[1], b: directions(b)[1] };

// --- re-adding a removed track ----------------------------------------------------
const readded = next(b, 'track');
const reSender = a.addTrack(audioTrack, stream);
out.reAdd = { newSender: reSender !== audioSender, transceivers: a.getTransceivers().length };
await negotiate(a, b);
const readdedEvent = await readded;
out.reAdd.remoteStreamReused = readdedEvent.streams[0] === remoteStream;
out.reAdd.audio = await firstAudio(readdedEvent.track).then((e) => e.sampleRate);

// --- transceiver.stop() and clones of remote tracks -------------------------------
const remoteTracks = b.getReceivers().map((r) => r.track);
const clones = remoteTracks.map((track) => track.clone());
const readyStates = () => ({
  tracks: remoteTracks.map((t) => t.readyState),
  clones: clones.map((t) => t.readyState),
});
out.stop = { before: readyStates() };
// `ended` events, as 'track <i>' / 'clone <i>' in firing order. Ours fires
// them when a transceiver stops or the PC closes (the spec, Chrome); wrtc
// has no ended events.
const endedEvents = [];
for (const [i, track] of remoteTracks.entries()) {
  track.addEventListener('ended', () => endedEvents.push(`track ${i}`));
}
for (const [i, track] of clones.entries()) {
  track.addEventListener('ended', () => endedEvents.push(`clone ${i}`));
}
const stopped = a.getTransceivers().find((t) => t.sender === reSender);
stopped.stop();
out.stop.local = { direction: stopped.direction, senders: a.getSenders().length };
await negotiate(a, b);
// The track ends in a task queued by the offer's setRemoteDescription.
await new Promise((resolve) => setImmediate(resolve));
out.stop.endedEvents = [...endedEvents];
out.stop.afterNegotiation = {
  ...readyStates(),
  a: directions(a),
  b: directions(b),
  bReceivers: b.getReceivers().length,
};

// --- restartIce -----------------------------------------------------------------
const before = ufrag(a);
const needed = next(a, 'negotiationneeded');
a.restartIce();
await needed;
await negotiate(a, b);
out.restartIce = {
  negotiationneeded: true,
  newUfrag: ufrag(a) !== before,
  signaling: a.signalingState,
};

// --- getConfiguration and errors -------------------------------------------------
const configured = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.example.org:3478' }],
  portRange: { min: 50000, max: 50100 },
});
const config = configured.getConfiguration();
configured.close();
out.getConfiguration = {
  iceServers: config.iceServers,
  iceTransportPolicy: config.iceTransportPolicy,
  bundlePolicy: config.bundlePolicy,
  rtcpMuxPolicy: config.rtcpMuxPolicy,
  iceCandidatePoolSize: config.iceCandidatePoolSize,
  portRange: config.portRange,
  sdpSemantics: config.sdpSemantics,
  certificates: config.certificates,
};
out.errors = {
  createAnswerInStable: await outcome(() => b.createAnswer()),
  srdGarbage: await outcome(() => b.setRemoteDescription({ type: 'offer', sdp: 'garbage' })),
  addIceCandidateUnknownMid: await outcome(() =>
    a.addIceCandidate({
      candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 50000 typ host',
      sdpMid: '9',
    }),
  ),
  portRange: await outcome(() => new RTCPeerConnection({ portRange: { min: 2, max: 1 } })),
  turnWithoutCredentials: await outcome(
    () => new RTCPeerConnection({ iceServers: [{ urls: 'turn:x' }] }),
  ),
};

// Everything up to close(); close()'s own events are recorded separately.
out.signaling = {
  a: logA.filter((e) => e !== 'negotiationneeded'),
  b: logB.filter((e) => e !== 'negotiationneeded'),
  negotiationneededBeforeFirstOffer: logA.indexOf('negotiationneeded') === 0,
};
out.ice = {
  shape: ice.shape,
  sequenceA: [...new Set(ice.a)],
  gatheringAtNull: ice.gatheringAtNull,
  errors: ice.errors,
};
out.remoteStream.removetrackEvents = removedFromStream;
out.remoteStream.tracksAfterRemoval = remoteStream.getTracks().map((t) => t.kind);

// --- close ------------------------------------------------------------------------
const afterClose = [];
for (const type of ['signalingstatechange', 'connectionstatechange', 'iceconnectionstatechange']) {
  a.addEventListener(type, () => afterClose.push(type));
}
const remoteTrack = audioEvent.track;
const heldTransceiver = a.getTransceivers()[1];
a.close();
b.close();
out.close = {
  states: [a.signalingState, a.connectionState, a.iceConnectionState],
  remoteTrackEnded: remoteTrack.readyState,
  getTransceivers: a.getTransceivers().length,
  getSenders: a.getSenders().length,
  createOffer: await outcome(() => a.createOffer()),
  addTransceiver: await outcome(() => a.addTransceiver('audio')),
  restartIce: await outcome(() => a.restartIce()),
  getStats: await outcome(async () => (await a.getStats()).size > 0),
  stopHeldTransceiver: await outcome(() => heldTransceiver.stop()),
};
// Polling as a stats loop would, after close.
const polls = [];
for (let i = 0; i < 3; i++) polls.push(await outcome(async () => (await b.getStats()).size > 0));
out.close.getStatsPolling = polls;
// Ours: close()'s native events were delivered (and dropped) before the
// getStats() above completed, on the same queue. wrtc dispatches its
// close events on process.nextTick from its uv callbacks, a few turns in.
for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
out.close.eventsAfterClose = afterClose;
out.close.remoteTrackEndedAfterTasks = remoteTrack.readyState;
// Ours ends them in a queued task (the spec), so read after the tasks above.
out.close.clones = readyStates();
out.close.endedEvents = endedEvents.slice(out.stop.endedEvents.length);

clearInterval(pump);
for (const sink of sinks) sink.stop();
writeAll(JSON.stringify(out));
// wrtc's own threads keep its process alive; ours must exit on its own
// (two-pc-media.test.ts checks that).
if (impl === 'wrtc') process.exit(0);
