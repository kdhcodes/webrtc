#!/usr/bin/env bash
# Installs only the packaged tarballs into a fresh directory and runs
# scripts/smoke.mjs there: proof that the packages work without a compiler,
# libwebrtc, this repo, or the network.
#
#   scripts/smoke-install.sh [--pm npm|pnpm] <dir with the .tgz files> [install dir]
#
# The install dir (default: a new temp dir, removed afterwards) must be
# outside the repo. The install runs offline against an empty package cache,
# so anything it would fetch from a registry fails it, and with a PATH of only
# node, the package manager and the few tools this script needs, so no
# compiler (devenv's, LLVM's or the system's) is reachable. Needs bash, tar,
# Node and the package manager; it runs as is on gpubox and in a stock node
# image.
set -euo pipefail

pm=npm
if [ "${1:-}" = --pm ]; then
  pm="$2"
  shift 2
fi
[ $# -ge 1 ] || {
  echo "usage: scripts/smoke-install.sh [--pm npm|pnpm] <tarball dir> [install dir]" >&2
  exit 2
}
here="$(cd "$(dirname "$0")" && pwd)"
tarballs="$(cd "$1" && pwd)"
triple="$(node -p 'process.platform + "-" + process.arch')"
main=""
for tgz in "$tarballs"/*.tgz; do
  # The main package is the one without an `os` field.
  if tar -xOzf "$tgz" package/package.json |
    node -e 'process.exit(JSON.parse(require("fs").readFileSync(0)).os ? 1 : 0)'; then
    main="$tgz"
  fi
done
[ -n "$main" ] || {
  echo "smoke-install: no main package tarball in $tarballs" >&2
  exit 1
}
manifest_name() {
  tar -xOzf "$1" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0)).name'
}
name="$(manifest_name "$main")"
# Matched by the name inside, not the file name: a scoped @scope/x packs as
# scope-x-<version>.tgz.
platform_tgz=""
for tgz in "$tarballs"/*.tgz; do
  [ "$(manifest_name "$tgz")" = "$name-$triple" ] && platform_tgz="$tgz"
done
[ -n "$platform_tgz" ] || {
  echo "smoke-install: no $name-$triple tarball in $tarballs" >&2
  exit 1
}

if [ $# -ge 2 ]; then
  mkdir -p "$2"
  dir="$(cd "$2" && pwd)"
else
  dir="$(mktemp -d)"
  trap 'rm -rf "$dir"' EXIT
fi
[ -z "$(ls -A "$dir")" ] || {
  echo "smoke-install: $dir is not empty" >&2
  exit 1
}
cd "$dir"
echo '{ "name": "smoke", "private": true, "type": "module" }' >package.json
cp "$here/smoke.mjs" .

echo "smoke-install: $pm $("$pm" --version), installing $(basename "$main") and $(basename "$platform_tgz") into $dir"
tools=(node "$pm" sh find rm)
mkdir .bin
for tool in "${tools[@]}"; do
  ln -s "$(command -v "$tool")" ".bin/$tool"
done
export PATH="$dir/.bin"
unset CC CXX
echo "smoke-install: PATH=$PATH, holding only: ${tools[*]}"
case "$pm" in
  npm) npm install --offline --no-audit --no-fund --no-update-notifier --cache "$dir/.cache" "$main" "$platform_tgz" ;;
  pnpm) pnpm add --offline --store-dir "$dir/.cache" "$main" "$platform_tgz" ;;
  *)
    echo "smoke-install: unknown package manager $pm" >&2
    exit 2
    ;;
esac

# Nothing may have been built during the install.
built="$(find -L node_modules -name binding.gyp -o -name '*.o' -o -type d -name build 2>/dev/null || true)"
if [ -n "$built" ]; then
  echo "smoke-install: FAIL, the install has build files:" >&2
  echo "$built" >&2
  exit 1
fi

# smoke.mjs runs itself as a child it SIGKILLs on a hang, so this always ends.
node smoke.mjs "$name"
echo "smoke-install: PASS ($triple, $pm)"
