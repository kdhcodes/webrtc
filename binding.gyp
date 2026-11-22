{
  "variables": {
    "webrtc_dir": "<!(python3 scripts/gyp-webrtc.py dir)",
  },
  "targets": [
    {
      "target_name": "wrtc",
      "sources": [
        "src/addon.cc",
        "src/runtime.cc",
        "src/event_sink.cc",
        "src/peer_connection.cc",
        "src/data_channel.cc",
        "src/media_track.cc",
        "src/media_source.cc",
        "src/media_sink.cc",
        "src/rtp.cc",
        "src/yuv.cc",
        "src/playout_adm.cc",
        "src/log_hook.cc",
        "src/sink_reassert.cc",
        "src/receiver_mute.cc",
        "src/transport.cc",
        "src/certificate.cc",
        "src/video_encoder_factory.cc",
      ],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")",
        "<(webrtc_dir)/include",
        "<(webrtc_dir)/include/third_party/abseil-cpp",
        "<(webrtc_dir)/include/third_party/libyuv/include",
      ],
      "defines": [
        "<!@(python3 scripts/gyp-webrtc.py defines)",
        "WEBRTC_APM_DEBUG_DUMP=0",
        "NAPI_VERSION=9",
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        # Events still queued when a worker env tears down are delivered
        # while JS can no longer run; without this, the first failed napi
        # call in CallJs becomes a fatal error instead of a no-op.
        "NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS",
      ],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
            "CLANG_CXX_LIBRARY": "libc++",
            "GCC_ENABLE_CPP_RTTI": "YES",
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            # libwebrtc is built with hidden visibility; match it so weak
            # template symbols agree across the link (NODE_API_MODULE still
            # exports the module entry point explicitly).
            "GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
            "GCC_INLINES_ARE_PRIVATE_EXTERN": "YES",
            "OTHER_CFLAGS": ["-Wno-nullability-completeness", "-Wno-deprecated-declarations"],
            "OTHER_LDFLAGS": [
              "-Wl,-dead_strip",
              "<(webrtc_dir)/lib/libwebrtc.a",
              "-framework Foundation", "-framework AVFoundation", "-framework Security",
              "-framework CoreAudio", "-framework AudioToolbox", "-framework AppKit",
              "-framework CoreMedia", "-framework CoreGraphics", "-framework VideoToolbox",
              "-framework CoreVideo", "-framework OpenGL", "-framework Metal",
              "-framework MetalKit", "-framework QuartzCore", "-framework IOKit",
              "-framework IOSurface", "-framework ScreenCaptureKit",
            ],
          },
        }],
        # The Linux libwebrtc is built against Chromium's hermetic libc++
        # (std::__Cr), so we must compile with clang against those headers
        # and not link libstdc++; GCC ignores libc++'s trivial_abi and
        # miscompiles calls passing unique_ptr/shared_ptr (PLAN.md "Linux").
        # Build with CC=clang CXX=clang++.
        ["OS=='linux'", {
          "cflags_cc": [
            "-std=c++20", "-frtti", "-fno-exceptions", "-nostdinc++",
            "-fvisibility=hidden", "-fvisibility-inlines-hidden",
            "-isystem<(webrtc_dir)/include/third_party/libc++/src/include",
            "-isystem<(webrtc_dir)/include/third_party/libc++abi/src/include",
            "-isystem<(webrtc_dir)/include/buildtools/third_party/libc++",
            "-Wno-deprecated-declarations", "-Wno-nullability-completeness",
          ],
          "cflags_cc!": ["-fno-rtti", "-std=gnu++17", "-std=gnu++20"],
          # --exclude-libs keeps everything from libwebrtc.a (its libc++abi,
          # BoringSSL, ...) out of the addon's dynamic symbol table, so none
          # of it interposes with the libstdc++/OpenSSL symbols Node exports.
          # -z nodelete: Node dlclose()s an addon when the last env that
          # loaded it is destroyed (a worker that loaded it alone), but the
          # libwebrtc threads (src/runtime.cc) and BoringSSL's pthread_key
          # destructor outlive every env and run our code afterwards. macOS
          # needs nothing: dyld never unloads an image with TLVs or ObjC.
          "ldflags": [
            "-nostdlib++", "-Wl,--gc-sections", "-Wl,--exclude-libs,ALL", "-Wl,-z,nodelete",
          ],
          "libraries": ["<(webrtc_dir)/lib/libwebrtc.a", "-lrt", "-ldl", "-lpthread", "-lm"],
        }],
      ],
    },
  ],
}
