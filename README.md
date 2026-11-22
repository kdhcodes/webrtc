# @kdh.codes/webrtc

[![WPT](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fkevindhanna%2Fwebrtc%2Fbadges%2Fwpt.json)](https://github.com/kevindhanna/webrtc/blob/badges/WPT.md)

WebRTC for Node.js. It's a native addon over Google's libwebrtc (M150, built from upstream) with an API that sticks to the spec, and it's a drop-in replacement for `@roamhq/wrtc`, `nonstandard` APIs and all.

## Install

```bash
npm install @kdh.codes/webrtc
```

Or swap it in for wrtc without touching any code:

```json
"@roamhq/wrtc": "npm:@kdh.codes/webrtc"
```

Prebuilt for macOS arm64 and Linux x64/arm64 (glibc 2.34+, so not Alpine). Needs Node 24+.

## Usage

```js
import { RTCPeerConnection, nonstandard } from '@kdh.codes/webrtc';

const pc = new RTCPeerConnection();
const source = new nonstandard.RTCVideoSource();
pc.addTrack(source.createTrack());
```

The default export is the whole namespace too, so `import wrtc from '@kdh.codes/webrtc'` works like it does with wrtc.

## Differences from wrtc

Mostly it does what Chrome does where wrtc didn't:

- No H264, just VP8, VP9 and AV1
- Remote tracks start muted and unmute when media arrives, and they fire `ended` when their transceiver stops or the connection closes
- Sinks stop when their track ends, so they don't keep your process alive
- The error messages should actually tell you what went wrong

## License

MIT. libwebrtc and the third party code built into it have their own licences, see `THIRD_PARTY_NOTICES.md`.
