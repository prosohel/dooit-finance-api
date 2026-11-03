/**
 * Exchange hub (plans/integration/03 §4, §4.1).
 *
 *   POST /exchange/events                 ingest — AFC OS delivers a signed event; a tenant produces one
 *   GET  /exchange/events?to=&after=&limit=  feed — events addressed to the caller, oldest first, cursor = seq
 *   POST /exchange/events/:eventId/receipt   delivered | read | acknowledged (+ echoed back as receipt.*)
 *   GET  /exchange/status                 counts by status and app (for the Connected Platforms screen)
 *
 * The hub stores and routes; it never interprets a payload.
 */
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const ExchangeEvent = require("../models/ExchangeEvent");
const Client = require("../models/Client");
const { verifyEvent } = require("../utils/exchangeCrypto");
const { logEvent } = require("../utils/audit");
const { project } = require("../services/exchangeProjections");

const APPS = ["afcos", "portal", "grc", "bfiu", "platform"];
const RECEIPT_KINDS = ["delivered", "read", "acknowledged"];
const RECEIPT_STATUS = { delivered: "delivered", read: "read", acknowledged: "acknowledged" };
const toWire = (e) => ({ seq: e.seq, eventId: e.eventId, type: e.type, version: e.version, occurredAt: e.occurredAt, from: e.from, to: e.to, subject: e.subject, payload: e.payload, payloadHash: e.payloadHash, signature: e.signature, idempotencyKey: e.idempotencyKey, status: e.status, receipts: e.receipts, actor: e.actor });

/** May this caller see / act on an event addressed `to`? */
function addressedTo(caller, to) {
  if (caller.service) return to.app === caller.app;
  // A tenant sees its own events and the broadcasts (no client, no RO: e.g. circular.published to every portal).
  return to.app === caller.app && (String(to.client ?? "") === String(caller.client) || (to.client == null && to.roId == null));
}

// @route POST /api/v1/exchange/events
exports.ingest = asyncHandler(async (req, res, next) => {
  const c = req.exchangeCaller;
  const b = req.body ?? {};
  if (!b.type || !b.subject?.kind || b.payload == null) return next(new ErrorResponse("type, subject.kind and payload are required", 400));

  if (c.service) {
    // AFC OS (or BFIU) delivers a fully formed, signed envelope. Idempotent by eventId / idempotencyKey.
    if (!b.eventId || !b.idempotencyKey || !b.payloadHash || !b.signature || !b.to?.app) return next(new ErrorResponse("eventId, idempotencyKey, payloadHash, signature and to.app are required", 400));
    if (!APPS.includes(b.to.app)) return next(new ErrorResponse(`to.app must be one of ${APPS.join(", ")}`, 400));
    if (!verifyEvent(b)) return next(new ErrorResponse("Event signature does not verify", 400));
    const existing = await ExchangeEvent.findOne({ $or: [{ eventId: b.eventId }, { idempotencyKey: b.idempotencyKey }] });
    if (existing) return res.status(200).json({ success: true, duplicate: true, data: { eventId: existing.eventId, seq: existing.seq, status: existing.status, receipts: existing.receipts } });
    // Resolve the tenant from the RO id when the producer only knows the regulator's uid.
    let client = b.to.client ?? null;
    if (!client && b.to.roId) client = (await Client.findOne({ uid: b.to.roId }).select("_id").lean())?._id ?? null;
    const now = new Date();
    const doc = await ExchangeEvent.create({
      seq: await ExchangeEvent.nextSeq(),
      eventId: b.eventId, type: b.type, version: b.version ?? 1, occurredAt: b.occurredAt ? new Date(b.occurredAt) : now,
      from: { app: b.from?.app ?? c.app, body: b.from?.body ?? null, client: null, roId: null },
      to: { app: b.to.app, body: b.to.body ?? null, client, roId: b.to.roId ?? null },
      subject: b.subject, payload: b.payload, payloadHash: b.payloadHash, signature: b.signature, idempotencyKey: b.idempotencyKey,
      status: "delivered", receipts: { deliveredAt: now, readAt: null, acknowledgedAt: null, note: null },
      receivedVia: c.app, actor: b.actor ?? {},
    });
    logEvent?.({ req, service: "exchange", action: "ingested", target: { kind: "ExchangeEvent", id: doc._id, uid: doc.eventId }, after: { type: doc.type, to: doc.to.app, roId: doc.to.roId } });
    // What the platform does with the event beyond routing it (e.g. accepted gaps → Issue Register rows). Never throws.
    const projection = await project(doc);
    if (projection) logEvent?.({ req, service: "exchange", action: "projected", status: projection.ok ? "success" : "failure", target: { kind: "ExchangeEvent", id: doc._id, uid: doc.eventId }, details: projection.note });
    return res.status(201).json({ success: true, data: { eventId: doc.eventId, seq: doc.seq, status: doc.status, receipts: doc.receipts, projection } });
  }

  // A tenant produces an event (rfi.responded, circular.acknowledged, remediation.evidence …). The hub signs it.
  const toApp = b.to?.app ?? "afcos";
  if (!["afcos", "bfiu"].includes(toApp)) return next(new ErrorResponse("Tenant events are addressed to afcos or bfiu", 400));
  const client = await Client.findById(c.client).select("uid name").lean();
  const idempotencyKey = b.idempotencyKey || `${c.app}:${client?.uid ?? c.client}:${b.type}:${b.subject.uid ?? b.subject.id ?? ""}:${Date.now()}`;
  const existing = await ExchangeEvent.findOne({ idempotencyKey });
  if (existing) return res.status(200).json({ success: true, duplicate: true, data: toWire(existing) });
  const doc = await ExchangeEvent.create({
    seq: await ExchangeEvent.nextSeq(),
    eventId: await ExchangeEvent.nextEventId(),
    type: b.type, version: b.version ?? 1, occurredAt: b.occurredAt ? new Date(b.occurredAt) : new Date(),
    from: { app: c.app, body: null, client: c.client, roId: client?.uid ?? null },
    to: { app: toApp, body: b.to?.body ?? null, client: null, roId: null },
    subject: b.subject, payload: b.payload, idempotencyKey,
    status: "queued", receivedVia: String(c.user?._id ?? c.user?.id ?? "user"),
    actor: { user: c.user?._id ?? null, name: c.user?.name ?? null, role: c.user?.userType ?? null, body: client?.name ?? null },
  });
  logEvent?.({ req, service: "exchange", action: "produced", target: { kind: "ExchangeEvent", id: doc._id, uid: doc.eventId }, after: { type: doc.type, to: toApp } });
  res.status(201).json({ success: true, data: toWire(doc) });
});

// @route GET /api/v1/exchange/events?to=afcos&after=<seq>&limit=200&type=
exports.feed = asyncHandler(async (req, res, next) => {
  const c = req.exchangeCaller;
  const to = String(req.query.to ?? c.app);
  if (!APPS.includes(to)) return next(new ErrorResponse(`to must be one of ${APPS.join(", ")}`, 400));
  if (to !== c.app) return next(new ErrorResponse(`A ${c.app} caller reads events addressed to ${c.app}`, 403));
  const filter = { "to.app": to };
  // Tenants: own events plus broadcasts (circular.published is addressed to every portal with no client).
  if (!c.service) filter.$or = [{ "to.client": c.client }, { "to.client": null, "to.roId": null }];
  const after = Number(req.query.after ?? 0);
  if (after > 0) filter.seq = { $gt: after };
  if (req.query.type) filter.type = String(req.query.type);
  if (req.query.status) filter.status = String(req.query.status);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
  const rows = await ExchangeEvent.find(filter).sort({ seq: 1 }).limit(limit);
  res.status(200).json({ success: true, count: rows.length, cursor: rows.length ? rows[rows.length - 1].seq : after, data: rows.map(toWire) });
});

// @route GET /api/v1/exchange/events/:eventId
exports.get = asyncHandler(async (req, res, next) => {
  const doc = await ExchangeEvent.findOne({ eventId: req.params.eventId });
  if (!doc) return next(new ErrorResponse("Event not found", 404));
  const c = req.exchangeCaller;
  if (!addressedTo(c, doc.to) && !(c.service && doc.from.app === c.app) && !(!c.service && String(doc.from.client ?? "") === String(c.client))) return next(new ErrorResponse("Not addressed to this caller", 403));
  res.status(200).json({ success: true, data: toWire(doc) });
});

// @desc  Receipt by the consumer. Also echoed to the producer as a `receipt.<kind>` event so its poll sees it.
// @route POST /api/v1/exchange/events/:eventId/receipt   { kind: delivered | read | acknowledged, note? }
exports.receipt = asyncHandler(async (req, res, next) => {
  const c = req.exchangeCaller;
  const doc = await ExchangeEvent.findOne({ eventId: req.params.eventId });
  if (!doc) return next(new ErrorResponse("Event not found", 404));
  if (!addressedTo(c, doc.to)) return next(new ErrorResponse("Only the addressee records a receipt", 403));
  const { kind, note = null } = req.body ?? {};
  if (!RECEIPT_KINDS.includes(kind)) return next(new ErrorResponse(`kind must be one of ${RECEIPT_KINDS.join(", ")}`, 400));
  const now = new Date();
  const order = RECEIPT_KINDS.indexOf(kind);
  if (!doc.receipts.deliveredAt) doc.receipts.deliveredAt = now;
  if (order >= 1 && !doc.receipts.readAt) doc.receipts.readAt = now;
  if (order >= 2 && !doc.receipts.acknowledgedAt) doc.receipts.acknowledgedAt = now;
  if (note) doc.receipts.note = String(note);
  if (RECEIPT_KINDS.indexOf(RECEIPT_STATUS[kind]) >= RECEIPT_KINDS.indexOf(doc.status) || doc.status === "queued" || doc.status === "failed") doc.status = RECEIPT_STATUS[kind];
  await doc.save();
  // Echo to the producer (never to itself: receipts on receipts stop here).
  let echo = null;
  if (!doc.type.startsWith("receipt.")) {
    echo = await ExchangeEvent.create({
      seq: await ExchangeEvent.nextSeq(),
      eventId: await ExchangeEvent.nextEventId(),
      type: `receipt.${kind}`, occurredAt: now,
      from: { app: c.app, body: null, client: c.client, roId: doc.to.roId ?? null },
      to: { app: doc.from.app, body: doc.from.body ?? null, client: doc.from.client ?? null, roId: doc.from.roId ?? null },
      subject: { kind: "ExchangeEvent", id: String(doc._id), uid: doc.eventId },
      payload: { eventId: doc.eventId, type: doc.type, subject: doc.subject, kind, at: now, note },
      idempotencyKey: `receipt:${doc.eventId}:${kind}`,
      status: "queued", receivedVia: c.service ? c.app : String(c.user?._id ?? "user"),
      actor: { user: c.user?._id ?? null, name: c.user?.name ?? c.app, role: null, body: null },
    }).catch((err) => (err.code === 11000 ? null : Promise.reject(err)));
  }
  logEvent?.({ req, service: "exchange", action: `receipt_${kind}`, target: { kind: "ExchangeEvent", id: doc._id, uid: doc.eventId }, after: { by: c.app, echo: echo?.eventId ?? null } });
  res.status(200).json({ success: true, data: { eventId: doc.eventId, status: doc.status, receipts: doc.receipts, echo: echo?.eventId ?? null } });
});

// @route GET /api/v1/exchange/status
exports.status = asyncHandler(async (req, res) => {
  const c = req.exchangeCaller;
  const match = c.service ? {} : { $or: [{ "to.client": c.client }, { "from.client": c.client }] };
  const rows = await ExchangeEvent.aggregate([{ $match: match }, { $group: { _id: { to: "$to.app", status: "$status" }, n: { $sum: 1 } } }]);
  const byApp = {};
  for (const r of rows) {
    byApp[r._id.to] ??= {};
    byApp[r._id.to][r._id.status] = r.n;
  }
  const last = await ExchangeEvent.findOne(match).sort({ seq: -1 }).select("seq eventId type createdAt").lean();
  res.status(200).json({ success: true, data: { byApp, lastSeq: last?.seq ?? 0, last } });
});
