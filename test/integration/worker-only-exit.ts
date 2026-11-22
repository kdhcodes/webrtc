// Child process of peer-connection.test.ts: the addon is loaded only by
// workers, never by this process's main thread. Two workers, one after the
// other, each create and close a peer connection and stop a sink on a source
// track, then exit on their own. Prints each worker's exit code.
//
// On Linux, Node dlclose()s an addon when the last env that loaded it goes
// away. Unless the library is pinned (-z nodelete in binding.gyp), the first
// worker's thread then segfaults on exit in BoringSSL's pthread_key
// destructor (the source's track id came from RAND_bytes on that thread), and
// libwebrtc's own threads run unmapped code on their next wakeup.
//
// The workers are plain JS on the raw native API, not TypeScript: Node's
// type stripper is wasm, and Node 24's V8 can crash the process when workers
// using wasm come and go (PLAN.md, "V8 wasm crash in workers"), which would
// make this test flaky.
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const addon = fileURLToPath(new URL('../../build/Release/wrtc.node', import.meta.url));
const body = `
  const native = require(${JSON.stringify(addon)});
  (async () => {
    const pc = new native.PeerConnection({}, () => {});
    pc.addTransceiver('audio');
    await pc.setLocalDescription();
    pc.close();
    const track = new native.AudioSource().createTrack();
    new native.AudioSink(track, () => {}).stop();
  })();
`;
for (let i = 0; i < 2; i++) {
  const worker = new Worker(body, { eval: true });
  const code = await new Promise<number>((resolve, reject) => {
    worker.once('exit', resolve);
    worker.once('error', reject);
  });
  console.log(`worker ${code}`);
}
