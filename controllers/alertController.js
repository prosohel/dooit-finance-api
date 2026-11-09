// controllers/alertController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Alert = require("../models/Alert");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog");
const Customer = require("../models/Customer");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { auditContext } = require("../utils/auditContext");
const { logEvent } = require("../utils/audit");
const { priorityForRiskLabel, CASE_TYPES } = require("../models/schemas/riskShared");
const { bumpRuleTelemetry } = require("../services/ruleAlerting");
// Escalate-or-attach + entity pull-through live in the case-linking service
// (docs/74 §6.1) so this controller and caseController link alerts identically.
const {
  populateCase,
  attachAlertsToCase,
  findAttachableCase,
  listAttachableCases,
} = require("../services/caseLinking");

// Maps Alert.riskLabel → Case.priority (shared with the rule engine)
const mapRiskToPriority = priorityForRiskLabel;

// Maps Alert.caseType → Case.type enum
const mapAlertTypeToCase = (caseType) => {
  const t = (caseType || "").toLowerCase().replace(/\s+/g, "_");
  if (t === "sar") return "SAR";
  if (t === "pep") return "PEP";
  if (t === "transaction_monitoring") return "transaction_monitoring";
  return "other";
};

const sanitizeCaseType = (val) => (CASE_TYPES.includes(val) ? val : null);

// @desc   Get all alerts
// @route  GET /api/v1/alerts
// @access Private
exports.getAlerts = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Alert']
  #swagger.summary = 'Get All Alerts'
  */
  res.status(200).json(res.advancedResults);
});

// @desc   Get all alerts via POST
// @route  POST /api/v1/alerts/search
// @access Private
exports.getAlertsPost = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Alert']
    #swagger.summary = 'Search Alerts'
  */
  res.status(200).json(res.advancedResults);
});

// @desc   Create single alert
// @route  POST /api/v1/alerts
// @access Private
exports.createAlert = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Alert']
    #swagger.summary = 'Create Alert'
    #swagger.security = [{ "BearerAuth": [] }]
  */
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  const user = req?.user?._id || null;

  const {
    customerId,
    transactionId,
    ruleRef,
    ruleId,
    ruleName,
    ruleVersion,
    ruleMeta,
    explanation,
    caseType,
    riskScore,
    riskLabel,
    priority,
    deduplicationKey,
    slaDeadline,
    activity = [],
    metadata,
    status,
  } = req.body;

  const customer = customerId ? await Customer.findById(customerId) : null;
  if (customerId && !customer) {
    return next(new ErrorResponse(`Customer not found with id ${customerId}`, 404));
  }

  let transaction = null;
  if (transactionId) {
    transaction = await Transaction.findById(transactionId).select("_id").lean();
    if (!transaction) {
      return next(new ErrorResponse(`Transaction not found with id ${transactionId}`, 404));
    }
  }

  const alert = await Alert.create({
    client,
    branch,
    customer: customer?._id || null,
    transaction: transaction?._id || null,
    ruleRef: ruleRef || null,
    ruleId: ruleId || null,
    ruleName: ruleName || null,
    ruleVersion: ruleVersion || null,
    ruleMeta: ruleMeta || {},
    explanation: explanation || null,
    caseType: caseType || null,
    riskScore: riskScore || 0,
    riskLabel: riskLabel || "Low",
    priority: priority || "medium",
    deduplicationKey: deduplicationKey || undefined,
    slaDeadline: slaDeadline || null,
    activity,
    metadata: metadata || {},
    createdBy: user,
    status: status || "new",
  });

  // Telemetry: if this alert was fired by a RuleEngine rule, bump its counters
  // (best-effort, shared with the rule engine's own alert path).
  await bumpRuleTelemetry(ruleRef);

  logEvent({
    req,
    service: "alert",
    action: "alert_created",
    alert: alert._id,
    customer: alert.customer || undefined,
    target: alert.uid,
  });

  res.status(201).json({ succeed: true, data: alert, id: alert._id });
});

// @desc   Create dummy alert (for testing / demo)
// @route  POST /api/v1/alerts/dummy
// @access Private
exports.createDummyAlert = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Alert']
    #swagger.summary = 'Create Dummy Alert'
  */
  const {
    customerName,
    analystName,
    transactionId,
    caseType,
    status = "new",
    riskScore = Math.floor(Math.random() * 100),
    riskLabel = "Medium",
    activity = [],
  } = req.body;

  const userDoc = customerName ? await User.findOne({ name: customerName }) : null;
  const customer = userDoc ? await Customer.findOne({ user: userDoc._id }) : null;
  const transaction = transactionId ? await Transaction.findOne({ uid: transactionId }) : null;
  const analyst = analystName ? await User.findOne({ name: analystName }) : null;

  if (!customer) return next(new ErrorResponse("Customer not found", 404));
  if (!transaction) return next(new ErrorResponse("Transaction not found", 404));

  const alert = await Alert.create({
    customer: customer._id,
    transaction: transaction._id,
    analyst: analyst?._id || null,
    caseType: caseType || "Default",
    riskScore,
    riskLabel,
    activity,
    status,
  });

  res.status(201).json({ succeed: true, data: alert, id: alert._id });
});

// @desc   Get single alert by id
// @route  GET /api/v1/alerts/:id
// @access Private
exports.getAlert = asyncHandler(async (req, res, next) => {
  // The details page is built on this one response (docs/72 Status box):
  // customer (+ its login user), analyst, transaction (parties auto-populate),
  // the rule with enough of its definition to explain the hit, the case hub
  // and the notify that raised it.
  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .populate({ path: "customer", populate: { path: "user", select: "name email photoUrl avatar" } })
    .populate("analyst", "name email photoUrl avatar")
    .populate("transaction")
    .populate(
      "ruleRef",
      "ruleId ruleName version caseType engine appliesTo ruleCondition descriptiveExplanation " +
        "riskScore riskLabel mainDomain ruleDomainSubdomain category hitCount lastFiredAt " +
        "cooldownMinutes dedupeBy slaHours actions status"
    )
    .populate({ path: "linkedCase", select: "uid title status priority caseType assignedTo slaDeadline", populate: { path: "assignedTo", select: "name" } })
    .populate("notify", "uid status notes createdAt")
    .populate("activity.createdBy", "name")
    .populate("auditLogs.performedBy", "name")
    .populate("monitoringResult");

  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));
  }

  res.status(200).json({ succeed: true, data: alert });
});

// @desc   Update single alert
// @route  PUT /api/v1/alerts/:id
// @access Private
exports.updateAlert = asyncHandler(async (req, res, next) => {
  const alertId = req.params.id;
  const alert = await Alert.findOne({ _id: alertId, isDeleted: { $ne: true } });

  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${alertId}`, 404));
  }

  const allowedFields = [
    "caseType",
    "riskScore",
    "riskLabel",
    "priority",
    "status",
    "statusReason",
    "analyst",
    "slaDeadline",
    "slaStatus",
    "explanation",
    "metadata",
  ];

  const updates = {};
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  if (Object.keys(updates).length === 0) {
    return next(new ErrorResponse("No valid fields provided for update", 400));
  }

  const updated = await Alert.findByIdAndUpdate(alertId, updates, {
    new: true,
    runValidators: true,
  });

  const auditedKeys = ["status", "riskScore", "riskLabel", "priority", "analyst"];
  const beforeValue = {};
  const afterValue = {};
  auditedKeys.forEach((k) => {
    if (
      updates[k] !== undefined &&
      JSON.stringify(alert[k]) !== JSON.stringify(updated[k])
    ) {
      beforeValue[k] = alert[k];
      afterValue[k] = updated[k];
    }
  });
  if (Object.keys(afterValue).length) {
    logEvent({
      req,
      service: "alert",
      action: "alert_updated",
      alert: updated._id,
      customer: updated.customer || undefined,
      beforeValue,
      afterValue,
    });
  }

  res.status(200).json({ succeed: true, data: updated });
});

// @desc   Soft-delete an alert
// @route  DELETE /api/v1/alerts/:id
// @access Private
exports.deleteAlert = asyncHandler(async (req, res, next) => {
  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));
  }

  alert.isDeleted = true;
  alert.deletedAt = new Date();
  await alert.save();

  logEvent({
    req,
    service: "alert",
    action: "alert_deleted",
    alert: alert._id,
    customer: alert.customer || undefined,
    beforeValue: { uid: alert.uid, status: alert.status },
  });

  res.status(200).json({ succeed: true, data: req.params.id });
});

// @desc   Assign an analyst to an alert
// @route  PUT /api/v1/alerts/:id/assign-analyst
// @access Private
exports.assignAnalyst = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Alert']
    #swagger.summary = 'Assign Analyst to Alert'
  */
  const alertId = req.params.id;
  const { analystId } = req.body;

  if (!analystId) {
    return next(new ErrorResponse("analystId is required", 400));
  }

  const alert = await Alert.findOne({ _id: alertId, isDeleted: { $ne: true } });
  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${alertId}`, 404));
  }

  const analyst = await User.findById(analystId);
  if (!analyst) {
    return next(new ErrorResponse(`Analyst not found with id ${analystId}`, 404));
  }

  alert.analyst = analyst._id;
  alert.activity.push({
    type: "activity",
    title: "Analyst assigned",
    message: `${analyst.name} assigned by ${req.user.name || req.user._id}`,
    createdBy: req.user._id,
  });
  await alert.save();

  logEvent({
    req,
    service: "alert",
    action: "alert_assigned",
    alert: alert._id,
    customer: alert.customer || undefined,
    afterValue: { analyst: analyst.name || analyst._id },
  });

  res.status(200).json({
    succeed: true,
    message: `Analyst ${analyst.name} assigned to alert ${alert.uid}`,
    data: alert,
  });
});

// @desc   Add an analyst note to an alert (appends to alert.activity as type 'note')
// @route  POST /api/v1/alert/:id/notes
// @access Private (ALERT.EDIT)
exports.addAlertNote = asyncHandler(async (req, res, next) => {
  const message = String(req.body?.message || req.body?.note || "").trim();
  if (!message) return next(new ErrorResponse("message is required", 400));
  if (message.length > 4000) return next(new ErrorResponse("message must be 4000 characters or fewer", 400));

  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!alert) return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));

  alert.activity.push({
    type: "note",
    title: req.body?.title ? String(req.body.title).trim().slice(0, 200) : "Analyst note",
    message,
    createdBy: req.user._id,
  });
  await alert.save();

  logEvent({
    req,
    service: "alert",
    action: "alert_note_added",
    alert: alert._id,
    customer: alert.customer || undefined,
    afterValue: { length: message.length },
  });

  const note = alert.activity[alert.activity.length - 1];
  res.status(201).json({ succeed: true, data: { ...note.toObject(), createdBy: { _id: req.user._id, name: req.user.name } } });
});

// @desc   Audit trail for one alert (AuditLog collection, newest first)
// @route  GET /api/v1/alert/:id/audit
// @access Private (ALERT.GET)
exports.getAlertAudit = asyncHandler(async (req, res, next) => {
  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).select("_id").lean();
  if (!alert) return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));

  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const logs = await AuditLog.find({ alert: alert._id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("user", "name email")
    .populate("actor", "name email")
    .populate("case", "uid title")
    .lean();

  res.status(200).json({ succeed: true, count: logs.length, data: logs });
});

// @desc   Other transactions of the alert's customer (any party role), newest first
// @route  GET /api/v1/alert/:id/related-transactions?days=90&limit=20
// @access Private (ALERT.GET)
exports.getRelatedTransactions = asyncHandler(async (req, res, next) => {
  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select("customer transaction client")
    .lean();
  if (!alert) return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));
  if (!alert.customer) return res.status(200).json({ succeed: true, count: 0, total: 0, data: [] });

  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 90));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const since = new Date(Date.now() - days * 86400e3);

  const filter = {
    _id: { $ne: alert.transaction || null },
    timestamp: { $gte: since },
    $or: ["sender", "receiver", "beneficiary", "intermediary"].map((p) => ({ [`${p}.customer`]: alert.customer })),
  };
  if (alert.client) filter.client = alert.client;

  const [total, data] = await Promise.all([
    Transaction.countDocuments(filter),
    Transaction.find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .select("uid amount currency convertedAmountAUD type subtype channel status timestamp riskScore riskFlags sender receiver beneficiary investigation")
      .lean({ autopopulate: false }),
  ]);

  res.status(200).json({ succeed: true, count: data.length, total, days, data });
});

// @desc   Compliance reports raised from this alert — by alert ref, by the
//         legacy caseNumber = alert.uid key (ECDD / SMR), and via the linked case.
// @route  GET /api/v1/alert/:id/reports
// @access Private (ALERT.GET)
exports.getAlertReports = asyncHandler(async (req, res, next) => {
  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select("uid linkedCase")
    .lean();
  if (!alert) return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));

  // Lazy requires keep this controller's import list honest for the common paths
  const EcddReport = require("../models/EcddReport");
  const SMR = require("../models/SmrReport");
  const TTR = require("../models/TtrReport");
  const IFTI = require("../models/IftiReport");
  const GFS = require("../models/gfsReport");
  const RFI = require("../models/Rfi");
  const AlertDismissal = require("../models/AlertDismissal");

  const caseId = alert.linkedCase || null;
  // ECDD / SMR key on caseId + caseNumber; TTR / IFTI / GFS / RFI key on case.
  const byCaseId = [{ alert: alert._id }, { caseNumber: alert.uid }];
  const byCase = [{ alert: alert._id }];
  if (caseId) { byCaseId.push({ caseId }); byCase.push({ case: caseId }); }

  const [ecdd, smr, ttr, ifti, gfs, rfi, dismissal] = await Promise.all([
    EcddReport.find({ $or: byCaseId }).select("uid status createdAt updatedAt customerName fullName caseNumber alert caseId").sort({ createdAt: -1 }).lean(),
    SMR.find({ $or: byCaseId }).select("uid status createdAt updatedAt caseNumber alert caseId metadata.austracReference").sort({ createdAt: -1 }).lean(),
    TTR.find({ $or: byCase }).select("uid status createdAt updatedAt referenceNumber completionDate alert case").sort({ createdAt: -1 }).lean(),
    IFTI.find({ $or: byCase }).select("uid status createdAt updatedAt alert case").sort({ createdAt: -1 }).lean(),
    GFS.find({ $or: byCase }).select("uid status createdAt updatedAt customerName customerUID alert case").sort({ createdAt: -1 }).lean(),
    RFI.find({ $or: byCase }).select("uid status createdAt updatedAt primaryContactName responseDeadline sentAt alert case").sort({ createdAt: -1 }).lean(),
    // A dismissal always belongs to one alert, so it is never matched by case.
    AlertDismissal.find({ alert: alert._id }).select("uid status createdAt updatedAt title dismissalType requiresEscalation alert case").sort({ createdAt: -1 }).lean(),
  ]);

  const counts = { ecdd: ecdd.length, smr: smr.length, ttr: ttr.length, ifti: ifti.length, gfs: gfs.length, rfi: rfi.length, dismissal: dismissal.length };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  // Same derivation as the case endpoint: a SAR is filed iff an approved SMR exists
  const sarFiled = smr.some((s) => String(s.status).toLowerCase() === "approved");

  res.status(200).json({
    succeed: true,
    data: { ecdd, smr, ttr, ifti, gfs, rfi, dismissal },
    summary: { counts, total, sarFiled, linkedCase: caseId },
  });
});

// @desc   The AI transaction-monitoring result behind this alert, or data: null
//         for alerts the AFC monitoring service didn't raise (rule/manual).
// @route  GET /api/v1/alert/:id/monitoring-result
// @access Private (ALERT.GET)
exports.getAlertMonitoringResult = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Alert']
    #swagger.summary = 'AI transaction-monitoring result for an alert'
  */
  // Same join getAlert embeds: the Alert.monitoringResult virtual.
  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select("transaction")
    .populate("monitoringResult")
    .lean();
  if (!alert) return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));

  res.status(200).json({ succeed: true, data: alert.monitoringResult ?? null });
});

// @desc   ECCD Dummy Data for Presentation
// @route  GET /api/v1/alerts/:caseNumber/eccd-dummy
// @access Private
exports.getDummyEccdData = asyncHandler(async (req, res, next) => {
  const { caseNumber } = req.params;

  const alert = await Alert.findOne({ uid: caseNumber, isDeleted: { $ne: true } });
  if (!alert) {
    return next(new ErrorResponse(`Alert not found with Case Number ${caseNumber}`, 404));
  }

  // Only ever this alert's own stored ECDD.
  //
  // This used to fall back to `$sample`-ing a RANDOM other alert's ECDD payload
  // — returning it AND saving it onto this alert — so one customer's
  // due-diligence narrative could be written into another's record and filed
  // from there (docs/74 C16). Nothing legitimate can come from that, so the
  // fallback and its write-back are gone: an alert with no ECDD says so.
  //
  // To draft a real ECDD from the case's own facts, use
  // POST /cases/:id/reports/ecdd/draft (docs/74 §6.3).
  const eccdData = alert.metadata?.ecddReport || null;

  if (!eccdData) {
    return res.status(200).json({
      succeed: false,
      data: null,
      message: `No ECDD data stored on alert ${alert.uid}. Draft one from its case instead.`,
    });
  }

  res.status(200).json({
    succeed: true,
    data: eccdData,
    message: `ECDD returned from alert ${alert.uid}`,
  });
});

// @desc   Mark alert as under review (analyst picks it up)
// @route  PUT /api/v1/alerts/:id/review
// @access Private
exports.reviewAlert = asyncHandler(async (req, res, next) => {
  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));
  }

  if (alert.status !== "new") {
    return next(new ErrorResponse(`Alert is already in status "${alert.status}"`, 400));
  }

  alert.status = "under_review";
  if (!alert.analyst) alert.analyst = req.user._id;
  alert.activity.push({
    type: "activity",
    title: "Review started",
    message: `Picked up for review by ${req.user.name || req.user._id}`,
    createdBy: req.user._id,
  });
  await alert.save();

  logEvent({
    req,
    service: "alert",
    action: "alert_review_started",
    alert: alert._id,
    customer: alert.customer || undefined,
    afterValue: { analyst: alert.analyst },
  });

  res.status(200).json({ succeed: true, data: alert });
});

// @desc   Dismiss an alert
// @route  PUT /api/v1/alerts/:id/dismiss
// @access Private
exports.dismissAlert = asyncHandler(async (req, res, next) => {
  const { reason = "false_positive", note } = req.body;
  const validDismissals = ["dismissed", "false_positive"];

  if (!validDismissals.includes(reason)) {
    return next(new ErrorResponse(`reason must be one of: ${validDismissals.join(", ")}`, 400));
  }

  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));
  }

  if (alert.status === "escalated_to_case") {
    return next(new ErrorResponse("Cannot dismiss an alert that has been escalated to a case", 400));
  }

  const previousStatus = alert.status;
  alert.status = reason;
  alert.closedAt = new Date();
  if (note) alert.statusReason = note;
  if (!alert.analyst) alert.analyst = req.user._id;
  alert.activity.push({
    type: "activity",
    title: reason === "false_positive" ? "Marked false positive" : "Dismissed",
    message: `By ${req.user.name || req.user._id}${note ? `. Note: ${note}` : ""}`,
    createdBy: req.user._id,
  });
  await alert.save();

  logEvent({
    req,
    service: "alert",
    action: "alert_dismissed",
    alert: alert._id,
    customer: alert.customer || undefined,
    beforeValue: { status: previousStatus },
    afterValue: { status: alert.status, reason, note: note || undefined },
  });

  res.status(200).json({ succeed: true, data: alert });
});

// @desc   Escalate an alert to a new investigation case
// @route  POST /api/v1/alerts/:id/escalate
// @access Private — admin / compliance_officer
exports.escalateAlertToCase = asyncHandler(async (req, res, next) => {
  const tenant = {
    client: req?.user?.client?._id || null,
    branch: req?.user?.branch?._id || null,
  };

  const alertFilter = { _id: req.params.id, isDeleted: { $ne: true } };
  if (tenant.client) alertFilter.client = tenant.client;

  const alert = await Alert.findOne(alertFilter)
    .populate("customer", "name email")
    .populate("transaction", "uid amount type");

  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));
  }

  if (alert.linkedCase) {
    return next(
      new ErrorResponse(`Alert ${alert.uid} is already linked to case ${alert.linkedCase}`, 400)
    );
  }

  // A case belongs to the tenant whose alert raised it — not to whoever
  // happened to press escalate. Taking this from `req.user` meant a dooit admin
  // (who has no client of their own) escalating a client's alert created a
  // client-less case, invisible to that client's own case list (docs/74 C15).
  const caseTenant = {
    client: alert.client || tenant.client || null,
    branch: alert.branch || tenant.branch || null,
  };

  const {
    caseId,            // attach to this case explicitly
    attach,            // 'auto' → attach to the customer's newest open case, else create
    title = `Investigation — ${alert.uid}`,
    description,
    priority = mapRiskToPriority(alert.riskLabel),
    type = mapAlertTypeToCase(alert.caseType),
    assignedTo,
  } = req.body;

  // ── 1. Attach to an existing case? ──────────────────────────────────────────
  // Same customer (POI), same tenant, not closed. docs/74 §6.1 "escalate-or-attach".
  let targetCase = null;
  if (caseId) {
    const caseFilter = { _id: caseId, isDeleted: { $ne: true } };
    if (tenant.client) caseFilter.client = tenant.client;
    targetCase = await Case.findOne(caseFilter);
    if (!targetCase) {
      return next(new ErrorResponse(`Case not found with id ${caseId}`, 404));
    }
    if (targetCase.status === "closed") {
      return next(new ErrorResponse(`Case ${targetCase.uid} is closed — reopen it before attaching alerts`, 400));
    }
  } else if (attach === "auto") {
    // Search the alert's own tenant, so an admin attaches to the right
    // client's open case rather than to nothing.
    targetCase = await findAttachableCase({ customerId: alert.customer?._id, tenant: caseTenant });
  }
  const attached = !!targetCase;

  // ── 2. Otherwise create the case (links are added in step 3) ───────────────
  if (!targetCase) {
    targetCase = await Case.create({
      ...caseTenant,
      title,
      description,
      priority,
      type,
      caseType: sanitizeCaseType(alert.caseType),
      assignedTo: assignedTo || null,
      createdBy: req.user._id,
    });

    await AuditLog.create({
      ...caseTenant,
      case: targetCase._id,
      user: req.user._id,
      action: "case_created",
      details: `Case created by escalating alert ${alert.uid} (${alert.riskLabel || ""} ${alert.caseType || ""})`,
      ...auditContext(req),
    });
  }

  // ── 3. Link the alert: pulls its customer, transaction and the transaction's
  //       party customers onto the case, re-derives risk, syncs the alert. ───
  await attachAlertsToCase(targetCase, [alert.toObject()], {
    user: req.user,
    req,
    activityTitle: attached ? "Attached to case" : "Escalated to case",
  });

  logEvent({
    req,
    service: "alert",
    action: attached ? "alert_attached_to_case" : "alert_escalated",
    alert: alert._id,
    case: targetCase._id,
    customer: alert.customer?._id || undefined,
    target: alert.uid,
  });

  const populated = await populateCase(Case.findById(targetCase._id)).lean();
  res.status(attached ? 200 : 201).json({ succeed: true, attached, data: populated });
});

// @desc   Open cases of this alert's customer that the alert could be attached to
//         (feeds the "Attach to CA-… / Create new case" choice in the escalate dialog)
// @route  GET /api/v1/alert/:id/attachable-cases
// @access Private (ALERT.GET)
exports.getAttachableCases = asyncHandler(async (req, res, next) => {
  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select("customer client")
    .lean();
  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));
  }

  const tenant = {
    client: req?.user?.client?._id || null,
    branch: req?.user?.branch?._id || null,
  };
  const data = alert.customer ? await listAttachableCases({ customerId: alert.customer, tenant }) : [];

  res.status(200).json({ succeed: true, count: data.length, data });
});
