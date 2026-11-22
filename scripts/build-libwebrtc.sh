#!/usr/bin/env bash
# Builds upstream Google libwebrtc from source into
# third_party/libwebrtc-upstream/<os>-<arch>-release/, in the layout binding.gyp
# reads:
#   include/      every .h and .inc in the source tree, plus (Linux) the
#                 hermetic libc++ headers binding.gyp compiles against
#   lib/libwebrtc.a
#   args.gn, webrtc.ninja (scripts/gyp-webrtc.py reads its defines),
#   desktop_capture.ninja, LICENSE.md, .source (what it was built from)
#
#   scripts/build-libwebrtc.sh <triple> [step...]
#
#   triple: darwin-arm64 | linux-x64 | linux-arm64
#           (or the directory names: mac-arm64-release, linux-x64-release, ...)
#   steps:  sync gen build package, in that order (default: all four).
#           gen applies patches/*.patch (paths relative to src/) first.
#
# darwin-arm64 builds on an arm64 Mac with Xcode. Both Linux triples build on
# an x64 Linux host (arm64 cross-compiles with Chromium's arm64 sysroot) from
# one checkout. Everything comes from depot_tools, gclient hooks and Chromium's
# sysroots: no system packages beyond git, python3 and curl.
#
# Environment:
#   WEBRTC_CHECKOUT  gclient root, outside the repo and reused across builds
#                    (default ~/src/webrtc-m150). Holds depot_tools/ and src/;
#                    the build goes to src/out/<os>-<arch>-release.
#   WEBRTC_DEST      where the layout goes (default third_party/libwebrtc-upstream)
#   NINJA_JOBS       parallel compile jobs (default: about 2 GB of RAM per job,
#                    at most one per CPU)
#   DEVELOPER_DIR    macOS: the Xcode to use (default /Applications/Xcode.app/...)
#
# `pnpm run build` links the addon against the result (scripts/gyp-webrtc.py).
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$PWD"

# Pins. M150 is branch-heads/7871 (chromiumdash.appspot.com/fetch_milestones?mstone=150).
webrtc_branch=7871
webrtc_commit=05e02da9d17f5844e84800fa524dd1eb57d7014c
depot_tools_commit=c5d6eef1cc00425dea5b149cefe7068455ee4f56
# The version of this script's recipe. Bump it whenever a change here changes
# what a build contains or how it's laid out (the ninja targets, what's
# archived, prefix_boringssl, the headers copied, the files next to them),
# not for comments or logging. It's recorded in .source and in
# `gyp-webrtc.py config-id`, so existing builds count as stale until rebuilt.
libwebrtc_recipe=1

die() {
  echo "build-libwebrtc: $*" >&2
  exit 1
}
log() { echo "build-libwebrtc: $*" >&2; }

[ $# -ge 1 ] || die "usage: scripts/build-libwebrtc.sh <darwin-arm64|linux-x64|linux-arm64> [sync|gen|build|package...]"
case "$1" in
  darwin-arm64 | mac-arm64-release) os=mac arch=arm64 triple=darwin-arm64 ;;
  linux-x64 | linux-x64-release) os=linux arch=x64 triple=linux-x64 ;;
  linux-arm64 | linux-arm64-release) os=linux arch=arm64 triple=linux-arm64 ;;
  *) die "unknown triple '$1'" ;;
esac
shift
name="$os-$arch-release"
steps=("$@")
[ ${#steps[@]} -gt 0 ] || steps=(sync gen build package)

case "$os/$(uname -s)/$(uname -m)" in
  mac/Darwin/arm64 | linux/Linux/x86_64) ;;
  *) die "$name builds on $([ $os = mac ] && echo 'an arm64 Mac' || echo 'an x64 Linux host'), not $(uname -sm)" ;;
esac

root="${WEBRTC_CHECKOUT:-$HOME/src/webrtc-m150}"
dest_base="${WEBRTC_DEST:-$repo/third_party/libwebrtc-upstream}"
args_file="$repo/third_party/args/$name.gn"
out="$root/src/out/$name"
# The patches applied to the checkout since its last sync
# (scripts/libwebrtc-patches.sh).
applied="$root/.libwebrtc-rs-js-applied-patches"
# shellcheck source=scripts/libwebrtc-patches.sh
source "$repo/scripts/libwebrtc-patches.sh"
[ -f "$args_file" ] || die "no args for $name: $args_file"

# A git worktree's third_party/libwebrtc-upstream links to the main
# checkout's (scripts/setup-worktree.sh), which other worktrees link too.
# Don't replace a build there with one made from other args or patches.
if [ -L "$dest_base" ] && [ -f "$dest_base/$name/.source" ] &&
  ! python3 scripts/gyp-webrtc.py check "$triple" --source "$dest_base/$name/.source" >/dev/null 2>&1; then
  die "$dest_base links to $(readlink "$dest_base"), which other checkouts use, and its $name build" \
    "is made from other args or patches than this checkout's. Replace the link with a directory" \
    "(or set WEBRTC_DEST) to build your own."
fi

# A clean toolchain environment: depot_tools first, then the system. A dev
# shell's compilers, SDK and flags (e.g. nix's SDKROOT and NIX_CFLAGS_COMPILE)
# would otherwise leak into Chromium's build.
unset CC CXX LD AR CFLAGS CXXFLAGS CPPFLAGS LDFLAGS CPATH LIBRARY_PATH SDKROOT \
  MACOSX_DEPLOYMENT_TARGET NIX_CFLAGS_COMPILE NIX_LDFLAGS PYTHONPATH PYTHONHOME
export PATH="$root/depot_tools:/usr/bin:/bin:/usr/sbin:/sbin"
export DEPOT_TOOLS_UPDATE=0 DEPOT_TOOLS_METRICS=0 GCLIENT_SUPPRESS_GIT_VERSION_WARNING=1
if [ "$os" = mac ]; then
  case "${DEVELOPER_DIR:-}" in
    /Applications/*) ;;
    *) export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ;;
  esac
fi

jobs() {
  if [ -n "${NINJA_JOBS:-}" ]; then
    echo "$NINJA_JOBS"
    return
  fi
  local cpus mem_gb
  if [ "$(uname -s)" = Darwin ]; then
    cpus=$(sysctl -n hw.ncpu)
    mem_gb=$(($(sysctl -n hw.memsize) / 1073741824))
  else
    cpus=$(nproc)
    mem_gb=$(($(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1048576))
  fi
  # About 2 GB per clang job, leaving some for the rest of the machine.
  local j=$(((mem_gb - 2) / 2))
  [ "$j" -le "$cpus" ] || j=$cpus
  [ "$j" -ge 1 ] || j=1
  echo "$j"
}

step_sync() {
  mkdir -p "$root"
  local dt="$root/depot_tools"
  if [ ! -d "$dt/.git" ]; then
    log "cloning depot_tools"
    git clone -q https://chromium.googlesource.com/chromium/tools/depot_tools.git "$dt"
  fi
  if [ "$(git -C "$dt" rev-parse HEAD)" != "$depot_tools_commit" ]; then
    git -C "$dt" cat-file -e "$depot_tools_commit^{commit}" 2>/dev/null || git -C "$dt" fetch -q origin
    git -C "$dt" checkout -q --detach "$depot_tools_commit"
  fi
  # Fetches depot_tools' own python and tools from CIPD (DEPOT_TOOLS_UPDATE=0
  # keeps it from moving off the pin).
  "$dt/ensure_bootstrap"

  cd "$root"
  # What `fetch webrtc` writes, but with the solution pinned to our commit, so
  # the first sync doesn't download every dependency at main first.
  if [ ! -f .gclient ]; then
    log "writing $root/.gclient"
    cat >.gclient <<EOF
solutions = [
  {
    "name": "src",
    "url": "https://webrtc.googlesource.com/src.git@$webrtc_commit",
    "deps_file": "DEPS",
    "managed": False,
    "custom_deps": {},
  },
]
EOF
    # Both Linux targets come from one checkout: checkout_arm64 pulls the arm64 sysroot.
    if [ "$os" = linux ]; then echo 'target_cpu = ["x64", "arm64"]' >>.gclient; fi
  fi
  log "gclient sync at $webrtc_commit (branch-heads/$webrtc_branch)"
  # --reset reverts every patch; sync_checkout drops the record first.
  sync_checkout -D --no-history --force --reset --revision "src@$webrtc_commit"
  [ "$(git -C src rev-parse HEAD)" = "$webrtc_commit" ] || die "src is not at $webrtc_commit after sync"
  cd "$repo"
}

step_gen() {
  apply_patches
  cd "$root/src"
  if [ "$os" = linux ]; then
    local sysroot_arch=$arch
    [ "$arch" = x64 ] && sysroot_arch=amd64
    python3 build/linux/sysroot_scripts/install-sysroot.py --arch="$sysroot_arch"
  fi
  mkdir -p "$out"
  cp "$args_file" "$out/args.gn"
  gn gen "$out"
  cd "$repo"
}

step_build() {
  cd "$root/src"
  # :default builds the webrtc target and what it depends on. Also build
  # what src/ uses beyond that: SimulcastEncoderAdapter
  # (src/video_encoder_factory.cc), which no :default target depends on.
  local targets=(:default media:rtc_simulcast_encoder_adapter)
  if [ "$os" = linux ]; then
    # Nothing in :default links a target binary, so libc++/libc++abi's own
    # objects would never be compiled (or, natively, only the host copy).
    # Name their archives from the ninja graph; target-toolchain outputs sit
    # directly under obj/, host ones under a toolchain directory.
    local libcxx
    libcxx=$(ninja -C "$out" -t targets all | grep -oE '^obj/[^:]*/libc\+\+(abi)?\.a' | sort -u)
    [ -n "$libcxx" ] || die "no libc++/libc++abi archives in the ninja graph of $out"
    # shellcheck disable=SC2206 # paths without spaces
    targets+=($libcxx)
  fi
  # step_package archives every object under obj/, and ninja leaves behind
  # the outputs of targets that are no longer in the graph (after an args
  # change, e.g. PipeWire's when rtc_use_pipewire went false). Delete those.
  ninja -C "$out" -t cleandead
  local j
  j=$(jobs)
  log "ninja -j$j ${targets[*]}"
  ninja -C "$out" -j "$j" "${targets[@]}"
  cd "$repo"
}

step_package() {
  local src="$root/src"
  local llvm="$src/third_party/llvm-build/Release+Asserts/bin"
  local dest="$dest_base/$name"
  local tmp="$dest.partial"
  # The build is stamped with patches/ (below), so it must be what's applied.
  require_applied_patches
  rm -rf "$tmp"
  mkdir -p "$tmp/lib" "$tmp/include"

  # One archive with every object the build compiled for the target, as the
  # webrtc target's own complete static library leaves out what :default
  # builds beside it (and, on Linux, libc++). nasm is a host tool.
  log "archiving objects"
  (cd "$out" && find obj -name '*.o' -not -path '*/third_party/nasm/*' | LC_ALL=C sort) >"$tmp/objects.rsp"
  local format=gnu
  [ "$os" = mac ] && format=darwin
  (cd "$out" && "$llvm/llvm-ar" rcsD --format=$format "$tmp/lib/libwebrtc.a" @"$tmp/objects.rsp")
  rm "$tmp/objects.rsp"

  if [ "$os" = linux ]; then
    # binding.gyp links with -nostdlib++: the archive must carry libc++ itself.
    local defined
    defined=$("$llvm/llvm-nm" --defined-only --extern-only -j "$tmp/lib/libwebrtc.a" 2>/dev/null |
      grep -xE '__cxa_throw|_ZNSt4__Cr6localeC1Ev' | sort -u | wc -l)
    [ "$defined" -eq 2 ] || die "libwebrtc.a is missing the hermetic libc++/libc++abi objects"
    prefix_boringssl "$tmp/lib/libwebrtc.a"
  fi

  log "copying headers"
  # Every header in the tree (the old prebuilt's layout), minus build outputs
  # and Chromium's Linux sysroots.
  (cd "$src" && find . \( -path ./out -o -path './build/linux/debian_*-sysroot' -o -name .git \) -prune -o \
    \( -name '*.h' -o -name '*.inc' \) -type f -print0 |
    tar -cf - --null -T -) | tar -xf - -C "$tmp/include"
  if [ "$os" = linux ]; then
    # The hermetic libc++ headers have no extension; binding.gyp's -isystem
    # paths point here.
    local d f
    for d in third_party/libc++/src/include third_party/libc++abi/src/include; do
      [ -d "$src/$d" ] || die "missing $src/$d"
      mkdir -p "$tmp/include/$d"
      cp -R "$src/$d/." "$tmp/include/$d/"
    done
    d=buildtools/third_party/libc++
    mkdir -p "$tmp/include/$d"
    for f in __config_site __assertion_handler; do cp "$src/$d/$f" "$tmp/include/$d/"; done
  fi

  cp "$out/args.gn" "$tmp/args.gn"
  cp "$out/obj/webrtc.ninja" "$tmp/webrtc.ninja"
  if [ -f "$out/obj/modules/desktop_capture/desktop_capture.ninja" ]; then
    cp "$out/obj/modules/desktop_capture/desktop_capture.ninja" "$tmp/"
  fi

  log "generating LICENSE.md"
  # libwebrtc's licence plus those of the third-party code the webrtc target
  # links (BoringSSL, libvpx, libaom, dav1d, opus, abseil, ...).
  mkdir -p "$tmp/licenses"
  if (cd "$src" && vpython3 tools_webrtc/libs/generate_licenses.py --target :webrtc "$tmp/licenses" "$out" >"$tmp/licenses.log" 2>&1); then
    mv "$tmp/licenses/LICENSE.md" "$tmp/LICENSE.md"
    rm -rf "$tmp/licenses" "$tmp/licenses.log"
  else
    log "generate_licenses.py failed (see $dest/licenses.log); LICENSE.md is libwebrtc's own LICENSE only"
    rm -rf "$tmp/licenses"
    cp "$src/LICENSE" "$tmp/LICENSE.md"
  fi

  # The webrtc, depot_tools, recipe, args and patches lines are what
  # scripts/gyp-webrtc.py check compares with the checkout that links the
  # build (the hashes are computed without git, so this works in a copy of
  # the repo whose .git is missing or points elsewhere).
  {
    echo "webrtc https://webrtc.googlesource.com/src.git $webrtc_commit (branch-heads/$webrtc_branch, M150)"
    python3 "$repo/scripts/gyp-webrtc.py" stamp "$triple"
    echo "built $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(uname -sm)"
  } >"$tmp/.source"
  rm -rf "$dest"
  mv "$tmp" "$dest"
  log "$dest: $(du -sh "$dest/lib/libwebrtc.a" | cut -f1) libwebrtc.a, $(du -sh "$dest/include" | cut -f1) include/"
}

# Prefixes BoringSSL's global symbols in the archive (BSSL_<name>), so that
# even with -fvisibility=hidden and --exclude-libs out of the picture they
# can't bind to the OpenSSL Node exports. upstream BoringSSL's own
# BORINGSSL_PREFIX route needs the symbol list before compiling; renaming the
# finished objects does the same in one pass.
prefix_boringssl() {
  local archive="$1"
  local llvm="$root/src/third_party/llvm-build/Release+Asserts/bin"
  local map="$out/boringssl_prefix_symbols.txt"
  # Every global C symbol BoringSSL's objects define, mapped to BSSL_<name>.
  # (nm also prints a header line per file; C++ symbols (_Z...) and
  # reserved names stay as they are.)
  find "$out/obj/third_party/boringssl" -name '*.o' -print0 |
    xargs -0 "$llvm/llvm-nm" --defined-only --extern-only -j 2>/dev/null |
    grep -E '^[A-Za-z][A-Za-z0-9_]*$' | LC_ALL=C sort -u | awk '{print $1, "BSSL_" $1}' >"$map"
  [ -s "$map" ] || die "found no BoringSSL symbols to prefix"
  "$llvm/llvm-objcopy" --redefine-syms="$map" "$archive"
  log "prefixed $(wc -l <"$map" | tr -d ' ') BoringSSL symbols with BSSL_"
}

for step in "${steps[@]}"; do
  case "$step" in
    sync | gen | build | package)
      log "== $step ($name, $(date +%H:%M:%S))"
      "step_$step"
      ;;
    *) die "unknown step '$step'" ;;
  esac
done
log "done ($name, $(date +%H:%M:%S))"
