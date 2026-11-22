#include "certificate.h"

#include <cmath>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>

#include "event_sink.h"
#include "napi_safe.h"
#include "util.h"

#include "api/rtc_error.h"
#include "rtc_base/rtc_certificate_generator.h"
#include "rtc_base/ssl_fingerprint.h"
#include "rtc_base/ssl_identity.h"

namespace wrtc {
namespace {

// One generateCertificate() call. Created on the JS thread, filled in on a
// threadpool thread (Execute), settled and deleted on the JS thread
// (Complete). Execute only touches the plain fields.
struct GenerateWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  webrtc::KeyParams params;
  std::optional<uint64_t> expires_ms;

  bool ok = false;
  std::string private_key;
  std::string certificate;
  uint64_t expires = 0;
  std::string algorithm;
  std::string fingerprint;
};

void Execute(napi_env, void* data) {
  auto* w = static_cast<GenerateWork*>(data);
  webrtc::scoped_refptr<webrtc::RTCCertificate> cert =
      webrtc::RTCCertificateGenerator::GenerateCertificate(w->params,
                                                           w->expires_ms);
  if (!cert) {
    return;
  }
  // The fingerprint libwebrtc puts in the SDP (JsepTransportDescription
  // uses the same function), so getFingerprints() always matches it.
  std::unique_ptr<webrtc::SSLFingerprint> fp =
      webrtc::SSLFingerprint::CreateFromCertificate(*cert);
  if (!fp) {
    return;
  }
  webrtc::RTCCertificatePEM pem = cert->ToPEM();
  w->private_key = pem.private_key();
  w->certificate = pem.certificate();
  w->expires = cert->Expires();
  w->algorithm = fp->algorithm;
  w->fingerprint = fp->GetRfc4572Fingerprint();
  w->ok = true;
}

// A plain Error with `errorType` (NativeError), built with raw N-API calls:
// this runs from a completion callback, where JS may no longer be able to
// run (worker termination) and node-addon-api's error path would abort.
napi_value MakeError(napi_env env,
                     webrtc::RTCErrorType type,
                     const char* message) {
  napi_value msg = ToNapi(env, message);
  napi_value err = nullptr;
  if (msg == nullptr || napi_create_error(env, nullptr, msg, &err) != napi_ok) {
    return nullptr;
  }
  SafeSet(Napi::Object(env, err), "errorType",
          std::string(webrtc::ToString(type)));
  return err;
}

void Complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<GenerateWork> w(static_cast<GenerateWork*>(data));
  napi_delete_async_work(env, w->work);
  if (status != napi_ok || !w->ok) {
    SafeSettle(env, w->deferred, false,
               MakeError(env, webrtc::RTCErrorType::INTERNAL_ERROR,
                         "certificate generation failed"));
    return;
  }
  napi_value result = nullptr;
  napi_value fingerprint = nullptr;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_object(env, &fingerprint) != napi_ok) {
    SafeSettle(env, w->deferred, false, nullptr);
    return;
  }
  Napi::Object out(env, result);
  Napi::Object fp(env, fingerprint);
  SafeSet(fp, "algorithm", w->algorithm);
  SafeSet(fp, "value", w->fingerprint);
  SafeSet(out, "privateKey", w->private_key);
  SafeSet(out, "certificate", w->certificate);
  SafeSet(out, "expires", static_cast<double>(w->expires));
  SafeSet(out, "fingerprint", fingerprint);
  SafeSettle(env, w->deferred, true, result);
}

// {type: 'ecdsa'} or {type: 'rsa', modulusLength, publicExponent}. On
// failure a TypeError is pending.
bool ParseKeyParams(Napi::Env env, Napi::Value value, webrtc::KeyParams* out) {
  if (!value.IsObject()) {
    ThrowTypeError(env, "keyParams must be an object");
    return false;
  }
  Napi::Object obj = value.As<Napi::Object>();
  Napi::Value type = SafeGet(obj, "type");
  if (!type.IsString()) {
    ThrowTypeError(env, "keyParams.type must be 'ecdsa' or 'rsa'");
    return false;
  }
  std::string name = type.As<Napi::String>().Utf8Value();
  if (name == "ecdsa") {
    *out = webrtc::KeyParams::ECDSA(webrtc::EC_NIST_P256);
    return true;
  }
  if (name == "rsa") {
    Napi::Value modulus = SafeGet(obj, "modulusLength");
    Napi::Value exponent = SafeGet(obj, "publicExponent");
    if (!modulus.IsNumber() || !exponent.IsNumber()) {
      ThrowTypeError(env, "keyParams needs a modulusLength and publicExponent");
      return false;
    }
    // The JS layer passes integers that fit in an int (as Chrome requires);
    // IsValid() then checks libwebrtc's own limits.
    *out = webrtc::KeyParams::RSA(modulus.As<Napi::Number>().Int32Value(),
                                  exponent.As<Napi::Number>().Int32Value());
    return true;
  }
  ThrowTypeError(env, "keyParams.type must be 'ecdsa' or 'rsa'");
  return false;
}

}  // namespace

Napi::Value GenerateCertificate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto w = std::make_unique<GenerateWork>();
  if (!ParseKeyParams(env, info[0], &w->params)) {
    return env.Undefined();
  }
  Napi::Value expires = info[1];
  if (expires.IsNumber()) {
    double ms = expires.As<Napi::Number>().DoubleValue();
    // Finite and within 2^53 - 1 (the JS layer's [EnforceRange] limit), so
    // the cast below is defined.
    if (!std::isfinite(ms) || ms < 0 || ms > 9007199254740991.0) {
      return ThrowTypeError(env, "expires must be a non-negative safe integer");
    }
    w->expires_ms = static_cast<uint64_t>(ms);
  } else if (!expires.IsUndefined()) {
    return ThrowTypeError(env, "expires must be a number");
  }
  if (!w->params.IsValid()) {
    return RejectedPromise(
        env, ToJsError(env, webrtc::RTCErrorType::INVALID_PARAMETER,
                       "unsupported key parameters"));
  }

  Napi::Promise promise = SafeNewPromise(env, &w->deferred);
  if (w->deferred == nullptr) {
    return promise;
  }
  napi_value resource = ToNapi(env, "wrtc:generateCertificate");
  bool queued = resource != nullptr &&
                napi_create_async_work(env, nullptr, resource, Execute,
                                       Complete, w.get(), &w->work) == napi_ok;
  if (queued && napi_queue_async_work(env, w->work) != napi_ok) {
    napi_delete_async_work(env, w->work);
    queued = false;
  }
  if (!queued) {
    SafeSettle(env, w->deferred, false,
               MakeError(env, webrtc::RTCErrorType::INTERNAL_ERROR,
                         "could not queue certificate generation"));
    return promise;
  }
  // Owned by the async work from here; Complete deletes it.
  w.release();
  return promise;
}

bool ParseCertificates(
    Napi::Env env,
    Napi::Value value,
    std::vector<webrtc::scoped_refptr<webrtc::RTCCertificate>>* out) {
  if (!value.IsArray()) {
    ThrowTypeError(env, "certificates must be an array");
    return false;
  }
  Napi::Array arr = value.As<Napi::Array>();
  std::vector<webrtc::scoped_refptr<webrtc::RTCCertificate>> parsed;
  for (uint32_t i = 0; i < SafeLength(arr); i++) {
    Napi::Value entry = SafeGet(arr, i);
    if (!entry.IsObject()) {
      ThrowTypeError(env, "certificates entries must be objects");
      return false;
    }
    Napi::Value key = SafeGet(entry.As<Napi::Object>(), "privateKey");
    Napi::Value cert = SafeGet(entry.As<Napi::Object>(), "certificate");
    if (!key.IsString() || !cert.IsString()) {
      ThrowTypeError(env, "certificates entries need PEM strings");
      return false;
    }
    webrtc::scoped_refptr<webrtc::RTCCertificate> certificate =
        webrtc::RTCCertificate::FromPEM(
            webrtc::RTCCertificatePEM(key.As<Napi::String>().Utf8Value(),
                                      cert.As<Napi::String>().Utf8Value()));
    if (!certificate) {
      if (!env.IsExceptionPending()) {
        ToJsError(env, webrtc::RTCErrorType::INVALID_PARAMETER,
                  "invalid certificate PEM")
            .ThrowAsJavaScriptException();
      }
      return false;
    }
    parsed.push_back(std::move(certificate));
  }
  *out = std::move(parsed);
  return true;
}

}  // namespace wrtc
