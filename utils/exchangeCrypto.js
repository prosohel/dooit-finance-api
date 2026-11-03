/**
 * Exchange hub cryptography — mirrors api_afc_os/utils/crypto.js so both
 * sides hash and sign events identically (plans/integration/03 §4).
 *
 *   payloadHash = sha256:<sha256(canonicalJson(payload))>
 *   signature   = hmac-sha256:<hmac(payloadHash, EXCHANGE_SIGNING_KEY)>
 *
 * Service calls (AFC OS ↔ hub, no user) authenticate with the same key:
 *   X-Exchange-Timestamp: <ISO>   X-Exchange-Signature: hmac(`${ts}\n${METHOD}\n${path}`)
 * valid for five minutes; a replay inside the window is harmless because
 * every write is idempotent by eventId.
 */
const crypto = require("crypto");

function canonicalJson(value) {
  return sortedJson(JSON.parse(JSON.stringify(value ?? null)));
}
function sortedJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(value[k])}`).join(",")}}`;
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const key = () => process.env.EXCHANGE_SIGNING_KEY || "dev-only";
const hmac = (s, k = key()) => crypto.createHmac("sha256", k).update(s).digest("hex");

const payloadHashOf = (payload) => `sha256:${sha256(canonicalJson(payload))}`;
const signatureOf = (payloadHash) => `hmac-sha256:${hmac(payloadHash)}`;

/** Constant-time string compare (lengths may differ). */
function safeEqual(a, b) {
  const A = Buffer.from(String(a ?? ""));
  const B = Buffer.from(String(b ?? ""));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function verifyEvent({ payload, payloadHash, signature }) {
  return safeEqual(payloadHash, payloadHashOf(payload)) && safeEqual(signature, signatureOf(payloadHash));
}

const requestString = (ts, method, path) => `${ts}\n${String(method).toUpperCase()}\n${path}`;
const signRequest = (method, path, ts = new Date().toISOString()) => ({ ts, signature: hmac(requestString(ts, method, path)) });

/** @returns {boolean} the service signature on this request is valid and fresh */
function verifyRequest(req, maxSkewMs = 5 * 60_000) {
  const ts = req.get("x-exchange-timestamp");
  const sig = req.get("x-exchange-signature");
  if (!ts || !sig) return false;
  const t = Date.parse(ts);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > maxSkewMs) return false;
  const path = req.baseUrl + req.path; // "/api/v1/exchange/events" — query string excluded on purpose
  return safeEqual(sig, hmac(requestString(ts, req.method, path)));
}

module.exports = { canonicalJson, sha256, hmac, payloadHashOf, signatureOf, verifyEvent, signRequest, verifyRequest, safeEqual };
