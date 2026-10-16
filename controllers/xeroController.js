"use strict";

const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const XeroConnection = require("../models/XeroConnection");
const XeroSyncLog = require("../models/XeroSyncLog");
const XeroJob = require("../models/XeroJob");
const { getConfig, validateXeroConfig } = require("../config/xero");
const xero = require("../services/xero/client");
const oauth = require("../services/xero/oauth");
const tokens = require("../services/xero/tokenService");
const queue = require("../services/xero/jobQueue");
const webhook = require("../services/xero/webhook");
const signup = require("../services/xero/signupService");
const requests = require("../services/xero/connectionRequestService");
const settingsService = require("../services/xero/settingsService");
const { billMappingComplete } = require("../services/xero/mappers");
const { logSync } = require("../services/xero/syncLog");

// ── helpers ──────────────────────────────────────────────────────────────────

const requireEnabled = (_req, _res, next) => {
  const { enabled, errors } = validateXeroConfig();
  if (!enabled) return next(new ErrorResponse(`Xero integration is not configured: ${errors.join("; ") || "disabled"}`, 503));
  next();
};

/**
 * The tenant (Dooit company) the request acts on. Client/branch users are
 * pinned to their own company; dooit staff must name one explicitly.
 */
const resolveCompanyId = (req) => {
  let id = req.user.clientBelongs;
  if (!id && (req.user.userType ?? "").toLowerCase() === "dooit") {
    id = req.query.companyId || req.body?.companyId;
  }
  if (!id) throw new ErrorResponse("A company context is required for Xero", 400);
  if (!mongoose.isValidObjectId(id)) throw new ErrorResponse("Invalid companyId", 400);
  return id;
};

const liveConnection = async (companyId) => {
  const conn = await XeroConnection.findOne({ companyId, status: { $in: ["connected", "error", "revoked"] } });
  return conn;
};

/** The mapping as the UI may see it (ids/codes/names only). */
const publicSettings = (s) =>
  s
    ? {
        billAccountCode: s.billAccountCode || null,
        billAccountName: s.billAccountName || null,
        taxType: s.taxType || null,
        taxTypeName: s.taxTypeName || null,
        taxRatePercent: s.taxRatePercent ?? null,
        billStatus: s.billStatus || "DRAFT",
        syncPayments: !!s.syncPayments,
        paymentAccountId: s.paymentAccountId || null,
        paymentAccountName: s.paymentAccountName || null,
        syncCustomers: !!s.syncCustomers,
        configuredAt: s.configuredAt || null,
      }
    : null;

const publicConnection = (conn, job) => ({
  connected: !!conn && conn.status === "connected",
  setupComplete: billMappingComplete(conn?.settings),
  settings: publicSettings(conn?.settings),
  baseCurrency: conn?.baseCurrency || null,
  xeroUrl: conn?.shortCode ? `https://go.xero.com/organisationlogin/default.aspx?shortcode=${encodeURIComponent(conn.shortCode)}` : null,
  status: conn?.status || "disconnected",
  tenantName: conn?.tenantName || null,
  tenantId: conn?.tenantId || null,
  connectedAt: conn?.connectedAt || null,
  scopes: conn?.scopes || [],
  lastSyncAt: conn?.lastSyncAt || null,
  lastSyncStatus: conn?.lastSyncStatus || "idle",
  lastSyncError: conn?.lastSyncError || null,
  lastSyncSummary: conn?.lastSyncSummary || null,
  syncing: conn?.lastSyncStatus === "running" || !!job,
});

const redirectToSettings = (res, params) => {
  const { postConnectUrl } = getConfig();
  if (!postConnectUrl) return false;
  const url = new URL(postConnectUrl);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  res.redirect(url.toString());
  return true;
};

// ── OAuth ────────────────────────────────────────────────────────────────────

// @route GET /xero/auth   — returns { url } (or 302s with ?redirect=true)
exports.startAuth = asyncHandler(async (req, res) => {
  const companyId = resolveCompanyId(req);
  const state = await oauth.createState(req.user.id, companyId);
  const url = oauth.buildAuthUrl(state);
  if (req.query.redirect === "true") return res.redirect(url);
  res.status(200).json({ success: true, data: { url } });
});

// @route GET /xero/callback — public: reached by Xero's browser redirect.
// Identity comes from the one-time state, never from a cookie or query param.
exports.callback = asyncHandler(async (req, res, next) => {
  const { code, state, error } = req.query;

  const fail = (message, status = 400, reason = "error") => {
    if (redirectToSettings(res, { xero: reason, message })) return;
    return next(new ErrorResponse(message, status));
  };

  const saved = await oauth.consumeState(state);
  if (!saved) return fail("Invalid or expired authorisation state", 400, "invalid_state");

  // "Sign up with Xero" — anonymous; resolved by the signup service.
  if (saved.purpose === "signup") return signupCallback({ saved, code, error, res, next });

  if (error) return fail("Xero authorisation was cancelled", 400, "denied");
  if (!code) return fail("Missing authorisation code", 400);

  try {
    const conn = await xero.connect({ code: String(code), userId: saved.userId, companyId: saved.companyId });
    if (redirectToSettings(res, { xero: "connected", org: conn.tenantName || "" })) return;
    res.status(200).json({ success: true, data: publicConnection(conn) });
  } catch (err) {
    await logSync({ companyId: saved.companyId, entity: "connection", action: "connect", status: "failed", error: err.message, actor: saved.userId });
    return fail(err.statusCode && err.statusCode < 500 ? err.message : "Could not complete the Xero connection", err.statusCode || 502);
  }
});

// ── Sign up with Xero ────────────────────────────────────────────────────────

const redirectToSignup = (res, params) => {
  const { signupUrl } = getConfig();
  if (!signupUrl) return false;
  const url = new URL(signupUrl);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  res.redirect(url.toString());
  return true;
};

const signupCallback = async ({ saved, code, error, res, next }) => {
  const fail = (message, status, reason) => {
    if (redirectToSignup(res, { error: reason, message })) return;
    return next(new ErrorResponse(message, status));
  };
  if (error) return fail("Xero sign-up was cancelled", 400, "denied");
  if (!code) return fail("Missing authorisation code", 400, "error");
  try {
    const out = await signup.handleSignupCallback({ code: String(code), state: saved });
    const params = out.kind === "signup" ? { ticket: out.ticket } : { pending: out.requesterToken };
    if (redirectToSignup(res, params)) return;
    return res.status(200).json({ success: true, data: params });
  } catch (err) {
    await logSync({ entity: "connection", action: "xero_signup", status: "failed", error: err.message });
    const safe = err.statusCode && err.statusCode < 500 ? err.message : "Could not sign up with Xero";
    return fail(safe, err.statusCode || 502, err.statusCode === 409 ? "exists" : "error");
  }
};

// @route GET /xero/signup/start — public; returns { url } (or 302 with ?redirect=true)
exports.signupStart = asyncHandler(async (req, res) => {
  const url = await signup.startSignup();
  if (req.query.redirect === "true") return res.redirect(url);
  res.status(200).json({ success: true, data: { url } });
});

// @route GET /xero/signup/prefill?ticket=… — public; ticket is the credential
exports.signupPrefill = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await signup.getPrefill(req.query.ticket) });
});

// @route POST /xero/signup/complete — { ticket, ...form }
exports.signupComplete = asyncHandler(async (req, res) => {
  const { ticket, ...form } = req.body || {};
  const data = await signup.completeSignup({ ticket, form });
  res.status(201).json({ success: true, data });
});

// @route POST /xero/signup/session — { loginCode } → { token } (same shape as /auth/login)
exports.signupSession = asyncHandler(async (req, res) => {
  const token = await signup.redeemLoginCode(req.body?.loginCode);
  res.status(200).json({ success: true, token });
});

// ── Existing-client approval (organisation already belongs to a client) ──────

// @route GET /xero/connection-requests/:token — public; token is the credential.
// Shows only the organisation and who asked.
exports.connectionRequestDetails = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await requests.getForApprover(req.params.token) });
});

// @route POST /xero/connection-requests/:token/approve — client administrator only
exports.connectionRequestApprove = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await requests.approve({ token: req.params.token, user: req.user }) });
});

// @route POST /xero/connection-requests/:token/reject — the emailed token suffices
exports.connectionRequestReject = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await requests.reject({ token: req.params.token }) });
});

// @route GET /xero/signup/pending?token=… — requester polls approval status
exports.signupPending = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await requests.getRequesterStatus(req.query.token) });
});

// @route POST /xero/signup/pending/continue — { token } once approved
exports.signupPendingContinue = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await requests.continueAsRequester(req.body?.token) });
});

// @route POST /xero/refresh
exports.refresh = asyncHandler(async (req, res) => {
  const conn = await liveConnection(resolveCompanyId(req));
  if (!conn || conn.status === "disconnected") throw new ErrorResponse("Xero is not connected", 409);
  await tokens.refreshAccessToken(conn._id);
  const fresh = await XeroConnection.findById(conn._id);
  res.status(200).json({ success: true, data: publicConnection(fresh) });
});

// @route POST /xero/disconnect
exports.disconnect = asyncHandler(async (req, res) => {
  const conn = await liveConnection(resolveCompanyId(req));
  if (!conn) throw new ErrorResponse("Xero is not connected", 409);
  const result = await xero.disconnect(conn, { actor: req.user.id });
  res.status(200).json({ success: true, data: { ...publicConnection(await XeroConnection.findById(conn._id)), ...result } });
});

// ── Status / sync ────────────────────────────────────────────────────────────

// @route GET /xero/status
exports.status = asyncHandler(async (req, res) => {
  const companyId = resolveCompanyId(req);
  const conn = await liveConnection(companyId);
  const job = conn
    ? await XeroJob.findOne({ tenantId: conn.tenantId, type: "full_sync", status: { $in: ["queued", "running"] } }).lean()
    : null;
  res.status(200).json({ success: true, data: { ...publicConnection(conn, job), configured: validateXeroConfig().enabled } });
});

// @route POST /xero/sync — "Sync Now". Duplicate clicks collapse into one job.
exports.syncNow = asyncHandler(async (req, res) => {
  const conn = await liveConnection(resolveCompanyId(req));
  if (!conn || conn.status !== "connected") {
    throw new ErrorResponse(conn?.status === "revoked" ? "Xero access was revoked — please reconnect" : "Xero is not connected", 409);
  }
  if (conn.lastSyncStatus === "running") {
    return res.status(202).json({ success: true, data: { ...publicConnection(conn), alreadyRunning: true } });
  }
  const { duplicate } = await queue.enqueue("full_sync", {
    tenantId: conn.tenantId,
    companyId: conn.companyId,
    dedupeKey: `full:${conn.tenantId}`,
    requestedBy: req.user.id,
  });
  await logSync({ tenantId: conn.tenantId, companyId: conn.companyId, entity: "sync", action: "requested", status: "success", actor: req.user.id });
  res.status(202).json({ success: true, data: { ...publicConnection(conn, true), alreadyRunning: duplicate } });
});

// ── Mapping (accounts, tax rate, payments) ───────────────────────────────────

const connectedOrThrow = async (req) => {
  const conn = await liveConnection(resolveCompanyId(req));
  if (!conn || conn.status !== "connected") {
    throw new ErrorResponse(conn?.status === "revoked" ? "Xero access was revoked — please reconnect" : "Xero is not connected", 409);
  }
  return conn;
};

// @route GET /xero/settings — saved mapping + the organisation's live accounts and tax rates
exports.getSettings = asyncHandler(async (req, res) => {
  const conn = await connectedOrThrow(req);
  const { options, problems } = await settingsService.loadOptions(conn);
  res.status(200).json({ success: true, data: { settings: publicSettings(conn.settings), options, problems } });
});

// @route PUT /xero/settings — { billAccountCode, taxType, billStatus, syncPayments, paymentAccountId, syncCustomers }
exports.saveSettings = asyncHandler(async (req, res) => {
  const conn = await connectedOrThrow(req);
  const wasComplete = billMappingComplete(conn.settings);
  const settings = await settingsService.saveSettings(conn, req.body, { actor: req.user.id });
  // A full pass picks up every issued invoice that waited for the mapping.
  await queue.enqueue("full_sync", {
    tenantId: conn.tenantId,
    companyId: conn.companyId,
    dedupeKey: `full:${conn.tenantId}`,
    requestedBy: req.user.id,
  });
  res.status(200).json({ success: true, data: { settings: publicSettings(settings), firstSetup: !wasComplete } });
});

// @route GET /xero/logs?status=failed&limit=50
exports.logs = asyncHandler(async (req, res) => {
  const conn = await liveConnection(resolveCompanyId(req));
  if (!conn) return res.status(200).json({ success: true, count: 0, data: [] });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const filter = { tenantId: conn.tenantId, ...(req.query.status ? { status: String(req.query.status) } : {}) };
  const rows = await XeroSyncLog.find(filter).sort({ timestamp: -1 }).limit(limit).lean();
  res.status(200).json({ success: true, count: rows.length, data: rows });
});

// ── Webhook ──────────────────────────────────────────────────────────────────

// @route POST /xero/webhook — public; authenticated by signature, raw body.
exports.webhook = asyncHandler(async (req, res) => {
  const raw = req.body;
  const signature = req.get("x-xero-signature");

  if (!Buffer.isBuffer(raw) || !webhook.verifySignature(raw, signature)) {
    await logSync({ entity: "webhook", action: "verify", direction: "inbound", status: "failed", error: "invalid signature" });
    return res.status(401).end();
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).end();
  }

  // Ack first (Xero's 5 s budget); intake only writes small queue rows.
  await webhook.processPayload(payload);
  res.status(200).end();
});

exports.requireEnabled = requireEnabled;
