#!/usr/bin/env bash
# Our libwebrtc builds as release assets, so CI (and anyone without the
# hours a build takes) can link the addon without building libwebrtc.
#
#   scripts/libwebrtc-assets.sh pack [<triple>...|all]    (default: all)
#   scripts/libwebrtc-assets.sh fetch [--force] [<triple>...|all]  (default: this machine's)
#
# pack: archives each third_party/libwebrtc-upstream/<os>-<arch>-release/
# (scripts/build-libwebrtc.sh's whole layout: include/, lib/libwebrtc.a,
# .source, LICENSE.md, args.gn, webrtc.ninja, ...) into
# artifacts/libwebrtc/libwebrtc-<config id>-<triple>.tar.xz, with its
# SHA-256 next to it in <asset>.sha256 (sha256sum's format). It refuses a
# build that doesn't match this checkout (scripts/gyp-webrtc.py check), since
# the asset's name claims this checkout's config id, or an asset over
# GitHub's 2 GiB limit, and prints the command that uploads the assets.
#
# fetch: downloads libwebrtc-<config id>-<triple>.tar.xz and its .sha256
# from the GitHub release tagged libwebrtc-<config id>, checks the hash,
# unpacks it into third_party/libwebrtc-upstream/ and runs gyp-webrtc.py
# check. A build already there that matches this checkout is kept as is
# (--force fetches anyway).
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
  local t dir asset size
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
    echo "$(sha256 "$out/$asset")  $asset" >"$out/$asset.sha256"
  done
  echo "libwebrtc assets for config $config_id in $out:"
  for t in $picked; do
    asset="$(asset_name "$t")"
    printf '  %-48s %5s MiB\n' "$asset" "$(($(size_of "$out/$asset") / 1024 / 1024))"
  done
  local files=""
  for t in $picked; do
    files="$files \\
    $out/$(asset_name "$t") $out/$(asset_name "$t").sha256"
  done
  cat <<EOF

Upload them (CONTRIBUTING-AGENTS.md, "CI and releases"). A new release:
  gh release create $tag --repo $repo_slug --target main --latest=false \\
    --title "libwebrtc $config_id" \\
    --notes "libwebrtc builds for config id $config_id (scripts/libwebrtc-assets.sh)"$files
or, to add to the release when it exists:
  gh release upload $tag --repo $repo_slug --clobber$files
EOF
}

cmd_fetch() {
  local force=false
  if [ "${1:-}" = --force ]; then
    force=true
    shift
  fi
  local url="${WRTC_LIBWEBRTC_BASE_URL:-https://github.com/$repo_slug/releases/download/$tag}"
  local cache="${WRTC_LIBWEBRTC_CACHE:-}"
  local tmp_cache=""
  if [ -z "$cache" ]; then
    tmp_cache="$(mktemp -d)"
    cache="$tmp_cache"
  fi
  # shellcheck disable=SC2064 # expand now: the paths are local
  trap "rm -rf '$tmp_cache' '$base'/.fetch.*" EXIT
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

    want=""
    if [ -f "$cache/$asset" ] && [ -f "$cache/$asset.sha256" ]; then
      want="$(cut -d' ' -f1 <"$cache/$asset.sha256")"
      if [ "$(sha256 "$cache/$asset")" = "$want" ]; then
        log "using $cache/$asset"
      else
        want=""
      fi
    fi
    if [ -z "$want" ]; then
      log "downloading $url/$asset"
      curl -fsSL --retry 3 --retry-delay 2 -o "$cache/$asset.sha256.partial" "$url/$asset.sha256" ||
        die "can't download $url/$asset.sha256: is there a $tag release with $t assets?" \
          "(make them with scripts/libwebrtc-assets.sh pack, CONTRIBUTING-AGENTS.md \"CI and releases\")"
      curl -fsSL --retry 3 --retry-delay 2 -o "$cache/$asset.partial" "$url/$asset" ||
        die "can't download $url/$asset"
      want="$(cut -d' ' -f1 <"$cache/$asset.sha256.partial")"
      got="$(sha256 "$cache/$asset.partial")"
      if [ "$got" != "$want" ]; then
        rm -f "$cache/$asset.partial" "$cache/$asset.sha256.partial"
        die "$asset: SHA-256 is $got, but $asset.sha256 says $want; nothing was unpacked"
      fi
      mv "$cache/$asset.sha256.partial" "$cache/$asset.sha256"
      mv "$cache/$asset.partial" "$cache/$asset"
    fi

    # Unpacked into an empty directory next to the builds, of which only
    # $dir/ is moved into place (tar itself refuses absolute and ../ paths).
    mkdir -p "$base"
    local stage
    stage="$(mktemp -d "$base/.fetch.XXXXXX")"
    tar -xJf "$cache/$asset" -C "$stage" --no-same-owner
    [ -f "$stage/$dir/lib/libwebrtc.a" ] || die "$asset has no $dir/lib/libwebrtc.a"
    rm -rf "${base:?}/$dir"
    mv "$stage/$dir" "$base/$dir"
    rm -rf "$stage"
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
  *)
    echo "usage: scripts/libwebrtc-assets.sh pack [<triple>...|all]" >&2
    echo "       scripts/libwebrtc-assets.sh fetch [--force] [<triple>...|all]" >&2
    exit 2
    ;;
esac
