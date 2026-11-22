import { registerInterface } from './internal/webidl.ts';

// biome-ignore lint/suspicious/noExplicitAny: stats dictionaries vary by type, as in the DOM's own RTCStatsReport (ReadonlyMap<string, any>).
type Stats = any;

const constructToken = Symbol('RTCStatsReport');

/**
 * The result of getStats(): a read-only map from stats id to a stats
 * dictionary (`{id, type, timestamp, ...}`), as libwebrtc reports them.
 * The entries are plain mutable objects, as in Chrome, Firefox and wrtc. Has
 * the Map read surface (`get`, `has`, `size`, `forEach`, `keys`, `values`,
 * `entries`, iteration), so wrtc code using its Map keeps working.
 */
export class RTCStatsReport implements ReadonlyMap<string, Stats> {
  #map: Map<string, Stats>;

  static {
    registerInterface('RTCStatsReport', (value) => #map in value);
  }

  /** @internal Use statsReportFromJson(). */
  constructor(...args: unknown[]) {
    if (args[0] !== constructToken) throw new TypeError('Illegal constructor');
    this.#map = args[1] as Map<string, Stats>;
  }

  get [Symbol.toStringTag](): string {
    return 'RTCStatsReport';
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: string): Stats | undefined {
    return this.#map.get(String(key));
  }

  has(key: string): boolean {
    return this.#map.has(String(key));
  }

  forEach(
    callbackfn: (value: Stats, key: string, parent: RTCStatsReport) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#map) callbackfn.call(thisArg, value, key, this);
  }

  keys(): MapIterator<string> {
    return this.#map.keys();
  }

  values(): MapIterator<Stats> {
    return this.#map.values();
  }

  entries(): MapIterator<[string, Stats]> {
    return this.#map.entries();
  }

  [Symbol.iterator](): MapIterator<[string, Stats]> {
    return this.#map.entries();
  }
}

const rtpTypes = new Set(['inbound-rtp', 'outbound-rtp']);

/**
 * libwebrtc m150's SRTP profile names, and the IANA ones (RFC 5764) that
 * later libwebrtc, and so Chrome, reports.
 */
const srtpCiphers: Record<string, string> = {
  AES_CM_128_HMAC_SHA1_80: 'SRTP_AES128_CM_HMAC_SHA1_80',
  AES_CM_128_HMAC_SHA1_32: 'SRTP_AES128_CM_HMAC_SHA1_32',
  AEAD_AES_128_GCM: 'SRTP_AEAD_AES_128_GCM',
  AEAD_AES_256_GCM: 'SRTP_AEAD_AES_256_GCM',
};

/**
 * Internal: a report from the addon's JSON, libwebrtc's `ToJson()`: an
 * array of stats objects (`{}` when a selector selects nothing), keyed here
 * by each one's `id`.
 *
 * RTP stream entries also get the legacy `mediaType` (equal to `kind`),
 * which libwebrtc has dropped but wrtc's older libwebrtc still reported,
 * and wrtc-era code reads.
 *
 * `ToJson()` writes `timestamp` in microseconds since the Unix epoch, but
 * RTCStats.timestamp is a DOMHighResTimeStamp: milliseconds (Performance
 * time, comparable with `performance.timeOrigin + performance.now()`), as
 * browsers and wrtc report it. Its other times (`remoteTimestamp`,
 * `lastPacketReceivedTimestamp`, ...) are already milliseconds.
 *
 * A transport's `srtpCipher` is renamed to the IANA name Chrome reports
 * (`SRTP_AES128_CM_HMAC_SHA1_80`, not m150's `AES_CM_128_HMAC_SHA1_80`).
 */
export function statsReportFromJson(json: string): RTCStatsReport {
  const parsed = JSON.parse(json) as Stats[] | Record<string, Stats>;
  const map = new Map<string, Stats>();
  for (const stats of Object.values(parsed)) {
    if (typeof stats.timestamp === 'number') stats.timestamp /= 1000;
    if (rtpTypes.has(stats.type) && stats.kind !== undefined && stats.mediaType === undefined) {
      stats.mediaType = stats.kind;
    }
    if (stats.type === 'transport' && Object.hasOwn(srtpCiphers, stats.srtpCipher)) {
      stats.srtpCipher = srtpCiphers[stats.srtpCipher];
    }
    map.set(String(stats.id), stats);
  }
  return new RTCStatsReport(constructToken, map);
}
