// A debugging aid: libwebrtc's own log lines, filtered, on stderr or in a
// file. Off unless WRTC_LOG is set (CONTRIBUTING-AGENTS.md, "Debugging
// libwebrtc"):
//   WRTC_LOG='SetSink|default receive stream'  lines containing any of the
//                                              '|'-separated substrings
//   WRTC_LOG='*' (or empty)                    every line
//   WRTC_LOG_FILE=/path                        append there, not to stderr
// Lines are info severity and up, prefixed with "RTCLOG <seconds> [thread]",
// where the seconds are on the monotonic clock process.hrtime() reads (on
// macOS and Linux), to line them up with timestamps from JS.
#pragma once

namespace wrtc {

// Reads the environment the first time it's called in the process and, if
// WRTC_LOG is set, adds the sink for the rest of the process. When it isn't
// set, nothing is registered and libwebrtc logs exactly as it otherwise
// would.
void InstallLogHookFromEnv();

}  // namespace wrtc
