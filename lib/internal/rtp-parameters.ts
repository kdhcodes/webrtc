/**
 * The spec's view of RTP parameters on top of what libwebrtc reports:
 * codecs from the negotiated descriptions, and the encodings'
 * scaleResolutionDownBy defaults.
 */
import type { RTCRtpCapabilities, RTCRtpCodecParameters } from './generated/idl.ts';
import { native } from './native.ts';
import { type SdpCodec, sectionCodecs } from './sdp.ts';

type Side = 'sender' | 'receiver';
type Kind = 'audio' | 'video';

// getParameters() reads the same few descriptions again and again, and
// parsing a large one costs far more than the rest of the call (about
// 240 us for 60 m-sections), so the parsed sections of the last few
// descriptions are kept, keyed by their text.
const PARSED_LIMIT = 16;
const parsed = new Map<string, Map<string, SdpCodec[]>>();

function codecsByMid(sdp: string): Map<string, SdpCodec[]> {
  let sections = parsed.get(sdp);
  if (sections) {
    // Most recently used last.
    parsed.delete(sdp);
  } else {
    sections = sectionCodecs(sdp);
    if (parsed.size >= PARSED_LIMIT) parsed.delete(parsed.keys().next().value as string);
  }
  parsed.set(sdp, sections);
  return sections;
}

// libwebrtc's capabilities don't change while the process runs. Keyed by
// the addon function too, so a test's fake gets its own.
const capabilityCache = new WeakMap<object, Map<string, RTCRtpCapabilities | null>>();

function capabilitiesOf(side: Side, kind: Kind): RTCRtpCapabilities | null {
  const fn = native.getRtpCapabilities;
  let byKind = capabilityCache.get(fn);
  if (!byKind) {
    byKind = new Map();
    capabilityCache.set(fn, byKind);
  }
  const key = `${side}:${kind}`;
  if (!byKind.has(key)) {
    byKind.set(key, native.getRtpCapabilities(side, kind) as RTCRtpCapabilities | null);
  }
  return byKind.get(key) ?? null;
}

/**
 * The codecs negotiated in the media section `mid` of `sdp`, in the
 * description's order, leaving out the ones libwebrtc can't use on `side`
 * and the RTX entries for those. A sender's come from the remote
 * description and a receiver's from the local one (the spec: "negotiated
 * for sending"/"receiving"), so they are there whatever the transceiver's
 * direction, while libwebrtc only reports codecs for a stream it is sending
 * or receiving. Empty until a description is current. `capabilities`
 * defaults to libwebrtc's for `side`.
 */
export function negotiatedCodecs(
  sdp: string | null | undefined,
  mid: string | null,
  kind: Kind,
  side: Side,
  capabilities?: RTCRtpCapabilities | null,
): RTCRtpCodecParameters[] {
  if (!sdp || mid === null) return [];
  const codecs = codecsByMid(sdp).get(mid);
  if (!codecs) return [];
  const supported = capabilities === undefined ? capabilitiesOf(side, kind) : capabilities;
  if (!supported) return [];
  const known = (name: string, clockRate: number) =>
    supported.codecs.find(
      (c) =>
        c.mimeType.toLowerCase() === `${kind}/${name}`.toLowerCase() && c.clockRate === clockRate,
    );
  const usable = codecs.flatMap((codec) => {
    const capability = known(codec.name, codec.clockRate);
    return capability ? [{ codec, mimeType: capability.mimeType }] : [];
  });
  const payloadTypes = new Set(usable.map(({ codec }) => codec.payloadType));
  return usable
    .filter(({ codec, mimeType }) => {
      if (mimeType.toLowerCase() !== `${kind}/rtx`) return true;
      const apt = /(?:^|;)\s*apt=(\d+)/.exec(codec.fmtp ?? '');
      return apt !== null && payloadTypes.has(Number(apt[1]));
    })
    .map(({ codec, mimeType }) => {
      const result: RTCRtpCodecParameters = {
        payloadType: codec.payloadType,
        mimeType,
        clockRate: codec.clockRate,
      };
      if (kind === 'audio') result.channels = codec.channels ?? 1;
      if (codec.fmtp !== undefined) result.sdpFmtpLine = codec.fmtp;
      return result;
    });
}

/** An encoding as the JS layer passes it around. */
type Encoding = Record<string, unknown>;

/**
 * A sender's encodings as getParameters() returns them, from libwebrtc's.
 *
 * - Audio has no scaleResolutionDownBy or maxFramerate (the spec removes
 *   them; libwebrtc keeps what it was given).
 * - Video always has scaleResolutionDownBy. libwebrtc leaves it unset and
 *   applies the spec's defaults itself: 1 for an encoding without one when
 *   another has one, otherwise 2^(n - 1 - i) over the n layers it was
 *   created with (`envelope`, the rids at creation; a layer a remote
 *   description removed still counts). The value shown is that default.
 *
 * `synthesized` is true when every scale shown is such a default, so
 * setParameters() can tell them from values the caller chose.
 */
export function presentEncodings(
  encodings: readonly Encoding[],
  kind: Kind,
  envelope: readonly (string | undefined)[],
): { encodings: Encoding[]; synthesized: boolean } {
  if (kind === 'audio') {
    return {
      encodings: encodings.map(({ scaleResolutionDownBy, maxFramerate, ...rest }) => rest),
      synthesized: false,
    };
  }
  if (encodings.some((e) => e.scaleResolutionDownBy !== undefined)) {
    return {
      encodings: encodings.map((e) => ({
        ...e,
        scaleResolutionDownBy: e.scaleResolutionDownBy ?? 1,
      })),
      synthesized: false,
    };
  }
  return {
    encodings: encodings.map((e, i) => {
      const at = typeof e.rid === 'string' ? envelope.indexOf(e.rid) : -1;
      const [index, count] = at >= 0 ? [at, envelope.length] : [i, encodings.length];
      return { ...e, scaleResolutionDownBy: 2 ** (count - 1 - index) };
    }),
    synthesized: encodings.length > 0,
  };
}

/**
 * Undoes presentEncodings() for setParameters(): when every scale shown was
 * a default and the caller passes them all back unchanged, they are dropped,
 * so libwebrtc keeps applying its own default rather than explicit values.
 * The two differ when the input is too small for every simulcast layer:
 * libwebrtc then sends fewer layers, and with its default the top one stays
 * at full resolution, while explicit scales keep the lowest layers' scales
 * and drop the top ones (`video/config/encoder_stream_factory.cc`). Any
 * change sends all of them as given. Encodings are matched by index; the
 * caller has already checked that they line up.
 */
export function unpresentEncodings(
  next: readonly Encoding[],
  shown: readonly Encoding[],
  synthesized: boolean,
): Encoding[] {
  const unchanged =
    synthesized &&
    next.every((e, i) => e.scaleResolutionDownBy === shown[i]?.scaleResolutionDownBy);
  if (!unchanged) return [...next];
  return next.map(({ scaleResolutionDownBy, ...rest }) => rest);
}
