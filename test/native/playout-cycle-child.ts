// Child process of playout.test.ts, run with --expose-gc, WRTC_LOG matching
// the voice engine's Init and Terminate lines, and WRTC_LOG_FILE set (the
// log hook reads them when the addon loads). Two calls in turn: once the
// first call's peer connections are gone, libwebrtc terminates its voice
// engine, and with it the playout ADM, then initializes both again for the
// second call. Prints each call's remote audio event rate (events per
// second) as JSON.
import { readFileSync } from 'node:fs';
import { AudioCounter, audioCall, eventRate } from './playout-harness.ts';

const LOG = process.env.WRTC_LOG_FILE ?? '';
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});

const terminates = () =>
  readFileSync(LOG, 'utf8')
    .split('\n')
    .filter((line) => line.endsWith('WebRtcVoiceEngine::Terminate')).length;

/** One call, closed before it resolves; nothing of it stays referenced. */
async function call(): Promise<number> {
  const cleanups: (() => void)[] = [];
  const t = { after: (fn: () => void) => cleanups.push(fn) };
  try {
    return await eventRate(new AudioCounter(t, await audioCall(t)), 200);
  } finally {
    for (const fn of cleanups.reverse()) fn();
  }
}

/**
 * Resolves once the voice engine has terminated. A peer connection holds it
 * until the peer connection is destroyed (libwebrtc's ~PeerConnection, not
 * close()), i.e. until its JS object is collected. The deadline is only a
 * failure guard.
 */
async function terminated(before: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (terminates() === before) {
    if (Date.now() > deadline) throw new Error('the voice engine never terminated');
    gc();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const rates: number[] = [];
for (let i = 0; i < 2; i++) {
  const before = terminates();
  rates.push(await call());
  await terminated(before);
}
console.log(JSON.stringify(rates));
