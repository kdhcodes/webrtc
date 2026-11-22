#!/usr/bin/env bash
# Node addons are linked with Node's own symbols (napi_*, node_*, uv_*) left
# unresolved, to be bound when the addon loads. On macOS node-gyp does this
# with `-undefined dynamic_lookup`, which also turns any symbol missing from
# libwebrtc.a into a null call at runtime; on Linux shared objects allow
# undefined symbols by default. Fail the build on anything else instead.
set -euo pipefail
addon="${1:-build/Release/wrtc.node}"
node_syms='^_?(napi_|node_|uv_)'

case "$(uname)" in
  Darwin)
    # Lines look like "(undefined) [weak] external SYMBOL (dynamically looked up)".
    missing=$(nm -m "$addon" | grep 'dynamically looked up' \
      | awk '{for (i = 1; i <= NF; i++) if ($i == "(dynamically") print $(i - 1)}' \
      | grep -vE "$node_syms" || true)
    ;;
  Linux)
    # Versioned symbols (sym@GLIBC_2.17) come from system libraries the addon
    # links against, which the loader checks; weak undefined symbols (w/v)
    # are allowed to stay null by design.
    missing=$(nm -D --undefined-only "$addon" | awk '$1 == "U" {print $2}' \
      | grep -v '@' | grep -vE "$node_syms" || true)
    ;;
  *) exit 0 ;;
esac

if [ -n "$missing" ]; then
  echo "unresolved symbols in $addon (missing from libwebrtc.a?):" >&2
  echo "$missing" | c++filt >&2
  exit 1
fi
