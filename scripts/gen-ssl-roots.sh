#!/usr/bin/env bash
# Regenerates patches/0003-ssl-roots-from-node.patch: libwebrtc's
# compiled-in root certificates (rtc_base/ssl_roots.h, what TURN over TLS
# verifies `turns:` servers against) from Node's bundled Mozilla roots
# (`tls.rootCertificates`), with upstream's own generator
# (tools_webrtc/sslroots/generate_sslroots.py).
#
#   scripts/gen-ssl-roots.sh
#
# Why these roots: M150's list (Google's pki.goog bundle) has no ISRG (Let's
# Encrypt) root, and the roots can't be supplied at runtime instead: on
# Linux libwebrtc's BoringSSL symbols are renamed BSSL_*, so a runtime
# SSLCertificateVerifier would be handed BoringSSL objects but bind to
# Node's OpenSSL.
#
# Run it with the Node the addon targets (the devenv's Node 24), before
# rebuilding libwebrtc (scripts/build-libwebrtc.sh <triple>, every triple);
# a new patch changes the native build id. If only the generator's
# timestamp or copyright year would change, the patch is left as it is.
#
# Environment:
#   WEBRTC_CHECKOUT  the gclient root scripts/build-libwebrtc.sh uses
#                    (default ~/src/webrtc-m150): the generator, the
#                    pristine ssl_roots.h (from git, at the pinned commit) and
#                    vpython3 (for the generator's asn1crypto) come from it.
#   NODE             the node binary whose roots to use (default: node on PATH)
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$PWD"

die() {
  echo "gen-ssl-roots: $*" >&2
  exit 1
}

root="${WEBRTC_CHECKOUT:-$HOME/src/webrtc-m150}"
node="$(command -v "${NODE:-node}")" || die "no node on PATH"
commit="$(sed -n 's/^webrtc_commit=//p' scripts/build-libwebrtc.sh)"
patch_file="$repo/patches/0003-ssl-roots-from-node.patch"
generator="$root/src/tools_webrtc/sslroots/generate_sslroots.py"
[ -n "$commit" ] || die "no webrtc_commit= in scripts/build-libwebrtc.sh"
[ -f "$generator" ] || die "no $generator; run scripts/build-libwebrtc.sh <triple> sync first"

node_version="$("$node" -p process.version)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/a/rtc_base" "$tmp/b/rtc_base"

# The name is what the generated header records as its source.
pem="node-$node_version-root-certificates.pem"
"$node" -e 'process.stdout.write(`${require("node:tls").rootCertificates.join("\n")}\n`)' >"$tmp/$pem"
count="$(grep -c 'BEGIN CERTIFICATE' "$tmp/$pem")"
grep -q 'ISRG Root X1' <("$node" -e '
  const { X509Certificate } = require("node:crypto");
  for (const pem of require("node:tls").rootCertificates) console.log(new X509Certificate(pem).subject);
') || die "Node $node_version's roots have no ISRG Root X1; is this the right node?"

git -C "$root/src" show "$commit:rtc_base/ssl_roots.h" >"$tmp/a/rtc_base/ssl_roots.h" ||
  die "can't read rtc_base/ssl_roots.h at $commit from $root/src"

# Writes ssl_roots.h next to the PEM. The same clean environment as
# build-libwebrtc.sh; vpython3 finds the generator's dependencies in the
# checkout's .vpython3.
(
  cd "$tmp"
  env -i HOME="$HOME" PATH="$root/depot_tools:/usr/bin:/bin" DEPOT_TOOLS_UPDATE=0 \
    DEPOT_TOOLS_METRICS=0 vpython3 "$generator" "$pem"
)
# The checked-in header includes <cstddef> for size_t; the generator doesn't
# write it.
awk '{ print }
  /^#define RTC_BASE_SSL_ROOTS_H_$/ && !done { print ""; print "#include <cstddef>"; done = 1 }' \
  "$tmp/ssl_roots.h" >"$tmp/b/rtc_base/ssl_roots.h"
grep -q '^#include <cstddef>$' "$tmp/ssl_roots.h" && die "the generator now writes <cstddef> itself; drop the awk above"
generated="$(grep -c '^/\* subject: ' "$tmp/b/rtc_base/ssl_roots.h")"
[ "$generated" -eq "$count" ] || die "the header has $generated roots, Node $node_version has $count"

{
  cat <<EOF
libwebrtc-rs-js: rtc_base/ssl_roots.h, the root certificates libwebrtc
verifies TURN over TLS (turns:) servers against, regenerated from Node
$node_version's bundled root certificates (tls.rootCertificates: Mozilla's
CA list as Node ships it, $count roots) with upstream's
tools_webrtc/sslroots/generate_sslroots.py, by scripts/gen-ssl-roots.sh.
Rerun that to refresh them (CONTRIBUTING-AGENTS.md).

M150's own list (36 roots from pki.goog) has no ISRG (Let's Encrypt) root,
so TURN over TLS to a server with a Let's Encrypt certificate failed the
handshake. The roots can't be supplied at runtime instead: on Linux
BoringSSL's symbols are renamed BSSL_*, so a runtime certificate verifier
would bind to Node's OpenSSL.

EOF
  echo "diff --git a/rtc_base/ssl_roots.h b/rtc_base/ssl_roots.h"
  # diff exits 1 when the files differ.
  (cd "$tmp" && diff -u a/rtc_base/ssl_roots.h b/rtc_base/ssl_roots.h || [ $? -eq 1 ]) |
    sed -E '1,2s/\t.*$//'
} >"$tmp/new.patch"

# The generator stamps the time it ran and the year as the copyright's;
# ignore those lines when comparing, so a rerun with the same Node (even in a
# new year) doesn't churn the patch.
strip_time() { grep -vE '^[+](// It was generated at | \*  Copyright [0-9]{4} )' "$1"; }
if [ -f "$patch_file" ] && cmp -s <(strip_time "$patch_file") <(strip_time "$tmp/new.patch"); then
  echo "gen-ssl-roots: ${patch_file#"$repo"/} is up to date (Node $node_version, $count roots)"
  exit 0
fi
mv "$tmp/new.patch" "$patch_file"
echo "gen-ssl-roots: wrote ${patch_file#"$repo"/} (Node $node_version, $count roots);" \
  "rebuild libwebrtc for every triple"
