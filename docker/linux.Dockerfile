# Builds the addon on Ubuntu and runs the test suite.
#   docker build -f docker/linux.Dockerfile -t wrtc-linux \
#     --build-context libwebrtc="$(cd -P third_party/libwebrtc-upstream/linux-arm64-release && pwd)" .
#   docker run --rm wrtc-linux
# (linux-x64-release on an x64 host; scripts/build-libwebrtc.sh makes both.)
# Parallel work packages use their own tag (wrtc-linux-<wp>) so concurrent
# builds don't overwrite each other's image.
#
# The `addon` target exports only the stripped addon, for packaging
# (scripts/prebuild.sh linux-arm64):
#   docker build -f docker/linux.Dockerfile --build-context libwebrtc=<dir> \
#     --target addon --output type=local,dest=<dir> .
FROM ubuntu:24.04 AS build

# Pinned to what the spike was verified with. clang is pinned by major only
# (apt.llvm.org ships the latest point release); Ubuntu by tag only.
ARG CLANG_VERSION=21
ARG NODE_VERSION=24.22.3
ARG PNPM_VERSION=12.9.0

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg lsb-release make openssl python3 software-properties-common wget xz-utils \
 && rm -rf /var/lib/apt/lists/*

# The Linux libwebrtc is built against Chromium's hermetic libc++, which
# needs a recent clang (GCC miscompiles calls across it; see binding.gyp).
RUN wget -qO /tmp/llvm.sh https://apt.llvm.org/llvm.sh && chmod +x /tmp/llvm.sh \
 && /tmp/llvm.sh ${CLANG_VERSION} && rm /tmp/llvm.sh
ENV CC=clang-${CLANG_VERSION} CXX=clang++-${CLANG_VERSION}

RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
 && npm install -g pnpm@${PNPM_VERSION} node-gyp

WORKDIR /src
# The libwebrtc build for the image's platform (scripts/build-libwebrtc.sh),
# passed in as the named build context `libwebrtc`, since
# third_party/libwebrtc-upstream is outside the main context (.dockerignore;
# third_party/args is in it, for scripts/gyp-webrtc.py's check of the
# build's .source) and may be a symlink:
#   --build-context libwebrtc=third_party/libwebrtc-upstream/linux-arm64-release
COPY --from=libwebrtc . /opt/libwebrtc-upstream/build
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
 && grep -q "linux-$arch-release" /opt/libwebrtc-upstream/build/.source \
    || { echo "the libwebrtc build context is not linux-$arch-release" >&2; exit 1; } \
 && ln -s build /opt/libwebrtc-upstream/linux-$arch-release
ENV WRTC_LIBWEBRTC_DIR=/opt/libwebrtc-upstream

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build && pnpm run typecheck

# --strip-unneeded keeps the dynamic symbol table (napi_register_module_v1,
# the napi_* imports and their GLIBC versions).
FROM build AS stripped
RUN strip --strip-unneeded -o /wrtc.node build/Release/wrtc.node

FROM scratch AS addon
COPY --from=stripped /wrtc.node /wrtc.node

# Last, so it stays the default target.
FROM build AS test
CMD ["sh", "-c", "pnpm test && pnpm run test:exit"]
