// Spike: two in-process peer connections, a data channel round trip, getStats,
// and a clean process exit after close().
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PeerConnection } = require('../../build/Release/wrtc.node');

const t0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - t0) / 1000).toFixed(3)}s]`, ...a);

let a, b;
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), 15000);
  const channels = new Map();
  // Candidates are buffered until both sides have finished offer/answer.
  const pending = { a: [], b: [] };
  let negotiated = false;
  const trickle = (target, key, c) => {
    if (negotiated) target.addIceCandidate(c).catch(reject);
    else pending[key].push(c);
  };
  const logEvent = (name, ev) => {
    if (ev.kind === 'dc:message' || ev.kind === 'dc:bufferedamount') return;
    log(
      name,
      ev.kind,
      ev.state ?? ev.candidate?.candidate.split(' ').slice(4, 8).join(' ') ?? ev.channelKey ?? '',
    );
  };

  a = new PeerConnection({ iceServers: [] }, (ev) => {
    logEvent('A', ev);
    if (ev.kind === 'icecandidate') trickle(b, 'b', ev.candidate);
    if (ev.kind === 'dc:state' && ev.state === 'open') {
      channels.get(ev.channelKey).send(Buffer.from('ping'), false);
    }
    if (ev.kind === 'dc:message') {
      log('A got', ev.data.toString());
      clearTimeout(timer);
      resolve();
    }
  });
  b = new PeerConnection({ iceServers: [] }, (ev) => {
    logEvent('B', ev);
    if (ev.kind === 'icecandidate') trickle(a, 'a', ev.candidate);
    if (ev.kind === 'datachannel') channels.set(ev.channelKey, ev.channel);
    if (ev.kind === 'dc:message') {
      log('B got', ev.data.toString());
      channels.get(ev.channelKey).send(Buffer.from('pong'), false);
    }
  });

  const dc = a.createDataChannel('ping', { ordered: true });
  channels.set(dc.key, dc);

  (async () => {
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    log('signaling', a.signalingState, b.signalingState);
    negotiated = true;
    for (const c of pending.a) await a.addIceCandidate(c);
    for (const c of pending.b) await b.addIceCandidate(c);
  })().catch(reject);
});

try {
  await done;
  const stats = JSON.parse(await a.getStats());
  const types = [...new Set(Object.values(stats).map((s) => s.type))].sort();
  log('stats types', types.join(', '));
  log('PASS');
} finally {
  a.close();
  b.close();
  log('closed; process should exit now');
}
