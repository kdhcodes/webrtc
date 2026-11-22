// Child process of mediaDevices.test.ts, run with --expose-gc: getUserMedia
// tracks dropped without stop() stop their generator once collected, while
// one that only a sink still holds keeps running until the sink stops.
// Prints what it saw as JSON.
import { getUserMedia } from '../../mediaDevices.ts';
import { RTCVideoSink } from '../../nonstandard/RTCVideoSink.ts';
import { clockState } from '../synthetic-media.ts';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with --expose-gc');

/** Collects garbage until `done()`, for at most `rounds` rounds. */
async function collect(rounds: number, done: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) {
    gc?.();
    // Finalization callbacks run in a later task.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// In functions, so nothing in this scope references the streams or tracks.
async function dropUnstopped(): Promise<void> {
  const stream = await getUserMedia({ audio: true, video: true });
  stream.getVideoTracks()[0]?.clone();
}
async function sinkOnly(): Promise<RTCVideoSink> {
  const stream = await getUserMedia({ video: true });
  return new RTCVideoSink(stream.getVideoTracks()[0] as never);
}

await dropUnstopped();
const sink = await sinkOnly();
const before = clockState().feeds;
await collect(100, () => clockState().feeds <= 1);
const afterGc = clockState().feeds;
await collect(20);
const frame = await new Promise<string>((resolve) => {
  sink.onframe = ({ frame: { width, height } }) => resolve(`${width}x${height}`);
});
const sinkHeld = clockState().feeds;
sink.stop();
await collect(100, () => clockState().feeds === 0);
console.log(JSON.stringify({ before, afterGc, sinkHeld, frame, afterSinkStop: clockState() }));
