/**
 * Counts the addon's asynchronous results reaching JS. libwebrtc completes
 * them on its own threads and the addon delivers each in a task of its own
 * (a thread-safe function call, in libuv's poll phase), so a change in the
 * count means a task boundary has passed: the spec's "queue a task" steps
 * that JS can't otherwise observe. A setImmediate() queued earlier doesn't
 * cover this: the poll phase can run before it.
 *
 * RTCRtpSender's [[LastReturnedParameters]] uses it. Only results the
 * addon delivers later count. An operation the JS layer settles itself (an
 * end-of-candidates addIceCandidate, a rejection before the native call),
 * and a promise the addon returns already rejected (an unparsable
 * description or candidate, an out-of-range maxBitrate), settle within the
 * caller's task.
 */
let completions = 0;

/** How many native results have been delivered so far. */
export function nativeCompletions(): number {
  return completions;
}

/**
 * `promise` (one the addon returned), counted when it settles in a later
 * task. The count goes up before any reaction the caller attaches to the
 * result runs. The promise, its value and its rejection are unchanged.
 */
export function nativeTask<T>(promise: Promise<T>): Promise<T> {
  // Whether `promise` was already settled when the addon returned it. A
  // reaction to a settled promise is queued at once, so it runs before a
  // microtask queued after it; one the addon settles later (always from a
  // thread-safe function call, a task of its own) runs after that
  // microtask. Both reactions are attached here, before the counting one.
  let settledOnReturn: boolean | undefined;
  const early = () => {
    settledOnReturn ??= true;
  };
  promise.then(early, early);
  queueMicrotask(() => {
    settledOnReturn ??= false;
  });
  return promise.finally(() => {
    if (!settledOnReturn) completions++;
  });
}
