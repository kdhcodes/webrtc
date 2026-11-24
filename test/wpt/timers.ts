// setTimeout and clearTimeout that keep HTML's guarantee: a timeout never
// fires before its delay has passed. Node's setTimeout runs on libuv's
// cached millisecond loop clock, so by performance.now() it can fire up to
// about 1 ms early, which a WPT test comparing against a finer clock
// notices (getStats timestamps 499.986 ms apart after a 500 ms wait, once
// on a CI runner). These re-arm for whatever is left. test/wpt/child.mjs
// installs them; the library itself uses no setTimeout.

type TimerHandle = unknown;
type Arm = (callback: () => void, ms: number) => TimerHandle;
type Disarm = (handle: TimerHandle) => void;

export function atLeastDelayTimers(arm: Arm, disarm: Disarm, now: () => number) {
  const pending = new Map<number, TimerHandle>();
  let lastId = 0;
  return {
    setTimeout(callback: unknown, delay: unknown = 0, ...args: unknown[]): number {
      const id = ++lastId;
      // WebIDL converts the delay to a long (ToInt32: NaN, Infinity and
      // 2^31 or more wrap), and HTML treats a negative one as 0.
      const ms = Math.max(0, Number(delay) | 0);
      const due = now() + ms;
      const schedule = (wait: number) => {
        pending.set(
          id,
          arm(() => {
            const left = due - now();
            if (left > 0) return schedule(left);
            pending.delete(id);
            if (typeof callback === 'function') callback(...args);
          }, wait),
        );
      };
      schedule(ms);
      return id;
    },
    clearTimeout(id: unknown): void {
      if (typeof id !== 'number' || !pending.has(id)) return;
      disarm(pending.get(id));
      pending.delete(id);
    },
  };
}
