/** Thrown by WP0 stubs until the owning work package lands. */
export class NotImplementedError extends Error {
  readonly code = 'ERR_WRTC_NOT_IMPLEMENTED';

  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

export function notImplemented(what: string): never {
  throw new NotImplementedError(what);
}
