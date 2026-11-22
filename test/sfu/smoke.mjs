// Smallest end-to-end check: one data message A -> SFU -> B, and the
// candidate pairs used (they must not be a VPN's).
//
//   MEDIASOUP_DIR=... node test/sfu/smoke.mjs   (HANDLER=Chrome111 for the other handler)
import { createClient, createSfu, installWrtcGlobals, once, selectedPair } from './common.mjs';

await installWrtcGlobals();
const sfu = await createSfu();
console.log('mediasoup', sfu.version);
const handlerName = process.env.HANDLER || 'Safari12';
const a = await createClient({ rpc: sfu.rpc, name: 'A', handlerName });
const b = await createClient({ rpc: sfu.rpc, name: 'B', handlerName });
const dp = await a.sendTransport.produceData({ label: 'smoke' });
await once(dp, 'open');
const dc = await b.consumeData(dp.id);
if (dc.readyState !== 'open') await once(dc, 'open');
const got = once(dc, 'message');
dp.send('hello');
console.log('got', await got);
console.log('A send pair', await selectedPair(a.sendTransport));
console.log('B recv pair', await selectedPair(b.recvTransport));
a.close();
b.close();
sfu.close();
