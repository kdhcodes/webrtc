// As dom-compat.ts, for the types we export that only the current
// TypeScript's lib.dom declares (TypeScript 5.8's doesn't), so this file is
// in ./tsconfig.json but not in ts5.8/tsconfig.json.
import type * as W from './.declarations/index.js';

declare const ours: W.RTCLocalIceCandidateInit;
declare const dom: RTCLocalIceCandidateInit;

export const o_RTCLocalIceCandidateInit: RTCLocalIceCandidateInit = ours;
export const d_RTCLocalIceCandidateInit: W.RTCLocalIceCandidateInit = dom;
