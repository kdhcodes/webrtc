import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { clockState, colourBars } from './internal/synthetic-media.ts';
import type { MediaStream } from './MediaStream.ts';
import type { MediaStreamTrack } from './MediaStreamTrack.ts';
import { getUserMedia, MediaDeviceInfo, MediaDevices, mediaDevices } from './mediaDevices.ts';
import { type RTCAudioDataEvent, RTCAudioSink } from './nonstandard/RTCAudioSink.ts';
import { type RTCVideoFrameEvent, RTCVideoSink } from './nonstandard/RTCVideoSink.ts';

/** getUserMedia, with every track it returns stopped after the test. */
async function open(t: TestContext, constraints: unknown): Promise<MediaStream> {
  const stream = await getUserMedia(constraints as Parameters<typeof getUserMedia>[0]);
  t.after(() => {
    for (const track of stream.getTracks()) track.stop();
  });
  return stream;
}

/** `'<name>: <message>'` of the rejection, or the kinds of the tracks it resolved with. */
async function outcome(promise: Promise<MediaStream>): Promise<string> {
  try {
    const stream = await promise;
    const kinds = stream.getTracks().map((track) => track.kind);
    for (const track of stream.getTracks()) track.stop();
    return `tracks: ${kinds.join(',')}`;
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

// What @roamhq/wrtc 0.10.0 does with each (probed; test/compat checks it
// against wrtc itself).
test('getUserMedia validates its argument as wrtc does, always by rejecting', async () => {
  const cases: [string, unknown[], string][] = [
    [
      'no argument',
      [],
      'TypeError: getUserMedia: constraints is missing: it must be an object such as {audio: true, video: true}',
    ],
    [
      'undefined',
      [undefined],
      'TypeError: getUserMedia: constraints is missing: it must be an object such as {audio: true, video: true}',
    ],
    [
      'null',
      [null],
      'TypeError: getUserMedia: constraints must be an object such as {audio: true, video: true}, not null',
    ],
    [
      'a string',
      ['audio'],
      'TypeError: getUserMedia: constraints must be an object such as {audio: true, video: true}, not the string "audio"',
    ],
    [
      'a boolean',
      [true],
      'TypeError: getUserMedia: constraints must be an object such as {audio: true, video: true}, not true',
    ],
    [
      '{}',
      [{}],
      'TypeError: getUserMedia: constraints must ask for audio or video (e.g. {audio: true}), but neither constraints.audio nor constraints.video is set',
    ],
    [
      'a function',
      [() => {}],
      'TypeError: getUserMedia: constraints must ask for audio or video (e.g. {audio: true}), but neither constraints.audio nor constraints.video is set',
    ],
    ['audio: false, video: false', [{ audio: false, video: false }], 'tracks: '],
    ['audio: null', [{ audio: null }], 'tracks: '],
    ['audio: "x"', [{ audio: 'x' }], 'tracks: audio'],
    ['audio: 0, video: 1', [{ audio: 0, video: 1 }], 'tracks: video'],
    ['video then audio', [{ video: {}, audio: {} }], 'tracks: audio,video'],
  ];
  for (const [name, args, expected] of cases) {
    let promise: Promise<MediaStream> | undefined;
    assert.doesNotThrow(() => {
      promise = (getUserMedia as (...a: unknown[]) => Promise<MediaStream>)(...args);
    }, name);
    assert.ok(promise instanceof Promise, name);
    assert.equal(await outcome(promise), expected, name);
  }
  assert.equal(clockState().feeds, 0, 'every feed stopped with its tracks');
});

test('getUserMedia rejects with what a throwing constraints getter throws', async () => {
  const error = new Error('boom');
  const constraints = {
    get audio(): boolean {
      throw error;
    },
  };
  await assert.rejects(getUserMedia(constraints), (e) => e === error);
});

test("gUM tracks report wrtc's settings whatever the constraints ask for", async (t) => {
  const stream = await open(t, {
    audio: { sampleRate: 16_000, channelCount: 2, deviceId: { exact: 'nope' } },
    video: { width: { exact: 320 }, height: 240, frameRate: 15, facingMode: 'environment' },
  });
  const [audio] = stream.getAudioTracks();
  const [video] = stream.getVideoTracks();
  assert.deepEqual(audio?.getSettings(), {
    deviceId: 'FakeAudioDevice',
    groupId: 'FakeDeviceGroup',
    autoGainControl: false,
    echoCancellation: false,
    noiseSuppression: false,
    channelCount: 1,
    sampleRate: 48000,
    sampleSize: 16,
    latency: 0,
    volume: 0.25,
  });
  assert.deepEqual(video?.getSettings(), {
    deviceId: 'FakeVideoDevice',
    groupId: 'FakeDeviceGroup',
    height: 480,
    width: 640,
    aspectRatio: 640 / 480,
    frameRate: 30,
    facingMode: 'user',
  });
  assert.equal(stream.active, true);
  assert.deepEqual(
    stream.getTracks().map((track) => [track.kind, track.readyState, track.enabled, track.muted]),
    [
      ['audio', 'live', true, false],
      ['video', 'live', true, false],
    ],
  );
});

test('gUM tracks carry silence and the colour bars in the reported formats', async (t) => {
  const stream = await open(t, { audio: true, video: true });
  const [audio] = stream.getAudioTracks() as [MediaStreamTrack];
  const [video] = stream.getVideoTracks() as [MediaStreamTrack];
  const audioSink = new RTCAudioSink(audio);
  const videoSink = new RTCVideoSink(video);
  t.after(() => {
    audioSink.stop();
    videoSink.stop();
  });
  const [data, { frame }] = await Promise.all([
    new Promise<RTCAudioDataEvent>((resolve) => {
      audioSink.ondata = resolve;
    }),
    new Promise<RTCVideoFrameEvent>((resolve) => {
      videoSink.onframe = resolve;
    }),
  ]);
  assert.deepEqual(
    [data.sampleRate, data.channelCount, data.numberOfFrames, data.bitsPerSample],
    [48000, 1, 480, 16],
  );
  assert.ok(
    data.samples.every((s) => s === 0),
    'audio is digital silence',
  );
  assert.deepEqual([frame.width, frame.height], [640, 480]);
  assert.equal(Buffer.compare(frame.data, colourBars(640, 480)), 0, 'video is the colour bars');
});

test('the generator runs until every track on its source, clones included, has ended', async (t) => {
  const stream = await open(t, { audio: true, video: true });
  const [audio] = stream.getAudioTracks() as [MediaStreamTrack];
  const [video] = stream.getVideoTracks() as [MediaStreamTrack];
  const clone = video.clone();
  const streamClone = stream.clone();
  t.after(() => {
    clone.stop();
    for (const track of streamClone.getTracks()) track.stop();
  });
  assert.equal(clockState().feeds, 2);

  audio.stop();
  assert.equal(clockState().feeds, 2, "the stream clone's audio track still needs the audio feed");
  streamClone.getAudioTracks()[0]?.stop();
  assert.equal(clockState().feeds, 1, 'audio stopped; video still live');

  video.stop();
  video.stop();
  streamClone.getVideoTracks()[0]?.stop();
  assert.equal(clockState().feeds, 1, 'one clone of the video track is still live');
  const lateClone = video.clone();
  assert.equal(lateClone.readyState, 'ended', "a stopped track's clone is ended");
  lateClone.stop();
  assert.equal(clockState().feeds, 1, "an ended clone doesn't count");

  clone.stop();
  assert.deepEqual(clockState(), { feeds: 0, ticking: false });
});

test('each gUM call gets its own source', async (t) => {
  const a = await open(t, { video: true });
  const b = await open(t, { video: true });
  assert.equal(clockState().feeds, 2);
  a.getTracks()[0]?.stop();
  assert.equal(clockState().feeds, 1, "stopping one call's track leaves the other's feed running");
  assert.equal(b.getTracks()[0]?.readyState, 'live');
});

test('unstopped gUM tracks stop their generator once collected, unless a sink holds one', () => {
  const child = fileURLToPath(new URL('./internal/testing/gum-gc-child.ts', import.meta.url));
  const out = execFileSync(process.execPath, ['--expose-gc', child], {
    encoding: 'utf8',
    // Failure guard only: the child exits once its sink is stopped.
    timeout: 30_000,
  });
  assert.deepEqual(JSON.parse(out), {
    before: 3,
    afterGc: 1,
    sinkHeld: 1,
    frame: '640x480',
    afterSinkStop: { feeds: 0, ticking: false },
  });
});

test('gUM tracks are labelled with their device, and clones keep the label', async (t) => {
  const stream = await open(t, { audio: true, video: true });
  const labels = stream.getTracks().map((track) => track.label);
  assert.deepEqual(labels, ['Fake audio device', 'Fake video device']);
  const clone = stream.getVideoTracks()[0]?.clone();
  t.after(() => clone?.stop());
  assert.equal(clone?.label, 'Fake video device');
});

test('enumerateDevices lists the devices gUM tracks come from', async (t) => {
  const devices = await mediaDevices.enumerateDevices();
  assert.ok(devices.every((device) => device instanceof MediaDeviceInfo));
  assert.deepEqual(JSON.parse(JSON.stringify(devices)), [
    {
      deviceId: 'FakeAudioDevice',
      kind: 'audioinput',
      label: 'Fake audio device',
      groupId: 'FakeDeviceGroup',
    },
    {
      deviceId: 'FakeVideoDevice',
      kind: 'videoinput',
      label: 'Fake video device',
      groupId: 'FakeDeviceGroup',
    },
  ]);
  const [audioDevice, videoDevice] = devices;
  assert.deepEqual(
    [audioDevice?.deviceId, audioDevice?.kind, audioDevice?.label, audioDevice?.groupId],
    ['FakeAudioDevice', 'audioinput', 'Fake audio device', 'FakeDeviceGroup'],
    'the getters agree with toJSON()',
  );
  assert.equal(Object.prototype.toString.call(videoDevice), '[object MediaDeviceInfo]');

  const stream = await open(t, { audio: true, video: true });
  const fromTracks = stream.getTracks().map((track) => {
    const { deviceId, groupId } = track.getSettings();
    return { deviceId, groupId, label: track.label };
  });
  assert.deepEqual(
    fromTracks,
    devices.map(({ deviceId, groupId, label }) => ({ deviceId, groupId, label })),
  );
  assert.notEqual(
    (await mediaDevices.enumerateDevices())[0],
    audioDevice,
    'a fresh list each call',
  );
});

test('getDisplayMedia is getUserMedia, as in wrtc', async () => {
  const cases: [unknown[], string][] = [
    [
      [],
      'TypeError: getDisplayMedia: constraints is missing: it must be an object such as {audio: true, video: true}',
    ],
    [
      [{}],
      'TypeError: getDisplayMedia: constraints must ask for audio or video (e.g. {audio: true}), but neither constraints.audio nor constraints.video is set',
    ],
    [[{ video: true }], 'tracks: video'],
    [[{ audio: true }], 'tracks: audio'],
  ];
  const getDisplayMedia = mediaDevices.getDisplayMedia as (...a: unknown[]) => Promise<MediaStream>;
  for (const [args, expected] of cases) {
    assert.equal(await outcome(getDisplayMedia(...args)), expected, JSON.stringify(args));
  }
  assert.equal(clockState().feeds, 0, 'every feed stopped with its tracks');
});

test("getSupportedConstraints is wrtc's {width, height}, fresh each call", () => {
  const { getSupportedConstraints } = mediaDevices;
  const supported = getSupportedConstraints();
  assert.deepEqual(supported, { width: true, height: true });
  assert.notEqual(getSupportedConstraints(), supported);
});

test('MediaDeviceInfo is not constructible', () => {
  const Info = MediaDeviceInfo as unknown as new () => unknown;
  assert.throws(() => new Info(), { name: 'TypeError', message: 'Illegal constructor' });
});

// Regression (WP-V): @whereby.com/assistant-sdk's polyfills build
// navigator.mediaDevices as a plain object holding wrtc's
// `mediaDevices.addEventListener`/`removeEventListener`, and core then calls
// `navigator.mediaDevices.addEventListener('devicechange', ...)` in
// startMedia. wrtc tolerates that; Node's EventTarget threw ERR_INVALID_THIS,
// so startMedia rejected.
test('mediaDevices listener methods work when copied onto another object', () => {
  const navigatorMediaDevices = {
    addEventListener: mediaDevices.addEventListener,
    removeEventListener: mediaDevices.removeEventListener,
  };
  let calls = 0;
  const listener = () => calls++;

  navigatorMediaDevices.addEventListener('devicechange', listener);
  mediaDevices.dispatchEvent(new Event('devicechange'));
  navigatorMediaDevices.removeEventListener('devicechange', listener);
  mediaDevices.dispatchEvent(new Event('devicechange'));

  assert.equal(calls, 1, 'the detached listener registers on mediaDevices and is removed again');
});

test('getUserMedia and enumerateDevices work when copied off mediaDevices', async (t) => {
  const { getUserMedia: detachedGum, enumerateDevices } = mediaDevices;
  const navigatorMediaDevices = { getUserMedia: detachedGum, enumerateDevices };
  const stream = await detachedGum({ audio: true });
  t.after(() => {
    for (const track of stream.getTracks()) track.stop();
  });
  assert.deepEqual(
    stream.getTracks().map((track) => track.kind),
    ['audio'],
  );
  const kinds = (await enumerateDevices()).map((device) => device.kind);
  assert.deepEqual(kinds, ['audioinput', 'videoinput']);
  assert.equal((await navigatorMediaDevices.enumerateDevices()).length, 2);
  await assert.rejects(navigatorMediaDevices.getUserMedia({}), {
    name: 'TypeError',
    message:
      'getUserMedia: constraints must ask for audio or video (e.g. {audio: true}), but neither constraints.audio nor constraints.video is set',
  });
});

test("the mediaDevices singleton's bound methods come from the WebIDL-shaped prototype", () => {
  for (const name of ['getUserMedia', 'enumerateDevices', 'getSupportedConstraints'] as const) {
    assert.equal(mediaDevices[name].length, MediaDevices.prototype[name].length, name);
  }
  // The IDL's: `getUserMedia(optional MediaStreamConstraints constraints = {})`.
  assert.equal(mediaDevices.getUserMedia.length, 0);
  assert.equal(
    Object.getOwnPropertyDescriptor(MediaDevices.prototype, 'getUserMedia')?.enumerable,
    true,
  );
});

test('each MediaDevices binds its methods to itself, keeping subclass overrides', async () => {
  const seen: string[] = [];
  class Devices extends MediaDevices {
    override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
      seen.push(args[0]);
      super.addEventListener(...args);
    }
    override async enumerateDevices(): Promise<MediaDeviceInfo[]> {
      seen.push(this instanceof Devices ? 'enumerate on the instance' : 'enumerate unbound');
      return super.enumerateDevices();
    }
  }
  const a = new Devices();
  const b = new MediaDevices();
  const { addEventListener, enumerateDevices } = a;
  let calls = 0;

  addEventListener('devicechange', () => calls++);
  b.dispatchEvent(new Event('devicechange'));
  a.dispatchEvent(new Event('devicechange'));
  await enumerateDevices();

  assert.deepEqual(seen, ['devicechange', 'enumerate on the instance']);
  assert.equal(calls, 1, 'the listener is on `a` only');
});
