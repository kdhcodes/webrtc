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
# renames every package (and what the loader looks for).
#
# Install the main tarball plus the one for your platform, e.g.
#   npm install ./kdh.codes-webrtc-0.0.0.tgz ./kdh.codes-webrtc-darwin-arm64-0.0.0.tgz
#
# How the main package refers to the platform packages (PLATFORM_DEPS):
#   peer (default)  optional peerDependencies: never installed implicitly.
#   optional        optionalDependencies, as @roamhq/wrtc does: the package
#                   manager picks the platform's package itself, which is
#                   what you want once the packages are published.
# Peers are the default because nothing is published: with
# optionalDependencies npm resolves all three names in the public registry,
# and if someone publishes one of them, npm installs it and runs its install
# scripts (reproduced with a fake registry). With peers, npm still looks the
# two absent names up but never installs them. The names are now scoped
# (@kdh.codes, an npm org we own), which removes that risk with either
# wiring: only the scope's owner can publish into it.
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
cp LICENSE THIRD_PARTY_NOTICES.md "$stage/main/"
for triple in ${present[@]+"${present[@]}"}; do
  mkdir -p "$stage/$triple"
  cp "$out/prebuilds/$triple/wrtc.node" "$stage/$triple/wrtc.node"
  cp LICENSE "$stage/$triple/"
  cp "notices/$triple.md" "$stage/$triple/THIRD_PARTY_NOTICES.md"
  printf '%s\t%s\n' "$(cat "$out/prebuilds/$triple/build-id")" \
    "$(cat "$out/prebuilds/$triple/commit" 2>/dev/null || echo unknown)" >"$stage/$triple/.build"
done

# Writes the staged package.json files (main, then one per platform present).
# (The ${a[@]+...} form keeps bash 3.2 happy with an empty array under set -u.)
node - "$stage" "$build_id" "${platforms[*]}" ${present[@]+"${present[@]}"} <<'EOF'
const { readFileSync, writeFileSync, rmSync } = require('node:fs');
const [stage, buildId, all, ...present] = process.argv.slice(2);
const root = JSON.parse(readFileSync('package.json', 'utf8'));
const write = (dir, manifest) =>
  writeFileSync(`${dir}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
const platformPackage = (triple) => `${root.name}-${triple}`;
const engines = { node: '>=24' };
const legal = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];

const runtimeDeps = { ...root.dependencies };
delete runtimeDeps['node-addon-api']; // headers for the native build only
const wiring = process.env.PLATFORM_DEPS ?? 'peer';
if (!['peer', 'optional'].includes(wiring)) throw new Error(`PLATFORM_DEPS=${wiring}?`);
const deps = Object.fromEntries(all.split(' ').map((t) => [platformPackage(t), root.version]));
write(`${stage}/main`, {
  name: root.name,
  version: root.version,
  private: root.private,
  description: root.description,
  license: root.license,
  type: root.type,
  exports: root.exports,
  types: root.types,
  engines,
  nativeBuild: buildId,
  files: ['dist', ...legal],
  ...(Object.keys(runtimeDeps).length ? { dependencies: runtimeDeps } : {}),
  ...(wiring === 'optional'
    ? { optionalDependencies: deps }
    : {
        peerDependencies: deps,
        peerDependenciesMeta: Object.fromEntries(
          Object.keys(deps).map((name) => [name, { optional: true }]),
        ),
      }),
});
for (const triple of present) {
  const [os, cpu] = triple.split('-');
  const [built, commit] = readFileSync(`${stage}/${triple}/.build`, 'utf8').trim().split('\t');
  rmSync(`${stage}/${triple}/.build`);
  write(`${stage}/${triple}`, {
    name: platformPackage(triple),
    version: root.version,
    private: root.private,
    description: `The ${triple} native addon for ${root.name}, built from ${commit}.`,
    license: root.license,
    os: [os],
    cpu: [cpu],
    ...(os === 'linux' ? { libc: ['glibc'] } : {}),
    engines,
    nativeBuild: built,
    main: 'wrtc.node',
    files: ['wrtc.node', ...legal],
  });
}
EOF

pack() {
  (cd "$1" && pnpm pack --pack-destination "$OLDPWD/$out" >/dev/null)
}
pack "$stage/main"
for triple in ${present[@]+"${present[@]}"}; do pack "$stage/$triple"; done
rm -rf "$stage"

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
