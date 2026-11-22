// Small helpers shared by the native classes.
#pragma once

#include <string>

#include <napi.h>

#include "napi_safe.h"

namespace wrtc {

// Throws "<what> is not implemented yet" and returns undefined. Used by the
// WP0 skeleton for contract members a later work package fills in.
inline Napi::Value NotImplemented(Napi::Env env, const char* what) {
  if (!env.IsExceptionPending()) {
    Napi::Error err =
        Napi::Error::New(env, std::string(what) + " is not implemented yet");
    SafeSet(err.Value(), "code", "ERR_WRTC_NOT_IMPLEMENTED");
    err.ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

// Throws a TypeError unless one is already pending, and returns undefined.
inline Napi::Value ThrowTypeError(Napi::Env env, const std::string& message) {
  if (!env.IsExceptionPending()) {
    Napi::TypeError::New(env, message).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

}  // namespace wrtc
