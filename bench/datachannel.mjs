#!/usr/bin/env node
// Data channel throughput harness. No dependencies beyond the repo's own
// devDependencies (@roamhq/wrtc and Playwright, each loaded only when used).
//
// One sender and one receiver peer connection, a single data channel from
// sender to receiver, host candidates only (no STUN/TURN). The sender sends
// for --duration seconds, then waits for its queue to drain; the receiver
// times first to last message. Prints MiB/s and messages/s (receiver side),
// a 100 ms timeline of received bytes (stalls show up as runs of zeros), and
// libwebrtc's data-channel / transport / candidate-pair stats deltas.
//
//   node bench/datachannel.mjs [options]
//
//   --sender ours|wrtc|chrome|firefox    sender (default ours)
//   --receiver ours|wrtc|chrome|firefox  receiver (default: --sender)
//   --topology same|proc|remote   where the receiver runs (default same):
//       same    both peers in this process (Node peers must then be the same
//               implementation); two browser peers of one kind share a page
//       proc    a Node receiver runs in a child process, signaling over its
//               stdin/stdout; a browser receiver gets its own browser
//               context (and page) apart from a browser sender's
//       remote  the receiver runs the command given by --remote-cmd (e.g.
//               over ssh), which must run `node bench/datachannel.mjs
//               --serve`; signaling over its stdin/stdout
//   --remote-cmd CMD              shell command for --topology remote
//   --size N                      message size in bytes; k/m suffixes (64k)
//   --strategy burst|one          burst (default): send until bufferedAmount
//                                 reaches --high, then wait for
//                                 bufferedamountlow at --low. one: send one
//                                 message, wait for bufferedamountlow at 0.
//   --high N --low N              burst watermarks (default 1m / 256k)
//   --unordered                   unordered channel (default ordered)
//   --duration S                  seconds of sending (default 5)
//   --poll MS                     while waiting for bufferedamountlow, also
//                                 recheck bufferedAmount every MS ms (needed
//                                 for @roamhq/wrtc, whose event doesn't fire)
//   --candidates REGEX            only signal ICE candidates matching REGEX
//                                 (e.g. ' 192\.168\.' to force the LAN)
//   --timeout S                   abort the whole run after S seconds
//                                 (default: --duration + 60)
//   --json                        print the full result as JSON
//   --debug                       log each peer's setup steps and states
//
// Browser peers run in Playwright: Chromium (the headless shell;
// INTEROP_CHANNEL=chromium for full Chromium, =chrome for an installed
// Chrome, as in test/interop) uses dcSCTP like us, Firefox uses usrsctp.
// Both are launched with mDNS host candidates off, so --candidates can pin
// their candidates too.
//
// A run that spanned a system sleep (the wall clock got ahead of the
// monotonic one) is flagged invalid; on macOS `caffeinate` keeps the machine
// awake while this runs. A child receiver exits when its stdin closes, so
// it never outlives the driver (or a dropped ssh connection).
//
// Never loads our addon and @roamhq/wrtc into the same process: a run that
// would need both in one process is refused.

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// The peer. Self-contained (no closures over module scope), because it is
// also injected into browser pages as source text.

async function runPeer(env) {
  const { RTCPeerConnection, role, opts, signal, onSignal, log } = env;
  const now = () => performance.now();
  const MAX_DRAIN_MS = 30000;
  const RECEIVE_GRACE_MS = 15000;

  const pc = new RTCPeerConnection({ iceServers: [] });
  const debug = opts.debug ? (...a) => log(`${role}:`, ...a) : () => {};
  pc.addEventListener('connectionstatechange', () => debug('connection', pc.connectionState));
  pc.addEventListener('iceconnectionstatechange', () => debug('ice', pc.iceConnectionState));
  const candidateFilter = opts.candidates ? new RegExp(opts.candidates) : null;
  const pendingCandidates = [];
  let remoteSet = false;
  const peerMessages = [];
  let peerWaiter = null;
  const nextPeerMessage = (type) =>
    new Promise((resolve) => {
      const check = () => {
        const i = peerMessages.findIndex((m) => m.t === type);
        if (i >= 0) {
          const [m] = peerMessages.splice(i, 1);
          peerWaiter = null;
          resolve(m);
          return true;
        }
        return false;
      };
      if (!check()) peerWaiter = check;
    });

  onSignal(async (msg) => {
    if (msg.t === 'ice') {
      if (remoteSet) await pc.addIceCandidate(msg.c);
      else pendingCandidates.push(msg.c);
      return;
    }
    peerMessages.push(msg);
    if (peerWaiter) peerWaiter();
  });

  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const c = typeof e.candidate.toJSON === 'function' ? e.candidate.toJSON() : e.candidate;
    if (!c.candidate) return;
    if (candidateFilter && !candidateFilter.test(c.candidate)) return;
    debug('candidate', c.candidate);
    signal({
      t: 'ice',
      c: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex },
    });
  };

  const applyRemote = async (desc) => {
    await pc.setRemoteDescription(desc);
    remoteSet = true;
    for (const c of pendingCandidates.splice(0)) await pc.addIceCandidate(c);
  };

  const pickStats = async () => {
    const report = await pc.getStats();
    const all = [];
    const values = typeof report.values === 'function' ? report.values() : Object.values(report);
    for (const s of values) all.push(s);
    const byId = new Map(all.map((s) => [s.id, s]));
    const pick = (s, keys) => {
      const o = { type: s.type };
      for (const k of keys) if (s[k] !== undefined) o[k] = s[k];
      return o;
    };
    const out = { dataChannel: null, transport: null, pair: null, local: null, remote: null };
    let pair = null;
    for (const s of all) {
      if (s.type === 'data-channel' && s.label === 'bench') {
        out.dataChannel = pick(s, [
          'state',
          'messagesSent',
          'bytesSent',
          'messagesReceived',
          'bytesReceived',
        ]);
      }
      if (s.type === 'transport') {
        out.transport = pick(s, [
          'bytesSent',
          'bytesReceived',
          'packetsSent',
          'packetsReceived',
          'dtlsState',
          'selectedCandidatePairId',
          'selectedCandidatePairChanges',
        ]);
        pair = byId.get(s.selectedCandidatePairId) ?? null;
      }
    }
    // Firefox has no 'transport' stats; it marks the pair in use `selected`.
    pair ??= all.find(
      (s) =>
        s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded')),
    );
    if (pair) {
      out.pair = pick(pair, [
        'state',
        'nominated',
        'currentRoundTripTime',
        'totalRoundTripTime',
        'availableOutgoingBitrate',
        'bytesSent',
        'bytesReceived',
        'packetsSent',
        'packetsReceived',
        'packetsDiscardedOnSend',
        'bytesDiscardedOnSend',
        'requestsSent',
        'responsesReceived',
      ]);
      const cand = (id) => {
        const c = byId.get(id);
        return c
          ? `${c.candidateType} ${c.protocol} ${c.address ?? c.ip}:${c.port}${c.networkType ? ` (${c.networkType})` : ''}`
          : null;
      };
      out.local = cand(pair.localCandidateId);
      out.remote = cand(pair.remoteCandidateId);
    }
    return out;
  };

  const waitFor = (target, type, ms) =>
    new Promise((resolve) => {
      let timer = null;
      const done = (v) => {
        target.removeEventListener(type, handler);
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      const handler = () => done(true);
      target.addEventListener(type, handler);
      if (ms !== undefined) timer = setTimeout(() => done(false), Math.max(0, ms));
    });

  if (role === 'sender') {
    const dc = pc.createDataChannel('bench', { ordered: !opts.unordered });
    dc.binaryType = 'arraybuffer';
    const opened = dc.readyState === 'open' ? Promise.resolve() : waitFor(dc, 'open', 30000);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal({ t: 'sdp', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    debug('offer sent');
    const answer = await nextPeerMessage('sdp');
    await applyRemote(answer.sdp);
    debug('answer applied; waiting for open');
    await opened;
    debug('open; waiting for the receiver');
    if (dc.readyState !== 'open') throw new Error(`channel did not open (${dc.readyState})`);
    await nextPeerMessage('ready');
    const before = await pickStats();
    debug('sending');

    const payload = new Uint8Array(opts.size);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const one = opts.strategy === 'one';
    const high = one ? 1 : opts.high;
    const low = one ? 0 : opts.low;
    dc.bufferedAmountLowThreshold = low;
    let messages = 0;
    let waits = 0;
    let waitMs = 0;
    let maxBuffered = 0;
    const t0 = now();
    const end = t0 + opts.duration * 1000;
    while (now() < end && dc.readyState === 'open') {
      while (dc.bufferedAmount < high && dc.readyState === 'open') {
        dc.send(payload);
        messages++;
        if (now() >= end) break;
      }
      if (dc.bufferedAmount > maxBuffered) maxBuffered = dc.bufferedAmount;
      if (now() >= end) break;
      if (dc.bufferedAmount > low) {
        const w0 = now();
        waits++;
        if (opts.poll) {
          // For implementations whose bufferedamountlow is unreliable (wrtc).
          while (dc.bufferedAmount > low && now() < end) {
            await waitFor(dc, 'bufferedamountlow', Math.min(opts.poll, end - now()));
          }
        } else {
          await waitFor(dc, 'bufferedamountlow', end - now());
        }
        waitMs += now() - w0;
      }
    }
    const sendLoopMs = now() - t0;
    debug(`sent ${messages} messages; draining ${dc.bufferedAmount} bytes`);
    // Drain: everything handed to SCTP (bufferedAmount 0).
    if (dc.bufferedAmount > 0) {
      dc.bufferedAmountLowThreshold = 0;
      const drainEnd = now() + MAX_DRAIN_MS;
      do {
        await waitFor(
          dc,
          'bufferedamountlow',
          Math.min(opts.poll || MAX_DRAIN_MS, drainEnd - now()),
        );
      } while (dc.bufferedAmount > 0 && now() < drainEnd);
    }
    const drainedMs = now() - t0;
    debug(`drained after ${Math.round(drainedMs)} ms, ${dc.bufferedAmount} bytes left`);
    const bytes = messages * opts.size;
    signal({ t: 'sent', messages, bytes });
    const fin = await nextPeerMessage('fin');
    const after = await pickStats();
    dc.close();
    pc.close();
    return {
      role,
      messages,
      bytes,
      sendLoopMs,
      drainedMs,
      waits,
      waitMs,
      maxBuffered,
      residualBuffered: dc.bufferedAmount,
      ackedByReceiver: fin.received,
      before,
      after,
    };
  }

  // Receiver.
  let dc = null;
  let received = 0;
  let receivedBytes = 0;
  let first = 0;
  let last = 0;
  const BUCKET_MS = 100;
  const buckets = [];
  // Exact lengths of the pauses between consecutive messages of >= GAP_MS.
  const GAP_MS = 50;
  const gaps = [];
  let expected = null;
  let finish = null;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  const maybeFinish = () => {
    if (expected && received >= expected.messages) finish('complete');
  };
  let channelOpen = null;
  const channelOpened = new Promise((resolve) => {
    channelOpen = resolve;
  });
  pc.ondatachannel = (e) => {
    dc = e.channel;
    dc.binaryType = 'arraybuffer';
    if (dc.readyState === 'open') channelOpen();
    else dc.onopen = () => channelOpen();
    dc.onmessage = (m) => {
      const t = now();
      if (received === 0) first = t;
      else if (t - last >= GAP_MS) gaps.push(Math.round(t - last));
      last = t;
      received++;
      const n = typeof m.data === 'string' ? m.data.length : m.data.byteLength;
      receivedBytes += n;
      const b = Math.floor((t - first) / BUCKET_MS);
      while (buckets.length <= b) buckets.push(0);
      buckets[b] += n;
      maybeFinish();
    };
  };
  const offer = await nextPeerMessage('sdp');
  await applyRemote(offer.sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signal({ t: 'sdp', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
  // Wait for the channel, then take the "before" stats and tell the sender.
  // (Setup that never completes is ended by the driver's --timeout.)
  debug('answer sent; waiting for the channel');
  await channelOpened;
  debug('channel open');
  const before = await pickStats();
  debug('stats read; ready');
  signal({ t: 'ready' });
  expected = await nextPeerMessage('sent');
  maybeFinish();
  const how = await Promise.race([
    finished,
    new Promise((r) => setTimeout(() => r('timeout'), RECEIVE_GRACE_MS)),
  ]);
  if (how !== 'complete') log(`receiver: ${how}, got ${received} of ${expected.messages}`);
  const after = await pickStats();
  signal({ t: 'fin', received });
  // Let the sender read its stats before the association goes away.
  await new Promise((r) => setTimeout(r, 200));
  pc.close();
  const elapsedMs = last - first;
  return {
    role,
    messages: received,
    bytes: receivedBytes,
    expectedMessages: expected.messages,
    elapsedMs,
    // Wall clock of the first message, to line up with outside samplers.
    firstEpochMs: performance.timeOrigin + first,
    timelineBucketMs: BUCKET_MS,
    timeline: buckets,
    gaps,
    before,
    after,
  };
}

// ---------------------------------------------------------------------------
// Options

const BROWSERS = ['chrome', 'firefox'];
const isBrowser = (impl) => BROWSERS.includes(impl);

function parseSize(v) {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(String(v));
  if (!m) throw new Error(`bad size: ${v}`);
  const mult = { '': 1, k: 1024, K: 1024, m: 1024 * 1024, M: 1024 * 1024 }[m[2]];
  return Math.round(Number(m[1]) * mult);
}

function parseArgs(argv) {
  const o = {
    sender: 'ours',
    receiver: null,
    topology: 'same',
    remoteCmd: null,
    size: 64 * 1024,
    strategy: 'burst',
    high: 1024 * 1024,
    low: 256 * 1024,
    unordered: false,
    duration: 5,
    candidates: null,
    poll: 0,
    timeout: null,
    json: false,
    debug: false,
    serve: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--sender':
        o.sender = val();
        break;
      case '--receiver':
        o.receiver = val();
        break;
      case '--topology':
        o.topology = val();
        break;
      case '--remote-cmd':
        o.remoteCmd = val();
        break;
      case '--size':
        o.size = parseSize(val());
        break;
      case '--strategy':
        o.strategy = val();
        break;
      case '--high':
        o.high = parseSize(val());
        break;
      case '--low':
        o.low = parseSize(val());
        break;
      case '--unordered':
        o.unordered = true;
        break;
      case '--duration':
        o.duration = Number(val());
        break;
      case '--poll':
        o.poll = Number(val());
        break;
      case '--candidates':
        o.candidates = val();
        break;
      case '--timeout':
        o.timeout = Number(val());
        break;
      case '--json':
        o.json = true;
        break;
      case '--debug':
        o.debug = true;
        break;
      case '--serve':
        o.serve = true;
        break;
      default:
        throw new Error(`unknown option ${a}`);
    }
  }
  o.receiver ??= o.sender;
  o.timeout ??= o.duration + 60;
  // Everything is checked here, before any peer connection or process exists.
  for (const impl of [o.sender, o.receiver]) {
    if (!['ours', 'wrtc', ...BROWSERS].includes(impl)) {
      throw new Error(`unknown implementation ${impl}`);
    }
  }
  if (!['same', 'proc', 'remote'].includes(o.topology)) {
    throw new Error(`bad topology ${o.topology}`);
  }
  if (!['burst', 'one'].includes(o.strategy)) throw new Error(`bad strategy ${o.strategy}`);
  if (!(o.duration > 0) || !(o.timeout > o.duration)) {
    throw new Error('--duration must be positive and --timeout longer than it');
  }
  if (o.topology === 'remote') {
    if (!o.remoteCmd) throw new Error('--topology remote needs --remote-cmd');
    if (isBrowser(o.sender) || isBrowser(o.receiver)) {
      throw new Error('--topology remote needs Node peers on both ends');
    }
  }
  if (
    o.topology === 'same' &&
    !isBrowser(o.sender) &&
    !isBrowser(o.receiver) &&
    o.sender !== o.receiver
  ) {
    throw new Error('same topology with two different Node implementations would load both addons');
  }
  return o;
}

/** The options the peers see. */
function peerOpts(o) {
  const { size, strategy, high, low, unordered, duration, candidates, poll, debug } = o;
  return { size, strategy, high, low, unordered, duration, candidates, poll, debug };
}

async function loadImpl(impl) {
  if (impl === 'ours') return (await import('../lib/index.ts')).RTCPeerConnection;
  if (impl === 'wrtc') return createRequire(import.meta.url)('@roamhq/wrtc').RTCPeerConnection;
  throw new Error(`not a Node implementation: ${impl}`);
}

const log = (...a) => console.error('[bench]', ...a);

/**
 * This machine's count of UDP datagrams dropped because a socket's receive
 * buffer was full, or null where unknown. System-wide, so it includes any
 * other UDP traffic on the machine.
 */
function udpBufferDrops() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('netstat', ['-s', '-p', 'udp'], { encoding: 'utf8' });
      const m = /(\d+) dropped due to full socket buffers/.exec(out);
      return m ? Number(m[1]) : null;
    }
    if (process.platform === 'linux') {
      const lines = readFileSync('/proc/net/snmp', 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('Udp:'));
      const keys = lines[0].split(/\s+/);
      const vals = lines[1].split(/\s+/);
      const v4 = Number(vals[keys.indexOf('RcvbufErrors')]);
      // IPv6 sockets (e.g. wrtc's ::1 pairs) are counted separately.
      const m = /^Udp6RcvbufErrors\s+(\d+)/m.exec(readFileSync('/proc/net/snmp6', 'utf8'));
      return v4 + (m ? Number(m[1]) : 0);
    }
  } catch {}
  return null;
}

/**
 * Keeps a Mac awake for as long as this process lives (as bench/run.mjs
 * does): `caffeinate -w` exits with us. True if it started.
 */
function keepAwake() {
  if (process.platform !== 'darwin') return false;
  try {
    const keeper = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    keeper.on('error', () => {});
    keeper.unref();
    return keeper.pid !== undefined;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Endpoints. Each runs one peer and exposes { send(msg), emit(msg), result }:
// send delivers a signaling message to the peer, emit passes one from it on
// (queued until connect()).

function newEndpoint() {
  const ep = { onMessage: null, outbox: [] };
  ep.emit = (msg) => {
    if (ep.onMessage) ep.onMessage(msg);
    else ep.outbox.push(msg);
  };
  return ep;
}

/** A peer in this process. */
function localEndpoint(RTCPeerConnection, role, opts) {
  const ep = Object.assign(newEndpoint(), { handler: null, queue: [] });
  ep.send = (msg) => {
    // Async, as over a real signaling channel.
    queueMicrotask(() => {
      if (ep.handler) ep.handler(msg);
      else ep.queue.push(msg);
    });
  };
  ep.result = runPeer({
    RTCPeerConnection,
    role,
    opts,
    log,
    signal: (msg) => ep.emit(msg),
    onSignal: (h) => {
      ep.handler = (m) => Promise.resolve(h(m)).catch((e) => log('signal handler', e));
      for (const m of ep.queue.splice(0)) ep.handler(m);
    },
  });
  return ep;
}

/** Child processes still running; ended by stopChildren(). */
const children = new Set();

/**
 * Ends every child: closing its stdin makes a `--serve` peer exit (and makes
 * ssh close the remote one's), and the signal stops the process group (the
 * shell of --remote-cmd and whatever it started).
 */
function stopChildren() {
  for (const child of children) {
    try {
      child.stdin.end();
    } catch {}
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
  children.clear();
}

/** A peer in a child process (or across ssh), JSON lines over stdin/stdout. */
function childEndpoint(command, args, impl, role, opts) {
  // Its own process group, so stopChildren() reaches the whole tree.
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], detached: true });
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.stdin.on('error', () => {});
  const ep = newEndpoint();
  ep.send = (msg) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  ep.result = new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log('child:', line);
        return;
      }
      if (msg.t === 'result') resolve(msg.result);
      else if (msg.t === 'error') reject(new Error(`child: ${msg.message}`));
      else ep.emit(msg);
    });
    child.on('exit', (code, sig) => reject(new Error(`child exited (${sig ?? code})`)));
    child.on('error', reject);
  });
  ep.result.finally(() => child.stdin.end()).catch(() => {});
  ep.send({ t: 'config', impl, role, opts });
  return ep;
}

/** A peer in a browser page. */
async function pageEndpoint(page, role, opts) {
  const id = `p${Math.random().toString(36).slice(2)}`;
  const ep = newEndpoint();
  await page.exposeFunction(`__benchSignal_${id}`, (msg) => ep.emit(msg));
  ep.send = (msg) =>
    page
      .evaluate(([i, m]) => globalThis.__benchDeliver[i](m), [id, msg])
      .catch((e) => log('page send', e.message));
  await page.evaluate(
    ([i, src, role, opts]) => {
      globalThis.__benchDeliver ??= {};
      globalThis.__benchResults ??= {};
      globalThis.__benchQueue ??= {};
      globalThis.__benchQueue[i] = [];
      globalThis.__benchDeliver[i] = (m) => globalThis.__benchQueue[i].push(m);
      // The peer's source text, compiled in the page.
      const run = new Function(`return (${src})`)();
      globalThis.__benchResults[i] = run({
        RTCPeerConnection: globalThis.RTCPeerConnection,
        role,
        opts,
        log: (...a) => console.log(...a),
        signal: (m) => globalThis[`__benchSignal_${i}`](m),
        onSignal: (h) => {
          globalThis.__benchDeliver[i] = (m) =>
            Promise.resolve(h(m)).catch((e) => console.error(e));
          for (const m of globalThis.__benchQueue[i].splice(0)) globalThis.__benchDeliver[i](m);
        },
      });
    },
    [id, runPeer.toString(), role, opts],
  );
  ep.result = page.evaluate((i) => globalThis.__benchResults[i], id);
  return ep;
}

// ---------------------------------------------------------------------------
// Driver

function connect(a, b) {
  a.onMessage = (m) => b.send(m);
  b.onMessage = (m) => a.send(m);
  for (const m of a.outbox.splice(0)) b.send(m);
  for (const m of b.outbox.splice(0)) a.send(m);
}

/** Launches a browser for `impl` with mDNS host candidates off. */
async function launchBrowser(impl) {
  const { chromium, firefox } = await import('playwright');
  if (impl === 'firefox') {
    return firefox.launch({
      headless: true,
      // A Firefox other than the one this Playwright version downloads.
      ...(process.env.FIREFOX_PATH ? { executablePath: process.env.FIREFOX_PATH } : {}),
      firefoxUserPrefs: {
        'media.peerconnection.ice.obfuscate_host_addresses': false,
        'media.peerconnection.ice.loopback': true,
        // Gather on every interface, not only the default route's (a VPN's).
        'media.peerconnection.ice.default_address_only': false,
        // e.g. en0: Firefox gathers on that interface only.
        ...(process.env.FIREFOX_ICE_INTERFACE
          ? { 'media.peerconnection.ice.force_interface': process.env.FIREFOX_ICE_INTERFACE }
          : {}),
        'media.navigator.permission.disabled': true,
        'media.navigator.streams.fake': true,
      },
    });
  }
  return chromium.launch({
    headless: true,
    // As in test/interop: 'chromium' runs full Chromium (new headless)
    // rather than the headless shell, 'chrome' an installed Chrome.
    ...(process.env.INTEROP_CHANNEL ? { channel: process.env.INTEROP_CHANNEL } : {}),
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
}

async function drive(o) {
  const opts = peerOpts(o);
  const browsers = new Map();
  const pages = new Map();

  const pageFor = async (impl, index) => {
    const key = `${impl}:${index}`;
    if (!pages.has(key)) {
      if (!browsers.has(impl)) browsers.set(impl, await launchBrowser(impl));
      const context = await browsers.get(impl).newContext();
      const page = await context.newPage();
      page.on('console', (m) => log(`${impl} page:`, m.text()));
      if (impl === 'firefox') {
        // Firefox gathers host candidates only on the default route's
        // interface (here a VPN's) unless the page holds a capture grant:
        // keep a fake microphone stream open. getUserMedia needs a secure
        // context, which about:blank isn't; localhost is (served by
        // Playwright, nothing listens there).
        await page.route('http://localhost/', (route) =>
          route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>bench</title>' }),
        );
        await page.goto('http://localhost/');
        await page.evaluate(async () => {
          globalThis.__benchCapture = await navigator.mediaDevices.getUserMedia({ audio: true });
        });
      } else {
        await page.goto('about:blank');
      }
      pages.set(key, page);
    }
    return pages.get(key);
  };

  const run = async () => {
    let senderEp;
    let receiverEp;
    if (isBrowser(o.sender)) {
      senderEp = await pageEndpoint(await pageFor(o.sender, 0), 'sender', opts);
    } else {
      senderEp = localEndpoint(await loadImpl(o.sender), 'sender', opts);
    }
    if (isBrowser(o.receiver)) {
      const sharePage = o.sender === o.receiver && o.topology === 'same';
      receiverEp = await pageEndpoint(
        await pageFor(o.receiver, sharePage ? 0 : 1),
        'receiver',
        opts,
      );
    } else if (o.topology === 'same') {
      receiverEp = localEndpoint(await loadImpl(o.receiver), 'receiver', opts);
    } else if (o.topology === 'proc') {
      const args = [THIS_FILE, '--serve'];
      receiverEp = childEndpoint(process.execPath, args, o.receiver, 'receiver', opts);
    } else {
      receiverEp = childEndpoint('/bin/sh', ['-c', o.remoteCmd], o.receiver, 'receiver', opts);
    }
    connect(senderEp, receiverEp);
    const drops0 = udpBufferDrops();
    const [sender, receiver] = await Promise.all([senderEp.result, receiverEp.result]);
    const drops1 = udpBufferDrops();
    const udpDrops = drops0 === null || drops1 === null ? null : drops1 - drops0;
    return { config: o, sender, receiver, udpBufferDrops: udpDrops };
  };

  // Wall clock vs monotonic clock: the monotonic one stops while the machine
  // sleeps, so a difference flags a run that spanned a sleep.
  const wallStart = Date.now();
  const monoStart = performance.now();
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`run exceeded --timeout ${o.timeout} s`)),
      o.timeout * 1000,
    );
  });
  try {
    const result = await Promise.race([run(), deadline]);
    result.sleepDriftMs = Math.round(Date.now() - wallStart - (performance.now() - monoStart));
    return result;
  } finally {
    clearTimeout(timer);
    stopChildren();
    // Bounded: a browser can take a long time to close after a failed run.
    const closing = [...browsers.values()].map((b) => b.close().catch(() => {}));
    await Promise.race([Promise.all(closing), new Promise((r) => setTimeout(r, 5000))]);
  }
}

/** Child mode: one peer, configured and signaled over stdin/stdout. */
async function serve() {
  const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin });
  let handler = null;
  const queue = [];
  let configured;
  let answered = false;
  const config = new Promise((r) => {
    configured = r;
  });
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.t === 'config') configured(msg);
    else if (handler) handler(msg);
    else queue.push(msg);
  });
  // The driver went away (it finished, was killed, or ssh dropped): an open
  // peer connection would otherwise keep this process alive forever.
  rl.on('close', () => {
    if (!answered) {
      log('serve: stdin closed before the run finished; exiting');
      process.exit(1);
    }
  });
  const { impl, role, opts } = await config;
  try {
    const RTCPeerConnection = await loadImpl(impl);
    const drops0 = udpBufferDrops();
    const result = await runPeer({
      RTCPeerConnection,
      role,
      opts,
      log,
      signal: out,
      onSignal: (h) => {
        handler = (m) => Promise.resolve(h(m)).catch((e) => log('signal handler', e));
        for (const m of queue.splice(0)) handler(m);
      },
    });
    const drops1 = udpBufferDrops();
    result.udpBufferDrops = drops0 === null || drops1 === null ? null : drops1 - drops0;
    answered = true;
    out({ t: 'result', result });
  } catch (e) {
    answered = true;
    out({ t: 'error', message: String(e?.stack ?? e) });
  }
  rl.close();
}

// ---------------------------------------------------------------------------
// Report

function delta(after, before, key) {
  const a = after?.[key];
  const b = before?.[key];
  return typeof a === 'number' && typeof b === 'number' ? a - b : null;
}

/** Packet and byte counters: the transport's, else (Firefox) the pair's. */
const counters = (stats) => stats.transport ?? stats.pair;

function summarize(r) {
  const { config: o, sender: s, receiver: rx } = r;
  const MiB = 1024 * 1024;
  // The longer of the receiver's first-to-last span and the sender's send
  // loop: a sender stuck waiting for bufferedamountlow shows up as a short
  // receiver span, a receiver lagging behind as a long one.
  const secs = Math.max(rx.elapsedMs, s.sendLoopMs) / 1000;
  const mibps = secs > 0 ? rx.bytes / MiB / secs : 0;
  const msgps = secs > 0 ? rx.messages / secs : 0;
  const sPkts = delta(counters(s.after), counters(s.before), 'packetsSent');
  const rPkts = delta(counters(rx.after), counters(rx.before), 'packetsReceived');
  const sBytes = delta(counters(s.after), counters(s.before), 'bytesSent');
  const dcBytes = delta(s.after.dataChannel, s.before.dataChannel, 'bytesSent');
  const pair = `${s.after.local} -> ${s.after.remote}`;
  return {
    label: `${o.sender}->${o.receiver} ${o.topology} ${o.size}B ${o.strategy}${o.strategy === 'burst' ? ` ${o.high}/${o.low}` : ''} ${o.unordered ? 'unordered' : 'ordered'}${o.poll ? ` poll ${o.poll}ms` : ''}`,
    mibps,
    msgps,
    received: `${rx.messages}/${s.messages}`,
    gapsMs: rx.gaps,
    transportPacketsSent: sPkts,
    transportPacketsReceivedByPeer: rPkts,
    lossPct: sPkts && rPkts !== null ? (100 * (sPkts - rPkts)) / sPkts : null,
    wireOverhead: sBytes && dcBytes ? sBytes / dcBytes : null,
    rttMs:
      s.after.pair?.currentRoundTripTime != null ? s.after.pair.currentRoundTripTime * 1000 : null,
    pair,
    // libwebrtc reports a VPN interface's candidates as networkType 'vpn'.
    pairOverVpn: /\(vpn\)/.test(`${pair} ${rx.after.local} ${rx.after.remote}`),
    waits: s.waits,
    waitMs: Math.round(s.waitMs),
    maxBuffered: s.maxBuffered,
    udpBufferDrops: r.udpBufferDrops,
    remoteUdpBufferDrops: rx.udpBufferDrops ?? null,
    sleepDriftMs: r.sleepDriftMs,
    // More than a second of wall clock the monotonic clock didn't see.
    valid: Math.abs(r.sleepDriftMs) <= 1000,
  };
}

function printSummary(sum, r) {
  const o = r.config;
  const f = (x, d = 2) => (x === null || x === undefined ? '-' : Number(x).toFixed(d));
  if (!sum.valid) {
    console.log(
      `WARNING: this run spanned a system sleep (wall clock ${(sum.sleepDriftMs / 1000).toFixed(0)} s ahead); treat it as invalid`,
    );
  }
  if (sum.pairOverVpn) {
    console.log(
      'WARNING: the selected candidate pair is on a VPN interface; pin with --candidates',
    );
  }
  console.log(sum.label);
  console.log(
    `  ${f(sum.mibps)} MiB/s, ${f(sum.msgps, 0)} msg/s; received ${sum.received}; receiver span ${f(r.receiver.elapsedMs / 1000)} s, send loop ${f(r.sender.sendLoopMs / 1000)} s`,
  );
  console.log(
    `  transport packets: sent ${sum.transportPacketsSent ?? '-'}, peer received ${sum.transportPacketsReceivedByPeer ?? '-'} (loss ${f(sum.lossPct)}%); wire/payload ${f(sum.wireOverhead, 3)}; rtt ${f(sum.rttMs, 1)} ms`,
  );
  console.log(
    `  sender waited ${sum.waits}x for bufferedamountlow (${sum.waitMs} ms total), max bufferedAmount ${sum.maxBuffered}`,
  );
  console.log(
    `  UDP drops (full socket buffers): this machine ${sum.udpBufferDrops ?? '-'}${o.topology === 'remote' ? `, remote ${sum.remoteUdpBufferDrops ?? '-'}` : ''}`,
  );
  const gaps = r.receiver.gaps;
  console.log(`  gaps >= 50 ms between messages: ${gaps.length ? gaps.join(', ') : 'none'}`);
  console.log(`  pair: ${sum.pair}`);
  const kib = r.receiver.timeline.map((b) => Math.round(b / 1024));
  console.log(`  timeline (KiB per ${r.receiver.timelineBucketMs} ms): ${kib.join(' ')}`);
}

// ---------------------------------------------------------------------------

const o = parseArgs(process.argv.slice(2));
if (o.serve) {
  await serve();
} else {
  for (const [sig, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.once(sig, () => {
      stopChildren();
      process.exit(code);
    });
  }
  keepAwake();
  try {
    const r = await drive(o);
    const sum = summarize(r);
    if (o.json) console.log(JSON.stringify({ summary: sum, ...r }, null, 2));
    else printSummary(sum, r);
  } catch (e) {
    console.error(`[bench] ${e?.stack ?? e}`);
    // Local peers may still hold open peer connections.
    process.exit(1);
  }
}
