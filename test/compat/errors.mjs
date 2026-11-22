// How every compat scenario records an exception: by its name only
// (TypeError, RangeError, or a DOMException's name such as
// InvalidStateError), never its message.
//
// Error messages differ from wrtc's by design. Ours say which API and field
// was wrong, what was expected and what was given; wrtc's are terse ("Expected
// an object"). What code can rely on is kept instead: the same error type in
// the same cases, and whether a call throws at all (SPEC-LAYER-PLAN.md, "wrtc
// compatibility spec"). So the differential tests compare whether a call
// threw and as what; the unit tests pin our messages.

/** The name a scenario records for `error`. */
export function errorName(error) {
  return error?.name ?? String(error);
}
