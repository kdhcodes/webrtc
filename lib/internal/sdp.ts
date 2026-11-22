/**
 * The little SDP reading the JS layer needs: media sections' mids, ICE
 * ufrags and BUNDLE groups, to validate addIceCandidate and to name the
 * ICE transports whose gathering completed. libwebrtc does the real
 * parsing; this only reads descriptions libwebrtc has already accepted.
 */

export interface MediaSection {
  /** The m-line's index (sdpMLineIndex). */
  index: number;
  mid: string | null;
  /** a=ice-ufrag, falling back to the session-level one. */
  ufrag: string | null;
  /** Port 0 outside a BUNDLE group. */
  rejected: boolean;
}

export interface ParsedSdp {
  sections: MediaSection[];
  /** a=group:BUNDLE mid lists. */
  bundles: string[][];
  /** a=ice-options lists 'trickle' (session or media level). */
  trickle: boolean;
}

export function parseSdp(sdp: string): ParsedSdp {
  const lines = sdp.split(/\r?\n/);
  const sections: (MediaSection & { port: number })[] = [];
  const bundles: string[][] = [];
  let sessionUfrag: string | null = null;
  let trickle = false;
  let current: (MediaSection & { port: number }) | undefined;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      const port = Number(line.split(' ')[1]);
      current = { index: sections.length, mid: null, ufrag: null, rejected: false, port };
      sections.push(current);
    } else if (line.startsWith('a=mid:') && current) {
      current.mid = line.slice('a=mid:'.length);
    } else if (line.startsWith('a=ice-ufrag:')) {
      const ufrag = line.slice('a=ice-ufrag:'.length);
      if (current) current.ufrag = ufrag;
      else sessionUfrag = ufrag;
    } else if (line.startsWith('a=group:BUNDLE')) {
      bundles.push(line.split(' ').slice(1).filter(Boolean));
    } else if (line.startsWith('a=ice-options:')) {
      if (line.slice('a=ice-options:'.length).split(' ').includes('trickle')) trickle = true;
    }
  }
  const bundled = new Set(bundles.flat());
  return {
    sections: sections.map(({ port, ...section }) => ({
      ...section,
      ufrag: section.ufrag ?? sessionUfrag,
      rejected: port === 0 && !(section.mid !== null && bundled.has(section.mid)),
    })),
    bundles,
    trickle,
  };
}

/**
 * `sdp` with `line` appended to each media section whose index is in
 * `indices` (after its last line), unless the section already has that
 * line. Keeps the description's line endings.
 */
export function appendToSections(sdp: string, indices: Iterable<number>, line: string): string {
  const targets = new Set(indices);
  if (targets.size === 0) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  // A description normally ends with an end-of-line, leaving a final ''.
  const trailing = lines.at(-1) === '' ? lines.pop() : undefined;
  const out: string[] = [];
  let section = -1;
  let has = false;
  const close = () => {
    if (targets.has(section) && !has) out.push(line);
  };
  for (const l of lines) {
    if (l.startsWith('m=')) {
      close();
      section++;
      has = false;
    }
    if (l === line) has = true;
    out.push(l);
  }
  close();
  if (trailing !== undefined) out.push(trailing);
  return out.join(eol);
}

export interface SctpSection {
  /** The m-line's index. */
  index: number;
  /** a=max-message-size, or null without one. */
  maxMessageSize: number | null;
}

/**
 * The first data channel (SCTP) media section that isn't rejected, or
 * null. Both the current `UDP/DTLS/SCTP webrtc-datachannel` form and the
 * legacy `DTLS/SCTP 5000` one count.
 */
export function sctpSection(sdp: string): SctpSection | null {
  const { sections } = parseSdp(sdp);
  let index = -1;
  let found: SctpSection | null = null;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      if (found) return found;
      index++;
      const [media, , proto] = line.slice(2).split(' ');
      if (media === 'application' && proto?.includes('SCTP') && !sections[index]?.rejected) {
        found = { index, maxMessageSize: null };
      }
    } else if (found && line.startsWith('a=max-message-size:')) {
      found.maxMessageSize = Number(line.slice('a=max-message-size:'.length));
    }
  }
  return found;
}

export interface IceSection {
  /** The m-line's index (sdpMLineIndex). */
  index: number;
  /** a=ice-ufrag and a=ice-pwd, falling back to the session-level ones. */
  ufrag: string | null;
  pwd: string | null;
  /** The a=candidate lines' candidate-attributes, in order. */
  candidates: string[];
}

/**
 * Reads the ICE parameters and candidates of the (first) media section with
 * a given mid, or null if there is none. Each reader caches the last
 * description it parsed (a peer connection's transports read the same one
 * repeatedly); the sections it returns are shared, not to be changed.
 */
export function iceSectionReader(): (sdp: string, mid: string) => IceSection | null {
  let cache: { sdp: string; sections: Map<string, IceSection> } | null = null;
  return (sdp, mid) => {
    if (cache?.sdp !== sdp) cache = { sdp, sections: iceSections(sdp) };
    return cache.sections.get(mid) ?? null;
  };
}

function iceSections(sdp: string): Map<string, IceSection> {
  {
    let sessionUfrag: string | null = null;
    let sessionPwd: string | null = null;
    const all: { mid: string | null; section: IceSection }[] = [];
    let current: { mid: string | null; section: IceSection } | undefined;
    for (const line of sdp.split(/\r?\n/)) {
      if (line.startsWith('m=')) {
        current = {
          mid: null,
          section: { index: all.length, ufrag: null, pwd: null, candidates: [] },
        };
        all.push(current);
      } else if (line.startsWith('a=ice-ufrag:')) {
        const value = line.slice('a=ice-ufrag:'.length);
        if (current) current.section.ufrag = value;
        else sessionUfrag = value;
      } else if (line.startsWith('a=ice-pwd:')) {
        const value = line.slice('a=ice-pwd:'.length);
        if (current) current.section.pwd = value;
        else sessionPwd = value;
      } else if (current && line.startsWith('a=mid:')) {
        current.mid = line.slice('a=mid:'.length);
      } else if (current && line.startsWith('a=candidate:')) {
        current.section.candidates.push(line.slice('a='.length));
      }
    }
    const sections = new Map<string, IceSection>();
    for (const { mid: sectionMid, section } of all) {
      if (sectionMid === null || sections.has(sectionMid)) continue;
      section.ufrag ??= sessionUfrag;
      section.pwd ??= sessionPwd;
      sections.set(sectionMid, section);
    }
    return sections;
  }
}

/**
 * One media section per ICE transport: the first mid of each BUNDLE group,
 * plus every unbundled section that isn't rejected.
 */
export function transportSections(parsed: ParsedSdp): MediaSection[] {
  const bundled = new Set(parsed.bundles.flat());
  const tags = new Set(parsed.bundles.map((group) => group[0]));
  return parsed.sections.filter((section) =>
    section.mid !== null && bundled.has(section.mid) ? tags.has(section.mid) : !section.rejected,
  );
}

/** One payload type of a media section, as the SDP describes it. */
export interface SdpCodec {
  payloadType: number;
  /** The encoding name as written (its case varies). */
  name: string;
  clockRate: number;
  /** The a=rtpmap's channel count, if it has one. */
  channels?: number;
  /** The a=fmtp parameters, verbatim. */
  fmtp?: string;
}

// RFC 3551's static audio payload types that libwebrtc implements, for
// m-lines that list them without an a=rtpmap.
const staticPayloadTypes: Partial<Record<number, { name: string; clockRate: number }>> = {
  0: { name: 'PCMU', clockRate: 8000 },
  8: { name: 'PCMA', clockRate: 8000 },
  9: { name: 'G722', clockRate: 8000 },
  13: { name: 'CN', clockRate: 8000 },
};

/**
 * The payload types of each media section that has a mid, keyed by mid, in
 * m-line order (the order of preference). A payload type with neither an
 * a=rtpmap nor a static assignment is left out.
 */
export function sectionCodecs(sdp: string): Map<string, SdpCodec[]> {
  const result = new Map<string, SdpCodec[]>();
  let mid: string | null = null;
  let order: number[] = [];
  let rtpmaps = new Map<number, Omit<SdpCodec, 'payloadType' | 'fmtp'>>();
  let fmtps = new Map<number, string>();
  const finish = () => {
    if (mid === null) return;
    result.set(
      mid,
      order.flatMap((pt): SdpCodec[] => {
        const map = rtpmaps.get(pt) ?? staticPayloadTypes[pt];
        if (!map) return [];
        const fmtp = fmtps.get(pt);
        return [{ payloadType: pt, ...map, ...(fmtp === undefined ? {} : { fmtp }) }];
      }),
    );
  };
  let inSection = false;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      finish();
      inSection = true;
      mid = null;
      order = line.split(' ').slice(3).filter(Boolean).map(Number);
      rtpmaps = new Map();
      fmtps = new Map();
    } else if (!inSection) {
      // Session-level lines.
    } else if (line.startsWith('a=mid:')) {
      mid = line.slice('a=mid:'.length);
    } else if (line.startsWith('a=rtpmap:')) {
      const match = /^a=rtpmap:(\d+) ([^/\s]+)\/(\d+)(?:\/(\d+))?/.exec(line);
      if (match) {
        rtpmaps.set(Number(match[1]), {
          name: match[2] as string,
          clockRate: Number(match[3]),
          ...(match[4] === undefined ? {} : { channels: Number(match[4]) }),
        });
      }
    } else if (line.startsWith('a=fmtp:')) {
      const match = /^a=fmtp:(\d+) (.*)$/.exec(line);
      if (match) fmtps.set(Number(match[1]), (match[2] as string).trim());
    }
  }
  finish();
  return result;
}
