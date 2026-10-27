const mongoose = require('mongoose');
const asyncHandler = require('../middleware/async');
const ErrorResponse = require('../utils/errorResponse');
const Case = require('../models/Case');
const CaseNote = require('../models/CaseNote');
const AuditLog = require('../models/AuditLog');
const Alert = require('../models/Alert');
const User = require('../models/User');
const Staff = require('../models/Staff');
const EcddReport = require('../models/EcddReport');
const SMR = require('../models/SmrReport');
const TTR = require('../models/TtrReport');
const IFTI = require('../models/IftiReport');
const GFS = require('../models/gfsReport');
const RFI = require('../models/Rfi');
const Customer = require('../models/Customer');
const { linkTransactionsToCase } = require('../utils/transactionCaseLink');
const { auditContext } = require('../utils/auditContext');
const { customerRelatedToTenant } = require('../utils/customerTenantGuard');
// Alert / customer linkage rules + the shared populate live in one service
// (docs/74 §6.1) so escalate, link and create all behave the same way.
const {
  populateCase,
  partyCustomersOf,
  deriveCaseRisk,
  attachAlertsToCase,
  detachAlertFromCase,
  addCustomersToCase,
  removeCustomerFromCase,
  addExternalPoi,
  updateExternalPoi,
  removeExternalPoi,
  listAlertPoiCandidates,
} = require('../services/caseLinking');
const { searchCustomers } = require('../utils/customerSearch');
const { analyseCase } = require('../services/caseAnalysis');
const {
  draftReport,
  saveReportEdits,
  suggestNarrative,
  SUPPORTED_TYPES,
  EDITABLE_FIELDS,
} = require('../services/reportDrafts');
const { resolveCaseLinkage } = require('../utils/resolveCaseLinkage');
const { isValidDismissalType, DISMISSAL_CODES } = require('../utils/dismissalTypes');
const AlertDismissal = require('../models/AlertDismissal');
const CaseInvestigation = require('../models/CaseInvestigation');
const { logEvent } = require('../utils/audit');

// How long a cached analysis snapshot stays usable. The cache is also dropped
// whenever the case itself changes (links, status) — this only bounds staleness
// caused by NEW transactions arriving for a POI.
const ANALYSIS_CACHE_TTL_MS = 15 * 60 * 1000;

// ── Status machine ────────────────────────────────────────────────────────────
const STATUS_TRANSITIONS = {
  open: ['under_investigation'],
  under_investigation: ['pending_review'],
  pending_review: ['closed', 'escalated'],
  closed: [],
  escalated: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const getTenant = (req) => ({
  client: req?.user?.client?._id || req?.user?.clientBelongs || null,
  branch: req?.user?.branch?._id || req?.user?.branchBelongs || null,
});

const logAudit = (caseId, userId, action, details, tenant, req) =>
  AuditLog.create({
    case: caseId,
    user: userId,
    action,
    details,
    ...tenant,
    ...auditContext(req),
  });

// Returns an ErrorResponse if access is denied, null if allowed.
const checkCaseAccess = (caseDoc, req, { requireAssignment = false } = {}) => {
  const tenant = getTenant(req);
  if (tenant.client && caseDoc.client && caseDoc.client.toString() !== tenant.client.toString()) {
    return new ErrorResponse('Case not in your tenant', 403);
  }
  if (req.user.role === 'investigator') {
    const assignedId = caseDoc.assignedTo?._id || caseDoc.assignedTo;
    const isAssigned = assignedId && assignedId.toString() === req.user._id.toString();
    if (!isAssigned) {
      return new ErrorResponse(
        requireAssignment ? 'You must be assigned to this case' : 'Case not assigned to you',
        403
      );
    }
  }
  return null;
};

// Maps Alert.caseType → Case.type enum
const mapAlertTypeToCase = (caseType) => {
  const t = (caseType || '').toLowerCase().replace(/\s+/g, '_');
  if (t === 'sar') return 'SAR';
  if (t === 'pep') return 'PEP';
  if (t === 'transaction_monitoring') return 'transaction_monitoring';
  return 'other';
};

// Σ linked-transaction value in AUD (converted where available, else raw amount).
const sumNetActivity = (txns) =>
  (txns || []).reduce((s, t) => s + (t.convertedAmountAUD || t.amount || 0), 0);

// ── GET /cases ────────────────────────────────────────────────────────────────
exports.getCases = asyncHandler(async (req, res, next) => {
  const tenant = getTenant(req);

  const {
    status,
    priority,
    type,
    caseType,
    assignedTo,
    decision,
    startDate,
    endDate,
    search,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    page = 1,
    limit = 10,
  } = req.query;

  const filter = { isDeleted: { $ne: true }, ...tenant };
  Object.keys(filter).forEach((k) => filter[k] == null && delete filter[k]);
  filter.isDeleted = { $ne: true };

  if (req.user.role === 'investigator') {
    filter.assignedTo = req.user._id;
  } else if (assignedTo) {
    filter.assignedTo = assignedTo;
  }

  if (status)   filter.status = status;
  if (priority) filter.priority = priority;
  if (type)     filter.type = type;
  if (caseType) filter.caseType = caseType;
  if (decision) filter.decision = decision;
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate)   filter.createdAt.$lte = new Date(endDate);
  }
  if (search) filter.$text = { $search: search };

  const allowedSortFields = ['createdAt', 'updatedAt', 'priority', 'status', 'title', 'riskScore'];
  const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';
  const sortDir   = sortOrder === 'asc' ? 1 : -1;

  const pageNum  = Math.max(1, Number(page));
  const limitNum = Math.min(Math.max(1, Number(limit)), 100);
  const skip     = (pageNum - 1) * limitNum;

  const [cases, total] = await Promise.all([
    populateCase(
      Case.find(filter).sort({ [sortField]: sortDir }).skip(skip).limit(limitNum)
    ).lean(),
    Case.countDocuments(filter),
  ]);

  // ── Enrich rows for the case-list UI (net activity, counts, filing status) ──
  if (cases.length) {
    const caseIds = cases.map((c) => c._id);
    const [noteCounts, filedIds] = await Promise.all([
      CaseNote.aggregate([
        { $match: { case: { $in: caseIds } } },
        { $group: { _id: '$case', n: { $sum: 1 } } },
      ]),
      SMR.find({ caseId: { $in: caseIds }, status: 'approved' }).distinct('caseId'),
    ]);
    const noteMap  = new Map(noteCounts.map((n) => [String(n._id), n.n]));
    const filedSet = new Set(filedIds.map(String));
    cases.forEach((c) => {
      c.netActivity  = sumNetActivity(c.linkedTransactions);
      c.alertCount   = (c.linkedAlerts || []).length;
      c.commentCount = noteMap.get(String(c._id)) || 0;
      c.sarFiled     = c.decision === 'sar_filed' || filedSet.has(String(c._id));
    });
  }

  res.status(200).json({
    succeed: true,
    data: cases,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum),
    },
  });
});

// ── GET /cases/:id ────────────────────────────────────────────────────────────
exports.getCaseById = asyncHandler(async (req, res, next) => {
  const caseDoc = await populateCase(
    Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
  ).lean();

  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  // Related cases: other cases sharing a customer with this one (tenant-scoped).
  // Runs alongside the approved-SMR check — neither depends on the other.
  const custIds = (caseDoc.linkedCustomers || []).map((c) => (c && c._id) || c).filter(Boolean);
  const [related, approvedSmr] = await Promise.all([
    custIds.length
      ? Case.find({
          _id: { $ne: caseDoc._id },
          isDeleted: { $ne: true },
          linkedCustomers: { $in: custIds },
          ...(caseDoc.client ? { client: caseDoc.client } : {}),
        })
          .select('uid caseType type status')
          .limit(10)
          .lean()
      : [],
    caseDoc.decision === 'sar_filed'
      ? true
      : SMR.exists({ caseId: caseDoc._id, status: 'approved' }),
  ]);
  const relatedCases = related.map((c) => ({
    _id: c._id,
    caseId: c.uid,
    caseType: c.caseType || c.type || '—',
    status: c.status,
  }));

  // Derived header stats (kept API-side so the UI never recomputes business rules).
  const netActivity = sumNetActivity(caseDoc.linkedTransactions);
  const sarFiled = !!approvedSmr;

  // Regulatory filings (ECDD/SMR/TTR/IFTI/GFS/RFI) are served by
  // GET /cases/:id/reports — this endpoint stays the case document only.
  res.status(200).json({
    succeed: true,
    data: { ...caseDoc, relatedCases, netActivity, sarFiled },
  });
});

// ── GET /cases/:id/export-pdf ────────────────────────────────────────────────
// The printable Case Summary. Built from the same lean populated case the
// detail endpoint serves, so the PDF can never show a role more than the
// screen does (masked POI fields print as "***"). ?disposition=inline opens
// it in the browser's viewer (the Print action); default is a download.
exports.exportCasePdf = asyncHandler(async (req, res, next) => {
  const { launchPdfBrowser } = require('../utils/puppeteerLaunch');
  const { buildCaseSummaryHtml } = require('../services/caseSummaryDocument');

  const caseDoc = await populateCase(
    Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
  ).lean();
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const html = buildCaseSummaryHtml(caseDoc, {
    netActivity: sumNetActivity(caseDoc.linkedTransactions),
    generatedBy: req.user?.name || '',
  });

  let browser;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%; font-size:7px; color:#8a8a8a; padding:0 13mm;' +
        'font-family: Helvetica, Arial, sans-serif; display:flex; justify-content:space-between;">' +
        '<span>Case ' +
        String(caseDoc.uid || caseDoc._id).replace(/[<>&"']/g, '') +
        '</span>' +
        '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>' +
        '</div>',
      margin: { top: '16mm', bottom: '18mm', left: '13mm', right: '13mm' },
    });

    const safeName = String(caseDoc.uid || caseDoc._id).replace(/[^A-Za-z0-9._-]/g, '_');
    const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="CASE_${safeName}.pdf"`);
    res.send(Buffer.from(pdfBuffer));
  } finally {
    if (browser) await browser.close();
  }
});

// ── POST /cases/:id/duplicate ────────────────────────────────────────────────
// A fresh investigation over the same facts: copies the classification, the
// customer POIs and the linked transactions. Deliberately NOT copied — alerts
// (an alert belongs to exactly one case), reports, notes, the audit trail,
// investigation progress, and external POIs (their PII is encrypted per
// record; a new case starts its own list).
exports.duplicateCase = asyncHandler(async (req, res, next) => {
  const source = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).lean();
  if (!source) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(source, req);
  if (accessErr) return next(accessErr);

  const copy = await Case.create({
    title: `${source.title} (copy)`,
    description: source.description,
    type: source.type,
    caseType: source.caseType,
    priority: source.priority,
    riskScore: source.riskScore,
    riskLabel: source.riskLabel,
    tags: source.tags,
    client: source.client,
    branch: source.branch,
    customer: source.customer,
    linkedCustomers: source.linkedCustomers,
    linkedTransactions: source.linkedTransactions,
    status: 'open',
    createdBy: req.user._id,
  });

  const tenant = { client: copy.client || null, branch: copy.branch || null };
  await Promise.all([
    logAudit(
      copy._id,
      req.user._id,
      'duplicated',
      `Created as a duplicate of ${source.uid || source._id}`,
      tenant,
      req
    ),
    logAudit(
      source._id,
      req.user._id,
      'duplicated',
      `Duplicated to new case ${copy.uid}`,
      tenant,
      req
    ),
  ]);

  const populated = await populateCase(Case.findById(copy._id)).lean();
  res.status(201).json({ succeed: true, data: populated });
});

// ── POST /cases ───────────────────────────────────────────────────────────────
exports.createCase = asyncHandler(async (req, res, next) => {
  const tenant = getTenant(req);
  const {
    title,
    description,
    priority,
    type,
    caseType,
    tags,
    alertIds,
    linkedCustomers,
    linkedTransactions,
    assignedTo,
  } = req.body;

  // ── Resolve alerts (tenant-scoped) ───────────────────────────────────────────
  let resolvedAlerts = [];
  if (alertIds && alertIds.length > 0) {
    const alertFilter = { _id: { $in: alertIds }, isDeleted: { $ne: true } };
    if (tenant.client) alertFilter.client = tenant.client;
    resolvedAlerts = await Alert.find(alertFilter).lean();

    if (resolvedAlerts.length !== alertIds.length) {
      return next(new ErrorResponse('One or more alertIds not found in your tenant', 404));
    }
    const alreadyLinked = resolvedAlerts.filter((a) => a.linkedCase);
    if (alreadyLinked.length > 0) {
      return next(
        new ErrorResponse(
          `Alert(s) [${alreadyLinked.map((a) => a.uid).join(', ')}] are already linked to a case`,
          400
        )
      );
    }
  }

  const firstAlert       = resolvedAlerts[0];
  // Risk comes from the linked alerts: the top-scoring alert wins (docs/74 C10).
  const derivedRisk      = deriveCaseRisk(resolvedAlerts);
  const derivedPriority  = priority  || derivedRisk?.priority || 'medium';
  const derivedType      = type      || (firstAlert ? mapAlertTypeToCase(firstAlert.caseType) : 'other');
  const derivedCaseType  = caseType  || derivedRisk?.caseType || null;

  // ── Derive linked entities from alerts ───────────────────────────────────────
  const alertCustomers    = resolvedAlerts.map((a) => a.customer).filter(Boolean);
  const alertTransactions = resolvedAlerts.map((a) => a.transaction).filter(Boolean);

  const mergedTransactions = [...new Set([...(linkedTransactions || []), ...alertTransactions.map(String)])];
  // Customers that are parties on those transactions are POIs too (doc 66 G13).
  // Only this tenant's customers — the counterparty may bank with someone else.
  const partyCustomers     = await partyCustomersOf(mergedTransactions, {
    clientId: firstAlert?.client || tenant.client || null,
  });
  const mergedCustomers    = [
    ...new Set([...(linkedCustomers || []), ...alertCustomers.map(String), ...partyCustomers]),
  ];

  // ── Validate assignedTo is an investigator ───────────────────────────────────
  if (assignedTo) {
    const analyst = await User.findOne({ _id: assignedTo, role: 'investigator' }).select('_id').lean();
    if (!analyst) {
      return next(new ErrorResponse('assignedTo must be a valid investigator', 400));
    }
  }

  const newCase = await Case.create({
    // The alerts' own tenant wins over the caller's: an admin creating a case
    // from a client's alerts must not produce a client-less case (docs/74 C15).
    client: firstAlert?.client || tenant.client || null,
    branch: firstAlert?.branch || tenant.branch || null,
    title,
    description,
    priority: derivedPriority,
    type: derivedType,
    caseType: derivedCaseType,
    tags: tags || [],
    linkedAlerts: alertIds || [],
    // Primary customer (POI) is derived, not client-supplied: the first
    // alert's customer when the case comes from alerts, else the first
    // linked customer.
    customer: alertCustomers[0] || mergedCustomers[0] || null,
    linkedCustomers: mergedCustomers,
    linkedTransactions: mergedTransactions,
    riskScore: derivedRisk?.riskScore ?? null,
    riskLabel: derivedRisk?.riskLabel ?? null,
    assignedTo: assignedTo || null,
    createdBy: req.user._id,
  });

  // ── Sync Transaction ↔ Case (investigation.case + flagged) ──────────────────
  if (mergedTransactions.length > 0) {
    await linkTransactionsToCase(mergedTransactions, newCase);
  }

  // ── Mark linked alerts as escalated ─────────────────────────────────────────
  if (alertIds && alertIds.length > 0) {
    await Alert.updateMany(
      { _id: { $in: alertIds } },
      {
        $set: { status: 'escalated_to_case', linkedCase: newCase._id },
        $push: {
          activity: {
            type: 'activity',
            title: 'Escalated to case',
            message: `Linked to case "${title}" by ${req.user.name || req.user._id}`,
            createdBy: req.user._id,
          },
        },
      }
    );
  }

  // ── Audit ────────────────────────────────────────────────────────────────────
  const auditPromises = [
    logAudit(
      newCase._id, req.user._id, 'case_created',
      `Case "${title}" created with type "${derivedType}" and priority "${derivedPriority}"`, tenant, req),
  ];
  if (alertIds && alertIds.length > 0) {
    auditPromises.push(
      logAudit(
        newCase._id, req.user._id, 'alert_linked',
        `${alertIds.length} alert(s) linked on creation: [${resolvedAlerts.map((a) => a.uid).join(', ')}]`,
        tenant, req
      )
    );
  }
  if (assignedTo) {
    auditPromises.push(
      logAudit(newCase._id, req.user._id, 'assignment', `Investigator assigned on creation: ${assignedTo}`, tenant, req)
    );
  }
  await Promise.all(auditPromises);

  const populated = await populateCase(Case.findById(newCase._id)).lean();
  res.status(201).json({ succeed: true, data: populated });
});

// ── PUT /cases/:id ────────────────────────────────────────────────────────────
exports.updateCase = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req, { requireAssignment: true });
  if (accessErr) return next(accessErr);

  const allowedFields = [
    'title', 'description', 'priority', 'type', 'caseType',
    'closureReason', 'tags', 'decision', 'decisionNotes', 'slaDeadline', 'metadata',
    'reviewer',
  ];
  const updates = {};
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  if (Object.keys(updates).length === 0) {
    return next(new ErrorResponse('No valid fields provided for update', 400));
  }

  // Compliance guard: decision 'sar_filed' must be backed by an approved SMR on
  // this case (the filing decision is derived from a real SMR, not free-set).
  if (updates.decision === 'sar_filed') {
    const hasApprovedSmr = await SMR.exists({ caseId: caseDoc._id, status: 'approved' });
    if (!hasApprovedSmr) {
      return next(new ErrorResponse(
        "Cannot set decision 'sar_filed': no approved SMR is linked to this case.",
        400
      ));
    }
  }

  // Record decision timestamp when decision is set
  if (updates.decision && !caseDoc.decidedAt) {
    updates.decidedAt = new Date();
    updates.decidedBy = req.user._id;
  }

  const updated = await populateCase(
    Case.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true })
  ).lean();

  const tenant = getTenant(req);
  await logAudit(
    req.params.id, req.user._id, 'field_update',
    `Fields updated: ${Object.keys(updates).join(', ')}`, tenant, req);

  res.status(200).json({ succeed: true, data: updated });
});

// ── PATCH /cases/:id/status ───────────────────────────────────────────────────
exports.updateCaseStatus = asyncHandler(async (req, res, next) => {
  const { status, closureReason } = req.body;

  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req, { requireAssignment: true });
  if (accessErr) return next(accessErr);

  if (req.user.role === 'investigator') {
    const investigatorAllowed = ['under_investigation', 'pending_review'];
    if (!investigatorAllowed.includes(status)) {
      return next(
        new ErrorResponse(`Investigators can only transition to: ${investigatorAllowed.join(', ')}`, 403)
      );
    }
  }

  const validTransitions = STATUS_TRANSITIONS[caseDoc.status] || [];
  if (!validTransitions.includes(status)) {
    return next(
      new ErrorResponse(
        `Invalid transition from "${caseDoc.status}" to "${status}". Allowed: [${validTransitions.join(', ') || 'none'}]`,
        400
      )
    );
  }

  const previousStatus = caseDoc.status;
  caseDoc.status = status;
  if (closureReason) caseDoc.closureReason = closureReason;
  await caseDoc.save();

  const tenant = getTenant(req);
  await logAudit(
    caseDoc._id, req.user._id, 'status_change',
    `Status: "${previousStatus}" → "${status}"${closureReason ? `. Reason: ${closureReason}` : ''}`, tenant, req);

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── PATCH /cases/:id/assign ───────────────────────────────────────────────────
// @desc   Assign or reassign the primary investigator
exports.assignInvestigators = asyncHandler(async (req, res, next) => {
  const { investigatorId } = req.body;

  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  if (investigatorId) {
    const { client: clientId } = getTenant(req);
    const staffMatch = await Staff.findOne({
      user: investigatorId,
      ...(clientId ? { client: clientId } : {}),
    }).select('_id').lean();
    if (!staffMatch) {
      return next(new ErrorResponse('investigatorId is not a staff member of this client', 400));
    }
  }

  const previousAssignee = caseDoc.assignedTo?.toString() || 'none';
  caseDoc.assignedTo = investigatorId || null;
  await caseDoc.save();

  const tenant = getTenant(req);
  await logAudit(
    caseDoc._id, req.user._id, 'assignment',
    `Investigator updated. Previous: ${previousAssignee}, New: ${investigatorId || 'none'}`, tenant, req);

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── PATCH /cases/:id/watchers ─────────────────────────────────────────────────
// @desc   Set watchers list for a case
exports.updateWatchers = asyncHandler(async (req, res, next) => {
  const { watcherIds = [] } = req.body;

  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  caseDoc.watchers = watcherIds;
  await caseDoc.save();

  const tenant = getTenant(req);
  await logAudit(
    caseDoc._id, req.user._id, 'watchers_updated',
    `Watchers set to [${watcherIds.join(', ') || 'none'}]`, tenant, req);

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── GET /cases/:id/alerts ─────────────────────────────────────────────────────
exports.getCaseAlerts = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({
    _id: req.params.id,
    isDeleted: { $ne: true },
  })
    .select('linkedAlerts client assignedTo')
    .lean();

  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const alerts = await Alert.find({
    _id: { $in: caseDoc.linkedAlerts },
    isDeleted: { $ne: true },
  })
    .populate('customer', 'name email')
    .populate('analyst', 'name email')
    .populate('transaction', 'uid amount type')
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({ succeed: true, data: alerts, count: alerts.length });
});

// ── GET /cases/:id/reports ──────────────────────────────────────────────────────
// Unified reverse view: every compliance report + RFI attached to this case.
// ECDD/SMR hang off `caseId`; TTR/IFTI/GFS/RFI off `case`.
exports.getCaseReports = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select('uid client assignedTo')
    .lean();

  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const id = caseDoc._id;
  const [ecdd, smr, ttr, ifti, gfs, rfi, dismissal] = await Promise.all([
    EcddReport.find({ caseId: id })
      .select('uid status createdAt customerName fullName caseNumber customer alert riskAssessment' +
        ' aiMeta.scope.mismatch aiMeta.error.code')
      .sort({ createdAt: -1 }).lean(),
    SMR.find({ caseId: id })
      .select('uid status createdAt caseNumber customer alert metadata.austracReference' +
        ' aiMeta.scope.mismatch aiMeta.error.code')
      .sort({ createdAt: -1 }).lean(),
    TTR.find({ case: id })
      .select('uid status createdAt referenceNumber completionDate customer alert')
      .sort({ createdAt: -1 }).lean(),
    IFTI.find({ case: id })
      .select('uid status createdAt customer alert')
      .sort({ createdAt: -1 }).lean(),
    GFS.find({ case: id })
      .select('uid status createdAt customerName customerUID customer alert' +
        ' aiMeta.scope.mismatch aiMeta.error.code')
      .sort({ createdAt: -1 }).lean(),
    RFI.find({ case: id })
      .select('uid status createdAt primaryContactName responseDeadline customer alert' +
        ' aiMeta.scope.mismatch aiMeta.error.code')
      .sort({ createdAt: -1 }).lean(),
    AlertDismissal.find({ case: id })
      .select('uid status createdAt title dismissalType requiresEscalation customer alert' +
        ' aiMeta.scope.mismatch aiMeta.error.code')
      .sort({ createdAt: -1 }).lean(),
  ]);

  const counts = {
    ecdd: ecdd.length, smr: smr.length, ttr: ttr.length,
    ifti: ifti.length, gfs: gfs.length, rfi: rfi.length,
    dismissal: dismissal.length,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  // Derived: a SAR is "filed" iff an approved SMR exists on this case.
  const sarFiled = smr.some((s) => s.status === 'approved');

  res.status(200).json({
    succeed: true,
    data: { ecdd, smr, ttr, ifti, gfs, rfi, dismissal },
    summary: { counts, total, sarFiled },
  });
});

// ── GET /cases/:id/analysis ─────────────────────────────────────────────────────
// The case's transaction analysis: every figure the ECDD / SMR / GFS / RFI
// drafts are built from, computed by us (docs/74 §6.2). Query params:
//   from, to  — analyse an ad-hoc window (never cached, never persisted)
//   refresh   — "true" recomputes even when a fresh snapshot exists
exports.getCaseAnalysis = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).lean();
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const { from, to, refresh } = req.query;
  const adHocWindow = !!(from || to);

  // Reuse the snapshot only when it is newer than the case (so any link or
  // status change invalidates it) and still inside the TTL.
  const cache = caseDoc.analysis || {};
  const computedAt = cache.computedAt ? new Date(cache.computedAt) : null;
  const isFresh =
    computedAt &&
    cache.snapshot &&
    computedAt >= new Date(caseDoc.updatedAt) &&
    Date.now() - computedAt.getTime() < ANALYSIS_CACHE_TTL_MS;

  if (!adHocWindow && refresh !== 'true' && isFresh) {
    return res.status(200).json({ succeed: true, cached: true, data: cache.snapshot });
  }

  const analysis = await analyseCase(caseDoc, { from, to });

  // An ad-hoc window is one analyst's question, not the case's own view.
  if (!adHocWindow) {
    await Case.updateOne(
      { _id: caseDoc._id },
      { $set: { 'analysis.computedAt': analysis.computedAt, 'analysis.snapshot': analysis } },
      // Caching must not bump updatedAt — that would invalidate what we just wrote.
      { timestamps: false }
    );
  }

  res.status(200).json({ succeed: true, cached: false, data: analysis });
});

// ── PATCH /cases/:id/review-window ──────────────────────────────────────────────
// Pin the period the analysis (and every report drafted from it) covers.
// Sending an empty body clears it back to the derived default.
exports.updateReviewWindow = asyncHandler(async (req, res, next) => {
  const { start, end } = req.body;

  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  caseDoc.reviewWindow = {
    start: start ? new Date(start) : null,
    end: end ? new Date(end) : null,
    source: start || end ? 'analyst' : 'default',
  };
  await caseDoc.save();

  await logAudit(
    caseDoc._id, req.user._id, 'review_window_updated',
    start || end
      ? `Review window set to ${start || '—'} → ${end || 'now'}`
      : 'Review window reset to the derived default',
    getTenant(req), req);

  // Recompute immediately so the caller gets the numbers for the new window.
  const analysis = await analyseCase(caseDoc.toObject(), {});
  await Case.updateOne(
    { _id: caseDoc._id },
    { $set: { 'analysis.computedAt': analysis.computedAt, 'analysis.snapshot': analysis } },
    { timestamps: false }
  );

  res.status(200).json({ succeed: true, data: analysis });
});

// ── GET /cases/:id/investigation ────────────────────────────────────────────────
// The analyst's progress through the Investigation Hub. Returns `null` when the
// case has never been worked on, so the UI seeds its own empty defaults rather
// than this endpoint inventing a shape it does not own (docs/74 C18).
exports.getCaseInvestigation = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select('uid client assignedTo')
    .lean();
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const investigation = await CaseInvestigation.findOne({ case: caseDoc._id })
    .populate('lastSavedBy', 'name email')
    .lean();

  res.status(200).json({ succeed: true, data: investigation || null });
});

// ── PUT /cases/:id/investigation ────────────────────────────────────────────────
// Save progress. Called by autosave as the analyst works, so it merges the keys
// it is given rather than replacing the record — a tab that only knows about the
// SMR part must not blank out the narrative.
//
// Deliberately NOT audited on every call: autosave would bury the case's audit
// trail. The first save is recorded (the investigation opened), and every save
// stamps `lastSavedBy` + `updatedAt`, which is what an auditor needs to see who
// was working and when.
exports.saveCaseInvestigation = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select('uid client branch assignedTo')
    .lean();
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  // Only the analyst's own work is writable — never the linkage or attribution.
  const WRITABLE = [
    'activeStep', 'stepsDone', 'checklist', 'selections', 'pois',
    'customTypologies', 'customReasons', 'dateRange',
    'narrativeTemplate', 'narrative', 'smr',
    'decision', 'managerReview', 'ongoingMonitoring',
  ];

  const update = { lastSavedBy: req.user._id };
  for (const key of WRITABLE) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }

  const existing = await CaseInvestigation.findOne({ case: caseDoc._id }).select('_id').lean();

  const investigation = await CaseInvestigation.findOneAndUpdate(
    { case: caseDoc._id },
    {
      $set: update,
      $setOnInsert: {
        case: caseDoc._id,
        client: caseDoc.client || null,
        branch: caseDoc.branch || null,
        createdBy: req.user._id,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();

  if (!existing) {
    await logAudit(
      caseDoc._id, req.user._id, 'investigation_started',
      'Investigation Hub opened and progress saved for the first time', getTenant(req), req);
  }

  res.status(existing ? 200 : 201).json({ succeed: true, created: !existing, data: investigation });
});

// ── POST /cases/:id/reports/:type/draft ─────────────────────────────────────────
// Draft an ECDD / SMR / GFS / RFI for this case: every figure and identity from
// our own models via services/caseAnalysis, the prose from the AI service's
// narrative whitelist (docs/74 §6.3). The draft is saved even if the AI is
// unavailable — `aiMeta.error` then records why the narrative is empty.
//
// Body: { alertId?, regenerate? }. Without `regenerate` an existing draft is
// returned untouched, so the endpoint is safe to call twice.
exports.draftCaseReport = asyncHandler(async (req, res, next) => {
  const type = String(req.params.type || '').toLowerCase();
  if (!SUPPORTED_TYPES.includes(type)) {
    return next(
      new ErrorResponse(`type must be one of: ${SUPPORTED_TYPES.join(', ')}`, 400)
    );
  }

  // The report forms hold whatever reference they were opened with — a Case id
  // or uid, or the originating Alert's id or uid — so resolve all four through
  // the shared helper rather than making every caller find the Case first.
  let caseDoc = mongoose.isValidObjectId(req.params.id)
    ? await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).lean()
    : null;

  if (!caseDoc) {
    const link = await resolveCaseLinkage({ caseId: req.params.id, caseNumber: req.params.id });
    if (link.caseId) {
      caseDoc = await Case.findOne({ _id: link.caseId, isDeleted: { $ne: true } }).lean();
    }
  }

  if (!caseDoc) {
    return next(
      new ErrorResponse(
        `No case found for ${req.params.id}. An alert must be escalated to a case before a report can be drafted from it.`,
        404
      )
    );
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  // A report is about a person and their activity; without either there is
  // nothing to state.
  if (!caseDoc.customer && !(caseDoc.linkedCustomers || []).length) {
    return next(
      new ErrorResponse('This case has no customer (POI) to report on — link one first', 400)
    );
  }

  const { alertId, dismissalType, regenerate } = req.body || {};
  if (alertId && !(caseDoc.linkedAlerts || []).some((a) => String(a) === String(alertId))) {
    return next(new ErrorResponse('alertId is not linked to this case', 400));
  }

  // A dismissal closes one alert, so it cannot be drafted for a whole case.
  if (type === 'dismissal') {
    if (!alertId) {
      return next(new ErrorResponse('alertId is required to draft a dismissal', 400));
    }
    if (!isValidDismissalType(dismissalType)) {
      return next(
        new ErrorResponse(
          `dismissalType must be one of: generic, ${DISMISSAL_CODES.join(', ')}`,
          400
        )
      );
    }
  }

  const { report, created, regenerated } = await draftReport({
    caseDoc,
    type,
    alertId,
    dismissalType,
    regenerate: regenerate === true || regenerate === 'true',
    user: req.user,
  });

  if (created || regenerated) {
    const failure = report.aiMeta?.error?.code;
    // A narrative written from data outside this client is worth an audit line
    // of its own — it is the reason the draft needs a careful read (C15).
    const scopeMismatch = report.aiMeta?.scope?.mismatch;
    await logAudit(
      caseDoc._id, req.user._id, created ? 'report_drafted' : 'report_redrafted',
      `${type.toUpperCase()} ${report.uid || report._id} ${created ? 'drafted' : 're-drafted'}` +
        (failure ? ` (narrative unavailable: ${failure})` : '') +
        (scopeMismatch
          ? ` (summary service saw ${report.aiMeta.scope.theirTransactionCount} transaction(s) vs this client's ${report.aiMeta.scope.ourTransactionCount} — narrative may reach beyond this client)`
          : ''),
      getTenant(req), req);

    logEvent({
      req,
      service: 'report',
      action: created ? 'report_drafted' : 'report_redrafted',
      reportType: type.toUpperCase(),
      target: report.uid || String(report._id),
      case: caseDoc._id,
      customer: report.customer || undefined,
      afterValue: {
        sectionsUsed: report.aiMeta?.sectionsUsed || [],
        aiError: failure || null,
        client: report.aiMeta?.client || null,
        scopeMismatch: !!scopeMismatch,
      },
    });
  }

  res.status(created ? 201 : 200).json({ succeed: true, created, regenerated, data: report });
});

// Shared by the two narrative endpoints below: the case, access-checked, and
// a type that supports editing from the case.
const loadCaseForReportEdit = async (req, next) => {
  const type = String(req.params.type || '').toLowerCase();
  if (!EDITABLE_FIELDS[type]) {
    next(new ErrorResponse(`type must be one of: ${Object.keys(EDITABLE_FIELDS).join(', ')}`, 400));
    return null;
  }
  const caseDoc = mongoose.isValidObjectId(req.params.id)
    ? await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).lean()
    : null;
  if (!caseDoc) {
    next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
    return null;
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) {
    next(accessErr);
    return null;
  }
  return { caseDoc, type };
};

// One audit line per analyst per report per window, not per autosave.
const EDIT_AUDIT_WINDOW_MS = 15 * 60 * 1000;

// ── PATCH /cases/:id/reports/:type ────────────────────────────────────────────
// Save an analyst's edits to the case's draft (the Investigation Hub's
// narrative step autosaves through here). Only whitelisted fields; each one
// that changes joins `editedFields`, so a re-draft never overwrites it.
exports.saveCaseReportEdits = asyncHandler(async (req, res, next) => {
  const loaded = await loadCaseForReportEdit(req, next);
  if (!loaded) return;
  const { caseDoc, type } = loaded;

  const { report, changed } = await saveReportEdits({ caseDoc, type, patch: req.body || {} });

  if (changed.length) {
    const action = 'report_edited';
    const recent = await AuditLog.exists({
      case: caseDoc._id,
      user: req.user._id,
      action,
      details: new RegExp(`^${type.toUpperCase()} `),
      createdAt: { $gte: new Date(Date.now() - EDIT_AUDIT_WINDOW_MS) },
    });
    if (!recent) {
      await logAudit(
        caseDoc._id, req.user._id, action,
        `${type.toUpperCase()} ${report.uid || report._id} edited (${changed.join(', ')})`,
        getTenant(req), req
      );
    }
  }

  res.status(200).json({ succeed: true, changed, data: report });
});

// ── POST /cases/:id/reports/:type/suggest ─────────────────────────────────────
// Fresh AI prose for the case, returned and NOT saved — the analyst chooses
// what to take, so a suggestion can never overwrite their words.
exports.suggestCaseReportNarrative = asyncHandler(async (req, res, next) => {
  const loaded = await loadCaseForReportEdit(req, next);
  if (!loaded) return;
  const { caseDoc, type } = loaded;

  const { narrative, meta } = await suggestNarrative({ caseDoc, type, user: req.user });
  res.status(200).json({ succeed: true, data: { narrative, meta } });
});

// ── GET /cases/analytics ────────────────────────────────────────────────────────
// Tenant-scoped aggregates for the Case Manager dashboard (cards + charts).
exports.getCaseAnalytics = asyncHandler(async (req, res, next) => {
  const tenant = getTenant(req);
  const match = { isDeleted: { $ne: true } };
  if (tenant.client) {
    try { match.client = new mongoose.Types.ObjectId(String(tenant.client)); } catch (_) { /* ignore */ }
  }

  const now = new Date();
  const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const start8 = new Date(now.getFullYear(), now.getMonth() - 7, 1);

  // ms spent in review, only for closed cases (null otherwise → ignored by $avg)
  const closedReviewMs = {
    $cond: [
      { $and: [{ $eq: ['$status', 'closed'] }, { $ne: ['$closedAt', null] }] },
      { $subtract: ['$closedAt', '$createdAt'] },
      null,
    ],
  };

  const [agg = {}] = await Case.aggregate([
    { $match: match },
    {
      $facet: {
        summary: [
          { $group: {
              _id: null,
              total: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } },
              open: { $sum: { $cond: [{ $ne: ['$status', 'closed'] }, 1, 0] } },
              avgReviewMs: { $avg: closedReviewMs },
          }},
        ],
        createdThisMonth: [{ $match: { createdAt: { $gte: startThisMonth } } }, { $count: 'n' }],
        createdLastMonth: [{ $match: { createdAt: { $gte: startLastMonth, $lt: startThisMonth } } }, { $count: 'n' }],
        closedThisMonth: [{ $match: { closedAt: { $gte: startThisMonth } } }, { $count: 'n' }],
        closedLastMonth: [{ $match: { closedAt: { $gte: startLastMonth, $lt: startThisMonth } } }, { $count: 'n' }],
        typeDistribution: [
          { $group: { _id: { $ifNull: ['$caseType', 'Other'] }, count: { $sum: 1 } } },
        ],
        openedTrend: [
          { $match: { createdAt: { $gte: start8 } } },
          { $group: {
              _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } },
              opened: { $sum: 1 },
              inReview: { $sum: { $cond: [{ $in: ['$status', ['under_investigation', 'pending_review']] }, 1, 0] } },
          }},
        ],
        closedTrend: [
          { $match: { closedAt: { $gte: start8 } } },
          { $group: { _id: { y: { $year: '$closedAt' }, m: { $month: '$closedAt' } }, closed: { $sum: 1 } } },
        ],
        analystPerformance: [
          { $match: { assignedTo: { $ne: null } } },
          { $group: {
              _id: '$assignedTo',
              assigned: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } },
              avgReviewMs: { $avg: closedReviewMs },
          }},
          { $sort: { assigned: -1 } },
          { $limit: 6 },
        ],
      },
    },
  ]);

  const first = (arr) => (Array.isArray(arr) && arr[0]) || {};
  const cnt = (arr) => (Array.isArray(arr) && arr[0] && arr[0].n) || 0;
  const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : 0);
  const msToDays = (ms) => (ms ? Math.round((ms / 86400000) * 10) / 10 : 0);

  const s = first(agg.summary);
  const cThis = cnt(agg.createdThisMonth);
  const cLast = cnt(agg.createdLastMonth);
  const clThis = cnt(agg.closedThisMonth);
  const clLast = cnt(agg.closedLastMonth);

  const summary = {
    totalReviews: s.total || 0,
    completedReviews: s.completed || 0,
    openReviews: s.open || 0,
    avgReviewTimeDays: msToDays(s.avgReviewMs),
    totalReviewsChange: pct(cThis, cLast),
    completedReviewsChange: pct(clThis, clLast),
    openReviewsChange: pct(cThis - clThis, cLast - clLast),
    avgReviewTimeChange: 0,
  };

  const TYPE_COLORS = { Fraud: '#f97316', AML: '#ef4444', Compliance: '#6366f1', TF: '#eab308', Other: '#94a3b8' };
  const typeTotal = (agg.typeDistribution || []).reduce((a, t) => a + t.count, 0) || 1;
  const typeDistribution = (agg.typeDistribution || []).map((t) => ({
    name: t._id || 'Other',
    count: t.count,
    value: Math.round((t.count / typeTotal) * 100),
    color: TYPE_COLORS[t._id] || TYPE_COLORS.Other,
  }));

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const openedMap = new Map((agg.openedTrend || []).map((d) => [`${d._id.y}-${d._id.m}`, d]));
  const closedMap = new Map((agg.closedTrend || []).map((d) => [`${d._id.y}-${d._id.m}`, d.closed]));
  const trend = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
    const o = openedMap.get(key) || {};
    trend.push({
      month: MONTHS[d.getMonth()],
      opened: o.opened || 0,
      closed: closedMap.get(key) || 0,
      inReview: o.inReview || 0,
    });
  }

  const perfRows = agg.analystPerformance || [];
  const ids = perfRows.map((r) => r._id).filter(Boolean);
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select('name').lean() : [];
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));
  const analystPerformance = perfRows.map((r) => ({
    name: nameById.get(String(r._id)) || 'Unknown',
    assigned: r.assigned,
    completed: r.completed,
    avgDays: msToDays(r.avgReviewMs),
  }));

  res.status(200).json({
    succeed: true,
    data: { summary, typeDistribution, trend, analystPerformance },
  });
});

// ── POST /cases/:id/sar ──────────────────────────────────────────────────────────
// Record a SAR/SMR filing decision on the case (the deliberate compliance action).
// Sets decision='sar_filed'; the derived `sarFiled` flag also lights up when an
// approved SMR exists on the case (see getCaseById / getCases).
exports.fileSAR = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req, { requireAssignment: true });
  if (accessErr) return next(accessErr);

  caseDoc.decision   = 'sar_filed';
  caseDoc.decidedAt  = caseDoc.decidedAt || new Date();
  caseDoc.decidedBy  = req.user._id;
  if (req.body.sarNotes) caseDoc.decisionNotes = req.body.sarNotes;
  await caseDoc.save();

  await logAudit(
    caseDoc._id, req.user._id, 'sar_filed',
    `SAR filing recorded${req.body.sarNotes ? `: ${req.body.sarNotes}` : ''}`, getTenant(req), req);

  const updated = await populateCase(Case.findById(caseDoc._id)).lean();
  res.status(200).json({
    succeed: true,
    data: { ...updated, sarFiled: true, netActivity: sumNetActivity(updated.linkedTransactions) },
  });
});

// ── POST /cases/:id/alerts ────────────────────────────────────────────────────
exports.linkAlerts = asyncHandler(async (req, res, next) => {
  const { alertIds } = req.body;

  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const tenant = getTenant(req);
  const alertFilter = { _id: { $in: alertIds }, isDeleted: { $ne: true } };
  if (tenant.client) alertFilter.client = tenant.client;

  const alerts = await Alert.find(alertFilter).lean();
  if (alerts.length !== alertIds.length) {
    return next(new ErrorResponse('One or more alertIds not found in your tenant', 404));
  }

  const alreadyLinked = alerts.filter(
    (a) => a.linkedCase && a.linkedCase.toString() !== req.params.id
  );
  if (alreadyLinked.length > 0) {
    return next(
      new ErrorResponse(
        `Alert(s) [${alreadyLinked.map((a) => a.uid).join(', ')}] are already linked to a different case`,
        400
      )
    );
  }

  // Links the alerts and pulls through their customers (incl. transaction
  // parties) and transactions, then re-derives the case risk. Audit included.
  const { addedAlertIds } = await attachAlertsToCase(caseDoc, alerts, { user: req.user, req });

  if (addedAlertIds.length === 0) {
    return next(new ErrorResponse('All provided alerts are already linked to this case', 400));
  }

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── DELETE /cases/:id/alerts/:alertId ────────────────────────────────────────
exports.unlinkAlert = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const alertId = req.params.alertId;
  const idx = caseDoc.linkedAlerts.findIndex((id) => id.toString() === alertId);
  if (idx === -1) {
    return next(new ErrorResponse('Alert is not linked to this case', 404));
  }

  const alert = (await Alert.findById(alertId).lean()) || { _id: alertId };

  // Removes the alert, drops its transaction if no other linked alert still
  // uses it, re-derives the case risk and writes the audit row.
  await detachAlertFromCase(caseDoc, alert, { user: req.user, req });

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── POST /cases/:id/customers ─────────────────────────────────────────────────
// Add customers as persons of interest (POIs) on the case, e.g. a counterparty
// the analyst wants to investigate alongside the primary customer.
exports.linkCustomers = asyncHandler(async (req, res, next) => {
  const { customerIds } = req.body;

  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  // Every customer must exist and belong to the CASE's tenant — not just the
  // caller's: a platform admin has no tenant of their own, and checking only
  // theirs let any tenant's customer be linked to any case.
  const tenant = getTenant(req);
  const customers = await Customer.find({ _id: { $in: customerIds } }).select('relations').lean();
  if (customers.length !== new Set(customerIds.map(String)).size) {
    return next(new ErrorResponse('One or more customerIds not found', 404));
  }
  const foreign = customers.filter(
    (c) =>
      !customerRelatedToTenant(c, tenant.client, tenant.branch) ||
      !customerRelatedToTenant(c, caseDoc.client, null)
  );
  if (foreign.length) {
    return next(new ErrorResponse('One or more customers are not in your tenant', 403));
  }

  const { addedCustomerIds } = await addCustomersToCase(caseDoc, customerIds, { user: req.user, req });
  if (addedCustomerIds.length === 0) {
    return next(new ErrorResponse('All provided customers are already linked to this case', 400));
  }

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── DELETE /cases/:id/customers/:customerId ──────────────────────────────────
// The primary POI (`case.customer`) cannot be removed — the service enforces it.
exports.unlinkCustomer = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  await removeCustomerFromCase(caseDoc, req.params.customerId, { user: req.user, req });

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── GET /cases/:id/poi-candidates?q= ─────────────────────────────────────────
// What the "Add person of interest" picker offers:
//   customers   — tenant customers matching `q` (only searched when q is given)
//   alerts      — every party on the case's linked alerts, grouped by alert
// Each entry says whether it is already a POI so the picker can disable it.
exports.getPoiCandidates = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select('client branch customer linkedCustomers linkedAlerts externalPois assignedTo')
    .lean();
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const q = String(req.query.q || '').trim();
  const tenant = getTenant(req);
  const poiIds = new Set(
    [caseDoc.customer, ...(caseDoc.linkedCustomers || [])].filter(Boolean).map(String)
  );

  const [customers, alerts] = await Promise.all([
    // Scope to the CASE's tenant (not a query param) so the picker can never
    // list another tenant's customers; linkCustomers re-checks on write anyway.
    q
      ? searchCustomers({ q, limit: 20, clientId: caseDoc.client || tenant.client, branchId: tenant.branch })
      : Promise.resolve([]),
    listAlertPoiCandidates(caseDoc),
  ]);

  res.status(200).json({
    succeed: true,
    data: {
      customers: customers.map((c) => ({ ...c, alreadyPoi: poiIds.has(String(c.id)) })),
      alerts,
    },
  });
});

// ── POST /cases/:id/pois ─────────────────────────────────────────────────────
// Add a person of interest who is not a customer: typed in, or taken off a
// party slot on a linked alert's transaction (`fromAlert: { alertId, slot }`).
// Customers are added through POST /cases/:id/customers instead.
exports.addPoi = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  await addExternalPoi(caseDoc, req.body, { user: req.user, req });

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(201).json({ succeed: true, data: updated });
});

// ── PATCH /cases/:id/pois/:poiId ─────────────────────────────────────────────
exports.updatePoi = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  await updateExternalPoi(caseDoc, req.params.poiId, req.body, { user: req.user, req });

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── DELETE /cases/:id/pois/:poiId ────────────────────────────────────────────
exports.removePoi = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  await removeExternalPoi(caseDoc, req.params.poiId, { user: req.user, req });

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── DELETE /cases/:id ─────────────────────────────────────────────────────────
exports.deleteCase = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  caseDoc.isDeleted = true;
  caseDoc.deletedAt = new Date();
  await caseDoc.save();

  res.status(200).json({ succeed: true, data: req.params.id });
});

// ── POST /cases/:id/notes ─────────────────────────────────────────────────────
exports.addNote = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req, { requireAssignment: true });
  if (accessErr) return next(accessErr);

  const tenant = getTenant(req);
  const { content, attachments } = req.body;

  const note = await CaseNote.create({
    ...tenant,
    case: req.params.id,
    author: req.user._id,
    content: content.trim(),
    attachments: attachments || [],
  });

  const auditPromises = [
    logAudit(req.params.id, req.user._id, 'note_added', `Note added by ${req.user.name || req.user._id}`, tenant, req),
  ];
  if (attachments && attachments.length > 0) {
    auditPromises.push(
      logAudit(req.params.id, req.user._id, 'evidence_added', `${attachments.length} evidence URL(s) attached`, tenant, req)
    );
  }
  await Promise.all(auditPromises);

  const populated = await CaseNote.findById(note._id).populate('author', 'name email avatar').lean();
  res.status(201).json({ succeed: true, data: populated });
});

// ── GET /cases/:id/notes ──────────────────────────────────────────────────────
exports.getCaseNotes = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select('client assignedTo')
    .lean();
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const notes = await CaseNote.find({ case: req.params.id })
    .populate('author', 'name email avatar')
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({ succeed: true, data: notes, count: notes.length });
});

// ── GET /cases/:id/audit ──────────────────────────────────────────────────────
exports.getAuditLog = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select('client assignedTo')
    .lean();
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const logs = await AuditLog.find({ case: req.params.id })
    .populate('user', 'name email avatar')
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({ succeed: true, data: logs, count: logs.length });
});

// ── GET /cases/investigators ──────────────────────────────────────────────────
// Returns staff members belonging to the current client tenant.
// Shape matches what the frontend expects: { _id, name, email, avatar }.
exports.getInvestigators = asyncHandler(async (req, res, next) => {
  const { client: clientId } = getTenant(req);

  const staffFilter = {};
  if (clientId) staffFilter.client = clientId;

  const staffList = await Staff.find(staffFilter)
    .populate('user', 'name email avatar photoUrl')
    .lean();

  const investigators = staffList
    .filter((s) => s.user) // exclude staff without a linked user account
    .map((s) => ({
      _id: s.user._id,
      name: `${s.personal?.firstName || ''} ${s.personal?.lastName || ''}`.trim() || s.user.name,
      email: s.contact?.workEmail || s.user.email,
      avatar: s.user.photoUrl || s.user.avatar || null,
      staffId: s._id,
      jobTitle: s.employment?.jobTitle || null,
    }));

  res.status(200).json({ succeed: true, data: investigators, count: investigators.length });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case documents
//
// Evidence attached to a case. The bytes are already in FileVault by the time
// these run — the UI uploads there first (POST /file-vault/upload) and sends us
// the reference. We hold the reference and, for a trade document, the id of the
// TBML screening run it was submitted to.
// ─────────────────────────────────────────────────────────────────────────────

// Loads a case the caller is allowed to touch, or returns the error to pass to
// next(). Every documents handler starts the same way.
//
// `populate` is off by default: the write handlers need a real document to save,
// and populating a subdocument ref would write the populated object back.
const loadCaseForDocuments = async (req, { populate = false } = {}) => {
  let query = Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (populate) query = query.populate('documents.uploadedBy', 'name email');

  const caseDoc = await query;
  if (!caseDoc) {
    return { error: new ErrorResponse(`Case not found with id ${req.params.id}`, 404) };
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return { error: accessErr };
  return { caseDoc };
};

// ── GET /cases/:id/documents ─────────────────────────────────────────────────
exports.getCaseDocuments = asyncHandler(async (req, res, next) => {
  const { caseDoc, error } = await loadCaseForDocuments(req, { populate: true });
  if (error) return next(error);

  // Newest first — an analyst is almost always looking for what was just added.
  const documents = [...(caseDoc.documents || [])].sort(
    (a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0)
  );

  res.status(200).json({ succeed: true, data: documents, count: documents.length });
});

// ── POST /cases/:id/documents ────────────────────────────────────────────────
exports.addCaseDocument = asyncHandler(async (req, res, next) => {
  const { name, url, mimeType, type, sizeBytes, tbml } = req.body;

  if (!url) {
    return next(new ErrorResponse('url is required — upload to /file-vault/upload first', 400));
  }

  const { caseDoc, error } = await loadCaseForDocuments(req);
  if (error) return next(error);

  caseDoc.documents.push({
    name: name || 'Untitled document',
    url,
    mimeType: mimeType || null,
    type: type || 'other',
    sizeBytes: sizeBytes ?? null,
    uploadedAt: new Date(),
    uploadedBy: req.user._id,
    // Present when the same file was handed to the TBML engine in one step.
    ...(tbml?.reportId && {
      tbml: {
        reportId:     tbml.reportId,
        submissionId: tbml.submissionId || null,
        status:       tbml.status || 'PENDING',
        dbSource:     tbml.dbSource ?? null,
        submittedAt:  new Date(),
      },
    }),
  });

  await caseDoc.save();
  const added = caseDoc.documents[caseDoc.documents.length - 1];

  await logAudit(
    caseDoc._id, req.user._id, 'document_added',
    `Document "${added.name}" attached` + (added.tbml?.reportId ? ` and submitted for TBML screening (${added.tbml.reportId})` : ''),
    getTenant(req), req
  );

  logEvent({
    req,
    service: 'case',
    action: 'case_document_added',
    target: caseDoc.uid || String(caseDoc._id),
    case: caseDoc._id,
    afterValue: { name: added.name, type: added.type, tbmlReportId: added.tbml?.reportId || null },
  });

  res.status(201).json({ succeed: true, data: added });
});

// ── PATCH /cases/:id/documents/:documentId/tbml ──────────────────────────────
// Records (or refreshes) the screening run a stored document was submitted to.
// Screening a document that is already in the vault is a separate step from
// attaching it, so this is its own endpoint rather than a re-upload.
exports.setCaseDocumentTbml = asyncHandler(async (req, res, next) => {
  const { reportId, submissionId, status, dbSource } = req.body;
  if (!reportId) return next(new ErrorResponse('reportId is required', 400));

  const { caseDoc, error } = await loadCaseForDocuments(req);
  if (error) return next(error);

  const document = caseDoc.documents.id(req.params.documentId);
  if (!document) {
    return next(new ErrorResponse(`Document not found with id ${req.params.documentId}`, 404));
  }

  document.tbml = {
    reportId,
    submissionId: submissionId || document.tbml?.submissionId || null,
    status: status || 'PENDING',
    dbSource: dbSource ?? document.tbml?.dbSource ?? null,
    submittedAt: new Date(),
  };

  await caseDoc.save();

  await logAudit(
    caseDoc._id, req.user._id, 'document_screened',
    `Document "${document.name}" submitted for TBML screening (${reportId})`,
    getTenant(req), req
  );

  res.status(200).json({ succeed: true, data: document });
});

// ── DELETE /cases/:id/documents/:documentId ──────────────────────────────────
exports.removeCaseDocument = asyncHandler(async (req, res, next) => {
  const { caseDoc, error } = await loadCaseForDocuments(req);
  if (error) return next(error);

  const document = caseDoc.documents.id(req.params.documentId);
  if (!document) {
    return next(new ErrorResponse(`Document not found with id ${req.params.documentId}`, 404));
  }

  const { name } = document;
  document.deleteOne();
  await caseDoc.save();

  // The file itself stays in FileVault. Detaching evidence from a case is not
  // authority to destroy it — vault retention is its own decision.
  await logAudit(
    caseDoc._id, req.user._id, 'document_removed',
    `Document "${name}" detached from the case (the file remains in FileVault)`,
    getTenant(req), req
  );

  logEvent({
    req,
    service: 'case',
    action: 'case_document_removed',
    target: caseDoc.uid || String(caseDoc._id),
    case: caseDoc._id,
    beforeValue: { name },
  });

  res.status(200).json({ succeed: true, data: { _id: req.params.documentId } });
});
