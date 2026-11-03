/**
 * AFC OS Service
 * ─────────────────────────────────────────────────────────────────────────────
 * The only place that knows how to talk to the AFC OS API (../api_afc_os) as a
 * connected application. Same shape as tbmlOsintService.js: a thin axios
 * wrapper, no business logic.
 *
 * AFC OS identifies us by client credentials (clientId + secret → short-lived
 * client JWT, POST /auth/token). The token is cached here and refreshed a
 * minute before it expires or after a 401.
 *
 * Env vars:
 *   AFC_OS_API_URL        – service root, e.g. http://localhost:6832/api/v1
 *   AFC_OS_CLIENT_ID      – clientId registered in AFC OS (seed: afc_platform_api)
 *   AFC_OS_CLIENT_SECRET  – its secret (dummy dev value in api_afc_os/example.env)
 */

const axios = require("axios");

const getConfig = () => {
  const baseURL = (process.env.AFC_OS_API_URL || "http://localhost:6832/api/v1").replace(/\/+$/, "");
  const clientId = process.env.AFC_OS_CLIENT_ID;
  const clientSecret = process.env.AFC_OS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error("AFC OS is not configured. Set AFC_OS_CLIENT_ID and AFC_OS_CLIENT_SECRET (and AFC_OS_API_URL).");
    err.code = "AFC_OS_NOT_CONFIGURED";
    throw err;
  }
  return { baseURL, clientId, clientSecret };
};

const isConfigured = () => !!(process.env.AFC_OS_CLIENT_ID && process.env.AFC_OS_CLIENT_SECRET);

// ── Client token cache ───────────────────────────────────────────────────────
let cached = null; // { token, expiresAt: ms, client }

const REFRESH_SKEW_MS = 60_000;

async function getToken({ force = false } = {}) {
  if (!force && cached && cached.expiresAt - REFRESH_SKEW_MS > Date.now()) return cached.token;
  const { baseURL, clientId, clientSecret } = getConfig();
  const { data } = await axios.post(`${baseURL}/auth/token`, { clientId, clientSecret }, { timeout: 15_000 });
  cached = { token: data.token, expiresAt: new Date(data.expires).getTime(), client: data.client };
  return cached.token;
}

/** Authenticated call; retries once with a fresh token on 401. Returns the AFC OS response body. */
async function request(method, path, { data, params, timeout = 30_000 } = {}) {
  const { baseURL } = getConfig();
  const call = async (token) =>
    axios({ method, url: `${baseURL}${path}`, data, params, timeout, headers: { Authorization: `Bearer ${token}` } });
  try {
    const res = await call(await getToken());
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      const res = await call(await getToken({ force: true }));
      return res.data;
    }
    throw err;
  }
}

/** Normalises an axios failure into { status, message } for controllers. */
const describeError = (err) => ({
  status: err.response?.status ?? (err.code === "AFC_OS_NOT_CONFIGURED" ? 503 : 502),
  message: err.response?.data?.error ?? err.message,
});

// ── Operations ───────────────────────────────────────────────────────────────

/** Who AFC OS thinks we are (scopes etc.) — the "Connected Platforms" status card. */
async function whoAmI() {
  const body = await request("get", "/auth/me");
  return body.data?.active ?? null;
}

/**
 * Single-use, 15-minute handoff INTO AFC OS for a platform user who already
 * holds an AFC OS membership (matched by platformUserId, then email).
 * Returns { url, token, expiresAt, context, returnTo }.
 */
async function issueHandoff({ platformUserId, email, userType = null, returnTo = null }) {
  return request("post", "/auth/handoff", { data: { platformUserId, email, userType, returnTo } });
}

/** Exchange events addressed to a reporting organisation (platform Client._id), newest first. */
async function listEvents({ roId, limit = 50 } = {}) {
  return request("get", "/exchange-events", { params: { ...(roId ? { "to.roId": roId } : {}), limit, sort: "-createdAt" } });
}

module.exports = { isConfigured, getToken, request, whoAmI, issueHandoff, listEvents, describeError };
