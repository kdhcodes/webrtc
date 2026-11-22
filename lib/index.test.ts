import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import * as ours from './index.ts';

// Loaded in a child process: never load @roamhq/wrtc's libwebrtc and ours
// into the same process.
function wrtcExports(): { top: string[]; nonstandard: string[] } {
  const script = `
    const w = require('@roamhq/wrtc');
    process.stdout.write(JSON.stringify({
      top: Object.keys(w),
      nonstandard: Object.keys(w.nonstandard),
    }));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
}

const wrtc = wrtcExports();

test('every @roamhq/wrtc top-level export exists', () => {
  const missing = wrtc.top.filter((name) => !(name in ours));
  assert.deepEqual(missing, []);
});

test('every @roamhq/wrtc nonstandard export exists', () => {
  const missing = wrtc.nonstandard.filter((name) => !(name in ours.nonstandard));
  assert.deepEqual(missing, []);
});

test('exported values have the same type of value as wrtc', () => {
  // Classes are functions; mediaDevices and nonstandard are objects.
  assert.equal(typeof ours.mediaDevices, 'object');
  assert.equal(typeof ours.getUserMedia, 'function');
  for (const name of wrtc.nonstandard) {
    assert.equal(typeof ours.nonstandard[name as keyof typeof ours.nonstandard], 'function', name);
  }
});

test('the default export is the module namespace, as `import wrtc from` code expects', async () => {
  const module = await import('./index.ts');
  const defaultExport = module.default;
  assert.equal(defaultExport.RTCPeerConnection, module.RTCPeerConnection);
  assert.equal(defaultExport.nonstandard, module.nonstandard);
  const missing = wrtc.top.filter((name) => !(name in defaultExport));
  assert.deepEqual(missing, []);
});

test('wrtc-style subclasses work: RTCPeerConnection and the nonstandard sources and sinks', async (t) => {
  // As @whereby.com/assistant-sdk's polyfills and endpoints write them.
  const { default: wrtc } = await import('./index.ts');
  class PeerConnection extends wrtc.RTCPeerConnection {
    private wrappedGetStats = wrtc.RTCPeerConnection.prototype.getStats.bind(this);
    override async getStats(arg?: unknown) {
      return this.wrappedGetStats(arg instanceof wrtc.MediaStreamTrack ? arg : undefined);
    }
  }
  class AudioSource extends wrtc.nonstandard.RTCAudioSource {}
  class AudioSink extends wrtc.nonstandard.RTCAudioSink {}

  const pc = new PeerConnection();
  t.after(() => pc.close());
  const report = await pc.getStats(null);
  assert.ok(report.size > 0, 'the subclass reaches the native getStats');

  const source = new AudioSource();
  const sink = new AudioSink(source.createTrack());
  t.after(() => sink.stop());
  const data = await new Promise<{ sampleRate: number }>((resolve) => {
    sink.ondata = resolve;
    source.onData({ samples: new Int16Array(480), sampleRate: 48_000 });
  });
  assert.equal(data.sampleRate, 48_000);
});

// node:crypto took about 7 of the 42 ms the package took to import on Linux
// (bench/RESULTS.md), so it's loaded on first use.
test('importing the package does not load node:crypto', () => {
  const script = `
    const before = new Set(process.moduleLoadList);
    await import(${JSON.stringify(new URL('./index.ts', import.meta.url).href)});
    const loaded = process.moduleLoadList.filter((m) => !before.has(m));
    process.stdout.write(JSON.stringify(loaded.filter((m) => m === 'NativeModule crypto')));`;
  const loaded = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    // Failure guard only: the child exits once the import is done.
    timeout: 30_000,
  });
  assert.deepEqual(JSON.parse(loaded), []);
});

test('the exported interfaces have WebIDL property shapes (lib/internal/interface-shape.ts)', async (t) => {
  const { RTCPeerConnection, RTCSessionDescription } = ours;
  const proto = RTCPeerConnection.prototype;
  for (const key of ['createOffer', 'localDescription', 'ontrack']) {
    assert.equal(Object.getOwnPropertyDescriptor(proto, key)?.enumerable, true, key);
  }
  assert.equal(proto.addIceCandidate.length, 0);
  assert.equal(proto.setRemoteDescription.length, 1);
  assert.throws(() => proto.ontrack, TypeError);
  await assert.rejects(Reflect.apply(proto.createOffer, {}, []), TypeError);

  // Instances' own keys are unchanged, so spread and JSON.stringify are too.
  class PeerConnection extends RTCPeerConnection {}
  const pc = new PeerConnection();
  t.after(() => pc.close());
  assert.deepEqual(Object.keys(pc), []);
  const handler = () => {};
  pc.ontrack = handler;
  assert.equal(pc.ontrack, handler, "a subclass instance passes the handler's brand check");
  const description = new RTCSessionDescription({ type: 'offer', sdp: 'v=0' });
  assert.deepEqual({ ...description }, {});
  assert.equal(JSON.stringify(description), '{"type":"offer","sdp":"v=0"}');
});

test("standard events' payloads are enumerable prototype getters, so a spread drops them (not wrtc's own properties)", () => {
  const attributes = {
    RTCTrackEvent: ['receiver', 'track', 'streams', 'transceiver'],
    RTCPeerConnectionIceEvent: ['candidate', 'url'],
    RTCPeerConnectionIceErrorEvent: ['address', 'port', 'url', 'errorCode', 'errorText'],
    RTCDataChannelEvent: ['channel'],
    RTCErrorEvent: ['error'],
    MediaStreamTrackEvent: ['track'],
  } as const;
  for (const [name, keys] of Object.entries(attributes)) {
    const proto = (ours as unknown as Record<string, { prototype: object }>)[name]?.prototype;
    assert.ok(proto instanceof Event, `${name} is an exported Event subclass`);
    for (const key of keys) {
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      assert.equal(typeof desc?.get, 'function', `${name}.${key} is a getter`);
      assert.equal(desc?.enumerable, true, `${name}.${key} is enumerable`);
    }
  }
  const event = new ours.RTCPeerConnectionIceEvent('icecandidate', { url: 'stun:x' });
  assert.equal(event.url, 'stun:x');
  // String keys: a spread also copies Node's Event state, kept under symbols.
  assert.deepEqual(Object.keys({ ...event }), []);
  assert.equal(JSON.stringify(event), '{}');
});
