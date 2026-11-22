# Sourced by scripts/prebuild.sh and scripts/package.sh, from the repo root.

# Platforms with a prebuilt platform package. Keep in sync with
# SUPPORTED_PLATFORMS in lib/internal/addon-path.ts.
platforms=(darwin-arm64 linux-arm64 linux-x64)

# What the native addon is built from: our sources, the build files, and
# what the libwebrtc build is made from (scripts/build-libwebrtc.sh holds the
# upstream pin; its gn args and our patches to libwebrtc).
native_inputs=(
  src binding.gyp scripts/gyp-webrtc.py docker/linux.Dockerfile
  scripts/build-libwebrtc.sh scripts/libwebrtc-patches.sh third_party/args patches
)

# A hash of the native inputs as they are in the working tree, untracked
# files included. The loader refuses a platform package whose id differs
# from the main package's.
native_build_id() {
  git ls-files -co --exclude-standard -- "${native_inputs[@]}" | LC_ALL=C sort |
    while IFS= read -r file; do
      # Skips tracked files deleted from the working tree.
      if [ -f "$file" ]; then printf '%s %s\n' "$file" "$(git hash-object -- "$file")"; fi
    done | git hash-object --stdin | cut -c1-12
}

# Succeeds when the native inputs differ from HEAD (modified or untracked).
native_dirty() {
  [ -n "$(git status --porcelain -- "${native_inputs[@]}")" ]
}

is_platform() {
  local p
  for p in "${platforms[@]}"; do [ "$p" = "$1" ] && return 0; done
  return 1
}
