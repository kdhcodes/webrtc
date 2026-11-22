#include "log_hook.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "rtc_base/logging.h"

namespace wrtc {
namespace {

class FilterLogSink : public webrtc::LogSink {
 public:
  FilterLogSink(std::vector<std::string> filters, FILE* out)
      : filters_(std::move(filters)), out_(out) {}

  // libwebrtc calls these on its own threads, under its logging lock, so
  // lines never interleave.
  void OnLogMessage(const webrtc::LogLineRef& line) override {
    Write(line.DefaultLogLine(), line.severity());
  }
  void OnLogMessage(const std::string& message) override {
    Write(message, webrtc::LS_INFO);
  }

 private:
  // Runs under libwebrtc's global logging lock, with blocking writes: if
  // stderr or the file blocks (e.g. a pipe nobody reads), every libwebrtc
  // thread that logs blocks with it. Acceptable for a debugging aid only.
  void Write(const std::string& text, webrtc::LoggingSeverity severity) {
    bool matches = Matches(text);
    if (matches) {
      auto micros = std::chrono::duration_cast<std::chrono::microseconds>(
                        std::chrono::steady_clock::now().time_since_epoch())
                        .count();
      std::ostringstream thread;
      thread << std::this_thread::get_id();
      bool newline = !text.empty() && text.back() == '\n';
      std::fprintf(out_, "RTCLOG %lld.%06lld [%s] %s%s",
                   static_cast<long long>(micros / 1000000),
                   static_cast<long long>(micros % 1000000),
                   thread.str().c_str(), text.c_str(), newline ? "" : "\n");
      std::fflush(out_);
    }
    // libwebrtc's own stderr output is off while the hook is on (see
    // InstallLogHookFromEnv); errors still go there, as they did.
    if (severity >= webrtc::LS_ERROR && !(matches && out_ == stderr)) {
      std::fputs(text.c_str(), stderr);
      std::fflush(stderr);
    }
  }

  bool Matches(const std::string& text) const {
    if (filters_.empty()) {
      return true;
    }
    for (const auto& filter : filters_) {
      if (text.find(filter) != std::string::npos) {
        return true;
      }
    }
    return false;
  }

  const std::vector<std::string> filters_;
  FILE* const out_;
};

// '|'-separated substrings; none (empty or '*') matches every line.
std::vector<std::string> ParseFilters(const std::string& spec) {
  std::vector<std::string> filters;
  if (spec == "*") {
    return filters;
  }
  std::stringstream stream(spec);
  std::string part;
  while (std::getline(stream, part, '|')) {
    if (!part.empty()) {
      filters.push_back(part);
    }
  }
  return filters;
}

}  // namespace

void InstallLogHookFromEnv() {
  // Once per process, though each worker loads the addon again.
  static const bool installed = [] {
    const char* spec = std::getenv("WRTC_LOG");
    if (spec == nullptr) {
      return false;
    }
    FILE* out = stderr;
    const char* path = std::getenv("WRTC_LOG_FILE");
    if (path != nullptr && *path != '\0') {
      out = std::fopen(path, "a");
      if (out == nullptr) {
        std::fprintf(stderr,
                     "wrtc: can't open WRTC_LOG_FILE %s, using stderr\n", path);
        out = stderr;
      }
    }
    // By default libwebrtc formats almost nothing (its minimum severity is
    // "none"), and prints what it does format, mostly RTCError messages, to
    // stderr. A sink at info severity lowers that minimum for everything,
    // so without this stderr would get every info line too.
    webrtc::LogMessage::SetLogToStderr(false);
    // Never removed or freed: libwebrtc's threads can log until the process
    // exits.
    webrtc::LogMessage::AddLogToStream(
        new FilterLogSink(ParseFilters(spec), out), webrtc::LS_INFO);
    return true;
  }();
  static_cast<void>(installed);
}

}  // namespace wrtc
