#!/usr/bin/env bash
# Assembles locally installable packages into artifacts/. Builds no native code.
#
#   scripts/package.sh [--strict]
#
#   artifacts/<name>-<version>.tgz           the JS (dist/ and its types), rebuilt with build:ts
#   artifacts/<name>-<triple>-<version>.tgz  wrtc.node for each platform whose binary is in
#                                            artifacts/prebuilds/<triple>/ (scripts/prebuild.sh)
#
# Every package carries LICENSE (ours, MIT) and THIRD_PARTY_NOTICES.md: in a
# platform package, notices/<triple>.md (what that platform's wrtc.node
# links: libwebrtc and its third-party code); in the main package, the union.
# Regenerate them with scripts/third-party-notices.mjs when the libwebrtc
# build changes (CONTRIBUTING-AGENTS.md, Packaging).
#
# The platform packages are named <name>-<triple>, in the same scope (e.g.
# @kdh.codes/webrtc-linux-x64). pnpm pack names a scoped @scope/x's
# tarball scope-x-<version>.tgz, so <name> in the file names above drops the
# @ and turns the / into -.
#
# Both carry `nativeBuild`, the id of the native inputs (scripts/native-inputs.sh):
# the main package's from the working tree now, each platform package's from
# when its binary was built. The loader refuses a pair whose ids differ, so a
# binary built from other native sources fails the run (before anything in
# artifacts/ changes), as does one linked against a libwebrtc build made
# from other gn args, patches or upstream commit (its `libwebrtc-source`,
# from prebuild.sh). One built from uncommitted native sources is a
# warning, or an error with --strict.
#
# The package name and version come from package.json; renaming it there
# renames every package (and what the loader looks for). So do the fields
# every package carries for the registry (license, repository, homepage,
# bugs, publishConfig); npm's provenance check needs `repository` in each.
# The manifests come from scripts/package-manifests.mjs.
#
# Install the main tarball plus the one for your platform, e.g.
#   npm install ./kdh.codes-webrtc-0.1.0.tgz ./kdh.codes-webrtc-darwin-arm64-0.1.0.tgz
# These tarballs are also what gets published, platform packages first
# (CONTRIBUTING-AGENTS.md, "CI and releases").
#
# How the main package refers to the platform packages (PLATFORM_DEPS), each
# at exactly the main package's version:
#   optional (default)  optionalDependencies, as @roamhq/wrtc does: the
#                       package manager installs the platform's package itself.
#   peer                optional peerDependencies: never installed implicitly,
#                       so install the platform's package next to the main one.
# With optionalDependencies npm resolves all three names in the public
# registry, and if someone else had published one of them, npm would install
# it and run its install scripts (reproduced with a fake registry); that's
# why peers were the default before anything was published. The names are
# scoped (@kdh.codes, an npm org we own), which removes that risk: only the
# scope's owner can publish into it.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/native-inputs.sh

strict=false
case "${1:-}" in
  --strict) strict=true ;;
  "") ;;
  *)
    echo "usage: scripts/package.sh [--strict]" >&2
    exit 2
    ;;
esac

out=artifacts
stage="$out/stage"
build_id="$(native_build_id)"

# Check the binaries before touching artifacts/, so a refused run keeps the
# last good tarballs.
errors=()
warnings=()
present=()
for triple in "${platforms[@]}"; do
  dir="$out/prebuilds/$triple"
  [ -f "$dir/wrtc.node" ] || continue
  present+=("$triple")
  [ -f "notices/$triple.md" ] ||
    errors+=("no notices/$triple.md; generate it with scripts/third-party-notices.mjs")
  built="$(cat "$dir/build-id" 2>/dev/null || echo unknown)"
  commit="$(cat "$dir/commit" 2>/dev/null || echo unknown)"
  if [ "$built" != "$build_id" ]; then
    errors+=("$triple's binary is native build $built, but the native inputs are now $build_id; the loader would refuse the pair")
  fi
  # What prebuild.sh checked before linking, checked again: a binary linked
  # against a libwebrtc build of other args or patches would carry a build
  # id that claims this checkout's.
  if ! mismatch="$(python3 scripts/gyp-webrtc.py check "$triple" --source "$dir/libwebrtc-source" 2>&1)"; then
    errors+=("$triple's binary: $mismatch")
  fi
  case "$commit" in
    *dirty*)
      dirty="$triple's binary was built from uncommitted native sources ($commit)"
      if $strict; then errors+=("$dirty"); else warnings+=("$dirty"); fi
      ;;
  esac
done
if [ ${#warnings[@]} -gt 0 ]; then
  for w in "${warnings[@]}"; do echo "warning: $w" >&2; done
fi
if [ ${#errors[@]} -gt 0 ]; then
  for e in "${errors[@]}"; do echo "error: $e" >&2; done
  echo "rebuild with scripts/prebuild.sh <platform>, then rerun scripts/package.sh;" \
    "artifacts/*.tgz are unchanged" >&2
  exit 1
fi

rm -rf "$stage" "$out"/*.tgz
mkdir -p "$stage/main"
# No source maps: they would point at lib/*.ts, which isn't shipped.
rm -rf dist
pnpm run build:ts --sourceMap false >/dev/null
cp -R dist "$stage/main/dist"
cp README.md LICENSE THIRD_PARTY_NOTICES.md "$stage/main/"
for triple in ${present[@]+"${present[@]}"}; do
  mkdir -p "$stage/$triple"
  cp "$out/prebuilds/$triple/wrtc.node" "$stage/$triple/wrtc.node"
  cp LICENSE "$stage/$triple/"
  cp "notices/$triple.md" "$stage/$triple/THIRD_PARTY_NOTICES.md"
  printf '%s\t%s\n' "$(cat "$out/prebuilds/$triple/build-id")" \
    "$(cat "$out/prebuilds/$triple/commit" 2>/dev/null || echo unknown)" >"$stage/$triple/.build"
done

# The staged package.json files (main, then one per platform present) and
# each platform package's README.
# (The ${a[@]+...} form keeps bash 3.2 happy with an empty array under set -u.)
node scripts/package-manifests.mjs "$stage" "$build_id" "${platforms[*]}" \
  ${present[@]+"${present[@]}"}

pack() {
  (cd "$1" && pnpm pack --pack-destination "$OLDPWD/$out" >/dev/null)
}
pack "$stage/main"
for triple in ${present[@]+"${present[@]}"}; do pack "$stage/$triple"; done
rm -rf "$stage"
# npm's package page shows the README of the main package's tarball.
main_tgz="$out/$(node -p 'const p = require("./package.json"); `${p.name.replace("@", "").replace("/", "-")}-${p.version}.tgz`')"
# (Not `tar | grep -q`: grep's early exit would fail tar under pipefail.)
main_files="$(tar -tzf "$main_tgz")"
grep -qx package/README.md <<<"$main_files" || {
  echo "error: $main_tgz has no README.md" >&2
  exit 1
}

echo "packages in $out/ (native build $build_id):"
for tgz in "$out"/*.tgz; do
  printf '  %-45s %6s KiB\n' "$(basename "$tgz")" "$(($(wc -c <"$tgz") / 1024))"
done
missing=()
for triple in "${platforms[@]}"; do
  is_present=false
  for p in ${present[@]+"${present[@]}"}; do [ "$p" = "$triple" ] && is_present=true; done
  $is_present || missing+=("$triple")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "no binary, so no package, for: ${missing[*]}" >&2
  echo "build them with scripts/prebuild.sh <platform>, then rerun scripts/package.sh" >&2
fi
