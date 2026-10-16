"use strict";

// Linking a Xero organisation to an EXISTING Dooit client, with the client's
// consent.
//
// Why this exists: Xero tells us who the user is and which organisation they
// authorised. Neither proves they may act for a client that already exists in
// Dooit — the Xero email can be anyone with access to the org, and an
// organisation name is not unique. So when a Xero organisation maps to an
// existing client we do NOT connect or sign anyone in. We email the client's
// registered address and link only after that client's administrator approves.
//
// Lifecycle:  PENDING_CONFIRMATION ─▶ APPROVED | REJECTED | EXPIRED
// Every transition is a single atomic findOneAndUpdate guarded on the previous
// state, so a replayed or raced click can never apply twice.

const User = require("../../models/User");
const UserType = require("../../models/UserType");
const Client = require("../../models/Client");
const XeroConnection = require("../../models/XeroConnection");
const XeroConnectionRequest = require("../../models/XeroConnectionRequest");
const { REQUEST_STATUS } = XeroConnectionRequest;
const ErrorResponse = require("../../utils/errorResponse");
const sendEmail = require("../../utils/sendEmail");
const { encrypt, decrypt, hashForSearch } = require("../../utils/encryption");
const { getRawEmail } = require("../../utils/rawUserFields");
const {
  xeroConnectionApprovalHtml,
  xeroConnectionDecisionHtml,
} = require("../../utils/email-template/xeroEmailTemplate");
const { getConfig } = require("../../config/xero");
const oauth = require("./oauth");
const xero = require("./client");
const { randomToken, createLoginSession } = require("./loginCode");
const { logSync } = require("./syncLog");
const cleanup = require("./connectionCleanup");

// Audit event names (XeroSyncLog.action).
const EVENTS = {
  CREATED: "XERO_CONNECTION_REQUEST_CREATED",
  EMAIL_SENT: "XERO_CONNECTION_REQUEST_EMAIL_SENT",
  APPROVED: "XERO_CONNECTION_REQUEST_APPROVED",
  REJECTED: "XERO_CONNECTION_REQUEST_REJECTED",
  EXPIRED: "XERO_CONNECTION_REQUEST_EXPIRED",
  TENANT_LINKED: "XERO_TENANT_LINKED",
};

// Same requester retrying inside this window reuses the live request rather
// than emailing the client again.
const RESEND_COOLDOWN_MS = 5 * 60 * 1000;
// An approved requester must continue within this window (single use).
const CONTINUE_WINDOW_MS = 30 * 60 * 1000;

const sha256 = oauth.sha256;
const GENERIC_INVALID = "This confirmation link is invalid or has expired.";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** a***@abc.com — enough to recognise, not enough to harvest. */
const maskEmail = (email = "") => {
  const [local = "", domain = ""] = String(email).split("@");
  return domain ? `${local.slice(0, 1)}***@${domain}` : "***";
};

const audit = (req, action, status = "success", extra = {}) =>
  logSync({
    tenantId: req.xeroTenantId,
    companyId: req.clientId,
    entity: "connection",
    entityId: req._id,
    action,
    direction: "system",
    status,
    actor: extra.actor || null,
    error: extra.error || null,
    meta: {
      requestId: String(req._id),
      clientId: String(req.clientId),
      xeroTenantId: req.xeroTenantId,
      requesterEmail: req.requesterEmail,
      targetEmail: maskEmail(req.targetEmail),
      ...extra.meta,
    },
  });

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Does this Xero organisation already belong to a Dooit client?
 *
 * 1. tenantId  — authoritative: a XeroConnection row (any status) names its client.
 * 2. ABN / registration number — strong secondary.
 * 3. exact organisation name   — weak secondary.
 * (2) and (3) can only ever lead to an approval EMAIL, never to access, so a
 * false positive costs one ignorable email while a miss would create a duplicate.
 *
 * @returns {Promise<{ client: Object, matchedBy: string } | null>}
 */
const findExistingClient = async ({ tenantId, org = {} }) => {
  const link = await XeroConnection.findOne({ tenantId }).sort({ updatedAt: -1 }).lean();
  if (link) {
    const client = await Client.findById(link.companyId);
    if (client) return { client, matchedBy: "tenant" };
  }

  const reg = org.RegistrationNumber && String(org.RegistrationNumber).trim();
  if (reg) {
    const client = await Client.findOne({ registrationNumber: reg });
    if (client) return { client, matchedBy: "registrationNumber" };
  }

  const name = (org.LegalName || org.Name || "").trim();
  if (name) {
    const client = await Client.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, "i") });
    if (client) return { client, matchedBy: "name" };
  }
  return null;
};

/** The client's registered address: Client.email, else its owning user's email. */
const registeredEmailOf = async (client) => {
  if (client.email) return client.email.toLowerCase();
  const raw = client.user ? await getRawEmail(client.user) : null;
  return raw ? raw.toLowerCase() : null;
};

// ── Create ───────────────────────────────────────────────────────────────────

const confirmUrl = (token, suffix = "") => {
  const { webBaseUrl } = getConfig();
  return `${webBaseUrl}/auth/xero/confirm/${token}${suffix}`;
};

const clearSecrets = { $unset: { accessToken: "", refreshToken: "" } };

/**
 * Move a still-pending request to a final state other than APPROVED (approve()
 * claims its own). The Xero grant it held is discarded, so the connection that
 * grant created is released at Xero too — unless `release: false` (the same
 * Xero user is starting a fresh request and still needs that connection).
 * Returns the updated doc or null.
 */
const closePending = async (filter, set, { release = true } = {}) => {
  const before = await XeroConnectionRequest.findOneAndUpdate(
    { ...filter, status: REQUEST_STATUS.PENDING },
    { $set: set, ...clearSecrets },
    { new: false, projection: "+accessToken +refreshToken" }
  );
  if (!before) return null;
  if (release) {
    await cleanup.releaseStored(before, {
      tenantId: before.xeroTenantId,
      connectionId: before.xeroConnectionId,
      reason: `request_${String(set.status || "closed").toLowerCase()}`,
      meta: { requestId: String(before._id), failureReason: set.failureReason || null },
    });
  }
  return XeroConnectionRequest.findById(before._id);
};

/**
 * Open (or reuse) an approval request and email the client.
 *
 * @returns {Promise<{ requesterToken: string, maskedEmail: string, reused: boolean }>}
 */
const createRequest = async ({ match, tenant, org, identity, tokens }) => {
  const { client, matchedBy } = match;
  const targetEmail = await registeredEmailOf(client);
  if (!targetEmail) {
    throw new ErrorResponse(
      "We couldn't reach the administrator of the existing account. Please contact Dooit support.",
      409
    );
  }

  const pair = { clientId: client._id, xeroTenantId: tenant.tenantId };
  const now = Date.now();
  const secrets = { accessToken: encrypt(tokens.accessToken), refreshToken: encrypt(tokens.refreshToken), scopes: tokens.scopes };
  const requesterEmail = identity.email;

  // Duplicate protection: at most one live request per (client, organisation).
  const live = await XeroConnectionRequest.findOne({ ...pair, status: REQUEST_STATUS.PENDING });
  if (live && new Date(live.expiresAt).getTime() <= now) {
    await expireOne(live);
  } else if (live) {
    const fresh = now - new Date(live.createdAt).getTime() < RESEND_COOLDOWN_MS;
    if (fresh && live.requesterEmail === requesterEmail) {
      // Same person retrying — keep the existing email valid, hand back a new
      // status handle and the fresh Xero authorisation. No second email.
      const requesterToken = randomToken();
      await XeroConnectionRequest.updateOne(
        { _id: live._id, status: REQUEST_STATUS.PENDING },
        { $set: { requesterTokenHash: sha256(requesterToken), ...secrets } }
      );
      return { requesterToken, maskedEmail: maskEmail(targetEmail), reused: true };
    }
    // A different person, or the cooldown has passed: supersede it.
    const sameXeroUser = !!identity.xeroUserId && live.requesterXeroUserId === identity.xeroUserId;
    const closed = await closePending(
      { _id: live._id },
      { status: REQUEST_STATUS.EXPIRED, failureReason: "superseded", usedAt: new Date() },
      { release: !sameXeroUser }
    );
    if (closed) await audit(closed, EVENTS.EXPIRED, "skipped", { error: "superseded by a newer request" });
  }

  const approverToken = randomToken();
  const requesterToken = randomToken();
  const request = await XeroConnectionRequest.create({
    clientId: client._id,
    xeroTenantId: tenant.tenantId,
    xeroConnectionId: tenant.id || null,
    xeroOrganisationName: org?.Name || tenant.tenantName,
    requesterEmail,
    requesterName: [identity.givenName, identity.familyName].filter(Boolean).join(" ") || null,
    requesterXeroUserId: identity.xeroUserId || null,
    targetEmail,
    matchedBy,
    tokenHash: sha256(approverToken),
    requesterTokenHash: sha256(requesterToken),
    expiresAt: new Date(now + getConfig().connectionRequestTtlMs),
    ...secrets,
  });
  await audit(request, EVENTS.CREATED, "success", { meta: { matchedBy } });

  try {
    await sendEmail({
      email: targetEmail,
      subject: `Confirm Xero connection for ${request.xeroOrganisationName || client.name}`,
      message: xeroConnectionApprovalHtml({
        organisationName: request.xeroOrganisationName,
        requesterName: request.requesterName,
        requesterEmail,
        approveUrl: confirmUrl(approverToken),
        rejectUrl: confirmUrl(approverToken, "?action=reject"),
        expiresInMinutes: Math.round(getConfig().connectionRequestTtlMs / 60000),
      }),
    });
    await XeroConnectionRequest.updateOne({ _id: request._id }, { $set: { emailSentAt: new Date() } });
    await audit(request, EVENTS.EMAIL_SENT);
  } catch (err) {
    // No email, no way to approve: close it so it doesn't block a retry.
    await closePending({ _id: request._id }, { status: REQUEST_STATUS.EXPIRED, failureReason: "email_failed" });
    await audit(request, EVENTS.EMAIL_SENT, "failed", { error: err.message });
    throw new ErrorResponse("We couldn't send the confirmation email. Please try again shortly.", 502);
  }

  return { requesterToken, maskedEmail: maskEmail(targetEmail), reused: false };
};

// ── Expiry ───────────────────────────────────────────────────────────────────

const expireOne = async (request) => {
  const closed = await closePending(
    { _id: request._id, expiresAt: { $lte: new Date() } },
    { status: REQUEST_STATUS.EXPIRED, usedAt: new Date() }
  );
  if (closed) await audit(closed, EVENTS.EXPIRED);
  return closed;
};

/** Sweep: expire every lapsed pending request (run from the worker tick). */
const expireDue = async () => {
  const due = await XeroConnectionRequest.find({
    status: REQUEST_STATUS.PENDING,
    expiresAt: { $lte: new Date() },
  });
  for (const r of due) await expireOne(r);
  return due.length;
};

// ── Lookup ───────────────────────────────────────────────────────────────────

const loadByApproverToken = async (token) => {
  if (!token || typeof token !== "string" || token.length > 128) return null;
  const req = await XeroConnectionRequest.findOne({ tokenHash: sha256(token) }).select("+tokenHash");
  if (req && req.status === REQUEST_STATUS.PENDING && new Date(req.expiresAt).getTime() <= Date.now()) {
    await expireOne(req);
    req.status = REQUEST_STATUS.EXPIRED;
  }
  return req;
};

/** What the approval page may show: the organisation and who asked — nothing about the client. */
const getForApprover = async (token) => {
  const req = await loadByApproverToken(token);
  if (!req) throw new ErrorResponse(GENERIC_INVALID, 404);
  return {
    status: req.status,
    organisation: req.xeroOrganisationName,
    requester: { name: req.requesterName, email: req.requesterEmail },
    expiresAt: req.expiresAt,
  };
};

// ── Decide ───────────────────────────────────────────────────────────────────

const notifyRequester = async (req, approved) => {
  try {
    const { webBaseUrl, signupUrl } = getConfig();
    await sendEmail({
      email: req.requesterEmail,
      subject: approved
        ? `Xero connection approved for ${req.xeroOrganisationName}`
        : `Xero connection request declined for ${req.xeroOrganisationName}`,
      message: xeroConnectionDecisionHtml({
        organisationName: req.xeroOrganisationName,
        approved,
        continueUrl: approved ? signupUrl || `${webBaseUrl}/auth/login` : null,
      }),
    });
  } catch (err) {
    console.error("[xero] requester notification failed:", err.message);
  }
};

/** Fail an approval whose Xero side is no longer valid; the requester must restart. */
const invalidate = async (req, reason, userMessage) => {
  const closed = await closePending({ _id: req._id }, { status: REQUEST_STATUS.EXPIRED, failureReason: reason });
  if (closed) await audit(closed, EVENTS.EXPIRED, "failed", { error: reason });
  throw new ErrorResponse(userMessage, 409);
};

/**
 * Approve: the caller must be an administrator of the target client AND hold
 * the emailed token. Both, because the link alone can be forwarded.
 */
const approve = async ({ token, user }) => {
  const req = await loadByApproverToken(token);
  if (!req) throw new ErrorResponse(GENERIC_INVALID, 404);
  if (req.status !== REQUEST_STATUS.PENDING || req.usedAt) {
    throw new ErrorResponse("This request has already been handled or has expired.", 410);
  }

  const isClientAdmin =
    user &&
    (user.userType ?? "").toLowerCase() === "client" &&
    (user.role ?? "").toLowerCase() === "admin" &&
    user.clientBelongs &&
    String(user.clientBelongs) === String(req.clientId);
  if (!isClientAdmin) {
    throw new ErrorResponse("Only the administrator of the account can approve this connection.", 403);
  }

  const client = await Client.findById(req.clientId);
  if (!client) return invalidate(req, "client_missing", "This request is no longer valid.");

  // Re-verify the Xero side with the stored authorisation: still valid, and the
  // organisation is still one the user authorised.
  const stored = await XeroConnectionRequest.findById(req._id).select("+accessToken +refreshToken");
  let tokens;
  let tenant;
  try {
    const { status, data } = await oauth.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: decrypt(stored.refreshToken),
    });
    if (status !== 200 || !data.access_token) throw new Error("refresh rejected");
    tokens = oauth.normaliseTokens(data);
    tenant = (await oauth.fetchConnections(tokens.accessToken)).find((c) => c.tenantId === req.xeroTenantId);
    if (!tenant) throw new Error("organisation no longer authorised");
  } catch (err) {
    return invalidate(
      req,
      `xero_invalid: ${err.message}`,
      "The Xero authorisation is no longer valid. Ask the requester to start again from Xero."
    );
  }

  // Claim — exactly one approval/rejection wins.
  const claimed = await XeroConnectionRequest.findOneAndUpdate(
    { _id: req._id, status: REQUEST_STATUS.PENDING, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { status: REQUEST_STATUS.APPROVED, usedAt: new Date(), approvedAt: new Date(), decidedBy: user.id }, ...clearSecrets },
    { new: true }
  );
  if (!claimed) throw new ErrorResponse("This request has already been handled or has expired.", 410);

  try {
    await xero.upsertConnection({ tokens, tenant, userId: user.id, companyId: client._id });
  } catch (err) {
    await cleanup.releaseGrant({ tokens, tenantId: req.xeroTenantId, connectionId: tenant.id, reason: "request_link_failed", meta: { requestId: String(claimed._id) } });
    await XeroConnectionRequest.updateOne(
      { _id: claimed._id },
      { $set: { status: REQUEST_STATUS.EXPIRED, failureReason: `link_failed: ${err.message}` } }
    );
    await audit(claimed, EVENTS.EXPIRED, "failed", { error: err.message, actor: user.id });
    throw err;
  }

  await audit(claimed, EVENTS.APPROVED, "success", { actor: user.id });
  await audit(claimed, EVENTS.TENANT_LINKED, "success", { actor: user.id });
  await notifyRequester(claimed, true);
  return { status: REQUEST_STATUS.APPROVED, organisation: claimed.xeroOrganisationName };
};

/** Reject: safe direction, so the emailed token alone is enough. */
const reject = async ({ token }) => {
  const req = await loadByApproverToken(token);
  if (!req) throw new ErrorResponse(GENERIC_INVALID, 404);

  const closed = await closePending(
    { _id: req._id, usedAt: null, expiresAt: { $gt: new Date() } },
    { status: REQUEST_STATUS.REJECTED, usedAt: new Date(), rejectedAt: new Date() }
  );
  if (!closed) throw new ErrorResponse("This request has already been handled or has expired.", 410);

  await audit(closed, EVENTS.REJECTED);
  await notifyRequester(closed, false);
  return { status: REQUEST_STATUS.REJECTED, organisation: closed.xeroOrganisationName };
};

// ── Requester side ───────────────────────────────────────────────────────────

const loadByRequesterToken = async (requesterToken) => {
  if (!requesterToken || typeof requesterToken !== "string" || requesterToken.length > 128) return null;
  const req = await XeroConnectionRequest.findOne({ requesterTokenHash: sha256(requesterToken) }).select("+requesterTokenHash");
  if (req && req.status === REQUEST_STATUS.PENDING && new Date(req.expiresAt).getTime() <= Date.now()) {
    await expireOne(req);
    req.status = REQUEST_STATUS.EXPIRED;
  }
  return req;
};

/** Polled by the "waiting for approval" screen. */
const getRequesterStatus = async (requesterToken) => {
  const req = await loadByRequesterToken(requesterToken);
  if (!req) throw new ErrorResponse("This request was not found or has expired.", 404);
  return {
    status: req.status,
    organisation: req.xeroOrganisationName,
    maskedEmail: maskEmail(req.targetEmail),
    expiresAt: req.expiresAt,
  };
};

/**
 * After approval, let the requester into Dooit — with no new privileges.
 *
 * The approval linked the ORGANISATION. It did not make the requester an admin
 * (or anything) on the client. They get in only if their email already belongs
 * to a Dooit user with an active membership on that client, and then with
 * exactly that membership. Otherwise they are pointed to sign in / ask their
 * administrator for access, as for any other person.
 */
const continueAsRequester = async (requesterToken) => {
  const req = await loadByRequesterToken(requesterToken);
  if (!req) throw new ErrorResponse("This request was not found or has expired.", 404);
  if (req.status !== REQUEST_STATUS.APPROVED) throw new ErrorResponse("This request has not been approved.", 409);

  const claimed = await XeroConnectionRequest.findOneAndUpdate(
    { _id: req._id, status: REQUEST_STATUS.APPROVED, continuedAt: null, approvedAt: { $gt: new Date(Date.now() - CONTINUE_WINDOW_MS) } },
    { $set: { continuedAt: new Date() } }
  );
  if (!claimed) throw new ErrorResponse("This link has already been used or has expired. Please sign in to Dooit.", 410);

  const user = await User.findOne({ emailHash: hashForSearch(req.requesterEmail) });
  const membership = user
    ? await UserType.findOne({ user: user._id, userType: "client", clientBelongs: req.clientId, isActive: true })
    : null;
  if (!user || !membership) return { next: "login" };

  const loginCode = await createLoginSession({
    identity: { email: req.requesterEmail },
    tenant: { tenantId: req.xeroTenantId, tenantName: req.xeroOrganisationName },
    userId: user._id,
    clientId: req.clientId,
    membershipId: membership._id,
  });
  return { next: "signed_in", loginCode };
};

module.exports = {
  EVENTS,
  RESEND_COOLDOWN_MS,
  maskEmail,
  findExistingClient,
  createRequest,
  expireDue,
  getForApprover,
  approve,
  reject,
  getRequesterStatus,
  continueAsRequester,
};
