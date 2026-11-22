import { type EventInit, toRTCDataChannelEventInit } from './internal/generated/idl.ts';
import { registerInterface } from './internal/webidl.ts';
import type { RTCDataChannel } from './RTCDataChannel.ts';

export interface RTCDataChannelEventInit extends EventInit {
  channel: RTCDataChannel;
}

/**
 * The `datachannel` event: the remote side opened an in-band channel.
 * `channel` is a WebIDL attribute: a getter on the prototype, as in
 * browsers (wrtc's event is a plain object; SPEC-LAYER-PLAN.md, "Events").
 */
export class RTCDataChannelEvent extends Event {
  readonly #channel: RTCDataChannel;

  static {
    registerInterface('RTCDataChannelEvent', (value) => #channel in value);
  }

  constructor(type: string, eventInitDict: RTCDataChannelEventInit) {
    const init = toRTCDataChannelEventInit(
      eventInitDict,
      "Failed to construct 'RTCDataChannelEvent': eventInitDict",
    );
    super(String(type), init);
    this.#channel = init.channel as RTCDataChannel;
  }

  get channel(): RTCDataChannel {
    return this.#channel;
  }

  get [Symbol.toStringTag](): string {
    return 'RTCDataChannelEvent';
  }
}
