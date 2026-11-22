# Sourced by scripts/build-libwebrtc.sh: applying patches/ to the libwebrtc
# checkout, and the record of what's applied. The caller sets
#   repo     this repo's root (patches/ is under it)
#   root     the gclient root (src/ is under it)
#   applied  the record file, $root/.libwebrtc-rs-js-applied-patches
# and defines die and log. scripts/libwebrtc-patches.test.ts tests these
# functions against a fake checkout.
#
# The record lists the patches applied since the last sync, one
# "<cksum> <name>" line each. gclient sync --reset undoes them, but nothing
# can undo one that's gone from patches/ (or changed) short of a sync, and
# the build is stamped with what patches/ holds; so gen refuses to go on
# while the record has a patch patches/ doesn't, and package refuses a
# checkout whose record isn't exactly patches/.

# What patches/ holds now, one line per patch, in name order.
current_patches() {
  local patch
  for patch in "$repo"/patches/*.patch; do
    if [ -f "$patch" ]; then echo "$(cksum <"$patch" | awk '{print $1 "-" $2}') ${patch##*/}"; fi
  done
}

# gclient sync with these arguments. The record goes first: a sync that
# fails partway may have reset some patches and not others, and a record
# claiming they're all applied would let package through.
sync_checkout() {
  rm -f "$applied"
  gclient sync "$@"
}

# Applies patches/*.patch, with paths relative to src/ (they may cross into
# the dependency checkouts under it, e.g. src/build); already-applied ones
# are skipped. No .orig backups: a patch that applies at an offset would
# otherwise leave one in the checkout. Each patch is recorded before it's
# applied, so one that half-applies (and is then dropped from patches/)
# still needs a sync.
apply_patches() {
  local stale
  if [ -f "$applied" ]; then
    stale=$(LC_ALL=C comm -23 <(LC_ALL=C sort "$applied") <(current_patches | LC_ALL=C sort))
    [ -z "$stale" ] ||
      die "the checkout has patches applied that patches/ no longer has (or has changed):" \
        "$(echo "$stale" | cut -d' ' -f2 | tr '\n' ' ')- run the sync step first (it resets the checkout)"
  fi
  touch "$applied"
  local patch line
  for patch in "$repo"/patches/*.patch; do
    [ -f "$patch" ] || continue
    line="$(cksum <"$patch" | awk '{print $1 "-" $2}') ${patch##*/}"
    grep -qxF "$line" "$applied" || echo "$line" >>"$applied"
    if patch -p1 -d "$root/src" -R -f -s --dry-run <"$patch" >/dev/null 2>&1; then
      continue
    fi
    log "applying ${patch#"$repo"/}"
    patch -p1 -d "$root/src" -f -s --no-backup-if-mismatch <"$patch" ||
      die "${patch#"$repo"/} doesn't apply; if an older version of it is applied, run the sync step first (it resets the checkout)"
  done
}

# Fails unless the record is exactly patches/ (package stamps the build with it).
require_applied_patches() {
  [ -f "$applied" ] && cmp -s <(LC_ALL=C sort "$applied") <(current_patches | LC_ALL=C sort) ||
    die "the checkout's applied patches aren't patches/ as it is now (or weren't recorded); run the gen step (after sync, if a patch was removed or changed) and build again"
}
