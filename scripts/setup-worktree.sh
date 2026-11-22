#!/usr/bin/env bash
# Prepares a git worktree of this repo so it can build and test:
#   - links third_party/libwebrtc-upstream to the main checkout's copy
#     (about 1 GB per platform, gitignored; scripts/build-libwebrtc.sh makes it)
#   - installs node_modules
#   - builds the addon
# Run from inside the worktree: scripts/setup-worktree.sh
set -euo pipefail
cd "$(dirname "$0")/.."

main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
if [ "$main" = "$(pwd)" ]; then
  echo "this is the main checkout; nothing to link" >&2
else
  if [ ! -e third_party/libwebrtc-upstream ]; then
    if [ ! -d "$main/third_party/libwebrtc-upstream" ]; then
      echo "main checkout has no third_party/libwebrtc-upstream;" \
        "run scripts/build-libwebrtc.sh <triple> there" >&2
      exit 1
    fi
    mkdir -p third_party
    ln -s "$main/third_party/libwebrtc-upstream" third_party/libwebrtc-upstream
    echo "linked third_party/libwebrtc-upstream -> $main/third_party/libwebrtc-upstream"
  fi
fi

pnpm install --frozen-lockfile
pnpm run build
