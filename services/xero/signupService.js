"use strict";

// "Sign up with Xero".
//
// A visitor starts from Dooit (or the Xero App Store launch link), consents once
// at Xero, and that single consent both verifies who they are (OpenID Connect)
// and connects their organisation. Dooit then shows its client registration form
// pre-filled from the Xero organisation; on submit it creates the user, client,
// membership and Xero connection and signs them in.
//
// Identity policy (product decision): for a NEW organisation the Xero-asserted
// email is trusted and the account is activated immediately. The email on the
// new account is ALWAYS the Xero one — the form cannot change it.
//
// An organisation that already belongs to a Dooit client is different: neither
// the Xero email nor the organisation name may claim it. That case is handed to
// connectionRequestService, which needs the client's own approval.

const crypto = require("crypto");
const User = require("../../models/User");
const UserType = require("../../models/UserType");
const Client = require("../../models/Client");
const EntityType = require("../../models/EntityType");
const XeroSignup = require("../../models/XeroSignup");
const ErrorResponse = require("../../utils/errorResponse");
const { encrypt, decrypt, hashForSearch } = require("../../utils/encryption");
const { validateClientCreation } = require("../../utils");
const oauth = require("./oauth");
const xero = require("./client");
const { organisationToClientPrefill } = require("./mappers");
const { logSync } = require("./syncLog");
const requests = require("./connectionRequestService");
const cleanup = require("./connectionCleanup");
const { randomToken, issueLoginCode } = require("./loginCode");

const TICKET_TTL_MS = 30 * 60 * 1000;

const sha256 = oauth.sha256;

// Fields the registration form may set. Everything else is ignored, so a crafted
// request cannot write status, user links, risk answers etc.
const FORM_FIELDS = ["name", "clientType", "clientTypeId", "registrationNumber", "taxId", "phone", "website", "address", "legalRepresentative"];
const ADDRESS_FIELDS = ["street", "city", "state", "country", "zipcode"];

const pick = (obj = {}, keys) =>
  Object.fromEntries(keys.filter((k) => obj[k] !== undefined && obj[k] !== "").map((k) => [k, obj[k]]));

const str = (v) => (typeof v === "string" ? v.trim() : v);

/** Begin signup: returns the Xero consent URL. */
const startSignup = async () => {
  const { state, nonce } = await oauth.createSignupState();
  return oauth.buildAuthUrl(state, { signup: true, nonce });
};

const findUserByEmail = (email) => User.findOne({ emailHash: hashForSearch(email) });

/**
 * OAuth callback for a signup-purpose state.
 *
 *  • organisation already belongs to a client → open an approval request
 *  • otherwise                                → ticket for the pre-filled form
 *
 * @returns {Promise<{ kind: "signup", ticket: string }
 *                 | { kind: "pending", requesterToken: string, maskedEmail: string }>}
 */
const handleSignupCallback = async ({ code, state }) => {
  const tk = await oauth.exchangeCode(code);
  const tenant = oauth.pickNewestTenant(await oauth.fetchConnections(tk.accessToken));
  if (!tenant) throw new ErrorResponse("No Xero organisation was authorised", 400);
  try {
    return await resolveSignup(tk, tenant, state);
  } catch (err) {
    // The visitor authorised the app but we are turning them away (account
    // exists, email failed, bad id_token…): don't leave the connection behind.
    await cleanup.releaseGrant({ tokens: tk, tenantId: tenant.tenantId, connectionId: tenant.id, reason: "signup_refused", meta: { status: err.statusCode || null } });
    throw err;
  }
};

const resolveSignup = async (tk, tenant, state) => {
  const claims = oauth.readIdToken(tk.idToken, state.nonce);
  const email = String(claims.email).toLowerCase();

  const org = await xero.getOrganisationWithToken(tk.accessToken, tenant.tenantId);
  const identity = {
    email,
    givenName: claims.given_name,
    familyName: claims.family_name,
    xeroUserId: claims.xero_userid || claims.sub,
  };

  // ── Organisation already known to Dooit → needs the client's approval ─────
  const match = await requests.findExistingClient({ tenantId: tenant.tenantId, org });
  if (match) {
    const out = await requests.createRequest({ match, tenant, org, identity, tokens: tk });
    return { kind: "pending", requesterToken: out.requesterToken, maskedEmail: out.maskedEmail };
  }

  // ── New organisation ──────────────────────────────────────────────────────
  // The Xero email is the identity of the account we are about to create, so it
  // must be free. (If it belongs to an existing user they should sign in and
  // connect Xero from Settings — it never signs them in here.)
  if (await findUserByEmail(email)) {
    throw new ErrorResponse(
      "An account with this email already exists. Sign in to Dooit and connect Xero from System Settings.",
      409
    );
  }

  const ticket = randomToken();
  await XeroSignup.create({
    ticketHash: sha256(ticket),
    identity,
    tenant: { tenantId: tenant.tenantId, connectionId: tenant.id, tenantName: tenant.tenantName },
    prefill: organisationToClientPrefill(org, identity),
    accessToken: encrypt(tk.accessToken),
    refreshToken: encrypt(tk.refreshToken),
    tokenExpiresAt: tk.expiresAt,
    scopes: tk.scopes,
  });
  await logSync({ tenantId: tenant.tenantId, entity: "connection", action: "xero_signup_started", status: "success" });
  return { kind: "signup", ticket };
};

const loadTicket = async (ticket) => {
  if (!ticket || typeof ticket !== "string" || ticket.length > 128) return null;
  const row = await XeroSignup.findOne({ ticketHash: sha256(ticket), ticketUsed: false });
  if (!row || Date.now() - new Date(row.createdAt).getTime() > TICKET_TTL_MS) return null;
  return row;
};

/** Data for the registration form: what Xero knows, plus the choices to render. */
const getPrefill = async (ticket) => {
  const row = await loadTicket(ticket);
  if (!row) throw new ErrorResponse("This sign-up link has expired. Please start again.", 410);
  const entityTypes = await EntityType.find({ active: true, client: null })
    .select("name category")
    .sort({ name: 1 })
    .lean();
  return {
    organisation: row.tenant.tenantName,
    email: row.identity.email, // read-only in the form
    prefill: row.prefill,
    entityTypes: entityTypes.map((e) => ({ id: String(e._id), name: e.name, category: e.category })),
  };
};

/**
 * Finish signup: create user, client, membership and the Xero connection, then
 * issue a one-time login code. The ticket is spent exactly once; if creation
 * fails after it is claimed, it is released again so the user can correct the
 * form and resubmit.
 */
const completeSignup = async ({ ticket, form = {} }) => {
  const row = await loadTicket(ticket);
  if (!row) throw new ErrorResponse("This sign-up link has expired. Please start again.", 410);

  const email = row.identity.email;
  const input = {
    ...row.prefill,
    ...pick(form, FORM_FIELDS),
    address: { ...(row.prefill.address || {}), ...pick(form.address, ADDRESS_FIELDS) },
    legalRepresentative: { ...(row.prefill.legalRepresentative || {}), ...pick(form.legalRepresentative, ["name", "email", "phone", "designation"]) },
  };
  ["name", "clientType", "clientTypeId", "registrationNumber", "taxId", "phone", "website"].forEach((k) => {
    if (input[k] !== undefined) input[k] = str(input[k]);
  });

  if (!input.name) throw new ErrorResponse("Organisation name is required", 400);
  if (!input.clientType) throw new ErrorResponse("Please choose your entity type", 400);
  if (await findUserByEmail(email)) throw new ErrorResponse("An account with this email already exists", 409);

  // The organisation may have been registered since the ticket was issued (or the
  // ticket replayed against another org). Never create a second client for it.
  if (await requests.findExistingClient({ tenantId: row.tenant.tenantId, org: { LegalName: row.prefill.name, RegistrationNumber: row.prefill.registrationNumber } })) {
    throw new ErrorResponse(
      "This organisation is already registered with Dooit. Please start again from Xero to request access.",
      409
    );
  }

  // Reuse the standard client uniqueness rules (name / email / reg no / tax id…).
  let validationError = null;
  await validateClientCreation({ ...input, email }, (err) => { validationError = err; });
  if (validationError) {
    // Don't surface the raw "Client with this … already exists!" message.
    throw /already exists/i.test(validationError.message)
      ? new ErrorResponse("Some of these details match an organisation that is already registered with Dooit. Please review them or contact support.", 400)
      : validationError;
  }

  // Claim the ticket atomically — a double-click or replay loses here.
  const claimed = await XeroSignup.findOneAndUpdate({ _id: row._id, ticketUsed: false }, { $set: { ticketUsed: true } });
  if (!claimed) throw new ErrorResponse("This sign-up link has already been used", 409);

  const created = {};
  try {
    const secrets = await XeroSignup.findById(row._id).select("+accessToken +refreshToken");
    created.user = await User.create({
      name: [row.identity.givenName, row.identity.familyName].filter(Boolean).join(" ") || input.name,
      userName: email,
      email,
      // Never used or shown: the Xero identity is the credential. The user can
      // set a password later through the normal forgot-password flow.
      password: crypto.randomBytes(24).toString("base64url"),
      isActive: true,
    });
    created.client = await Client.create({
      user: created.user._id,
      name: input.name,
      clientType: input.clientType,
      clientTypeId: input.clientTypeId,
      registrationNumber: input.registrationNumber,
      taxId: input.taxId,
      email,
      phone: input.phone,
      website: input.website,
      address: input.address,
      legalRepresentative: input.legalRepresentative,
      contacts: [{ name: input.legalRepresentative?.name, email, phone: input.phone, primary: true }],
    });
    created.membership = await UserType.create({
      user: created.user._id,
      userType: "client",
      role: "admin",
      clientBelongs: created.client._id,
      isActive: true,
    });
    created.connection = await xero.upsertConnection({
      tokens: {
        accessToken: decrypt(secrets.accessToken),
        refreshToken: decrypt(secrets.refreshToken),
        expiresAt: secrets.tokenExpiresAt,
        scopes: secrets.scopes,
      },
      tenant: { tenantId: row.tenant.tenantId, id: row.tenant.connectionId, tenantName: row.tenant.tenantName },
      userId: created.user._id,
      companyId: created.client._id,
    });
  } catch (err) {
    // Roll back whatever was created and release the ticket for a retry.
    await Promise.allSettled([
      created.connection && created.connection.deleteOne(),
      created.membership && UserType.deleteOne({ _id: created.membership._id }),
      created.client && Client.deleteOne({ _id: created.client._id }),
      created.user && User.deleteOne({ _id: created.user._id }),
      XeroSignup.updateOne({ _id: row._id }, { $set: { ticketUsed: false } }),
    ]);
    throw err;
  }

  const loginCode = await issueLoginCode(row, {
    userId: created.user._id,
    clientId: created.client._id,
    membershipId: created.membership._id,
  });
  await logSync({ tenantId: row.tenant.tenantId, companyId: created.client._id, entity: "connection", action: "xero_signup_completed", status: "success", actor: created.user._id });
  return { loginCode, clientId: created.client._id };
};

/** Exchange a one-time login code for a session JWT (same shape as /auth/login). */
const redeemLoginCode = async (loginCode) => {
  if (!loginCode || typeof loginCode !== "string" || loginCode.length > 128) {
    throw new ErrorResponse("Invalid or expired sign-in code", 401);
  }
  const row = await XeroSignup.findOneAndUpdate(
    { loginCodeHash: sha256(loginCode), loginCodeUsed: false, loginCodeExpiresAt: { $gt: new Date() } },
    { $set: { loginCodeUsed: true } }
  );
  if (!row) throw new ErrorResponse("Invalid or expired sign-in code", 401);

  const [user, membership] = await Promise.all([
    User.findById(row.userId),
    UserType.findOne({ _id: row.membershipId, isActive: true }).lean(),
  ]);
  if (!user || !membership) throw new ErrorResponse("Invalid or expired sign-in code", 401);
  return user.getSignedJwtToken(membership);
};

module.exports = { startSignup, handleSignupCallback, getPrefill, completeSignup, redeemLoginCode, FORM_FIELDS };
