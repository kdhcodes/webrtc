// Child process of datachannel.test.ts: opens a data channel pair (with
// listeners attached and Blob sends in flight), closes both connections and
// then must exit on its own. Prints the channels' readyStates once open.
import {
  type RTCDataChannel,
  RTCPeerConnection,
  type RTCSessionDescriptionInit,
} from '../../lib/index.ts';

const a = new RTCPeerConnection();
const b = new RTCPeerConnection();
a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate);
b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate);
const local = a.createDataChannel('exit');
const remote = new Promise<RTCDataChannel>((resolve) => {
  b.ondatachannel = ({ channel }) => resolve(channel);
});
const opened = new Promise((resolve) => {
  local.onopen = resolve;
});
await a.setLocalDescription(await a.createOffer());
await b.setRemoteDescription(a.localDescription as RTCSessionDescriptionInit);
await b.setLocalDescription(await b.createAnswer());
await a.setRemoteDescription(b.localDescription as RTCSessionDescriptionInit);
await opened;
const channel = await remote;
channel.onmessage = () => {};
local.onmessage = () => {};
local.send(new Blob(['in flight']));
console.log(`${local.readyState} ${channel.readyState}`);
a.close();
b.close();
