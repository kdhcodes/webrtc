// Node-API calls that may fail without aborting the process.
//
// Worker.terminate() stops a worker's JS from another thread, at any moment:
// from then on every Node-API call that may run JS (property gets and sets,
// coercions, creating buffers and promises, calling functions) fails. When a
// node-addon-api wrapper sees such a failure it builds an Error from the
// last error info, and that path aborts the process ("FATAL ERROR:
// Error::New napi_get_last_error_info"). So code that runs in a JS-callable
// method or in a TSFN callback uses these instead of `Object::Get`/`Set`,
// `Value::ToBoolean`, `Buffer::Copy`, `ArrayBuffer::New`, `Function::Call`
// and `Promise::Deferred`. A failed get reads as undefined (an empty
// Napi::Value, which node-addon-api's type checks treat as undefined); a
// failed set or call is dropped. Nothing they would have produced can reach
// JS anyway. Creating primitives, plain objects and arrays never runs JS, so
// node-addon-api's own versions of those are fine.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <type_traits>

#include <napi.h>

namespace wrtc {

/** A JS value for `value`, or null on failure. */
inline napi_value ToNapi(napi_env, napi_value value) {
  return value;
}
inline napi_value ToNapi(napi_env, const Napi::Value& value) {
  return value;
}
inline napi_value ToNapi(napi_env env, std::string_view s) {
  napi_value out = nullptr;
  return napi_create_string_utf8(env, s.data(), s.size(), &out) == napi_ok
             ? out
             : nullptr;
}
inline napi_value ToNapi(napi_env env, const std::string& s) {
  return ToNapi(env, std::string_view(s));
}
inline napi_value ToNapi(napi_env env, const char* s) {
  return ToNapi(env, std::string_view(s));
}
inline napi_value ToNapi(napi_env env, bool b) {
  napi_value out = nullptr;
  return napi_get_boolean(env, b, &out) == napi_ok ? out : nullptr;
}
template <typename N,
          typename = std::enable_if_t<std::is_arithmetic_v<N> &&
                                      !std::is_same_v<N, bool>>>
napi_value ToNapi(napi_env env, N n) {
  napi_value out = nullptr;
  return napi_create_double(env, static_cast<double>(n), &out) == napi_ok
             ? out
             : nullptr;
}

/** `object[key] = value`; false if it failed (or `value` couldn't be made). */
template <typename T>
bool SafeSet(const Napi::Object& object, const char* key, const T& value) {
  napi_env env = object.Env();
  napi_value v = ToNapi(env, value);
  return v != nullptr &&
         napi_set_named_property(env, object, key, v) == napi_ok;
}
template <typename T>
bool SafeSet(const Napi::Object& object,
             const std::string& key,
             const T& value) {
  return SafeSet(object, key.c_str(), value);
}
template <typename T>
bool SafeSet(const Napi::Object& object, uint32_t index, const T& value) {
  napi_env env = object.Env();
  napi_value v = ToNapi(env, value);
  return v != nullptr && napi_set_element(env, object, index, v) == napi_ok;
}

/** `object[key]`, or an empty value (reads as undefined) if that failed. */
inline Napi::Value SafeGet(const Napi::Object& object, const char* key) {
  napi_value out = nullptr;
  if (napi_get_named_property(object.Env(), object, key, &out) != napi_ok) {
    return Napi::Value();
  }
  return Napi::Value(object.Env(), out);
}
inline Napi::Value SafeGet(const Napi::Object& object, uint32_t index) {
  napi_value out = nullptr;
  if (napi_get_element(object.Env(), object, index, &out) != napi_ok) {
    return Napi::Value();
  }
  return Napi::Value(object.Env(), out);
}

/** `array.length` into `*out`; false (and 0) if that failed. */
inline bool SafeArrayLength(const Napi::Array& array, uint32_t* out) {
  *out = 0;
  return napi_get_array_length(array.Env(), array, out) == napi_ok;
}

/** `array.length`, or 0 if that failed (so a loop over it does nothing). */
inline uint32_t SafeLength(const Napi::Array& array) {
  uint32_t length = 0;
  SafeArrayLength(array, &length);
  return length;
}

/**
 * The base of every native class instead of Napi::ObjectWrap<T>. Its static
 * Unwrap hides ObjectWrap<T>::Unwrap, which node-addon-api's method and
 * accessor trampolines call as `T::Unwrap(this)` and which aborts when
 * napi_unwrap fails (see the top of this file). Ours returns nullptr, which
 * the trampolines turn into `undefined`, and throws "Illegal invocation"
 * only while JS can still run (a `this` that isn't one of ours).
 *
 * Not covered: the napi_wrap in ObjectWrap<T>'s constructor, for objects
 * constructed from JS (`new PeerConnection(...)`, sources and sinks); it
 * can't be reached from here. Handles created by native code go through
 * NewHandle, whose napi_new_instance fails first.
 */
template <typename T>
class SafeObjectWrap : public Napi::ObjectWrap<T> {
 public:
  using Napi::ObjectWrap<T>::ObjectWrap;

  /** For `this` in a method or accessor; see the class comment. */
  static T* Unwrap(Napi::Object wrapper) {
    T* unwrapped = TryUnwrap(wrapper);
    if (unwrapped == nullptr && !wrapper.IsEmpty()) {
      napi_env env = wrapper.Env();
      bool pending = true;
      if (napi_is_exception_pending(env, &pending) == napi_ok && !pending) {
        napi_throw_type_error(env, nullptr, "Illegal invocation");
      }
    }
    return unwrapped;
  }

  /** The native object behind `wrapper`, or nullptr; never throws. */
  static T* TryUnwrap(Napi::Object wrapper) {
    void* unwrapped = nullptr;
    if (wrapper.IsEmpty() ||
        napi_unwrap(wrapper.Env(), wrapper, &unwrapped) != napi_ok) {
      return nullptr;
    }
    return static_cast<T*>(unwrapped);
  }
};

/** `object instanceof ctor`; false if that failed. */
inline bool SafeInstanceOf(const Napi::Object& object,
                           const Napi::Function& ctor) {
  bool out = false;
  return napi_instanceof(object.Env(), object, ctor, &out) == napi_ok && out;
}

/** `!!value` (JS truthiness); false if the coercion failed. */
inline bool SafeToBool(const Napi::Value& value) {
  if (value.IsEmpty()) {
    return false;
  }
  napi_env env = value.Env();
  bool out = false;
  // A boolean (what the JS layer passes) is read without a coercion, which
  // could fail.
  if (napi_get_value_bool(env, value, &out) == napi_ok) {
    return out;
  }
  napi_value coerced = nullptr;
  if (napi_coerce_to_bool(env, value, &coerced) != napi_ok ||
      napi_get_value_bool(env, coerced, &out) != napi_ok) {
    return false;
  }
  return out;
}

/** A Buffer holding a copy of `data`, or null on failure. */
inline napi_value SafeBufferCopy(napi_env env, const void* data, size_t size) {
  napi_value out = nullptr;
  void* copied = nullptr;
  return napi_create_buffer_copy(env, size, data, &copied, &out) == napi_ok
             ? out
             : nullptr;
}

/** An ArrayBuffer holding a copy of `data`, or null on failure. */
inline napi_value SafeArrayBufferCopy(napi_env env,
                                      const void* data,
                                      size_t size) {
  napi_value out = nullptr;
  void* bytes = nullptr;
  if (napi_create_arraybuffer(env, size, &bytes, &out) != napi_ok) {
    return nullptr;
  }
  if (size > 0) {
    std::memcpy(bytes, data, size);
  }
  return out;
}

/**
 * A new promise and its deferred; both empty/null on failure (the caller
 * returns the empty promise, which reads as undefined).
 */
inline Napi::Promise SafeNewPromise(napi_env env, napi_deferred* deferred) {
  napi_value promise = nullptr;
  if (napi_create_promise(env, deferred, &promise) != napi_ok) {
    *deferred = nullptr;
    return Napi::Promise();
  }
  return Napi::Promise(env, promise);
}

/** Resolves or rejects `deferred` with `value` (undefined if null). */
inline void SafeSettle(napi_env env,
                       napi_deferred deferred,
                       bool resolve,
                       napi_value value) {
  if (deferred == nullptr) {
    return;
  }
  if (value == nullptr && napi_get_undefined(env, &value) != napi_ok) {
    return;
  }
  if (resolve) {
    napi_resolve_deferred(env, deferred, value);
  } else {
    napi_reject_deferred(env, deferred, value);
  }
}

}  // namespace wrtc
