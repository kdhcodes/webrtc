// The published declarations without a DOM lib, as a Node-only consumer
// compiles them (./tsconfig.json: lib es2022, Node's types, skipLibCheck
// off, so every .d.ts is checked). Run by scripts/check-dom-types.mjs with
// each TypeScript version. It has a directory of its own so that editors
// find that tsconfig.json for it, not ../tsconfig.json's DOM lib. Without a
// lib.dom, the members typed as the consumer's lib.dom has them
// (LIB_DOM_MEMBERS in scripts/gen-idl.mjs) are the spec's types.
import type * as W from '../.declarations/index.js';

declare const track: W.MediaStreamTrack;

// Not narrowed (TypeScript 5.8's lib.dom has boolean[] and boolean)...
export const capabilities: ReturnType<W.MediaStreamTrack['getCapabilities']> = {
  echoCancellation: [true, 'remote-only'],
};
export const settings: ReturnType<W.MediaStreamTrack['getSettings']> = {
  echoCancellation: 'all',
};
export const constraints: W.MediaStreamConstraints = {
  audio: { echoCancellation: { exact: 'remote-only' } },
};

// ... nor widened to unknown.
export const read: (boolean | string)[] | undefined = track.getCapabilities().echoCancellation;
export const readSetting: boolean | string | undefined = track.getSettings().echoCancellation;
