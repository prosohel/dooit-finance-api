"use strict";

// Centralised Xero Accounting API client. Every call goes through `request`,
// which owns auth, tenant header, 401-refresh-retry, 429 back-off, network
// retries and error translation into the app's ErrorResponse format.

const XeroConnection = require("../../models/XeroConnection");
const ErrorResponse = require("../../utils/errorResponse");
const { getConfig } = require("../../config/xero");
const http = require("./http");
const oauth = require("./oauth");
const tokens = require("./tokenService");
const { logSync } = require("./syncLog");
const { encrypt } = require("../../utils/encryption");

const MAX_RATE_RETRIES = 2;
const MAX_NETWORK_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 60_000;

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);

/** Flatten Xero's validation envelope into one readable message. */
const describeXeroError = (data) => {
  if (!data) return null;
  const msgs = [];
  (data.Elements || []).forEach((el) =>
    (el.ValidationErrors || []).forEach((v) => msgs.push(v.Message))
  );
  if (msgs.length) return msgs.join("; ");
  return data.Message || data.Detail || data.Title || null;
};

/** Xero's 403 when the organisation disconnected the app (or the user lost access). */
const isTenantDisconnected = (status, data) =>
  status === 403 && /AuthenticationUnsuccessful/i.test(describeXeroError(data) || "");

const DISCONNECTED_MESSAGE =
  "Dooit no longer has access to this Xero organisation (it was disconnected in Xero, or the connecting user lost access) — reconnect in Settings → Xero";

const isDuplicateContact = (message) =>
  /already assigned to another contact|contact name .* already|must be unique/i.test(message || "");

const toError = (status, data) => {
  const detail = describeXeroError(data);
  if (status === 401) return new ErrorResponse("Xero authorisation failed — please reconnect", 401);
  if (status === 403)
    return new ErrorResponse(detail || "Xero denied access (missing scope or organisation)", 403);
  if (status === 404) return new ErrorResponse(detail || "Xero resource not found", 404);
  if (status === 429) return new ErrorResponse("Xero rate limit exceeded", 429);
  if (status === 400 || status === 422) {
    const e = new ErrorResponse(detail || "Xero rejected the request", 400);
    if (isDuplicateContact(detail)) e.code = "DUPLICATE_CONTACT";
    return e;
  }
  return new ErrorResponse(detail || `Xero request failed (${status})`, 502);
};

/**
 * @param {Object|String} connection  XeroConnection doc/lean object or its id
 * @param {{method?:string,path:string,params?:Object,data?:Object,headers?:Object,idempotencyKey?:string}} opts
 *   idempotencyKey — sent as `Idempotency-Key` so a create retried after a lost
 *   response is not applied twice by Xero.
 */
const request = async (connection, { method = "GET", path, params, data, headers = {}, idempotencyKey }) => {
  const conn =
    connection && connection._id
      ? connection
      : await XeroConnection.findById(connection).lean();
  if (!conn || conn.status === "disconnected") throw new ErrorResponse("Xero is not connected", 409);
  if (!conn.tenantId) throw new ErrorResponse("No Xero organisation is linked to this connection", 409);

  const cfg = getConfig();
  let refreshedOnce = false;
  let rateRetries = 0;
  let networkRetries = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const accessToken = await tokens.getAccessToken(conn._id);
    let res;
    try {
      res = await http.send({
        method,
        url: `${cfg.apiUrl}/api.xro/2.0${path}`,
        params,
        data,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "xero-tenant-id": conn.tenantId,
          Accept: "application/json",
          ...(data ? { "Content-Type": "application/json" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": String(idempotencyKey).slice(0, 128) } : {}),
          ...headers,
        },
      });
    } catch (err) {
      if (NETWORK_CODES.has(err.code) && networkRetries < MAX_NETWORK_RETRIES) {
        networkRetries += 1;
        await http.sleep(500 * 2 ** networkRetries);
        continue;
      }
      throw new ErrorResponse(`Network error talking to Xero (${err.code || err.message})`, 503);
    }

    if (res.status === 401 && !refreshedOnce) {
      refreshedOnce = true;
      await tokens.refreshAccessToken(conn._id);
      continue;
    }
    if (res.status === 429 && rateRetries < MAX_RATE_RETRIES) {
      rateRetries += 1;
      const wait = Math.min((Number(res.headers?.["retry-after"]) || 5) * 1000, MAX_RETRY_AFTER_MS);
      await http.sleep(wait);
      continue;
    }
    if (res.status >= 500 && networkRetries < MAX_NETWORK_RETRIES) {
      networkRetries += 1;
      await http.sleep(500 * 2 ** networkRetries);
      continue;
    }
    if (res.status >= 200 && res.status < 300) return res.data;
    if (isTenantDisconnected(res.status, res.data)) {
      // Disconnected from Xero's side: flip the connection so Settings shows
      // "Reconnect" instead of retrying a dead organisation forever.
      await tokens.markRevoked(conn, DISCONNECTED_MESSAGE);
      throw new ErrorResponse(DISCONNECTED_MESSAGE, 401);
    }
    throw toError(res.status, res.data);
  }
};

const resolve = (c) => c; // connection (or id) is passed straight through

// ── Contacts ─────────────────────────────────────────────────────────────────
const getContacts = async (conn, { page, ids, modifiedSince, where } = {}) => {
  const data = await request(resolve(conn), {
    path: "/Contacts",
    params: {
      ...(page ? { page } : {}),
      ...(ids?.length ? { IDs: ids.join(",") } : {}),
      ...(where ? { where } : {}),
    },
    headers: modifiedSince ? { "If-Modified-Since": new Date(modifiedSince).toUTCString() } : {},
  });
  return data?.Contacts || [];
};

// Creates use PUT: Xero's POST is create-OR-UPDATE (a contact is matched by
// name), so POSTing a second "Jane Citizen" silently overwrites the first one.
// PUT only ever creates and answers a duplicate name with a validation error.
const createContact = async (conn, contact, { idempotencyKey } = {}) => {
  const data = await request(conn, { method: "PUT", path: "/Contacts", data: { Contacts: [contact] }, idempotencyKey });
  return data?.Contacts?.[0] || null;
};

const updateContact = async (conn, contactId, contact) => {
  const data = await request(conn, {
    method: "POST",
    path: `/Contacts/${contactId}`,
    data: { Contacts: [{ ...contact, ContactID: contactId }] },
  });
  return data?.Contacts?.[0] || null;
};

// ── Invoices ─────────────────────────────────────────────────────────────────
const getInvoices = async (conn, { page, ids, modifiedSince, statuses } = {}) => {
  const data = await request(conn, {
    path: "/Invoices",
    params: {
      ...(page ? { page } : {}),
      ...(ids?.length ? { IDs: ids.join(",") } : {}),
      ...(statuses?.length ? { Statuses: statuses.join(",") } : {}),
    },
    headers: modifiedSince ? { "If-Modified-Since": new Date(modifiedSince).toUTCString() } : {},
  });
  return data?.Invoices || [];
};

// unitdp=4: Dooit unit prices can carry more than 2 decimals.
const createInvoice = async (conn, invoice, { idempotencyKey } = {}) => {
  const data = await request(conn, {
    method: "PUT", // create-only, as for contacts
    path: "/Invoices",
    params: { unitdp: 4 },
    data: { Invoices: [invoice] },
    idempotencyKey,
  });
  return data?.Invoices?.[0] || null;
};

const updateInvoice = async (conn, invoiceId, invoice) => {
  const data = await request(conn, {
    method: "POST",
    path: `/Invoices/${invoiceId}`,
    params: { unitdp: 4 },
    data: { Invoices: [{ ...invoice, InvoiceID: invoiceId }] },
  });
  return data?.Invoices?.[0] || null;
};

// ── Payments ─────────────────────────────────────────────────────────────────
const getPayments = async (conn, { page, modifiedSince, where } = {}) => {
  const data = await request(conn, {
    path: "/Payments",
    params: { ...(page ? { page } : {}), ...(where ? { where } : {}) },
    headers: modifiedSince ? { "If-Modified-Since": new Date(modifiedSince).toUTCString() } : {},
  });
  return data?.Payments || [];
};

const createPayment = async (conn, payment, { idempotencyKey } = {}) => {
  const data = await request(conn, { method: "PUT", path: "/Payments", data: { Payments: [payment] }, idempotencyKey });
  return data?.Payments?.[0] || null;
};

// ── Settings (read-only: accounting.settings.read) ───────────────────────────
const getAccounts = async (conn) => (await request(conn, { path: "/Accounts" }))?.Accounts || [];

const getTaxRates = async (conn) => (await request(conn, { path: "/TaxRates" }))?.TaxRates || [];

const getCurrencies = async (conn) => (await request(conn, { path: "/Currencies" }))?.Currencies || [];

const getOrganisation = async (conn) => (await request(conn, { path: "/Organisation" }))?.Organisations?.[0] || null;

// ── Connection lifecycle ─────────────────────────────────────────────────────

// What belongs to ONE organisation. When a company connects a different Xero
// organisation, none of it may carry over: the mapping points at the old
// organisation's chart of accounts, and nothing may be sent to the new one
// until an admin has reviewed its settings.
const ORG_SCOPED_RESET = {
  settings: {},
  baseCurrency: null,
  countryCode: null,
  shortCode: null,
  lastSyncAt: null,
  lastSyncStatus: "idle",
  lastSyncSummary: null,
  outboundCursor: null,
  inboundCursor: null,
};

/**
 * Persist (or refresh) the company's connection from a token set + chosen
 * organisation. Shared by the in-app connect flow and Sign up with Xero.
 */
const upsertConnection = async ({ tokens: tk, tenant, userId, companyId }) => {
  const taken = await XeroConnection.findOne({
    tenantId: tenant.tenantId,
    status: "connected",
    companyId: { $ne: companyId },
  }).lean();
  if (taken) {
    throw new ErrorResponse("This Xero organisation is already connected to another company", 409);
  }

  const fields = {
    userId,
    companyId,
    tenantId: tenant.tenantId,
    connectionId: tenant.id || null,
    tenantName: tenant.tenantName || null,
    accessToken: encrypt(tk.accessToken),
    refreshToken: encrypt(tk.refreshToken),
    expiresAt: tk.expiresAt,
    scopes: tk.scopes,
    connectedAt: new Date(),
    disconnectedAt: null,
    status: "connected",
    lastSyncError: null,
  };

  // Reuse the company's row (live or historical) so history stays on one document.
  const existing = await XeroConnection.findOne({ companyId }).sort({ updatedAt: -1 });
  let conn;
  if (existing) {
    existing.set(existing.tenantId === tenant.tenantId ? fields : { ...ORG_SCOPED_RESET, ...fields });
    conn = await existing.save();
  } else {
    conn = await XeroConnection.create(fields);
  }
  tokens.clearCache(conn._id);

  await logSync({
    tenantId: conn.tenantId,
    companyId,
    entity: "connection",
    action: "connect",
    status: "success",
    actor: userId,
  });
  return conn;
};

/** Organisation profile using a raw access token (before a connection exists). */
const getOrganisationWithToken = async (accessToken, tenantId) => {
  const cfg = getConfig();
  const res = await http.send({
    method: "GET",
    url: `${cfg.apiUrl}/api.xro/2.0/Organisation`,
    headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" },
  });
  if (res.status !== 200) throw toError(res.status, res.data);
  return res.data?.Organisations?.[0] || null;
};

/**
 * Complete the OAuth handshake: exchange the code, resolve the organisation and
 * persist an encrypted connection for `companyId`. (Used by the callback route.)
 */
const connect = async ({ code, userId, companyId }) => {
  const tk = await oauth.exchangeCode(code);
  const connections = await oauth.fetchConnections(tk.accessToken);
  const tenant = oauth.pickNewestTenant(connections);
  if (!tenant) throw new ErrorResponse("No Xero organisation was authorised", 400);

  const taken = await XeroConnection.findOne({
    tenantId: tenant.tenantId,
    status: "connected",
    companyId: { $ne: companyId },
  }).lean();
  if (taken) {
    throw new ErrorResponse("This Xero organisation is already connected to another company", 409);
  }

  const conn = await upsertConnection({ tokens: tk, tenant, userId, companyId });
  await rememberOrganisation(conn);
  return conn;
};

/** Store base currency / country / short code (best effort — never fails a connect). */
const rememberOrganisation = async (conn) => {
  try {
    const org = await getOrganisation(conn);
    if (!org) return null;
    const facts = { baseCurrency: org.BaseCurrency || null, countryCode: org.CountryCode || null, shortCode: org.ShortCode || null };
    await XeroConnection.updateOne({ _id: conn._id }, { $set: facts });
    return facts;
  } catch (err) {
    console.error("[xero] could not read organisation:", err.message);
    return null;
  }
};

/**
 * Revoke the app's access to the organisation and wipe stored tokens.
 * `reason` is recorded in the audit log ("user", "subscription_ended", …).
 */
const disconnect = async (conn, { actor = null, reason = "user" } = {}) => {
  const cfg = getConfig();
  let remoteError = null;

  if (conn.connectionId && conn.status === "connected") {
    try {
      const token = await tokens.getAccessToken(conn._id);
      const res = await http.send({
        method: "DELETE",
        url: `${cfg.apiUrl}/connections/${conn.connectionId}`,
        headers: { Authorization: `Bearer ${token}` },
      });
      // 204 = removed; 404/401/403 mean it is already gone or revoked — fine.
      if (![200, 204, 401, 403, 404].includes(res.status)) remoteError = `status ${res.status}`;
    } catch (err) {
      remoteError = err.message; // still disconnect locally — the user asked for it
    }
  }

  await XeroConnection.updateOne(
    { _id: conn._id },
    {
      $set: {
        status: "disconnected",
        disconnectedAt: new Date(),
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        lastSyncStatus: "idle",
      },
    }
  );
  tokens.clearCache(conn._id);

  await logSync({
    tenantId: conn.tenantId,
    companyId: conn.companyId,
    entity: "connection",
    action: "disconnect",
    status: remoteError ? "failed" : "success",
    error: remoteError ? `remote revoke: ${remoteError}` : null,
    actor,
    meta: { reason },
  });
  return { remoteRevoked: !remoteError };
};

module.exports = {
  request,
  connect,
  upsertConnection,
  rememberOrganisation,
  getAccounts,
  getTaxRates,
  getCurrencies,
  getOrganisation,
  DISCONNECTED_MESSAGE,
  getOrganisationWithToken,
  disconnect,
  getContacts,
  createContact,
  updateContact,
  getInvoices,
  createInvoice,
  updateInvoice,
  getPayments,
  createPayment,
  describeXeroError,
};
