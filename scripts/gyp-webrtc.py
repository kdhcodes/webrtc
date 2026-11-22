#!/usr/bin/env python3
"""Helpers binding.gyp and the build scripts call to locate our libwebrtc
build and check it matches this checkout.

  gyp-webrtc.py dir      -> path to third_party/libwebrtc-upstream/<os>-<arch>-release
                            for this machine (warns on stderr if it doesn't
                            match this checkout; see `check`)
  gyp-webrtc.py defines  -> preprocessor defines libwebrtc was built with,
                            read from webrtc.ninja (one per line, no -D)
  gyp-webrtc.py check [<triple>] [--source <file>]
                         -> exits 1 unless the build's .source (or <file>, a
                            copy of one) records the upstream and depot_tools
                            pins, recipe version, gn args and patches this
                            checkout has now
  gyp-webrtc.py stamp <triple>
                         -> the depot_tools, recipe, args and patches lines
                            of .source, for scripts/build-libwebrtc.sh
  gyp-webrtc.py config-id
                         -> a short id of what every libwebrtc build here is
                            made from (the pins, the recipe version, all gn
                            args, the patches), for keeping builds of
                            different configurations apart
                            (scripts/gpubox-test.sh)

<triple> is darwin-arm64, linux-x64 or linux-arm64 (default: this machine's).
WRTC_LIBWEBRTC_DIR points at a third_party/libwebrtc-upstream directory
elsewhere (e.g. the main checkout's, from a git worktree).

The pins and the recipe version (libwebrtc_recipe, bumped by hand when the
build script's output changes) come from scripts/build-libwebrtc.sh; the
script itself isn't hashed, so editing its comments doesn't invalidate
builds. The gn args are hashed without comments and blank lines, for the
same reason.

The builds come from scripts/build-libwebrtc.sh <triple>. A build made from
other patches or args still links (a local experiment may want that), but
`dir` warns, and scripts/prebuild.sh and scripts/package.sh refuse it: the
binary would carry the native build id of sources it wasn't built from.
"""
import glob
import hashlib
import os
import platform
import re
import sys

# Build-machine details that would only add noise to our compile lines.
IGNORE = {"CR_CLANG_REVISION", "CR_XCODE_VERSION", "CR_XCODE_BUILD"}
# On macOS we compile against the system libc++, whose config already sets
# this. On Linux we use libwebrtc's hermetic libc++ and need the build's value.
if platform.system() == "Darwin":
    IGNORE.add("_LIBCPP_HARDENING_MODE")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Our triple names and build-libwebrtc.sh's directory names.
DIRS = {
    "darwin-arm64": "mac-arm64-release",
    "linux-x64": "linux-x64-release",
    "linux-arm64": "linux-arm64-release",
}


def host_triple():
    os_name = {"Darwin": "darwin", "Linux": "linux"}[platform.system()]
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64"}[platform.machine()]
    return f"{os_name}-{arch}"


def webrtc_dir(triple=None):
    base = os.environ.get("WRTC_LIBWEBRTC_DIR") or os.path.join(
        ROOT, "third_party", "libwebrtc-upstream"
    )
    return os.path.join(base, DIRS[triple or host_triple()])


def git_blob_hash(data):
    """What `git hash-object` prints for these bytes (no git needed)."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def file_hash(path):
    with open(path, "rb") as f:
        return git_blob_hash(f.read())


def patches_hash():
    """The hash of the patches' hashes, in file name order."""
    paths = sorted(glob.glob(os.path.join(ROOT, "patches", "*.patch")))
    return git_blob_hash("".join(file_hash(p) + "\n" for p in paths).encode())


def args_path(triple):
    return os.path.join("third_party", "args", DIRS[triple] + ".gn")


def strip_gn_comment(line):
    """The line without its # comment (a # inside a "string" isn't one)."""
    quoted = False
    i = 0
    while i < len(line):
        c = line[i]
        if c == "\\" and quoted:
            i += 1
        elif c == '"':
            quoted = not quoted
        elif c == "#" and not quoted:
            return line[:i]
        i += 1
    return line


def args_hash(path):
    """The git blob hash of the args file's settings: comments, trailing
    whitespace and blank lines dropped, so editing a comment doesn't make
    every build stale."""
    with open(path, encoding="utf-8") as f:
        lines = [strip_gn_comment(line).rstrip() for line in f.read().splitlines()]
    return git_blob_hash("".join(line + "\n" for line in lines if line).encode())


def pin(name, pattern):
    with open(os.path.join(ROOT, "scripts", "build-libwebrtc.sh")) as f:
        m = re.search(rf"^{name}=({pattern})$", f.read(), re.M)
    if not m:
        sys.exit(f"gyp-webrtc.py: no {name}= in scripts/build-libwebrtc.sh")
    return m.group(1)


def webrtc_commit():
    return pin("webrtc_commit", "[0-9a-f]{40}")


def source_lines(triple):
    """The lines of .source that say what the build is made from, besides
    the webrtc line (which build-libwebrtc.sh writes, with the branch)."""
    args = args_path(triple)
    return [
        f"depot_tools {pin('depot_tools_commit', '[0-9a-f]{40}')}",
        f"recipe {pin('libwebrtc_recipe', '[0-9]+')}",
        f"args {args} {args_hash(os.path.join(ROOT, args))}",
        f"patches {patches_hash()}",
    ]


def config_id():
    parts = [webrtc_commit()]
    parts += [line.split()[-1] for t in sorted(DIRS) for line in source_lines(t)]
    return git_blob_hash(" ".join(parts).encode())[:12]


def mismatches(triple, source_file):
    """Why the build recorded in source_file isn't this checkout's, if it isn't."""
    try:
        with open(source_file) as f:
            recorded = f.read().splitlines()
    except FileNotFoundError:
        return [f"{source_file} is missing, so what it was built from is unknown"]
    by_key = {line.split(" ", 1)[0]: line for line in recorded if " " in line}
    problems = []
    commit = webrtc_commit()
    webrtc = by_key.get("webrtc", "")
    if commit not in webrtc.split():
        problems.append(f"upstream commit: built from '{webrtc}', the pin is now {commit}")
    labels = {
        "depot_tools": "depot_tools pin",
        "recipe": "build recipe (libwebrtc_recipe)",
        "args": f"gn args ({args_path(triple)}, without comments)",
        "patches": "patches",
    }
    for expected in source_lines(triple):
        key = expected.split(" ", 1)[0]
        if by_key.get(key) != expected:
            recorded = f"'{by_key[key]}'" if key in by_key else "nothing recorded"
            problems.append(f"{labels[key]}: built with {recorded}, this checkout has '{expected}'")
    return problems


def build_command(triple):
    """How to build triple's libwebrtc from this machine."""
    here = host_triple()
    if triple.startswith("linux-"):
        # Both Linux triples build on an x64 Linux host only.
        if here == "linux-x64":
            return f"scripts/build-libwebrtc.sh {triple}"
        return (
            f"scripts/gpubox-test.sh -- scripts/build-libwebrtc.sh {triple} (on gpubox), "
            "then copy it here (CONTRIBUTING-AGENTS.md, Setup)"
        )
    if triple == here:
        return f"scripts/build-libwebrtc.sh {triple}"
    return f"scripts/build-libwebrtc.sh {triple} on an arm64 Mac"


def rebuild_hint(triple):
    """How to get a matching build, given where the builds are."""
    build = build_command(triple)
    env = os.environ.get("WRTC_LIBWEBRTC_DIR")
    if env and os.environ.get("WEBRTC_DEST") != env:
        # Not where build-libwebrtc.sh writes (gpubox-test.sh sets both).
        return (
            f"the builds come from WRTC_LIBWEBRTC_DIR={env}: unset it, or point it at "
            f"a directory with a matching build; to make one, {build}"
        )
    base = os.path.dirname(webrtc_dir(triple))
    if not env and os.path.islink(base):
        return (
            f"{base} links to {os.readlink(base)}, which other checkouts share, so "
            "scripts/build-libwebrtc.sh won't replace it: replace the link with a "
            f"directory (rm {base} && mkdir {base}), then {build}"
        )
    return f"rebuild it: {build}"


def defines():
    d = webrtc_dir()
    ninja = os.path.join(d, "webrtc.ninja")
    if not os.path.isfile(ninja):
        sys.exit(
            f"gyp-webrtc.py: no libwebrtc build in {d}; "
            f"build it with scripts/build-libwebrtc.sh {host_triple()}"
        )
    with open(ninja) as f:
        line = f.readline()
    seen = []
    for name, value in re.findall(r"-D(\w+)(?:=(\S+))?", line):
        if name in IGNORE:
            continue
        d = f"{name}={value}" if value else name
        if d not in seen:
            seen.append(d)
    return seen


def main(argv):
    cmd = argv[0] if argv else ""
    if cmd == "dir":
        d = webrtc_dir()
        if os.path.isdir(d):
            problems = mismatches(host_triple(), os.path.join(d, ".source"))
            if problems:
                # gyp prints a command's stderr; the build goes on.
                print(
                    f"gyp-webrtc.py: warning: {d} doesn't match this checkout:\n  "
                    + "\n  ".join(problems)
                    + "\nLinking it anyway; scripts/prebuild.sh refuses it as it is. "
                    + "To fix: " + rebuild_hint(host_triple()),
                    file=sys.stderr,
                )
        print(d)
    elif cmd == "defines":
        print("\n".join(defines()))
    elif cmd == "check":
        rest = argv[1:]
        source = None
        usage = "usage: gyp-webrtc.py check [<triple>] [--source <file>]"
        if "--source" in rest:
            i = rest.index("--source")
            if i + 1 >= len(rest):
                sys.exit(usage)
            source = rest[i + 1]
            del rest[i : i + 2]
        if len(rest) > 1:
            sys.exit(usage)
        triple = rest[0] if rest else host_triple()
        if triple not in DIRS:
            sys.exit(f"gyp-webrtc.py: unknown triple '{triple}'")
        source = source or os.path.join(webrtc_dir(triple), ".source")
        problems = mismatches(triple, source)
        if problems:
            sys.exit(
                f"the {triple} libwebrtc build ({source}) doesn't match this checkout:\n  "
                + "\n  ".join(problems)
                + "\n"
                + rebuild_hint(triple)
            )
    elif cmd == "stamp" and len(argv) == 2 and argv[1] in DIRS:
        print("\n".join(source_lines(argv[1])))
    elif cmd == "config-id":
        print(config_id())
    else:
        sys.exit(f"gyp-webrtc.py: unknown command {' '.join(argv)!r}; see its docstring")


if __name__ == "__main__":
    main(sys.argv[1:])
