/**
 * Remote ICE-TCP candidates aimed at a Fetch "bad port" are ignored.
 *
 * webrtc-pc (ICE candidate administrative prohibition): "The UA MUST
 * prohibit connections to addresses on the [Fetch] block bad port list",
 * silently, "exactly as if there was no response from the address". WPT's
 * RTCPeerConnection-addTcpIceCandidate.html checks it for TCP candidates
 * from both setRemoteDescription and addIceCandidate. Chrome does it in its
 * network service, which a libwebrtc embedder doesn't have; libwebrtc
 * itself only drops ports below 1024 (other than 80 and 443) for every
 * protocol (VerifyCandidate), so the bad ports from 1719 up got a TCP
 * connection attempt.
 *
 * Only TCP: Fetch's list is about stream connections to other services, and
 * UDP media servers do use ports in it (mediasoup's default range starts at
 * 10000). Active TCP candidates are left alone: we never connect to them
 * (they connect to us), and they conventionally carry port 9, which is on
 * the list.
 */

/** https://fetch.spec.whatwg.org/#bad-port, as of 2026-11. */
const badPorts = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/**
 * Whether `candidate` (a candidate-attribute, with or without SDP's `a=`)
 * is a TCP candidate libwebrtc would accept and connect to on a bad port.
 * The rule is "block whatever libwebrtc accepts", so this checks no more
 * than libwebrtc's parser does (probed against it): trailing spaces and
 * line breaks are ignored; `candidate:` and `typ` are exact; fields are
 * single-space separated; component and priority are uint32 (0 allowed),
 * the port at most 65535; the foundation isn't checked; the transport
 * (`tcp`/`ssltcp`) and the `tcptype` keyword are case-insensitive, its
 * value isn't; extensions come in pairs. Anything libwebrtc rejects isn't
 * blocked, so it still rejects there as it would any other candidate.
 */
export function isBlockedCandidate(candidate: string): boolean {
  let text = candidate.replace(/[ \r\n]+$/, '');
  if (text.startsWith('a=')) text = text.slice(2);
  if (!text.startsWith('candidate:')) return false;
  const parts = text.slice('candidate:'.length).split(' ');
  if (parts.length < 8 || parts.length % 2 !== 0) return false;
  const [, component, transport, priority, , port, typ] = parts;
  const uint = (value: string | undefined, max: number) =>
    value !== undefined && /^[0-9]{1,10}$/.test(value) && Number(value) <= max;
  if (typ !== 'typ' || !uint(component, 2 ** 32 - 1) || !uint(priority, 2 ** 32 - 1)) {
    return false;
  }
  if (!uint(port, 65535) || !badPorts.has(Number(port))) return false;
  const protocol = transport?.toLowerCase();
  if (protocol !== 'tcp' && protocol !== 'ssltcp') return false;
  for (let i = 8; i + 1 < parts.length; i += 2) {
    if (parts[i]?.toLowerCase() === 'tcptype') {
      // Only the values libwebrtc takes; never active (we don't connect).
      return parts[i + 1] === 'passive' || parts[i + 1] === 'so';
    }
  }
  return true;
}

/**
 * `sdp` without its blocked `a=candidate` lines (see isBlockedCandidate),
 * each removed with its own line terminator, whatever the others use.
 */
export function withoutBlockedCandidates(sdp: string): string {
  return sdp.replace(/^a=candidate:[^\r\n]*(?:\r?\n|$)/gm, (line) =>
    isBlockedCandidate(line) ? '' : line,
  );
}
