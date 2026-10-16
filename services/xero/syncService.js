"use strict";

// Sync engine. Idempotent by construction:
//   • XeroEntityLink maps every Dooit entity to its Xero id (unique indexes), so
//     a re-run updates instead of creating.
//   • A payload hash per link means an unchanged entity makes no API call.
//   • Creates carry an Idempotency-Key, so a retry after a lost response is a no-op.
//   • Duplicate-contact errors are resolved by adopting the existing ACTIVE contact.
//
// What flows where (the connected organisation is the Dooit CLIENT's Xero):
//   out: Dooit (supplier contact) · KYC customers (contacts, optional)
//        Dooit invoices → bills (ACCPAY) · payments Dooit received → bill payments (optional)
//   in:  bill status and contact status are TRACKED on the link for display and
//        payment gating. Nothing in Xero ever changes a Dooit KYC record,
//        invoice or payment: the client's own books are not evidence that Dooit
//        was paid, and KYC data is verified evidence, not editable contact info.

const XeroConnection = require("../../models/XeroConnection");
const XeroEntityLink = require("../../models/XeroEntityLink");
const Customer = require("../../models/Customer");
const Invoice = require("../../models/Invoice");
const Payment = require("../../models/Payment");
const { getConfig } = require("../../config/xero");
const xero = require("./client");
const map = require("./mappers");
const settingsService = require("./settingsService");
const { logSync, hashPayload } = require("./syncLog");

const STALE_RUN_MS = 30 * 60 * 1000;
const SUPPLIER_LOCAL_ID = "dooit";

const emptySummary = () => ({
  contacts: { created: 0, updated: 0, skipped: 0, failed: 0 },
  bills: { created: 0, updated: 0, skipped: 0, failed: 0 },
  payments: { created: 0, updated: 0, skipped: 0, failed: 0 },
});

const getLink = (tenantId, entityType, localId) =>
  XeroEntityLink.findOne({ tenantId, entityType, localId: String(localId) });

/** Insert-or-adopt a link; a unique-index race resolves to the winner's row. */
const saveLink = async (conn, entityType, localId, fields) => {
  try {
    return await XeroEntityLink.findOneAndUpdate(
      { tenantId: conn.tenantId, entityType, localId: String(localId) },
      { $set: { companyId: conn.companyId, lastSyncedAt: new Date(), ...fields } },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err.code === 11000) return getLink(conn.tenantId, entityType, localId);
    throw err;
  }
};

const ctx = (conn) => ({ tenantId: conn.tenantId, companyId: conn.companyId });
// Xero rejects a key reused for a different request (method, path or body),
// so the key names the operation: creates moved from POST to PUT, and keys from
// the POST era must never be replayed against PUT.
const idemKey = (kind, conn, localId, hash = "") =>
  `dooit-${kind}-${conn.tenantId}-${localId}${hash ? `-${hash.slice(0, 16)}` : ""}`;

// ── Contacts ─────────────────────────────────────────────────────────────────

const sameEmail = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * Xero refused a create because an ACTIVE contact already has this name.
 * Adopt it only when it is provably the same party — the supplier contact, or
 * an unlinked contact with the same email / our account number. Otherwise
 * (two different customers called "Jane Citizen", or the client's own unrelated
 * contact) create a separate contact with a unique name; never overwrite.
 * @returns {Promise<{ contact: Object, action: string, displayName?: string }>}
 */
const resolveDuplicateContact = async (conn, entityType, localId, payload, hash, err) => {
  const name = payload.Name.replace(/"/g, '\\"');
  const found = (await xero.getContacts(conn, { where: `Name=="${name}" AND ContactStatus=="ACTIVE"` }))[0];
  if (!found) {
    err.message = `A contact named "${payload.Name}" already exists in Xero but is archived — restore it in Xero, then sync again`;
    throw err;
  }
  const owner = await XeroEntityLink.findOne({ tenantId: conn.tenantId, xeroId: found.ContactID });
  const samePartyAsFound =
    entityType === "supplier" ||
    (!owner && (sameEmail(found.EmailAddress, payload.EmailAddress) || (payload.AccountNumber && found.AccountNumber === payload.AccountNumber)));
  if (samePartyAsFound) {
    return { contact: await xero.updateContact(conn, found.ContactID, payload), action: "adopt" };
  }
  const displayName = `${payload.Name} (${payload.AccountNumber || String(localId).slice(-8)})`;
  const contact = await xero.createContact(conn, { ...payload, Name: displayName }, {
    idempotencyKey: idemKey("put-contact", conn, `${entityType}-${localId}-dn`, hash),
  });
  return { contact, action: "create", displayName };
};

/**
 * Push one contact. `entityType` is "customer" | "supplier".
 * @returns {Promise<{ action: string, xeroId?: string, error?: string }>}
 */
const pushContact = async (conn, entityType, localId, mapped) => {
  if (!mapped) {
    await logSync({ ...ctx(conn), entity: "contact", entityId: localId, action: "skip", direction: "outbound", status: "skipped", error: "no usable name" });
    return { action: "skipped" };
  }

  const link = await getLink(conn.tenantId, entityType, localId);
  // The client archived this contact in Xero themselves — respect that.
  if (link?.remoteStatus === "ARCHIVED" && !link.archivedByDooit) return { action: "skipped", xeroId: link.xeroId };
  // Keep the unique name a previous duplicate forced on this contact.
  const payload = link?.displayName ? { ...mapped, Name: link.displayName } : mapped;
  const reactivate = link?.remoteStatus === "ARCHIVED" && link.archivedByDooit;

  const hash = hashPayload(payload);
  if (link && link.payloadHash === hash && !reactivate) return { action: "skipped", xeroId: link.xeroId };

  try {
    let contact;
    let action;
    let displayName = link?.displayName || null;
    if (link) {
      contact = await xero.updateContact(conn, link.xeroId, reactivate ? { ...payload, ContactStatus: "ACTIVE" } : payload);
      action = reactivate ? "restore" : "update";
    } else {
      try {
        contact = await xero.createContact(conn, payload, { idempotencyKey: idemKey("put-contact", conn, `${entityType}-${localId}`, hash) });
        action = "create";
      } catch (err) {
        if (err.code !== "DUPLICATE_CONTACT") throw err;
        const resolved = await resolveDuplicateContact(conn, entityType, localId, payload, hash, err);
        ({ contact, action } = resolved);
        displayName = resolved.displayName || null;
      }
    }
    await saveLink(conn, entityType, localId, {
      xeroId: contact.ContactID,
      // The hash of what is stored, so the next run compares like with like.
      payloadHash: displayName && !link?.displayName ? hashPayload({ ...mapped, Name: displayName }) : hash,
      remoteStatus: contact.ContactStatus || "ACTIVE",
      remoteUpdatedAt: map.parseXeroDate(contact.UpdatedDateUTC),
      displayName,
      archivedByDooit: false,
    });
    await logSync({ ...ctx(conn), entity: "contact", entityId: localId, action, direction: "outbound", status: "success", payloadHash: hash, meta: { kind: entityType } });
    return { action: action === "create" ? "created" : "updated", xeroId: contact.ContactID };
  } catch (err) {
    await logSync({ ...ctx(conn), entity: "contact", entityId: localId, action: link ? "update" : "create", direction: "outbound", status: "failed", error: err.message, payloadHash: hash, meta: { kind: entityType } });
    return { action: "failed", error: err.message };
  }
};

/**
 * A synced customer is no longer eligible (KYC failed, sanctions match,
 * offboarded…): archive their Xero contact so the client can't keep trading
 * with them. Once only; restored automatically if they become eligible again.
 */
const retireCustomerContact = async (conn, localId, reason) => {
  const link = await getLink(conn.tenantId, "customer", localId);
  if (!link || link.remoteStatus === "ARCHIVED") return { action: "skipped" };
  try {
    await xero.updateContact(conn, link.xeroId, { ContactStatus: "ARCHIVED" });
    await XeroEntityLink.updateOne(
      { tenantId: conn.tenantId, entityType: "customer", localId: String(localId) },
      { $set: { remoteStatus: "ARCHIVED", archivedByDooit: true, payloadHash: null, lastSyncedAt: new Date() } }
    );
    await logSync({ ...ctx(conn), entity: "contact", entityId: localId, action: "archive", direction: "outbound", status: "success", meta: { kind: "customer", reason } });
    return { action: "updated", xeroId: link.xeroId };
  } catch (err) {
    await logSync({ ...ctx(conn), entity: "contact", entityId: localId, action: "archive", direction: "outbound", status: "failed", error: `Couldn't archive a customer who is no longer eligible (${reason}): ${err.message}`, meta: { kind: "customer", reason } });
    return { action: "failed", error: err.message };
  }
};

/** Dooit as the supplier contact the client's bills are addressed from. */
const ensureSupplier = (conn) => pushContact(conn, "supplier", SUPPLIER_LOCAL_ID, map.supplierToContact());

// ── Bills ────────────────────────────────────────────────────────────────────

const failBill = async (conn, invoice, action, error, hash = null) => {
  await logSync({ ...ctx(conn), entity: "invoice", entityId: invoice._id, action, direction: "outbound", status: "failed", error, payloadHash: hash, meta: { invoiceNumber: invoice.invoiceNumber || null } });
  return { action: "failed", error };
};

/** A Dooit void: delete an unapproved bill, void an approved one, flag a paid one. */
const voidBill = async (conn, invoice, link) => {
  const voidHash = hashPayload({ void: String(invoice._id) });
  if (link.payloadHash === voidHash) return { action: "skipped", xeroId: link.xeroId };

  const [remote] = await xero.getInvoices(conn, { ids: [link.xeroId] });
  const remoteStatus = remote?.Status || link.remoteStatus;
  if (["VOIDED", "DELETED"].includes(remoteStatus)) {
    await saveLink(conn, "invoice", invoice._id, { xeroId: link.xeroId, payloadHash: voidHash, remoteStatus });
    return { action: "skipped", xeroId: link.xeroId };
  }
  const target = map.voidStatusFor(remoteStatus);
  if (!target) {
    // Recorded once (hash), so a full sync does not repeat it.
    await saveLink(conn, "invoice", invoice._id, { xeroId: link.xeroId, payloadHash: voidHash, remoteStatus });
    return failBill(conn, invoice, "void", `Invoice ${invoice.invoiceNumber || ""} was voided in Dooit but its bill is ${String(remoteStatus || "").toLowerCase()} in Xero — remove the payment and void the bill in Xero`.replace(/ {2}/g, " "));
  }
  try {
    const result = await xero.updateInvoice(conn, link.xeroId, { Status: target });
    await saveLink(conn, "invoice", invoice._id, { xeroId: link.xeroId, payloadHash: voidHash, remoteStatus: result?.Status || target, remoteUpdatedAt: map.parseXeroDate(result?.UpdatedDateUTC) });
    await logSync({ ...ctx(conn), entity: "invoice", entityId: invoice._id, action: target === "DELETED" ? "delete" : "void", direction: "outbound", status: "success", meta: { invoiceNumber: invoice.invoiceNumber || null } });
    return { action: "updated", xeroId: link.xeroId };
  } catch (err) {
    return failBill(conn, invoice, "void", err.message);
  }
};

/**
 * Send one Dooit invoice to the client's Xero as a bill.
 * @param {{ supplierId: string, settings: Object, currencies?: string[] }} opts
 */
const pushBill = async (conn, invoice, { supplierId, settings, currencies = [] }) => {
  if (invoice.status === "draft") return { action: "skipped" }; // not issued yet

  const link = await getLink(conn.tenantId, "invoice", invoice._id);
  if (invoice.status === "void") return link ? voidBill(conn, invoice, link) : { action: "skipped" };

  if (currencies.length && !currencies.includes(invoice.currency)) {
    return failBill(conn, invoice, "create", `Invoice ${invoice.invoiceNumber || ""} is in ${invoice.currency}, which isn't enabled in your Xero organisation — add the currency in Xero (Settings → Currencies), then sync again`.replace(/ {2}/g, " "));
  }

  const built = map.invoiceToBill(invoice, { contactId: supplierId, settings, appUrl: getConfig().webBaseUrl });
  if (built.error) return failBill(conn, invoice, link ? "update" : "create", built.error);

  const { payload, expectedTotal } = built;
  const hash = hashPayload(payload);
  if (link && link.payloadHash === hash) return { action: "skipped", xeroId: link.xeroId };

  try {
    if (link) {
      // Issued Dooit invoices don't change; a new hash means the mapping changed.
      // Only a bill the client hasn't approved yet may be re-coded — never move
      // its status, which belongs to the client.
      if (!["DRAFT", "SUBMITTED"].includes(link.remoteStatus)) {
        await saveLink(conn, "invoice", invoice._id, { xeroId: link.xeroId, payloadHash: hash });
        return { action: "skipped", xeroId: link.xeroId };
      }
      const { Status, ...lines } = payload; // eslint-disable-line no-unused-vars
      const result = await xero.updateInvoice(conn, link.xeroId, lines);
      await saveLink(conn, "invoice", invoice._id, { xeroId: result.InvoiceID, payloadHash: hash, remoteStatus: result.Status, remoteUpdatedAt: map.parseXeroDate(result.UpdatedDateUTC) });
      await logSync({ ...ctx(conn), entity: "invoice", entityId: invoice._id, action: "update", direction: "outbound", status: "success", payloadHash: hash, meta: { invoiceNumber: invoice.invoiceNumber || null } });
      return { action: "updated", xeroId: result.InvoiceID };
    }

    const result = await xero.createInvoice(conn, payload, { idempotencyKey: idemKey("put-bill", conn, invoice._id, hash) });
    await saveLink(conn, "invoice", invoice._id, { xeroId: result.InvoiceID, payloadHash: hash, remoteStatus: result.Status, remoteUpdatedAt: map.parseXeroDate(result.UpdatedDateUTC) });
    await logSync({ ...ctx(conn), entity: "invoice", entityId: invoice._id, action: "create", direction: "outbound", status: "success", payloadHash: hash, meta: { invoiceNumber: invoice.invoiceNumber || null, xeroId: result.InvoiceID } });

    // Rounding check (Xero certification): confirm the bill totals what Dooit charged.
    const xeroTotal = Number(result.Total);
    if (Number.isFinite(xeroTotal) && map.round2(xeroTotal) !== expectedTotal) {
      await failBill(conn, invoice, "verify_total", `Bill ${invoice.invoiceNumber || ""} totals ${xeroTotal.toFixed(2)} in Xero but ${expectedTotal.toFixed(2)} in Dooit — review the bill in Xero`.replace(/ {2}/g, " "), hash);
    }
    return { action: "created", xeroId: result.InvoiceID };
  } catch (err) {
    return failBill(conn, invoice, link ? "update" : "create", err.message, hash);
  }
};

// ── Payments ─────────────────────────────────────────────────────────────────

/** Apply a payment Dooit received to the client's approved bill. */
const pushPayment = async (conn, payment, settings) => {
  if (payment.gateway === "xero") return { action: "skipped" }; // legacy inbound rows are never echoed
  if (!settings?.syncPayments || !settings.paymentAccountId) return { action: "skipped" };

  const existing = await getLink(conn.tenantId, "payment", payment._id);
  if (existing) return { action: "skipped", xeroId: existing.xeroId };

  // Waiting conditions are counted, not logged — they would repeat every run.
  const invLink = await getLink(conn.tenantId, "invoice", payment.invoice);
  if (!invLink || invLink.remoteStatus !== "AUTHORISED") return { action: "skipped" };

  const payload = map.paymentToXero(payment, invLink.xeroId, settings);
  if (!payload) return { action: "skipped" };

  const hash = hashPayload(payload);
  try {
    const result = await xero.createPayment(conn, payload, { idempotencyKey: idemKey("payment", conn, payment._id) });
    await saveLink(conn, "payment", payment._id, { xeroId: result.PaymentID, payloadHash: hash, remoteUpdatedAt: map.parseXeroDate(result.UpdatedDateUTC) });
    await XeroEntityLink.updateOne(
      { tenantId: conn.tenantId, entityType: "invoice", localId: String(payment.invoice) },
      { $set: { remoteStatus: result.Invoice?.Status || invLink.remoteStatus } }
    );
    await logSync({ ...ctx(conn), entity: "payment", entityId: payment._id, action: "create", direction: "outbound", status: "success", payloadHash: hash });
    return { action: "created", xeroId: result.PaymentID };
  } catch (err) {
    await logSync({ ...ctx(conn), entity: "payment", entityId: payment._id, action: "create", direction: "outbound", status: "failed", error: err.message, payloadHash: hash });
    return { action: "failed", error: err.message };
  }
};

// ── Outbound ─────────────────────────────────────────────────────────────────

const tally = (bucket, r) => {
  const k = r.action === "created" ? "created" : r.action === "updated" ? "updated" : r.action === "failed" ? "failed" : "skipped";
  bucket[k] += 1;
};

/**
 * Push what changed since `since` (all when null). Order matters: the supplier
 * contact before bills, bills before payments.
 *
 * @returns {Promise<{ summary: Object, billsBlocked: string|null }>}
 */
const runOutbound = async (conn, { since = null, summary = emptySummary(), check = { problems: [], currencies: [] } } = {}) => {
  const touched = since ? { updatedAt: { $gte: since } } : {};
  const settings = conn.settings || {};
  // Nothing leaves Dooit until an admin has reviewed and saved the Xero settings.
  if (!settings.configuredAt) return { summary, billsBlocked: "setup" };

  if (settings.syncCustomers) {
    const customers = Customer.find({ "relations.client": conn.companyId, ...touched }).cursor();
    for await (const c of customers) {
      const block = map.customerSyncBlock(c);
      if (block) {
        tally(summary.contacts, await retireCustomerContact(conn, c._id, block));
        continue;
      }
      const plain = typeof c.decryptForRole === "function" ? c.decryptForRole() : c.toObject();
      tally(summary.contacts, await pushContact(conn, "customer", c._id, map.customerToContact(plain)));
    }
  }

  let billsBlocked = null;
  if (!map.billMappingComplete(settings)) billsBlocked = "setup";
  else if (check.problems.length) billsBlocked = "mapping";
  if (billsBlocked) return { summary, billsBlocked };

  const supplier = await ensureSupplier(conn);
  tally(summary.contacts, supplier);
  if (!supplier.xeroId) return { summary, billsBlocked: "supplier" };

  const invoices = Invoice.find({ client: conn.companyId, ...touched }).cursor();
  for await (const inv of invoices) {
    tally(summary.bills, await pushBill(conn, inv, { supplierId: supplier.xeroId, settings, currencies: check.currencies }));
  }

  // Payments move independently of the invoice's updatedAt — scan the company's
  // settled payments; the link table makes the scan cheap and exact.
  if (settings.syncPayments) {
    const payments = Payment.find({ client: conn.companyId, type: "payment", status: "paid" }).cursor();
    for await (const p of payments) tally(summary.payments, await pushPayment(conn, p, settings));
  }
  return { summary, billsBlocked: null };
};

// ── Inbound (tracking only) ──────────────────────────────────────────────────

/** Record a linked contact's state (e.g. archived in Xero). Dooit data is not changed. */
const applyInboundContact = async (conn, xeroContact) => {
  const link = await XeroEntityLink.findOne({
    tenantId: conn.tenantId,
    entityType: { $in: ["customer", "supplier", "company"] },
    xeroId: xeroContact.ContactID,
  });
  if (!link) return { action: "skipped" }; // not a contact Dooit manages

  const status = xeroContact.ContactStatus || null;
  await XeroEntityLink.updateOne(
    { _id: link._id },
    { $set: { remoteStatus: status, remoteUpdatedAt: map.parseXeroDate(xeroContact.UpdatedDateUTC), lastSyncedAt: new Date() } }
  );
  if (link.entityType === "supplier" && status === "ARCHIVED" && link.remoteStatus !== "ARCHIVED") {
    await logSync({ ...ctx(conn), entity: "contact", entityId: link.localId, action: "archived_in_xero", direction: "inbound", status: "failed", error: `The "${xeroContact.Name}" supplier contact was archived in Xero — restore it so new Dooit bills can be added` });
  }
  return { action: "skipped" };
};

/** Track a bill's status in Xero (approved, paid, voided). Dooit's invoice is not changed. */
const applyInboundInvoice = async (conn, xeroInvoice) => {
  const link = await XeroEntityLink.findOne({ tenantId: conn.tenantId, entityType: "invoice", xeroId: xeroInvoice.InvoiceID });
  if (!link) return { action: "skipped" }; // not a bill Dooit created

  const from = link.remoteStatus || null;
  const to = xeroInvoice.Status || null;
  await XeroEntityLink.updateOne(
    { _id: link._id },
    { $set: { remoteStatus: to, remoteUpdatedAt: map.parseXeroDate(xeroInvoice.UpdatedDateUTC), lastSyncedAt: new Date() } }
  );
  if (from === to) return { action: "skipped" };

  const local = await Invoice.findById(link.localId).select("status invoiceNumber").lean();
  const removed = ["VOIDED", "DELETED"].includes(to) && local && local.status !== "void";
  await logSync({
    ...ctx(conn),
    entity: "invoice",
    entityId: link.localId,
    action: `status_${String(to || "unknown").toLowerCase()}`,
    direction: "inbound",
    status: removed ? "skipped" : "success",
    error: removed ? `Bill ${local.invoiceNumber || ""} was ${to.toLowerCase()} in Xero; the Dooit invoice is unchanged — contact Dooit if it is disputed`.replace(/ {2}/g, " ") : null,
    meta: { from, to },
  });
  return { action: "updated" };
};

/** Refresh the tracked state of linked contacts and bills modified since `since`. */
const runInbound = async (conn, { since = null, summary = emptySummary() } = {}) => {
  const linkedContacts = await XeroEntityLink.find({ tenantId: conn.tenantId, entityType: { $in: ["customer", "supplier"] } }).distinct("xeroId");
  for (let i = 0; i < linkedContacts.length; i += 40) {
    const batch = await xero.getContacts(conn, { ids: linkedContacts.slice(i, i + 40), modifiedSince: since });
    for (const c of batch) await applyInboundContact(conn, c);
  }

  const linkedBills = await XeroEntityLink.find({ tenantId: conn.tenantId, entityType: "invoice" }).distinct("xeroId");
  for (let i = 0; i < linkedBills.length; i += 40) {
    const batch = await xero.getInvoices(conn, { ids: linkedBills.slice(i, i + 40), modifiedSince: since });
    for (const inv of batch) await applyInboundInvoice(conn, inv);
  }
  return summary;
};

// ── Orchestration ────────────────────────────────────────────────────────────

const BLOCKED_MESSAGE = {
  setup: null, // not an error: Settings shows the setup step
  supplier: "Dooit couldn't be added as a supplier contact in Xero — see the sync log",
};

/**
 * Full or incremental sync for a connection; records progress on the connection
 * so Settings can show running/last-sync/error state.
 */
const runSync = async (connectionId, { full = false } = {}) => {
  const claimed = await XeroConnection.findOneAndUpdate(
    {
      _id: connectionId,
      status: "connected",
      // A "running" flag older than the lock window belongs to a crashed worker.
      $or: [
        { lastSyncStatus: { $ne: "running" } },
        { updatedAt: { $lt: new Date(Date.now() - STALE_RUN_MS) } },
      ],
    },
    { $set: { lastSyncStatus: "running", lastSyncError: null } },
    { new: true }
  );
  if (!claimed) return { skipped: true };

  const started = new Date();
  const summary = emptySummary();
  try {
    // Mapping still valid in Xero? (accounts/tax rates can be archived after setup)
    const check = map.billMappingComplete(claimed.settings)
      ? await settingsService.validateForSync(claimed)
      : { problems: [], currencies: [] };

    const since = full ? null : claimed.outboundCursor;
    const { billsBlocked } = await runOutbound(claimed, { since, summary, check });
    await runInbound(claimed, { since: full ? null : claimed.inboundCursor, summary });

    const failed = Object.values(summary).reduce((n, b) => n + b.failed, 0);
    const blockedMessage = billsBlocked === "mapping"
      ? `Bills paused — the Xero mapping needs attention: ${check.problems.join("; ")}`
      : BLOCKED_MESSAGE[billsBlocked] || null;
    const errorMessage = [blockedMessage, failed ? `${failed} item(s) failed — see the sync log` : null].filter(Boolean).join(". ") || null;

    await XeroConnection.updateOne(
      { _id: claimed._id },
      {
        $set: {
          lastSyncAt: new Date(),
          lastSyncStatus: errorMessage ? "partial" : "success",
          lastSyncError: errorMessage,
          lastSyncSummary: summary,
          // While bills are blocked, keep the cursor so nothing is skipped once fixed.
          ...(billsBlocked ? {} : { outboundCursor: started }),
          inboundCursor: started,
        },
      }
    );
    await logSync({ ...ctx(claimed), entity: "sync", action: full ? "full" : "incremental", direction: "system", status: errorMessage ? "failed" : "success", error: errorMessage });
    return { skipped: false, summary, billsBlocked };
  } catch (err) {
    await XeroConnection.updateOne(
      { _id: claimed._id, status: "connected" },
      { $set: { lastSyncStatus: "failed", lastSyncError: err.message.slice(0, 500), lastSyncSummary: summary } }
    );
    await logSync({ ...ctx(claimed), entity: "sync", action: full ? "full" : "incremental", status: "failed", error: err.message });
    throw err; // lets the job queue retry with back-off
  }
};

module.exports = {
  SUPPLIER_LOCAL_ID,
  emptySummary,
  pushContact,
  ensureSupplier,
  retireCustomerContact,
  pushBill,
  pushPayment,
  runOutbound,
  runInbound,
  runSync,
  applyInboundContact,
  applyInboundInvoice,
};
