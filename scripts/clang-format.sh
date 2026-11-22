#!/usr/bin/env bash
# Formats (or with --check, verifies) the native sources with clang-format.
set -euo pipefail
cd "$(dirname "$0")/.."
files=$(git ls-files 'src/*.h' 'src/*.cc')
if [ "${1:-}" = "--check" ]; then
  clang-format --dry-run --Werror $files
else
  clang-format -i $files
fi
