// Public entry point: every named export (lib/exports.ts), plus the same
// namespace as the default export.
//
// wrtc is CommonJS, so wrtc code commonly does `import wrtc from
// "@roamhq/wrtc"` and uses `wrtc.X` as both a value and a type (e.g.
// @whereby.com/assistant-sdk). Re-exporting the namespace as the default keeps
// both working. A deliberate exception to the "no default exports" convention.
// The named exports live in a separate module because a module can't re-export
// its own namespace without a circular alias.
import * as wrtc from './exports.ts';
import { applyInterfaceShapes } from './internal/interface-shape.ts';

// WebIDL's property shape (enumerable members, `length`s, brand-checked event
// handlers) for every exported interface class, once.
applyInterfaceShapes(wrtc);

export * from './exports.ts';
export { wrtc as default };
