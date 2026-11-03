/**
 * AFC OS connector — what the platform exposes to ui / ewra_ui about the
 * regulator's platform. All calls are server-to-server with the platform's
 * own client credentials (services/afcOsService.js); a browser never holds them.
 */
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const afcOs = require("../services/afcOsService");
const User = require("../models/User");
const UserType = require("../models/UserType");
const { logEvent } = require("../utils/audit");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const AfcHandoffToken = require("../models/HandoffToken");
const Client = require("../models/Client");
const { ensureAfcOfficer } = require("../services/afcOsIdentity");
const fileVaultService = require("../utils/fileVaultService");

const HANDOFF_TTL_MS = 15 * 60_000;
const targetBase = (target) => ((target === "grc" ? process.env.EWRA_UI_URL || "http://localhost:8002" : process.env.UI_URL || "http://localhost:8001").replace(/\/+$/, ""));

// @desc    Is AFC OS configured and reachable, and what may this platform do there?
// @route   GET /api/v1/afc-os/status
// @access  Private
exports.status = asyncHandler(async (req, res) => {
  if (!afcOs.isConfigured()) {
    return res.status(200).json({ success: true, data: { configured: false, connected: false } });
  }
  try {
    const active = await afcOs.whoAmI();
    res.status(200).json({ success: true, data: { configured: true, connected: true, clientId: active?.clientId ?? null, scopes: active?.permissions ?? [] } });
  } catch (err) {
    const { status, message } = afcOs.describeError(err);
    res.status(200).json({ success: true, data: { configured: true, connected: false, error: message, upstreamStatus: status } });
  }
});

// @desc    Open AFC OS as the logged-in platform user. AFC OS only agrees when the
//          person already holds an AFC OS membership; nothing is provisioned here.
// @route   POST /api/v1/afc-os/handoff   { userType?, returnTo? }
// @access  Private
exports.handoff = asyncHandler(async (req, res, next) => {
  const { userType = null, returnTo = null } = req.body ?? {};
  try {
    const out = await afcOs.issueHandoff({ platformUserId: String(req.user._id), email: req.user.email, userType, returnTo });
    logEvent?.({ req, service: "afc-os", action: "handoff_issued", target: { kind: "User", id: req.user._id }, after: { userType: out.context?.userType, role: out.context?.role } });
    // The browser only needs the URL; the token is inside it.
    res.status(200).json({ success: true, data: { url: out.url, expiresAt: out.expiresAt, context: out.context } });
  } catch (err) {
    const { status, message } = afcOs.describeError(err);
    if (status === 404) return next(new ErrorResponse("You do not have an AFC OS account. Ask the MLTFPD administrator to invite you.", 403));
    return next(new ErrorResponse(`AFC OS handoff failed: ${message}`, status === 503 ? 503 : 502));
  }
});

// @desc    AFC OS → platform: issue a single-use SSO ticket for a regulator officer (signed service call from AFC OS).
//          The officer gets a platform User + `dooit` membership with the "AFC OS Administrator" role on first use.
// @route   POST /api/v1/afc-os/handoff/inbound   { email, name?, afcUserId?, body?, role?, target: portal|grc, tenant?: <Client _id | uid | slug>, scope?: admin|supervisory, returnTo? }
// @access  Exchange signature (afcos)
exports.handoffInbound = asyncHandler(async (req, res, next) => {
  if (!req.exchangeCaller?.service || req.exchangeCaller.app !== "afcos") return next(new ErrorResponse("Only AFC OS issues inbound handoffs", 403));
  const { email, name = null, afcUserId = null, body = null, role = null, target = "portal", tenant = null, scope = "admin", returnTo = null } = req.body ?? {};
  if (!email) return next(new ErrorResponse("email is required", 400));
  if (!["portal", "grc"].includes(target)) return next(new ErrorResponse("target must be portal or grc", 400));
  if (!["admin", "supervisory"].includes(scope)) return next(new ErrorResponse("scope must be admin or supervisory", 400));
  let client = null;
  if (tenant) {
    client = /^[0-9a-f]{24}$/i.test(String(tenant)) ? await Client.findById(tenant).select("_id uid name slug").lean() : await Client.findOne({ $or: [{ uid: tenant }, { slug: tenant }, { name: tenant }] }).select("_id uid name slug").lean();
    if (!client) return next(new ErrorResponse(`Tenant "${tenant}" not found on the platform`, 404));
  }
  const { user, membership, created } = await ensureAfcOfficer({ email, name, afcUserId });
  const jti = crypto.randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);
  const safeReturnTo = typeof returnTo === "string" && /^\/(?!\/)/.test(returnTo) ? returnTo : null;
  await AfcHandoffToken.create({ jti, user: user._id, membership: membership._id, target, scope, tenant: client?._id ?? null, returnTo: safeReturnTo, requested: { email, name, afcUserId, body, role }, expiresAt, issuedIp: req.ip ?? null });
  const token = jwt.sign({ iss: "dooit-platform", kind: "afc_handoff", jti, sub: String(user._id) }, process.env.JWT_SECRET, { expiresIn: Math.floor(HANDOFF_TTL_MS / 1000) });
  const q = new URLSearchParams({ token, sso: "bb-afcos", scope, ...(client?.slug ? { tenant: client.slug } : {}), ...(safeReturnTo ? { returnTo: safeReturnTo } : {}) });
  const url = `${targetBase(target)}/sso/afcos?${q.toString()}`;
  logEvent?.({ req: { ...req, user: { _id: user._id, name: user.name, email: user.email, userType: "dooit", role: membership.role } }, service: "afc-os", action: "handoff_inbound_issued", target: { kind: "User", id: user._id }, after: { target, scope, tenant: client?.uid ?? null, created, afcUserId, body, role } });
  res.status(201).json({ success: true, data: { url, expiresAt, created, context: { userType: "dooit", role: membership.role, target, scope, tenant: client ? { id: client._id, uid: client.uid, name: client.name, slug: client.slug } : null } } });
});

// @desc    The target app exchanges the ticket once for a normal platform session (the `dooit` membership).
// @route   POST /api/v1/afc-os/handoff/exchange   { token }
// @access  Public (the ticket is the credential)
exports.handoffExchange = asyncHandler(async (req, res, next) => {
  const { token } = req.body ?? {};
  if (!token) return next(new ErrorResponse("token is required", 400));
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return next(new ErrorResponse("Handoff link is invalid or expired", 401));
  }
  if (decoded.iss !== "dooit-platform" || decoded.kind !== "afc_handoff") return next(new ErrorResponse("Not a handoff token", 401));
  const row = await AfcHandoffToken.findOne({ jti: decoded.jti });
  if (!row) return next(new ErrorResponse("Handoff not found", 404));
  if (row.usedAt) return next(new ErrorResponse("This handoff link was already used", 410));
  if (row.expiresAt < new Date()) return next(new ErrorResponse("Handoff link expired", 410));
  const user = await User.findById(row.user);
  const membership = await UserType.findById(row.membership).lean();
  if (!user || !membership || !user.isActive) return next(new ErrorResponse("Account unavailable", 403));
  row.usedAt = new Date();
  await row.save();
  const session = user.getSignedJwtToken({ ...membership, clientBelongs: row.scope === "supervisory" ? row.tenant : membership.clientBelongs });
  logEvent?.({ req: { ...req, user: { _id: user._id, name: user.name, email: user.email, userType: "dooit", role: membership.role } }, service: "afc-os", action: "handoff_inbound_exchanged", target: { kind: "User", id: user._id }, after: { target: row.target, scope: row.scope, tenant: row.tenant } });
  res.status(200).json({ success: true, token: session, expires: new Date(Date.now() + 30 * 60_000), context: { userType: "dooit", role: membership.role, target: row.target, scope: row.scope, tenant: row.tenant, returnTo: row.returnTo } });
});

// @desc    Stream a file-vault object to AFC OS for the intake pipeline (RO documents uploaded through the portal).
//          Only a signed AFC OS / BFIU service call may read it; bytes go vault → here → AFC OS, never to a browser.
// @route   GET /api/v1/afc-os/files/:id
// @access  Exchange signature (afcos | bfiu)
exports.fileForAfcOs = asyncHandler(async (req, res, next) => {
  if (!req.exchangeCaller?.service) return next(new ErrorResponse("Only a signed service call may fetch vault files", 403));
  if (!/^[0-9a-f]{24}$/i.test(String(req.params.id))) return next(new ErrorResponse("Not a vault file id", 400));
  let upstream;
  try {
    upstream = await fileVaultService.getFileStream(req.params.id);
  } catch (err) {
    const status = err.response?.status ?? 502;
    return next(new ErrorResponse(status === 404 ? "File not found in the vault" : `File vault unavailable: ${err.message}`, status === 404 ? 404 : 502));
  }
  for (const h of ["content-type", "content-disposition", "content-length"]) if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
  logEvent?.({ req, service: "afc-os", action: "file_served", target: { kind: "FileVault", id: req.params.id }, details: req.exchangeCaller.app });
  upstream.data.pipe(res);
});

// @desc    Store a document AFC OS received (an MLTFPD officer uploading on an RO's behalf) in the file vault and
//          return the vault id, so AFC OS keeps the same `vault://files/<id>` reference as portal uploads.
// @route   POST /api/v1/afc-os/files   multipart: file
// @access  Exchange signature (afcos | bfiu)
exports.fileStoreForAfcOs = asyncHandler(async (req, res, next) => {
  if (!req.exchangeCaller?.service) return next(new ErrorResponse("Only a signed service call may store vault files", 403));
  if (!req.file) return next(new ErrorResponse("Please upload a file", 400));
  const { buffer, originalname, mimetype } = req.file;
  let result;
  try {
    result = await fileVaultService.uploadFile(buffer, originalname, mimetype);
  } catch (err) {
    const status = err.response?.status ?? 502;
    const detail = err.response?.data?.message ?? err.response?.data?.error ?? err.message;
    return next(new ErrorResponse(`File vault upload failed: ${detail}`, status >= 500 ? 502 : status));
  }
  const f = result?.file ?? result?.data ?? result ?? {};
  logEvent?.({ req, service: "afc-os", action: "file_stored", target: { kind: "FileVault", id: f._id ?? f.id ?? null }, details: `${originalname} · ${buffer.length} bytes · from ${req.exchangeCaller.app}` });
  res.status(201).json({ success: true, data: { id: f._id ?? f.id ?? null, path: f.path ?? null, name: f.originalName ?? originalname, mimeType: f.mimetype ?? mimetype, sizeBytes: f.size ?? buffer.length } });
});
