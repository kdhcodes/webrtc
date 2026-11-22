#!/usr/bin/env bash
# Runs the build and test suite on a real Linux x64 box (default: gpubox),
# from this checkout or worktree.
#
#   scripts/gpubox-test.sh [name] [-- command...]
#
# Syncs this checkout to ~/repos/personal/<name> on the box (default name:
# libwebrtc-rs-js-<current branch>, so parallel worktrees don't collide),
# reuses the box's shared toolchain (~/repos/personal/libwebrtc-rs-js-tools:
# Node 24, pnpm, LLVM 21) and the box's libwebrtc builds for this checkout's
# libwebrtc configuration (below), installs dependencies and runs: build,
# typecheck, test, test:exit. With `-- command...` it runs that command in
# the synced checkout instead (with the same environment).
#
# The libwebrtc builds are kept per configuration, in
# ~/repos/personal/libwebrtc-rs-js-libwebrtc/<id>/<triple>-release, where
# <id> is `scripts/gyp-webrtc.py config-id`: a hash of the upstream and
# depot_tools pins, the recipe version (libwebrtc_recipe in
# build-libwebrtc.sh), the gn args (without comments) and patches/. Every checkout with the same configuration links the
# same builds, and building one never replaces a build another branch with
# other args or patches links. Both Linux triples build on the box, from its
# checkout in ~/src/webrtc-m150, into that directory (WEBRTC_DEST):
#   scripts/gpubox-test.sh -- scripts/build-libwebrtc.sh linux-x64
#   scripts/gpubox-test.sh -- scripts/build-libwebrtc.sh linux-arm64
# Configurations no branch uses any more can be deleted (about 1 GB each).
#
# Box setup (once, user-local, no sudo) is described in CONTRIBUTING-AGENTS.md.
set -euo pipefail
cd "$(dirname "$0")/.."

host="${GPUBOX_HOST:-gpubox}"
# The name ends up in remote paths and shell commands, so it's limited to
# safe characters: branch names are reduced to them, and a given name must
# already be.
branch="$(git rev-parse --abbrev-ref HEAD | tr -c 'A-Za-z0-9._\n-' '-')"
name="libwebrtc-rs-js-${branch}"
if [ $# -gt 0 ] && [ "$1" != "--" ]; then
  name="$1"
  shift
fi
case "$name" in
  "" | .* | *[!A-Za-z0-9._-]*)
    echo "gpubox-test: name '$name' must be letters, digits, '.', '_' or '-' (not leading '.')" >&2
    exit 2
    ;;
esac
custom=()
if [ $# -gt 0 ] && [ "$1" = "--" ]; then
  shift
  custom=("$@")
fi

remote_dir="repos/personal/${name}"
libwebrtc_dir="repos/personal/libwebrtc-rs-js-libwebrtc/$(python3 scripts/gyp-webrtc.py config-id)"
echo "syncing to ${host}:${remote_dir}"
rsync -a --delete \
  --exclude node_modules --exclude /build --exclude /dist --exclude /artifacts \
  --exclude /third_party/libwebrtc --exclude /third_party/libwebrtc-upstream \
  --exclude .claude --exclude .devenv --exclude .direnv \
  ./ "${host}:${remote_dir}/"

if [ ${#custom[@]} -gt 0 ]; then
  remote_cmd="$(printf '%q ' "${custom[@]}")"
else
  remote_cmd='pnpm run build && pnpm run typecheck && pnpm test && pnpm run test:exit'
fi

# shellcheck disable=SC2029 # expanded locally on purpose
ssh -o BatchMode=yes "${host}" "set -euo pipefail
  T=\$HOME/repos/personal/libwebrtc-rs-js-tools
  export PATH=\$T/node/bin:\$T/llvm/bin:\$PATH CC=clang CXX=clang++
  export WRTC_LIBWEBRTC_DIR=\$HOME/$(printf %q "$libwebrtc_dir")
  export WEBRTC_DEST=\$WRTC_LIBWEBRTC_DIR
  cd \$HOME/$(printf %q "$remote_dir")
  # No native build happens here (package.json has gypfile: false); the
  # build below uses clang 21.
  pnpm install --frozen-lockfile >/dev/null
  ${remote_cmd}"
