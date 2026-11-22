// Shared by playout.test.ts and playout-cycle-child.ts: a call that sends B
// remote audio, and a counter of the events a sink on it gets. A remote
// audio sink gets one event per playout pull (src/playout_adm.h), so the
// counter's rate is the pull rate.
import { native } from '../../lib/internal/native.ts';
import type { NativeAudioData, NativeTrack } from '../../lib/internal/native-types.ts';
import { type Cleanup, connect, Peer } from './pc-harness.ts';

/** A failure guard only; waits are for events, never for time. */
const WAIT_MS = 15_000;

/** 10 ms of a 440 Hz tone at 48 kHz mono. */
function tone(tick: number): Int16Array {
  const samples = new Int16Array(480);
  for (let i = 0; i < samples.length; i++) {
    const t = (tick * 480 + i) / 48_000;
    samples[i] = Math.round(8000 * Math.sin(2 * Math.PI * 440 * t));
  }
  return samples;
}

/**
 * Two connected peers, A pushing B a tone, 10 ms every 10 ms. Resolves with
 * B's remote audio track. Everything is closed or stopped through `t`.
 */
export async function audioCall(t: Cleanup): Promise<NativeTrack> {
  const a = new Peer(t);
  const b = new Peer(t);
  const source = new native.AudioSource();
  a.pc.addTrack(source.createTrack(), ['stream']);
  await connect(a, b);
  const [remote] = b.of('track').map((ev) => ev.receiver.track);
  if (remote?.kind !== 'audio') throw new Error('B got no remote audio track');

  let tick = 0;
  const pump = setInterval(() => {
    source.pushData({
      samples: tone(tick++),
      sampleRate: 48_000,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: 480,
    });
  }, 10);
  t.after(() => clearInterval(pump));
  return remote;
}

/** Counts a sink's events on `track`. The sink is stopped through `t`. */
export class AudioCounter {
  count = 0;
  audible = 0;
  #waiters: { pred: () => boolean; resolve: (at: number) => void }[] = [];

  constructor(t: Cleanup, track: NativeTrack) {
    const sink = new native.AudioSink(track, (data) => this.#onData(data));
    t.after(() => sink.stop());
  }

  /** Resolves with performance.now() at the event that makes `pred` true. */
  until(pred: (counter: AudioCounter) => boolean, what: string): Promise<number> {
    if (pred(this)) return Promise.resolve(performance.now());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for ${what} (${this.count} events so far)`));
      }, WAIT_MS);
      const waiter = {
        pred: () => pred(this),
        resolve: (at: number) => {
          clearTimeout(timer);
          resolve(at);
        },
      };
      this.#waiters.push(waiter);
    });
  }

  #onData(data: NativeAudioData): void {
    this.count++;
    if (data.samples.some((s) => Math.abs(s) > 1000)) this.audible++;
    const at = performance.now();
    const done = this.#waiters.filter((w) => w.pred());
    this.#waiters = this.#waiters.filter((w) => !done.includes(w));
    for (const w of done) w.resolve(at);
  }
}

/**
 * Once the tone is heard, the sink's events per second over the next
 * `events` events.
 */
export async function eventRate(counter: AudioCounter, events: number): Promise<number> {
  await counter.until((c) => c.audible >= 10, '10 audible events');
  const from = counter.count;
  const start = performance.now();
  const end = await counter.until((c) => c.count >= from + events, `${events} more events`);
  return (events / (end - start)) * 1000;
}
