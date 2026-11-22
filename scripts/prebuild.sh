#!/usr/bin/env bash
# Builds the stripped native addon for one platform into
# artifacts/prebuilds/<triple>/wrtc.node, for scripts/package.sh.
#
#   scripts/prebuild.sh darwin-arm64   # here, on an arm64 Mac: pnpm run build
#   scripts/prebuild.sh linux-arm64    # Docker (docker/linux.Dockerfile) on an arm64 host
#   scripts/prebuild.sh linux-x64      # Docker on an x64 host (CI); from anywhere
#                                      # else on gpubox, through scripts/gpubox-test.sh
#   scripts/prebuild.sh all            # all three, in that order
#
# A Linux binary builds in Docker whenever the host has its architecture, so
# CI's Linux runners (.github/workflows/release.yml) and an arm64 Mac build
# the same way. Each links our libwebrtc build (scripts/build-libwebrtc.sh,
# or scripts/libwebrtc-assets.sh fetch): from third_party/libwebrtc-upstream/
# here (or WRTC_LIBWEBRTC_DIR), except linux-x64 on gpubox, which uses the
# box's build for this checkout's configuration (see
# scripts/gpubox-test.sh). Get those first; this script doesn't. It refuses
# a libwebrtc build whose .source records other gn args,
# patches or upstream commit than the checkout has now
# (scripts/gyp-webrtc.py check): the binary would carry a build id that
# claims otherwise.
#
# Each binary is built from the current checkout, uncommitted changes
# included. Next to it go `build-id` (scripts/native-inputs.sh), `commit`
# (with " (dirty)" when the native inputs had uncommitted changes) and
# `libwebrtc-source`, the linked libwebrtc build's .source (package.sh checks
# it again). A failed build keeps the previous binary.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/native-inputs.sh

host="${GPUBOX_HOST:-gpubox}"
tmp=""
remote=""

die() {
  echo "prebuild: $*" >&2
  exit 1
}

cleanup() {
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
  if [ -n "$remote" ]; then
    ssh -o BatchMode=yes "$host" "rm -rf $(printf %q "$remote")" || true
  fi
}
trap cleanup EXIT

# Highest GLIBC_x.y symbol version an ELF binary needs: the oldest glibc it loads on.
glibc_floor() {
  LC_ALL=C grep -aoE 'GLIBC_[0-9]+\.[0-9]+(\.[0-9]+)?' "$1" | sort -uV | tail -1
}

# Where the libwebrtc build for a triple is on this machine.
libwebrtc_dir() {
  local base="${WRTC_LIBWEBRTC_DIR:-$PWD/third_party/libwebrtc-upstream}"
  case "$1" in
    darwin-arm64) echo "$base/mac-arm64-release" ;;
    *) echo "$base/$1-release" ;;
  esac
}

# Fails unless the libwebrtc build whose .source (or a copy of it) is $2 is
# made from this checkout's args, patches and upstream commit.
check_libwebrtc() {
  python3 scripts/gyp-webrtc.py check "$1" --source "$2" ||
    die "refusing to build $1 against that libwebrtc build"
}

build_one() {
  local triple="$1"
  local dest="artifacts/prebuilds/$triple"
  local id commit
  id="$(native_build_id)"
  commit="$(git rev-parse HEAD)"
  if native_dirty; then commit="$commit (dirty)"; fi

  mkdir -p artifacts/prebuilds
  tmp="$(mktemp -d "artifacts/prebuilds/.$triple.XXXXXX")"
  case "$triple" in
    darwin-arm64)
      [ "$(uname -sm)" = "Darwin arm64" ] || die "darwin-arm64 builds on an arm64 Mac only"
      [ -f "$(libwebrtc_dir "$triple")/lib/libwebrtc.a" ] ||
        die "no libwebrtc build in $(libwebrtc_dir "$triple"); run scripts/libwebrtc-assets.sh" \
          "fetch $triple, or scripts/build-libwebrtc.sh $triple"
      check_libwebrtc "$triple" "$(libwebrtc_dir "$triple")/.source"
      cp "$(libwebrtc_dir "$triple")/.source" "$tmp/libwebrtc-source"
      pnpm run build
      # -x drops local symbols only; Apple's strip re-signs the (ad-hoc,
      # linker-signed) binary, which arm64 macOS requires to load it.
      /usr/bin/strip -x -o "$tmp/wrtc.node" build/Release/wrtc.node
      codesign --verify "$tmp/wrtc.node"
      node -e "require(process.argv[1])" "$PWD/$tmp/wrtc.node"
      ;;
    linux-arm64 | linux-x64)
      if [ "$(host_arch)" = "${triple#linux-}" ]; then
        docker_build "$triple"
      elif [ "$triple" = linux-arm64 ]; then
        die "linux-arm64 builds in Docker on an arm64 host (natively, not emulated)"
      else
        gpubox_build
      fi
      ;;
  esac

  echo "$id" >"$tmp/build-id"
  echo "$commit" >"$tmp/commit"
  rm -rf "$dest"
  mv "$tmp" "$dest"
  tmp=""
  cleanup
  remote=""

  local size
  size="$(wc -c <"$dest/wrtc.node" | tr -d ' ')"
  echo "prebuild: $dest/wrtc.node, $((size / 1024)) KiB, native build $id, from $commit"
  case "$triple" in
    linux-*) echo "prebuild: $triple needs glibc >= $(glibc_floor "$dest/wrtc.node" | sed 's/GLIBC_//')" ;;
  esac
}

# Docker's name for a Linux triple's platform (x64 is amd64 there).
docker_platform() {
  case "$1" in
    linux-x64) echo linux/amd64 ;;
    linux-arm64) echo linux/arm64 ;;
    *) die "no Docker platform for $1" ;;
  esac
}

host_arch() {
  case "$(uname -m)" in
    arm64 | aarch64) echo arm64 ;;
    x86_64) echo x64 ;;
    *) uname -m ;;
  esac
}

# A Linux binary from docker/linux.Dockerfile's `addon` target, on a host of
# the same architecture (an arm64 Mac, or a Linux CI runner), into $tmp.
docker_build() {
  local triple="$1" lib platform
  platform="$(docker_platform "$triple")"
  lib="$(libwebrtc_dir "$triple")"
  [ -f "$lib/lib/libwebrtc.a" ] ||
    die "no libwebrtc build in $lib; run scripts/libwebrtc-assets.sh fetch $triple, or" \
      "scripts/build-libwebrtc.sh $triple (on an x64 Linux host)"
  check_libwebrtc "$triple" "$lib/.source"
  cp "$lib/.source" "$tmp/libwebrtc-source"
  # -P: a worktree's third_party/libwebrtc-upstream is a symlink.
  docker build --platform "$platform" -f docker/linux.Dockerfile --target addon \
    --build-context libwebrtc="$(cd -P "$lib" && pwd)" \
    --output "type=local,dest=$tmp/out" .
  mv "$tmp/out/wrtc.node" "$tmp/wrtc.node"
  rmdir "$tmp/out"
}

# linux-x64 from a host that isn't x64: built on gpubox, into $tmp.
gpubox_build() {
  local name
  name="libwebrtc-rs-js-prebuild-$(git rev-parse --abbrev-ref HEAD | tr -c 'A-Za-z0-9._\n-' '-')"
  # Removed on exit, whether the build succeeds or not.
  remote="repos/personal/$name"
  # The check runs on the box first, to fail before building; the
  # build's .source comes back with the binary and is checked here too.
  # --strip-unneeded keeps the dynamic symbol table the loader needs.
  scripts/gpubox-test.sh "$name" -- sh -c \
    'python3 scripts/gyp-webrtc.py check && pnpm run build &&
     strip --strip-unneeded -o build/wrtc.node build/Release/wrtc.node &&
     cp "$WRTC_LIBWEBRTC_DIR/linux-x64-release/.source" build/libwebrtc-source'
  scp -q "$host:$remote/build/wrtc.node" "$tmp/wrtc.node"
  scp -q "$host:$remote/build/libwebrtc-source" "$tmp/libwebrtc-source"
  check_libwebrtc linux-x64 "$tmp/libwebrtc-source"
}

usage="usage: scripts/prebuild.sh $(
  IFS='|'
  echo "${platforms[*]}"
)|all"
[ $# -eq 1 ] || die "$usage"
if [ "$1" = all ]; then
  for triple in "${platforms[@]}"; do build_one "$triple"; done
elif is_platform "$1"; then
  build_one "$1"
else
  die "unknown platform '$1'; $usage"
fi
