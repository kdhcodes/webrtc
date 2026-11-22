// RTCPeerConnection.generateCertificate() and the `certificates` of a PC's
// configuration.
//
// A certificate crosses into JS as plain data: its private key and
// certificate as PEM, plus what the JS RTCCertificate shows (expiry and
// fingerprint). A PC's configuration passes the PEM back, and libwebrtc
// gets a fresh RTCCertificate parsed from it (RTCCertificate::FromPEM), with
// the same key and so the same fingerprint. No native handle outlives a
// call, so there is nothing to keep alive or finalize, and nothing tied to
// one Node environment.
#pragma once

#include <vector>

#include <napi.h>

#include "api/scoped_refptr.h"
#include "rtc_base/rtc_certificate.h"

namespace wrtc {

// generateCertificate(keyParams, expiresMs?): Promise<{privateKey,
// certificate, expires, fingerprint: {algorithm, value}}>. keyParams is
// {type: 'ecdsa'} (P-256) or {type: 'rsa', modulusLength, publicExponent}.
// The key is generated on a libuv threadpool thread (RSA takes from tens of
// milliseconds to seconds), never on the JS thread. Rejects with
// INVALID_PARAMETER, at call time, for key parameters libwebrtc doesn't
// support (KeyParams::IsValid), and with INTERNAL_ERROR if generation fails.
Napi::Value GenerateCertificate(const Napi::CallbackInfo& info);

// Reads an array of {privateKey, certificate} (PEM) into `out`. On failure a
// JS exception is pending: a TypeError for a malformed value, INVALID_PARAMETER
// for PEM libwebrtc can't parse.
bool ParseCertificates(
    Napi::Env env,
    Napi::Value value,
    std::vector<webrtc::scoped_refptr<webrtc::RTCCertificate>>* out);

}  // namespace wrtc
