import {
  type RTCIceCandidateInit,
  type RTCIceCandidateType,
  type RTCIceComponent,
  type RTCIceProtocol,
  type RTCIceServerTransportProtocol,
  type RTCIceTcpCandidateType,
  type RTCLocalIceCandidateInit,
  toRTCLocalIceCandidateInit,
} from './internal/generated/idl.ts';
import { registerInterface } from './internal/webidl.ts';

export type {
  RTCIceCandidateInit,
  RTCIceCandidateType,
  RTCIceComponent,
  RTCIceProtocol,
  RTCIceServerTransportProtocol,
  RTCIceTcpCandidateType,
  RTCLocalIceCandidateInit,
};

interface Fields {
  foundation: string;
  component: RTCIceComponent | null;
  priority: number;
  /** Null only for a redacted peer-reflexive remote candidate. */
  address: string | null;
  protocol: RTCIceProtocol | null;
  port: number;
  type: RTCIceCandidateType | null;
  tcpType: RTCIceTcpCandidateType | null;
  relatedAddress: string | null;
  relatedPort: number | null;
  /** The `ufrag` extension attribute, if any. */
  ufrag: string | null;
}

const types = new Set(['host', 'srflx', 'prflx', 'relay']);
const tcpTypes = new Set(['active', 'passive', 'so']);
const iceChars = /^[A-Za-z0-9+/]{1,32}$/;
const digits = (max: number) => new RegExp(`^[0-9]{1,${max}}$`);
const componentDigits = digits(3);
const priorityDigits = digits(10);
const portDigits = digits(5);

/**
 * Parses an RFC 8839 candidate-attribute, as WPT's
 * RTCIceCandidate-constructor.html reads the grammar and its prose:
 *
 *   candidate:<foundation> <component> <transport> <priority> <address>
 *     <port> typ <type> [raddr <address> rport <port>] [tcptype <type>]
 *     *(<name> <value>)
 *
 * - single spaces between tokens, no leading `a=` (that is SDP framing)
 *   and no leading or trailing whitespace
 * - foundation: 1 to 32 of ALPHA / DIGIT / "+" / "/"
 * - component 1 to 256, priority 1 to 2^31 - 1, ports 0 to 65535, all
 *   plain digits
 * - keywords and enum values are case-insensitive (ABNF strings); the
 *   fields report them lowercased
 * - srflx, prflx and relay need raddr and rport; a TCP candidate that
 *   isn't relayed needs tcptype (RFC 6544), right after them
 * - extensions come in name/value pairs; `ufrag` is picked out
 *
 * Returns null if it doesn't parse. A transport or type outside the enums
 * parses, with that field null. Without `requireRelated`, a non-host
 * candidate may lack raddr/rport, as libwebrtc serializes a peer-reflexive
 * candidate it learned from a connectivity check.
 */
export function parseCandidate(candidate: string, requireRelated = true): Fields | null {
  const colon = candidate.indexOf(':');
  if (colon < 0 || candidate.slice(0, colon).toLowerCase() !== 'candidate') return null;
  const parts = candidate.slice(colon + 1).split(' ');
  if (parts.length < 8 || parts.some((part) => part === '')) return null;
  const [foundation, componentId, transport, priority, address, port, typ, type] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!iceChars.test(foundation) || typ.toLowerCase() !== 'typ') return null;
  const component = componentDigits.test(componentId) ? Number(componentId) : 0;
  const prio = priorityDigits.test(priority) ? Number(priority) : 0;
  const portNumber = portDigits.test(port) ? Number(port) : -1;
  if (component < 1 || component > 256) return null;
  if (prio < 1 || prio > 2 ** 31 - 1) return null;
  if (portNumber < 0 || portNumber > 65535) return null;

  const protocol = transport.toLowerCase();
  const candidateType = type.toLowerCase();
  const fields: Fields = {
    foundation,
    component: component === 1 ? 'rtp' : component === 2 ? 'rtcp' : null,
    priority: prio,
    address,
    protocol: protocol === 'udp' || protocol === 'tcp' ? protocol : null,
    port: portNumber,
    type: types.has(candidateType) ? (candidateType as RTCIceCandidateType) : null,
    tcpType: null,
    relatedAddress: null,
    relatedPort: null,
    ufrag: null,
  };

  let i = 8;
  const keyword = (name: string) => parts[i]?.toLowerCase() === name;
  if (keyword('raddr')) {
    const related = parts[i + 1];
    if (related === undefined) return null;
    fields.relatedAddress = related;
    i += 2;
    const rport = parts[i + 1];
    if (!keyword('rport') || rport === undefined || !portDigits.test(rport)) return null;
    fields.relatedPort = Number(rport);
    if (fields.relatedPort > 65535) return null;
    i += 2;
  } else if (keyword('rport')) {
    return null;
  }
  if (
    requireRelated &&
    candidateType !== 'host' &&
    types.has(candidateType) &&
    fields.relatedPort === null
  ) {
    return null;
  }
  if (protocol === 'tcp') {
    if (keyword('tcptype')) {
      const tcpType = parts[i + 1]?.toLowerCase();
      if (tcpType === undefined || !tcpTypes.has(tcpType)) return null;
      fields.tcpType = tcpType as RTCIceTcpCandidateType;
      i += 2;
    } else if (candidateType !== 'relay') {
      return null;
    }
  }
  if ((parts.length - i) % 2 !== 0) return null;
  for (; i < parts.length; i += 2) {
    if (parts[i] === 'ufrag') fields.ufrag = parts[i + 1] as string;
  }
  return fields;
}

let redact: (candidate: RTCIceCandidate) => void;

/**
 * An ICE candidate. The fields the spec derives from the candidate string
 * are parsed here; a string that doesn't parse leaves them null.
 *
 * Unlike wrtc's, the fields are getters on the prototype (the spec), so
 * `{...candidate}` is empty; `JSON.stringify(candidate)` and `toJSON()`
 * give `{candidate, sdpMid, sdpMLineIndex, usernameFragment}`.
 */
export class RTCIceCandidate {
  #candidate: string;
  #sdpMid: string | null;
  #sdpMLineIndex: number | null;
  #usernameFragment: string | null;
  #relayProtocol: RTCIceServerTransportProtocol | null;
  #url: string | null;
  #fields: Fields | null;

  static {
    registerInterface('RTCIceCandidate', (value) => #candidate in value);
    redact = (candidate) => {
      const fields = parseCandidate(candidate.#candidate, false);
      candidate.#candidate = '';
      candidate.#fields = fields && {
        ...fields,
        address: null,
        relatedAddress: null,
        relatedPort: fields.relatedPort ?? 0,
      };
    };
  }

  constructor(candidateInitDict: RTCLocalIceCandidateInit = {}) {
    const init = toRTCLocalIceCandidateInit(
      candidateInitDict,
      "Failed to construct 'RTCIceCandidate': candidateInitDict",
    );
    if ((init.sdpMid ?? null) === null && (init.sdpMLineIndex ?? null) === null) {
      throw new TypeError(
        "Failed to construct 'RTCIceCandidate': sdpMid and sdpMLineIndex are both null.",
      );
    }
    this.#candidate = init.candidate ?? '';
    this.#sdpMid = init.sdpMid ?? null;
    this.#sdpMLineIndex = init.sdpMLineIndex ?? null;
    this.#usernameFragment = init.usernameFragment ?? null;
    this.#relayProtocol = init.relayProtocol ?? null;
    this.#url = init.url ?? null;
    this.#fields = parseCandidate(this.#candidate);
  }

  get [Symbol.toStringTag](): string {
    return 'RTCIceCandidate';
  }

  get candidate(): string {
    return this.#candidate;
  }

  get sdpMid(): string | null {
    return this.#sdpMid;
  }

  get sdpMLineIndex(): number | null {
    return this.#sdpMLineIndex;
  }

  get foundation(): string | null {
    return this.#fields?.foundation ?? null;
  }

  get component(): RTCIceComponent | null {
    return this.#fields?.component ?? null;
  }

  get priority(): number | null {
    return this.#fields?.priority ?? null;
  }

  get address(): string | null {
    return this.#fields?.address ?? null;
  }

  get protocol(): RTCIceProtocol | null {
    return this.#fields?.protocol ?? null;
  }

  get port(): number | null {
    return this.#fields?.port ?? null;
  }

  get type(): RTCIceCandidateType | null {
    return this.#fields?.type ?? null;
  }

  get tcpType(): RTCIceTcpCandidateType | null {
    return this.#fields?.tcpType ?? null;
  }

  get relatedAddress(): string | null {
    return this.#fields?.relatedAddress ?? null;
  }

  get relatedPort(): number | null {
    return this.#fields?.relatedPort ?? null;
  }

  get usernameFragment(): string | null {
    return this.#usernameFragment;
  }

  get relayProtocol(): RTCIceServerTransportProtocol | null {
    return this.#relayProtocol;
  }

  get url(): string | null {
    return this.#url;
  }

  toJSON(): RTCIceCandidateInit {
    return {
      candidate: this.#candidate,
      sdpMid: this.#sdpMid,
      sdpMLineIndex: this.#sdpMLineIndex,
      usernameFragment: this.#usernameFragment,
    };
  }
}

/**
 * One end of a selected candidate pair, from libwebrtc's candidate-attribute.
 * A peer-reflexive remote candidate (`hideAddress`) was learned from the
 * network, not from the application, so webrtc-pc hides its address: its
 * `candidate` is '' and `address` and `relatedAddress` are null, while the
 * other fields stay (`relatedPort` 0 when it has none).
 */
export function pairCandidate(
  candidate: string,
  sdpMid: string,
  sdpMLineIndex: number | null,
  hideAddress: boolean,
): RTCIceCandidate {
  const result = new RTCIceCandidate({
    candidate,
    sdpMid,
    sdpMLineIndex,
    usernameFragment: parseCandidate(candidate, false)?.ufrag ?? null,
  });
  if (hideAddress) redact(result);
  return result;
}
