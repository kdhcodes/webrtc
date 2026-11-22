/**
 * Works around a libwebrtc bug (PLAN.md "Gotchas"; upstream report draft in
 * docs/upstream/libwebrtc-rollback-extmap-collision.md): after a rollback,
 * the offer libwebrtc creates can give an RTP header extension an id that
 * the BUNDLE group already uses for a different extension, and libwebrtc
 * then rejects its own offer in SLD: InvalidAccessError "A BUNDLE group
 * contains a codec collision for header extension id=N".
 *
 * Cause (libwebrtc M150, 05e02da): the PeerConnection-wide
 * RtpHeaderExtensionPicker remembers every uri -> id it ever suggested and
 * is never reset on rollback (call/payload_type_picker.cc:418-429), and
 * neither are the per-BUNDLE recorders (pc/sdp_payload_type_suggester.cc:
 * 123-159). The reuse branch never checks that the id is still free in the
 * target group. An upstream regression (webrtc d1ae1e9, April 2026); Chrome
 * 158/159 have it too.
 *
 * Re-check on every libwebrtc upgrade: drop this once
 * test/integration/signaling.test.ts passes without it.
 */

/**
 * Renumbers the a=extmap lines of each offer section where an id collides
 * with a different extension in the same BUNDLE group. Sections whose mid is
 * in `established` (already negotiated) are read first and normally keep
 * their ids. In a colliding section, each extension the group already has
 * takes the group's id for it; the others keep their own id if it's still
 * free, or else take a free one: from 14 down (as libwebrtc picks), then 16
 * to 255 when the offer allows two-byte ids (a=extmap-allow-mixed). Sections
 * without a collision, and offers without one, are left as they are
 * (`sdp` itself is returned).
 */
export function fixBundledExtmapCollisions(sdp: string, established: ReadonlySet<string>): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const sections: Section[] = [];
  const bundles: string[][] = [];
  let allowMixed = false;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('m=')) {
      sections.push({ mid: null, extmaps: [] });
      continue;
    }
    if (line === 'a=extmap-allow-mixed') allowMixed = true;
    const current = sections.at(-1);
    if (line.startsWith('a=group:BUNDLE ')) {
      bundles.push(line.split(' ').slice(1).filter(Boolean));
    } else if (current && line.startsWith('a=mid:')) {
      current.mid = line.slice('a=mid:'.length);
    } else if (current) {
      const extmap = parseExtmap(line);
      if (extmap) current.extmaps.push({ index, ...extmap });
    }
  }
  // Ids used anywhere in the offer: a free id must be free in every group.
  const used = new Set(sections.flatMap((s) => s.extmaps.map((e) => e.id)));

  let changed = false;
  for (const group of bundles) {
    const members = sections.filter((s) => s.mid !== null && group.includes(s.mid));
    const isEstablished = (s: Section) => s.mid !== null && established.has(s.mid);
    const ordered = [...members.filter(isEstablished), ...members.filter((s) => !isEstablished(s))];
    const idToKey = new Map<number, string>();
    const keyToId = new Map<string, number>();
    for (const section of ordered) {
      const collides = section.extmaps.some((e) => {
        const owner = idToKey.get(e.id);
        return owner !== undefined && owner !== e.key;
      });
      if (collides) {
        // Two passes, so that an extension never ends up with two ids in
        // the group (RFC 8843; libwebrtc's BUNDLE transport keeps only one):
        // first every extension the group already has takes the group's id,
        // then the others keep theirs if still free, or take a free one.
        const assigned = new Map<Extmap, number>();
        for (const e of section.extmaps) {
          const id = keyToId.get(e.key);
          if (id !== undefined) assigned.set(e, id);
        }
        const taken = new Set(assigned.values());
        for (const e of section.extmaps) {
          if (assigned.has(e)) continue;
          // Nothing free: keep the id and leave the offer for libwebrtc to reject.
          const id =
            idToKey.has(e.id) || taken.has(e.id) ? (freeId(used, allowMixed) ?? e.id) : e.id;
          used.add(id);
          taken.add(id);
          assigned.set(e, id);
        }
        for (const [e, id] of assigned) {
          if (id === e.id) continue;
          e.id = id;
          lines[e.index] = (lines[e.index] ?? '').replace(/^a=extmap:\d+/, `a=extmap:${id}`);
          changed = true;
        }
      }
      for (const e of section.extmaps) {
        if (!idToKey.has(e.id)) idToKey.set(e.id, e.key);
        if (!keyToId.has(e.key)) keyToId.set(e.key, e.id);
      }
    }
  }
  return changed ? lines.join(eol) : sdp;
}

/** Whether `error` is the SLD rejection fixBundledExtmapCollisions prevents. */
export function isExtmapCollision(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'InvalidAccessError' &&
    error.message.includes('A BUNDLE group contains a codec collision for header extension id=')
  );
}

interface Extmap {
  /** Index of the a=extmap line. */
  index: number;
  id: number;
  /** The extension's identity: its URI, and whether it's the encrypted form. */
  key: string;
}

interface Section {
  mid: string | null;
  extmaps: Extmap[];
}

const ENCRYPT = 'urn:ietf:params:rtp-hdrext:encrypt';

/** a=extmap:<id>[/<direction>] [urn:ietf:params:rtp-hdrext:encrypt] <uri> [<attributes>] */
function parseExtmap(line: string): { id: number; key: string } | null {
  const match = /^a=extmap:(\d+)(?:\/\S+)? (\S+)(?: (\S+))?/.exec(line);
  if (!match) return null;
  const [, id, first, second] = match;
  const encrypted = first === ENCRYPT && second !== undefined;
  return { id: Number(id), key: encrypted ? `encrypted ${second}` : `plain ${first}` };
}

function freeId(used: ReadonlySet<number>, allowMixed: boolean): number | undefined {
  for (let id = 14; id >= 1; id--) if (!used.has(id)) return id;
  // 15 is reserved in the one-byte form and avoided in the two-byte one.
  if (allowMixed) for (let id = 16; id <= 255; id++) if (!used.has(id)) return id;
  return undefined;
}
