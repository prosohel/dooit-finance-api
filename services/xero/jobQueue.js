"use strict";

// Mongo-backed job queue + worker for Xero sync work.
//
// Same shape as the other background sweeps in this codebase
// (services/billing/billingCycleJob.js): a setInterval started from server.js,
// safe on several instances because jobs are claimed with an atomic
// findOneAndUpdate and de-duplicated by a partial unique index.

const XeroJob = require("../../models/XeroJob");
const XeroConnection = require("../../models/XeroConnection");
const { getConfig, isXeroEnabled } = require("../../config/xero");
const { logSync } = require("./syncLog");
const sync = require("./syncService");
const xero = require("./client");
const connectionRequests = require("./connectionRequestService");
const cleanup = require("./connectionCleanup");

const OFFBOARD_SWEEP_MS = 60 * 60 * 1000;

const POLL_MS = 15 * 1000;
const LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const BACKOFF_BASE_MS = 30 * 1000;

/**
 * Queue a job. Identical pending work (same dedupeKey) collapses into one.
 * @returns {Promise<{ job: Object, duplicate: boolean }>}
 */
const enqueue = async (type, { tenantId, companyId = null, payload = {}, dedupeKey = null, requestedBy = null, delayMs = 0 }) => {
  try {
    const job = await XeroJob.create({
      type,
      tenantId,
      companyId,
      payload,
      dedupeKey,
      requestedBy,
      maxAttempts: getConfig().maxJobAttempts,
      nextRunAt: new Date(Date.now() + delayMs),
    });
    return { job, duplicate: false };
  } catch (err) {
    if (err.code === 11000 && dedupeKey) {
      const job = await XeroJob.findOne({ dedupeKey, status: { $in: ["queued", "running"] } });
      return { job, duplicate: true };
    }
    throw err;
  }
};

const handleInboundEvent = async (conn, { category, resourceId }) => {
  if (category === "CONTACT") {
    const [c] = await xero.getContacts(conn, { ids: [resourceId] });
    if (c) await sync.applyInboundContact(conn, c);
  } else if (category === "INVOICE") {
    const [inv] = await xero.getInvoices(conn, { ids: [resourceId] });
    if (inv) await sync.applyInboundInvoice(conn, inv);
  } else if (category === "PAYMENT") {
    // Resolve the payment to its invoice, then treat it as an invoice update.
    const data = await xero.request(conn, { path: `/Payments/${resourceId}` });
    const invoiceId = data?.Payments?.[0]?.Invoice?.InvoiceID;
    if (invoiceId) {
      const [inv] = await xero.getInvoices(conn, { ids: [invoiceId] });
      if (inv) await sync.applyInboundInvoice(conn, inv);
    }
  }
};

const execute = async (job) => {
  const conn = await XeroConnection.findOne({ tenantId: job.tenantId, status: "connected" });
  if (!conn) return; // disconnected since queueing — nothing to do, not an error

  if (job.type === "full_sync") await sync.runSync(conn._id, { full: true });
  else if (job.type === "outbound_sync") await sync.runSync(conn._id, { full: false });
  else if (job.type === "inbound_event") await handleInboundEvent(conn, job.payload);
};

/** Claim and run one due job. Returns false when the queue is empty. */
const processNext = async () => {
  const now = new Date();
  const job = await XeroJob.findOneAndUpdate(
    { status: "queued", nextRunAt: { $lte: now } },
    { $set: { status: "running", lockedAt: now }, $inc: { attempts: 1 } },
    { sort: { nextRunAt: 1 }, new: true }
  );
  if (!job) return false;

  try {
    await execute(job);
    await XeroJob.updateOne({ _id: job._id }, { $set: { status: "done", lockedAt: null, lastError: null } });
  } catch (err) {
    const dead = job.attempts >= job.maxAttempts || err.statusCode === 401 || err.statusCode === 409;
    await XeroJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: dead ? "dead" : "queued",
          lockedAt: null,
          lastError: String(err.message).slice(0, 500),
          nextRunAt: new Date(Date.now() + BACKOFF_BASE_MS * 2 ** (job.attempts - 1)),
        },
      }
    );
    await logSync({
      tenantId: job.tenantId,
      companyId: job.companyId,
      entity: job.type === "inbound_event" ? "webhook" : "sync",
      entityId: job._id,
      action: dead ? "job_dead" : "job_retry",
      status: "failed",
      error: err.message,
    });
  }
  return true;
};

/** Return jobs abandoned by a crashed worker to the queue. */
const recoverStale = () =>
  XeroJob.updateMany(
    { status: "running", lockedAt: { $lt: new Date(Date.now() - LOCK_TIMEOUT_MS) } },
    { $set: { status: "queued", lockedAt: null } }
  );

/** Queue an incremental sync for every live connection (deduped per interval window). */
const scheduleIncrementalSyncs = async () => {
  const { syncIntervalMs } = getConfig();
  const bucket = Math.floor(Date.now() / syncIntervalMs);
  const conns = await XeroConnection.find({ status: "connected" }).select("tenantId companyId").lean();
  for (const c of conns) {
    await enqueue("outbound_sync", {
      tenantId: c.tenantId,
      companyId: c.companyId,
      dedupeKey: `incr:${c.tenantId}:${bucket}`,
    });
  }
};

let started = false;

const startXeroWorker = () => {
  if (started || !isXeroEnabled()) return;
  started = true;

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await recoverStale();
      await connectionRequests.expireDue();
      await cleanup.releaseAbandonedSignups();
      for (let i = 0; i < 20 && (await processNext()); i += 1);
    } catch (err) {
      console.error("[xero] worker error:", err.message);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, POLL_MS).unref();
  setInterval(
    () => scheduleIncrementalSyncs().catch((e) => console.error("[xero] schedule error:", e.message)),
    getConfig().syncIntervalMs
  ).unref();
  // Customers who off-board (account deactivated, subscription ended) are disconnected.
  setInterval(
    () => cleanup.disconnectOffboarded(xero.disconnect).catch((e) => console.error("[xero] off-boarding sweep error:", e.message)),
    OFFBOARD_SWEEP_MS
  ).unref();
  console.log("[xero] background worker started");
};

module.exports = { enqueue, processNext, recoverStale, scheduleIncrementalSyncs, startXeroWorker };
