#!/usr/bin/env bash
# Our libwebrtc builds as release assets, so CI (and anyone without the
# hours a build takes) can link the addon without building libwebrtc.
#
#   scripts/libwebrtc-assets.sh pack [<triple>...|all]    (default: all)
#   scripts/libwebrtc-assets.sh fetch [--force] [<triple>...|all]  (default: this machine's)
#   scripts/libwebrtc-assets.sh sha256 <triple>
#
# pack: archives each third_party/libwebrtc-upstream/<os>-<arch>-release/
# (scripts/build-libwebrtc.sh's whole layout: include/, lib/libwebrtc.a,
# .source, LICENSE.md, args.gn, webrtc.ninja, ...) into
# artifacts/libwebrtc/libwebrtc-<config id>-<triple>.tar.xz, and records
# each one's SHA-256 in third_party/libwebrtc-assets.sha256 (sha256sum's
# format, one line per asset, so per config id and triple), which is
# committed. It refuses a build that doesn't match this checkout
# (scripts/gyp-webrtc.py check), since the asset's name claims this
# checkout's config id, or an asset over GitHub's 2 GiB limit, and prints
# the command that uploads the assets.
#
# fetch: downloads libwebrtc-<config id>-<triple>.tar.xz from the GitHub
# release tagged libwebrtc-<config id>, checks it against the SHA-256
# committed in third_party/libwebrtc-assets.sha256 (not one from the
# release, which whoever could replace the archive could replace too),
# unpacks it into third_party/libwebrtc-upstream/ and runs gyp-webrtc.py
# check. A build already there that matches this checkout is kept as is
# (--force fetches anyway).
#
# sha256: the committed SHA-256 of this config's asset for <triple> (CI's
# cache key).
#
# <triple> is darwin-arm64, linux-x64 or linux-arm64. The config id is
# `python3 scripts/gyp-webrtc.py config-id`: what every libwebrtc build is
# made from (the pins, the recipe version, the gn args, the patches), so a
# change to any of them needs new assets (CONTRIBUTING-AGENTS.md, "CI and
# releases").
#
# Environment:
#   WRTC_LIBWEBRTC_DIR       the builds' directory (default third_party/libwebrtc-upstream)
#   WRTC_LIBWEBRTC_ASSETS    where pack writes (default artifacts/libwebrtc)
#   WRTC_LIBWEBRTC_BASE_URL  where fetch downloads from (default the release's
#                            download URL); any URL curl reads, file:// too
#   WRTC_LIBWEBRTC_CACHE     fetch keeps the downloaded archives here and reuses
#                            them (CI caches it); default: a temp dir, removed
set -euo pipefail
cd "$(dirname "$0")/.."

repo_slug=kevindhanna/webrtc
triples=(darwin-arm64 linux-arm64 linux-x64)
hashes=third_party/libwebrtc-assets.sha256

die() {
  echo "libwebrtc-assets: $*" >&2
  exit 1
}
log() { echo "libwebrtc-assets: $*" >&2; }

dir_name() {
  case "$1" in
    darwin-arm64) echo mac-arm64-release ;;
    linux-x64 | linux-arm64) echo "$1-release" ;;
    *) die "unknown triple '$1' (expected one of: ${triples[*]})" ;;
  esac
}

host_triple() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "no libwebrtc build for $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) die "no libwebrtc build for $(uname -m)" ;;
  esac
  echo "$os-$arch"
}

sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

size_of() { wc -c <"$1" | tr -d ' '; }

base="${WRTC_LIBWEBRTC_DIR:-$PWD/third_party/libwebrtc-upstream}"
config_id="$(python3 scripts/gyp-webrtc.py config-id)"
tag="libwebrtc-$config_id"
asset_name() { echo "libwebrtc-$config_id-$1.tar.xz"; }

# The committed SHA-256 of asset $1, or nothing.
committed_hash() {
  [ -f "$hashes" ] || return 0
  awk -v name="$1" '$2 == name { print $1 }' "$hashes"
}

# The triples named on the command line ("all" for every one), or $1's default.
pick_triples() {
  local default="$1"
  shift
  if [ $# -eq 0 ]; then
    if [ "$default" = all ]; then set -- "${triples[@]}"; else set -- "$default"; fi
  fi
  local t
  for t in "$@"; do
    if [ "$t" = all ]; then
      echo "${triples[@]}"
      return
    fi
    dir_name "$t" >/dev/null
  done
  echo "$@"
}

# Runs gyp-webrtc.py check on the build in $base, quietly unless $2 = loud.
check_build() {
  if [ "${2:-}" = loud ]; then
    WRTC_LIBWEBRTC_DIR="$base" python3 scripts/gyp-webrtc.py check "$1"
  else
    WRTC_LIBWEBRTC_DIR="$base" python3 scripts/gyp-webrtc.py check "$1" >/dev/null 2>&1
  fi
}

cmd_pack() {
  local out="${WRTC_LIBWEBRTC_ASSETS:-$PWD/artifacts/libwebrtc}"
  local limit=$((2 * 1024 * 1024 * 1024))
  local tar_opts=()
  # GitHub's limit is per asset. Owners are dropped either way; bsdtar
  # (macOS) would otherwise add AppleDouble files and extended attributes,
  # which GNU tar warns about on extraction.
  if tar --version 2>/dev/null | grep -q 'GNU tar'; then
    tar_opts=(--owner=0 --group=0 --numeric-owner --sort=name)
  else
    tar_opts=(--uid 0 --gid 0 --no-mac-metadata --no-xattrs)
    export COPYFILE_DISABLE=1
  fi
  local t dir asset size f
  local picked
  picked="$(pick_triples all "$@")"
  # Check everything before writing anything.
  for t in $picked; do
    dir="$(dir_name "$t")"
    [ -f "$base/$dir/lib/libwebrtc.a" ] ||
      die "no $t build in $base/$dir; build it with scripts/build-libwebrtc.sh $t"
    for f in .source LICENSE.md webrtc.ninja args.gn include; do
      [ -e "$base/$dir/$f" ] || die "$base/$dir has no $f; rebuild it with scripts/build-libwebrtc.sh $t"
    done
    check_build "$t" loud || die "refusing to pack a $t build that isn't config $config_id"
    [ ! -e "$base/$dir/licenses.log" ] ||
      log "warning: $base/$dir/licenses.log exists: its LICENSE.md is libwebrtc's own only"
  done
  mkdir -p "$out"
  local recorded=""
  for t in $picked; do
    dir="$(dir_name "$t")"
    asset="$(asset_name "$t")"
    log "packing $base/$dir into $out/$asset"
    if command -v xz >/dev/null; then
      tar -C "$base" "${tar_opts[@]}" -cf - "$dir" | xz -T0 -6 >"$out/$asset.partial"
    else
      # bsdtar compresses with its own liblzma (single-threaded).
      tar -C "$base" "${tar_opts[@]}" -cJf - "$dir" >"$out/$asset.partial"
    fi
    mv "$out/$asset.partial" "$out/$asset"
    size="$(size_of "$out/$asset")"
    [ "$size" -lt "$limit" ] || die "$out/$asset is $size bytes, over GitHub's 2 GiB asset limit"
    recorded="$recorded$(sha256 "$out/$asset")  $asset
"
  done
  # Replaces these assets' lines and keeps every other config's.
  {
    if [ -f "$hashes" ]; then
      for t in $picked; do echo "$(asset_name "$t")"; done |
        awk 'NR == FNR { packed[$1] = 1; next } !($2 in packed)' - "$hashes"
    fi
    printf '%s' "$recorded"
  } | LC_ALL=C sort -k2 >"$hashes.partial"
  mv "$hashes.partial" "$hashes"

  echo "libwebrtc assets for config $config_id in $out:"
  for t in $picked; do
    asset="$(asset_name "$t")"
    printf '  %-48s %5s MiB\n' "$asset" "$(($(size_of "$out/$asset") / 1024 / 1024))"
  done
  local files=""
  for t in $picked; do
    files="$files \\
    $out/$(asset_name "$t")"
  done
  cat <<EOF

Their SHA-256s are in $hashes: commit it, since fetch checks
downloads against it. Upload the assets before pushing that commit
(CONTRIBUTING-AGENTS.md, "CI and releases"):
  gh release create $tag --repo $repo_slug --target main --latest=false \\
    --title "libwebrtc $config_id" \\
    --notes "libwebrtc builds for config id $config_id (scripts/libwebrtc-assets.sh)"$files
EOF
}

stage=""
tmp_cache=""
# Only what this run made: another checkout sharing $base (a worktree's
# link) may be unpacking into it at the same time.
cleanup() {
  if [ -n "$stage" ]; then rm -rf "$stage"; fi
  if [ -n "$tmp_cache" ]; then rm -rf "$tmp_cache"; fi
}
trap cleanup EXIT

cmd_fetch() {
  local force=false
  if [ "${1:-}" = --force ]; then
    force=true
    shift
  fi
  local url="${WRTC_LIBWEBRTC_BASE_URL:-https://github.com/$repo_slug/releases/download/$tag}"
  local cache="${WRTC_LIBWEBRTC_CACHE:-}"
  if [ -z "$cache" ]; then
    tmp_cache="$(mktemp -d)"
    cache="$tmp_cache"
  fi
  mkdir -p "$cache"

  if [ -L "$base" ]; then
    log "$base links to $(readlink "$base"), which other checkouts may share"
  fi
  local t dir asset want got picked
  picked="$(pick_triples "$(host_triple)" "$@")"
  for t in $picked; do
    dir="$(dir_name "$t")"
    asset="$(asset_name "$t")"
    if [ -f "$base/$dir/.source" ] && check_build "$t"; then
      if ! $force; then
        log "$base/$dir is already config $config_id; keeping it (--force to fetch anyway)"
        continue
      fi
    elif [ -L "$base" ] && [ -f "$base/$dir/.source" ]; then
      # As scripts/build-libwebrtc.sh: don't replace another checkout's build.
      die "$base links to $(readlink "$base"), which other checkouts use, and its $dir build" \
        "is another configuration. Replace the link with a directory (or set WRTC_LIBWEBRTC_DIR)" \
        "to fetch your own."
    fi

    want="$(committed_hash "$asset")"
    [ -n "$want" ] ||
      die "no SHA-256 for $asset in $hashes: scripts/libwebrtc-assets.sh pack records it" \
        "when it makes the asset, and that commit must be in this checkout" \
        "(CONTRIBUTING-AGENTS.md, \"CI and releases\")"
    if [ -f "$cache/$asset" ] && [ "$(sha256 "$cache/$asset")" = "$want" ]; then
      log "using $cache/$asset"
    else
      [ ! -f "$cache/$asset" ] || log "$cache/$asset doesn't match $hashes; downloading it again"
      rm -f "$cache/$asset"
      log "downloading $url/$asset"
      curl -fsSL --retry 3 --retry-delay 2 -o "$cache/$asset.partial" "$url/$asset" ||
        die "can't download $url/$asset: is there a $tag release with $t assets?" \
          "(make them with scripts/libwebrtc-assets.sh pack, CONTRIBUTING-AGENTS.md \"CI and releases\")"
      got="$(sha256 "$cache/$asset.partial")"
      if [ "$got" != "$want" ]; then
        rm -f "$cache/$asset.partial"
        die "$asset: SHA-256 is $got, but $hashes says $want; nothing was unpacked"
      fi
      mv "$cache/$asset.partial" "$cache/$asset"
    fi

    # Unpacked into an empty directory next to the builds, of which only
    # $dir/ is moved into place (tar itself refuses absolute and ../ paths).
    mkdir -p "$base"
    stage="$(mktemp -d "$base/.fetch.XXXXXX")"
    tar -xJf "$cache/$asset" -C "$stage" --no-same-owner
    [ -f "$stage/$dir/lib/libwebrtc.a" ] || die "$asset has no $dir/lib/libwebrtc.a"
    rm -rf "${base:?}/$dir"
    mv "$stage/$dir" "$base/$dir"
    rm -rf "$stage"
    stage=""
    check_build "$t" loud || die "the unpacked $t build doesn't match this checkout"
    log "$base/$dir: config $config_id, from $asset"
  done
}

case "${1:-}" in
  pack)
    shift
    cmd_pack "$@"
    ;;
  fetch)
    shift
    cmd_fetch "$@"
    ;;
  sha256)
    [ $# -eq 2 ] || die "usage: scripts/libwebrtc-assets.sh sha256 <triple>"
    dir_name "$2" >/dev/null
    want="$(committed_hash "$(asset_name "$2")")"
    [ -n "$want" ] || die "no SHA-256 for $(asset_name "$2") in $hashes"
    echo "$want"
    ;;
  *)
    echo "usage: scripts/libwebrtc-assets.sh pack [<triple>...|all]" >&2
    echo "       scripts/libwebrtc-assets.sh fetch [--force] [<triple>...|all]" >&2
    echo "       scripts/libwebrtc-assets.sh sha256 <triple>" >&2
    exit 2
    ;;
esac
