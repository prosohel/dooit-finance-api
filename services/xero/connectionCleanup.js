"use strict";

// Release Xero connections Dooit will never use.
//
// Xero certification ("Connection"): an app must have a process that deletes or
// revokes unused or expired connections — abandoned sign-ups, organisations that
// were never linked, customers who off-board. A connection left behind keeps
// access to someone's books, counts against the app's limits and keeps being
// billed as an App Store referral.
//
// Every path here is best effort and never throws: a failed clean-up is logged
// (XeroSyncLog, action "release_unused") and retried by the next sweep where
// the tokens still exist.

const XeroConnection = require("../../models/XeroConnection");
const XeroSignup = require("../../models/XeroSignup");
const Client = require("../../models/Client");
const Subscription = require("../../models/Subscription");
const { getConfig } = require("../../config/xero");
const { decrypt } = require("../../utils/encryption");
const http = require("./http");
const oauth = require("./oauth");
const { logSync } = require("./syncLog");

// A signup ticket lives 30 min; after this the visitor can no longer finish.
const ABANDONED_SIGNUP_MS = 35 * 60 * 1000;
const LIVE_SUBSCRIPTION = ["pending", "active", "paused"];
const OFFBOARDED_CLIENT = ["Inactive", "Blocked"];

const safeDecrypt = (v) => {
  try {
    return v ? decrypt(v) : null;
  } catch {
    return null;
  }
};

/**
 * Delete the connection between this app and `tenantId` that a discarded grant
 * created. Skipped when the organisation is live for a Dooit company: the
 * connection is per Xero user + organisation, so it may be the one that
 * company's sync depends on.
 *
 * @param {{ tokens: { accessToken?: string, refreshToken?: string, expiresAt?: Date },
 *           tenantId: string, connectionId?: string, reason: string, meta?: Object }} args
 *   tokens are PLAINTEXT (callers decrypt) and are never logged.
 */
const releaseGrant = async ({ tokens = {}, tenantId, connectionId = null, reason, meta = {} }) => {
  if (!tenantId) return { released: false };
  try {
    const live = await XeroConnection.findOne({ tenantId, status: "connected" }).lean();
    if (live) return { released: false, skipped: "organisation in use" };

    const fresh = tokens.expiresAt && new Date(tokens.expiresAt).getTime() - Date.now() > 60 * 1000;
    let accessToken = fresh ? tokens.accessToken : null;
    if (!accessToken && tokens.refreshToken) {
      const { status, data } = await oauth.tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refreshToken });
      if (status === 200 && data.access_token) accessToken = data.access_token;
    }
    if (!accessToken) throw new Error("the Xero authorisation had already expired");

    const id = connectionId || (await oauth.fetchConnections(accessToken)).find((c) => c.tenantId === tenantId)?.id;
    if (id) {
      const res = await http.send({
        method: "DELETE",
        url: `${getConfig().apiUrl}/connections/${id}`,
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (![200, 204, 404].includes(res.status)) throw new Error(`Xero answered ${res.status}`);
    }
    await logSync({ tenantId, entity: "connection", action: "release_unused", status: "success", meta: { reason, ...meta } });
    return { released: true };
  } catch (err) {
    await logSync({ tenantId, entity: "connection", action: "release_unused", status: "failed", error: err.message, meta: { reason, ...meta } });
    return { released: false, error: err.message };
  }
};

/** Same, from encrypted fields stored on a XeroSignup / XeroConnectionRequest row. */
const releaseStored = (row, { tenantId, connectionId, reason, meta }) =>
  releaseGrant({
    tokens: {
      accessToken: safeDecrypt(row.accessToken),
      refreshToken: safeDecrypt(row.refreshToken),
      expiresAt: row.tokenExpiresAt || null,
    },
    tenantId,
    connectionId,
    reason,
    meta,
  });

/**
 * Sweep: "Sign up with Xero" started but never finished. The visitor authorised
 * the app, so a connection exists at Xero; nothing in Dooit will ever use it.
 */
const releaseAbandonedSignups = async () => {
  const cutoff = new Date(Date.now() - ABANDONED_SIGNUP_MS);
  const rows = await XeroSignup.find(
    { clientId: null, createdAt: { $lte: cutoff }, refreshToken: { $exists: true } },
    "+accessToken +refreshToken"
  );
  let released = 0;
  for (const row of rows) {
    // Claim by wiping the tokens first, so two instances never release twice.
    const claimed = await XeroSignup.updateOne(
      { _id: row._id, refreshToken: row.refreshToken },
      { $unset: { accessToken: "", refreshToken: "" } }
    );
    if (!claimed.modifiedCount) continue;
    const out = await releaseStored(row, {
      tenantId: row.tenant?.tenantId,
      connectionId: row.tenant?.connectionId,
      reason: "signup_abandoned",
    });
    if (out.released) released += 1;
  }
  return released;
};

/**
 * Sweep: off-boarding. A company whose account is deactivated, or whose last
 * subscription has ended, should no longer be connected to Xero.
 * @param {(conn: Object, opts: Object) => Promise<any>} disconnect  client.disconnect
 */
const disconnectOffboarded = async (disconnect) => {
  const conns = await XeroConnection.find({ status: "connected" });
  let count = 0;
  for (const conn of conns) {
    const client = await Client.findById(conn.companyId).select("status").lean();
    let reason = null;
    if (!client) reason = "company_deleted";
    else if (OFFBOARDED_CLIENT.includes(client.status)) reason = `company_${client.status.toLowerCase()}`;
    else {
      const subs = await Subscription.find({ client: conn.companyId }).select("status").lean();
      if (subs.length && !subs.some((s) => LIVE_SUBSCRIPTION.includes(s.status))) reason = "subscription_ended";
    }
    if (!reason) continue;
    await disconnect(conn, { actor: null, reason });
    count += 1;
  }
  return count;
};

module.exports = {
  ABANDONED_SIGNUP_MS,
  releaseGrant,
  releaseStored,
  releaseAbandonedSignups,
  disconnectOffboarded,
};
