/**
 * The RTCPeerConnection operations chain (webrtc-pc, "chain an
 * operation"). Operations run one at a time in call order; the first one
 * runs synchronously, so its checks read the state in the caller's task.
 * Once the connection is closed, results of operations still in flight are
 * dropped: their promises never settle and the chain stops.
 */
import { closedError } from './errors.ts';

export type Operation<T> = () => Promise<T>;

export class OperationsChain {
  readonly #isClosed: () => boolean;
  readonly #onEmpty: () => void;
  #operations: (() => void)[] = [];

  /**
   * `isClosed` reads the connection's [[IsClosed]]. `onEmpty` runs each
   * time the chain becomes empty (where the spec checks
   * [[UpdateNegotiationNeededFlagOnEmptyChain]]).
   */
  constructor(isClosed: () => boolean, onEmpty: () => void) {
    this.#isClosed = isClosed;
    this.#onEmpty = onEmpty;
  }

  get length(): number {
    return this.#operations.length;
  }

  /** `what` names the method for the closed-connection error. */
  chain<T>(what: string, operation: Operation<T>): Promise<T> {
    if (this.#isClosed()) return Promise.reject(closedError(what));
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const settle = (fn: () => void) => {
      if (this.#isClosed()) return;
      fn();
      // The spec advances "upon fulfillment or rejection of p", a reaction
      // registered on p once p is settled, so it runs after the reactions
      // the caller registered before that. A microtask queued right after
      // settling p runs at the same point. The deliberate difference: a
      // reaction to p would also mark a rejected p as handled, so a
      // rejection the caller ignores would vanish silently (in Node it is
      // otherwise an unhandled rejection, as with wrtc's promises). We
      // keep reporting those. ops-chain.test.ts: "a rejection nobody
      // handles is still reported".
      queueMicrotask(() => this.#advance());
    };
    const run = () => {
      let result: Promise<T>;
      try {
        result = operation();
      } catch (error) {
        result = Promise.reject(error);
      }
      result.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    };
    this.#operations.push(run);
    if (this.#operations.length === 1) run();
    return promise;
  }

  #advance(): void {
    if (this.#isClosed()) return;
    this.#operations.shift();
    const next = this.#operations[0];
    if (next) {
      next();
    } else {
      this.#onEmpty();
    }
  }
}
