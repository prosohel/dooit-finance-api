// controllers/ecddReport.js
const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const Alert = require("../models/Alert");
const EcddReport = require("../models/EcddReport");
const ErrorResponse = require("../utils/errorResponse");
const {
  resolveCaseLinkage,
  hasLinkageRef,
  linkageOverrides,
} = require("../utils/resolveCaseLinkage");
    const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
const { logEvent } = require("../utils/audit");

const csvParser = require("csv-parser");
const { Parser: Json2CsvParser } = require("json2csv");
const stream = require("stream");

/**
 * Helper: map CSV row -> EcddReport document fields (whitelist)
 * Adjust keys to match your CSV header names (case-insensitive).
 */
const mapRowToDoc = (row) => {
  // Lowercase keys for tolerant matching
  const normalized = {};
  Object.keys(row).forEach(
    (k) => (normalized[k.trim().toLowerCase()] = row[k])
  );

  // Example mapping — update according to your CSV headers
  return {
    analystName:
      normalized["analyst name"] ||
      normalized["analystname"] ||
      normalized["analyst"] ||
      "",
    position: normalized["position"] || "",
    date: normalized["date"] ? new Date(normalized["date"]) : null,
    caseNumber: normalized["case number"] || normalized["case"] || "",
    userId: normalized["user id"] || normalized["userid"] || "",
    fullName: normalized["full name"] || normalized["fullname"] || "",
    customerName:
      normalized["customer name"] || normalized["customername"] || "",
    abn: normalized["abn"] || "",
    onboardingDate: normalized["onboarding date"]
      ? new Date(normalized["onboarding date"])
      : null,
    accountPurpose: normalized["account purpose"] || "",
    expectedVolume: normalized["expected volume"]
      ? Number(normalized["expected volume"])
      : undefined,
    annualIncome: normalized["annual income"]
      ? Number(normalized["annual income"])
      : undefined,
    beneficialOwner: normalized["beneficial owner"] || "",
    directors: normalized["directors"] || "",
    isPEP: (normalized["is pep"] || "No").trim() || "No",
    isSanctioned: (normalized["is sanctioned"] || "No").trim() || "No",
    relatedParty: normalized["related party"] || "N/A",
    accountCreationDate: normalized["account creation date"]
      ? new Date(normalized["account creation date"])
      : null,
    analysisEndDate: normalized["analysis end date"]
      ? new Date(normalized["analysis end date"])
      : null,
    totalDepositsAUD: normalized["total deposits aud"]
      ? Number(normalized["total deposits aud"])
      : 0,
    totalWithdrawalsUSDT: normalized["total withdrawals usdt"]
      ? Number(normalized["total withdrawals usdt"])
      : 0,
    totalWithdrawalsETH: normalized["total withdrawals eth"]
      ? Number(normalized["total withdrawals eth"])
      : 0,
    totalWithdrawalsBTC: normalized["total withdrawals btc"]
      ? Number(normalized["total withdrawals btc"])
      : 0,
    depositDetails: normalized["deposit details"] || "",
    withdrawalDetails: normalized["withdrawal details"] || "",
    additionalInfo: normalized["additional info"] || "",
    ipLocations: normalized["ip locations"]
      ? Number(normalized["ip locations"])
      : undefined,
    registeredAddress: normalized["registered address"] || "",
    profileSummary: normalized["profile summary"] || "",
    transactionAnalysis: normalized["transaction analysis"] || "",
    behavioralAnalysis: normalized["behavioral analysis"] || "",
    recommendation: normalized["recommendation"] || "",
  };
};
/**
 * Simple filter helper for front-end search (mirrors your user filter)
 * s: single EcddReport doc
 * requestBody: expected to contain { name: string } (will check against fullName / customerName)
 */
exports.filterEcddSection = (s, requestBody) => {
  const needle = (requestBody.name || "").toLowerCase().trim();
  if (!needle) return true;
  const hay = (
    (s.fullName || "") +
    " " +
    (s.customerName || "") +
    " " +
    (s.caseNumber || "")
  )
    .toLowerCase()
    .trim();
  return hay.includes(needle);
};

// @desc   Get all ECDD reports
// @route  GET /api/v1/ecdd
// @access Public (or protect with auth middleware in routes)
exports.getEcddReports = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['ECDD']
  #swagger.summary = 'Get All Reports'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  // expected to be populated by advancedResults middleware
  res.status(200).json(res.advancedResults);
});

// @desc   Create a single ECDD report
// @route  POST /api/v1/ecdd
// @access Private (require authentication in routes)
exports.createEcddReport = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  const user = req?.user?._id || null;

  // whitelist allowed fields server-side if you prefer
  const payload = req.body || {};
  const { caseNumber, riskAssessment: riskAssessmentId } = payload;

  if (caseNumber) {
    const existing = await EcddReport.findOne({
      caseNumber: caseNumber,
    });

    if (existing) {
      return next(
        new ErrorResponse(
          `The caseNumber (${caseNumber}) is already used by another report.`,
          409
        )
      );
    }
  }

  // Three origins:
  //  • Case-origin: `caseId` picked in the form — attaches straight to the Case
  //  • TM-origin:   caseNumber resolves to a TM Alert (Case derived if escalated)
  //  • CRA-origin:  riskAssessment supplied — backs a CRA ECDD gate; no Alert needed
  //
  // Resolution goes through the same shared helper SMR/TTR/IFTI/GFS/RFI use.
  // Resolve the two linkages separately: resolveCaseLinkage treats `caseId` and
  // `caseNumber` as one ref (caseId wins), so passing both would silently drop
  // the Alert. caseId is the hub, alert is provenance — keep both.
  const alertLink = await resolveCaseLinkage({
    caseNumber,
    alertId: payload.alert || payload.alertId,
  });
  const caseLink = payload.caseId
    ? await resolveCaseLinkage({ caseId: payload.caseId })
    : null;

  // An explicitly picked Case wins; otherwise fall back to Alert.linkedCase.
  const resolvedCaseId = caseLink?.caseId || alertLink.caseId || null;

  let alert = alertLink.alertDoc || null;
  let assessment = null;

  if (riskAssessmentId) {
    assessment = await IndividualRiskAssessment.findById(riskAssessmentId)
      .select("uid customer customerName client branch")
      .lean();
    if (!assessment) {
      return next(
        new ErrorResponse(`Risk assessment not found: ${riskAssessmentId}`, 404)
      );
    }
  } else if (!resolvedCaseId && !alert) {
    // Nothing to attach to — neither an explicit Case nor a resolvable Alert.
    return next(
      new ErrorResponse(
        `No Case or Alert found for reference ${payload.caseId || caseNumber}`,
        404
      )
    );
  }

  const submitObj = {
    ...payload,
    client,
    branch,
    caseId: resolvedCaseId,          // Case hub (explicit pick, else Alert.linkedCase)
    alert: alertLink.alert || null,  // originating TM Alert (provenance)
    riskAssessment: assessment?._id || null,
    customer:
      payload.customer ||
      caseLink?.customer ||
      alertLink.customer ||
      assessment?.customer ||
      null,
    generatedBy: user || null,
  };
  const report = await EcddReport.create(submitObj);

  // CRA-origin: back-link the assessment to its ECDD form + audit trail entry
  if (assessment) {
    const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
    const { logCraEvent } = require("../utils/craAudit");
    await IndividualRiskAssessment.updateOne(
      { _id: assessment._id },
      { $set: { ecddReport: report._id } }
    );
    await logCraEvent({
      req,
      assessment,
      action: "ECDD_REPORT_LINKED",
      after: { ecddReport: report.uid, analystName: report.analystName || "" },
      target: assessment.customerName,
    });
  }

  logEvent({
    req,
    service: "report",
    action: "ecdd_created",
    reportType: "ECDD",
    target: report.uid || String(report._id),
    case: report.caseId || null,
    customer: report.customer || null,
    afterValue: { status: report.status },
  });

  res.status(201).json({
    success: true,
    data: report,
    id: report._id,
  });
});
// @desc   Create a single ECDD report
// @route  POST /api/v1/ecdd
// @access Private (require authentication in routes)
exports.createPublicEcddReport = asyncHandler(async (req, res, next) => {
  const payload = req.body || {};

  const { caseNumber, generatedBy, analyst, transaction, customer, client, branch } = payload;



  const existing = await EcddReport.findOne({ caseNumber });
  if (existing) {
    return next(
      new ErrorResponse(
        `The caseNumber (${caseNumber}) is already used by another report.`,
        409
      )
    );
  }

  const alert = await Alert.findOne({ uid: caseNumber });
  if (!alert) {
    return next(
      new ErrorResponse(
        `Alert not found by CASE Number or Alert UID ${caseNumber}`,
        404
      )
    );
  }

  const submitObj = {
    ...payload,
    caseId: alert?.linkedCase || null, // Case hub (null until alert is escalated)
    alert: alert._id,                  // originating TM Alert (provenance)
    client: alert?.client ?? null,
    branch: alert?.branch ?? null,
    analyst: alert?.analyst ?? null,
    customer: alert?.customer ?? null,
    transaction: alert?.transaction ?? null,
    generatedBy: alert?.createdBy || null

  };

  const report = await EcddReport.create(submitObj);

  // Route is unauthenticated by design — attribute the event to the AI service
  // and carry tenant refs from the resolved alert.
  logEvent({
    req,
    service: "report",
    action: "ecdd_created",
    actorName: "ai-service",
    actorRole: "public",
    reportType: "ECDD",
    target: report.uid || String(report._id),
    case: report.caseId || null,
    customer: report.customer || null,
    client: report.client || null,
    branch: report.branch || null,
    afterValue: { status: report.status },
  });

  res.status(201).json({
    success: true,
    data: report,
    id: report._id,
  });
});

// @desc   Fetch single ECDD report by id
// @route  GET /api/v1/ecdd/:id
// @access Public or Protected
exports.getEcddReport = asyncHandler(async (req, res, next) => {
  const report = await EcddReport.findById(req.params.id)
    .populate("customer")
    .populate("analyst")
    .populate("generatedBy")
    .populate("transaction");

  if (!report) {
    return next(
      new ErrorResponse(
        `ECDD Report not found with id of ${req.params.id}`,
        404
      )
    );
  }
  res.status(200).json({
    success: true,
    data: report,
  });
});

// @desc   Fetch single report by caseNumber
// @route  GET /api/v1/ecdd/case/:caseNumber
// @access Public or Protected
exports.getEcddReportByCaseNumber = asyncHandler(async (req, res, next) => {
  const report = await EcddReport.findOne({ caseNumber: req.params.caseNumber })
    .populate("customer")
    .populate("analyst")
    .populate("generatedBy")
    .populate("transaction")
    // Linkage refs carry the uid the analyst actually recognises; unpopulated
    // they reach the UI as bare ObjectIds and render as raw hex.
    .populate("caseId", "uid title status")
    .populate("alert", "uid status riskScore riskLabel")
    .populate("riskAssessment", "uid riskScore riskLabel ecddStatus");

  if (!report) {
    return next(
      new ErrorResponse(
        `ECDD Report not found with caseNumber ${req.params.caseNumber}`,
        404
      )
    );
  }
  res.status(200).json({
    success: true,
    data: report,
  });
});

// @desc   Update single ECDD report
// @route  PUT /api/v1/ecdd/:id
// @access Private
exports.updateEcddReport = asyncHandler(async (req, res, next) => {
  // optional duplicate check for caseNumber
  if (req.body.caseNumber) {
    const existing = await EcddReport.findOne({
      caseNumber: req.body.caseNumber,
    });
    if (existing && existing._id.toString() !== req.params.id) {
      return next(
        new ErrorResponse(
          `The caseNumber (${req.body.caseNumber}) is already used by another report.`,
          409
        )
      );
    }
  }

  // Re-resolve linkage if the body carries a case/alert identifier.
  let updateBody = req.body;
  if (hasLinkageRef(req.body)) {
    updateBody = { ...req.body, ...(await linkageOverrides(req.body, "caseId")) };
  }

  // Capture the pre-update status so a transition can be audited with its
  // before/after values (findByIdAndUpdate with new:true only returns "after").
  let prevStatus;
  if (req.body.status !== undefined) {
    const prev = await EcddReport.findById(req.params.id)
      .select("status")
      .lean();
    prevStatus = prev?.status;
  }

  // Fields the analyst actually changed become theirs: a re-draft from the
  // case (Investigation Hub) must not overwrite them. The form re-sends every
  // value, so only real changes count.
  const { changedKeys, EDITABLE_FIELDS } = require("../services/reportDrafts");
  const before = await EcddReport.findById(req.params.id).select(EDITABLE_FIELDS.ecdd.join(" ")).lean();
  const { editedFields: _ignored, ...setBody } = updateBody;
  const edited = before ? changedKeys(before, setBody, EDITABLE_FIELDS.ecdd) : [];
  updateBody = edited.length
    ? { $set: setBody, $addToSet: { editedFields: { $each: edited } } }
    : setBody;

  const report = await EcddReport.findByIdAndUpdate(req.params.id, updateBody, {
    new: true,
    runValidators: true,
  });

  if (!report) {
    return next(
      new ErrorResponse(
        `ECDD Report not found with id of ${req.params.id}`,
        404
      )
    );
  }

  const statusChanged =
    setBody.status !== undefined && prevStatus !== report.status;
  logEvent({
    req,
    service: "report",
    action: statusChanged ? "ecdd_status_changed" : "ecdd_updated",
    reportType: "ECDD",
    target: report.uid || String(report._id),
    case: report.caseId || null,
    customer: report.customer || null,
    ...(statusChanged
      ? {
          beforeValue: { status: prevStatus },
          afterValue: { status: report.status },
        }
      : {}),
  });

  res.status(200).json({
    success: true,
    data: report,
  });
});

// @desc   Delete single ECDD report
// @route  DELETE /api/v1/ecdd/:id
// @access Private
exports.deleteEcddReport = asyncHandler(async (req, res, next) => {
  const report = await EcddReport.findById(req.params.id);

  if (!report) {
    return next(
      new ErrorResponse(
        `ECDD Report not found with id of ${req.params.id}`,
        404
      )
    );
  }

  // Snapshot before the delete — this is the only surviving record of the doc.
  const snapshot = {
    uid: report.uid,
    status: report.status,
    caseId: report.caseId,
    customer: report.customer,
  };
  await report.deleteOne();

  logEvent({
    req,
    service: "report",
    action: "ecdd_deleted",
    reportType: "ECDD",
    target: snapshot.uid || String(report._id),
    case: snapshot.caseId || null,
    customer: snapshot.customer || null,
    beforeValue: snapshot,
  });

  res.status(200).json({
    success: true,
    data: req.params.id,
  });
});

// @desc   Import ECDD report(s) (single object or array)
// @route  POST /api/v1/ecdd/import
// @access Private
exports.importFromJsonEcddReports = asyncHandler(async (req, res, next) => {
  const payload = req.body;

  if (!payload) {
    return next(new ErrorResponse("Request body is empty", 400));
  }

  // If array — bulk create
  if (Array.isArray(payload)) {
    const inserted = [];
    for (const p of payload) {
      // optionally sanitize p here
      const doc = await EcddReport.create(p);
      inserted.push(doc);
    }

    logEvent({
      req,
      service: "report",
      action: "ecdd_import",
      reportType: "ECDD",
      afterValue: { created: inserted.length },
    });

    return res.status(201).json({
      success: true,
      inserted: inserted.length,
      data: inserted,
    });
  }

  // Single object create
  const doc = await EcddReport.create(payload);

  logEvent({
    req,
    service: "report",
    action: "ecdd_import",
    reportType: "ECDD",
    target: doc.uid || String(doc._id),
    afterValue: { created: 1 },
  });

  return res.status(201).json({
    success: true,
    data: doc,
  });
});

/**
 * @route POST /api/v1/ecdd/import-csv
 * @desc Import CSV file, stream-parse and create documents (bulk)
 * @access Private
 * Multer upload should attach file in req.file
 */
exports.importEcddReportCsv = asyncHandler(async (req, res, next) => {
  if (!req.file) {
    return next(new ErrorResponse("No file uploaded", 400));
  }

  // stream from buffer
  const readStream = new stream.PassThrough();
  readStream.end(req.file.buffer);

  const createdDocs = [];
  let processed = 0;
  const errors = [];

  await new Promise((resolve, reject) => {
    readStream
      .pipe(csvParser({ skipLines: 0, strict: false }))
      .on("data", async (row) => {
        // Pause stream to allow async DB write (backpressure)
        readStream.pause();
        try {
          processed++;
          const mapped = mapRowToDoc(row);

          // Optional: basic validation — skip if required fields missing
          if (!mapped.caseNumber && !mapped.fullName) {
            errors.push({
              row: processed,
              reason: "missing caseNumber & fullName",
            });
            readStream.resume();
            return;
          }

          // Create document (you can use create() or insertMany for batches)
          const doc = await EcddReport.create(mapped);
          createdDocs.push(doc);
        } catch (err) {
          errors.push({ row: processed, error: err.message });
        } finally {
          readStream.resume();
        }
      })
      .on("end", () => resolve())
      .on("error", (err) => reject(err));
  });

  logEvent({
    req,
    service: "report",
    action: "ecdd_import",
    reportType: "ECDD",
    afterValue: {
      created: createdDocs.length,
      failed: errors.length,
      filename: req.file.originalname || null,
    },
  });

  return res.status(201).json({
    success: true,
    processed,
    inserted: createdDocs.length,
    errors,
    data: createdDocs.slice(0, 20), // return a sample of created docs (avoid huge responses)
  });
});

/**
 * @route GET /api/v1/ecdd/export-csv
 * @desc Export ECDD reports as CSV (supports query filters via req.query)
 * @access Private
 * Streams CSV back to client
 */
exports.exportEcddReportCsv = asyncHandler(async (req, res, next) => {
  // Build query (whitelist)
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.caseNumber) filters.caseNumber = req.query.caseNumber;
  if (req.query.userId) filters.userId = req.query.userId;
  if (req.query.fullName)
    filters.fullName = { $regex: req.query.fullName, $options: "i" };

  const cursor = EcddReport.find(filters).cursor();

  const fields = [
    { label: "Case Number", value: "caseNumber" },
    { label: "Analyst Name", value: "analystName" },
    { label: "Position", value: "position" },
    {
      label: "Date",
      value: (row) => (row.date ? row.date.toISOString().split("T")[0] : ""),
    },
    { label: "User ID", value: "userId" },
    { label: "Full Name", value: "fullName" },
    { label: "Customer Name", value: "customerName" },
    { label: "ABN", value: "abn" },
    {
      label: "Onboarding Date",
      value: (row) =>
        row.onboardingDate
          ? row.onboardingDate.toISOString().split("T")[0]
          : "",
    },
    { label: "Account Purpose", value: "accountPurpose" },
    { label: "Expected Volume", value: "expectedVolume" },
    { label: "Annual Income", value: "annualIncome" },
    { label: "Total Deposits (AUD)", value: "totalDepositsAUD" },
    { label: "Total Withdrawals (USDT)", value: "totalWithdrawalsUSDT" },
    { label: "Total Withdrawals (ETH)", value: "totalWithdrawalsETH" },
    { label: "Total Withdrawals (BTC)", value: "totalWithdrawalsBTC" },
    { label: "Is PEP", value: "isPEP" },
    { label: "Is Sanctioned", value: "isSanctioned" },
    { label: "Recommendation", value: "recommendation" },
  ];

  const filename = `ecdd_export_${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.csv`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/csv");

  // Parser to produce header using fields spec (label/value)
  const headerParser = new Json2CsvParser({ fields, header: true });
  const headerCsv = headerParser.parse([]); // header only
  const pass = new stream.PassThrough();
  pass.pipe(res);
  pass.write(headerCsv + "\n");

  // We'll use a different parser for rows: supply fields as label strings
  const labelFields = fields.map((f) => f.label);
  const rowParser = new Json2CsvParser({ fields: labelFields, header: false });

  for await (const doc of cursor) {
    // Build an object keyed by the label names (matching rowParser expectations)
    const rowObj = {};
    for (const f of fields) {
      const val = typeof f.value === "function" ? f.value(doc) : doc[f.value];
      // use the label as the key so rowParser picks the right column
      rowObj[f.label] = val !== undefined && val !== null ? val : "";
    }
    // parse the single-row object (header:false)
    const rowCsv = rowParser.parse([rowObj]);
    pass.write(rowCsv + "\n");
  }

  pass.end();
});

// @desc   Export a single ECDD report as a filing-grade PDF
// @route  GET /api/v1/ecdd-report/:id/export-pdf
// @access Private
//
// The on-screen ECDD view is a working surface; this is the artefact that gets
// filed, attached to a case pack, or handed to a regulator. It therefore carries
// its own provenance (report UID, case, alert, preparing officer, timestamp) and
// a page footer, so a printed page stays self-identifying once separated from
// the rest of the pack.
//
// Narrative sections fall back to the AI bundle on `metadata` — the same
// precedence the UI uses, so the PDF and the screen never disagree.
// Document composition is separated from transport so the layout can be
// rendered and inspected without launching a browser or hitting the route.
// Exported for that reason; the handler below is its only caller in production.
const buildEcddReportHtml = (report) => {
  const ai = report.metadata?.ecddReport || {};
  const txn = report.transaction || {};

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  // Every empty value renders as an em dash rather than "undefined" — a filed
  // report must not look like a rendering fault.
  const val = (v) => (v === 0 ? "0" : v ? esc(v) : "&mdash;");

  const fmtDate = (d) =>
    d && !Number.isNaN(new Date(d).getTime())
      ? new Date(d).toLocaleDateString("en-AU", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
      : "&mdash;";

  const fmtDateTime = (d) =>
    new Date(d).toLocaleString("en-AU", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const money = (n) =>
    Number.isFinite(Number(n))
      ? "$" + Number(n).toLocaleString("en-AU", { maximumFractionDigits: 2 })
      : "&mdash;";

  // Crypto figures are quantities, not currency — 4.25 ETH is not $4.25.
  const qty = (n, ticker) =>
    Number.isFinite(Number(n))
      ? Number(n).toLocaleString("en-AU", { maximumFractionDigits: 8 }) + " " + ticker
      : "&mdash;";

  const row = (label, value) => "<tr><th>" + label + "</th><td>" + value + "</td></tr>";

  // The generated narratives are markdown — emphasis is written as **…**.
  // Rendered raw, a filed report shows literal asterisks around every name and
  // figure, so the emphasis is promoted to real bold. Escaping happens first,
  // so this can never introduce markup from the underlying text.
  const narrative = (text) =>
    text
      ? '<p class="narr">' +
        esc(text)
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(/\n/g, "<br/>") +
        "</p>"
      : '<p class="narr muted">Not recorded.</p>';

  const flag = (yes) =>
    yes
      ? '<span class="flag flag-yes">YES</span>'
      : '<span class="flag flag-no">NO</span>';

  const isPep = String(report.isPEP || "No") === "Yes";
  const isSanctioned = String(report.isSanctioned || "No") === "Yes";

  const partyRows =
    [
      ["Sender", txn.sender],
      ["Receiver", txn.receiver],
      ["Beneficiary", txn.beneficiary],
      ["Intermediary", txn.intermediary],
    ]
      .filter(([, p]) => p && p.name)
      .map(
        ([role, p]) =>
          "<tr><td>" + role + "</td><td>" + val(p.name) + "</td><td>" +
          val([p.institution, p.institutionCountry].filter(Boolean).join(", ")) +
          '</td><td class="mono">' + val(p.account) + "</td></tr>"
      )
      .join("") ||
    '<tr><td colspan="4" class="muted">No counterparties recorded.</td></tr>';

  // Only rendered when a transaction is actually linked — an empty section
  // reads as missing evidence rather than as "no transaction in scope".
  const transactionSection = txn && txn.uid
    ? `
  <h2>5. Transaction in scope</h2>
  <table class="kv">
    ${row("Transaction UID", '<span class="mono">' + val(txn.uid) + "</span>")}
    ${row("Reference", val(txn.reference))}
    ${row("Date", fmtDate(txn.timestamp))}
    ${row("Amount", esc(txn.currency || "") + " " + Number(txn.amount || 0).toLocaleString("en-AU"))}
    ${row("Type", val([txn.type, txn.subtype].filter(Boolean).join(" / ")))}
    ${row("Channel", val(txn.channel))}
    ${row("Status", val(txn.status))}
    ${row("Purpose", val(txn.purpose))}
    ${row("Risk score", val(txn.riskScore))}
    ${row("Risk flags", val((txn.riskFlags || []).join(", ")))}
    ${row("Narrative", val(txn.narrative))}
  </table>

  <h3>Parties</h3>
  <table class="grid">
    <thead><tr><th>Role</th><th>Name</th><th>Institution</th><th>Account</th></tr></thead>
    <tbody>${partyRows}</tbody>
  </table>`
    : "";

  const forensicRow =
    txn && txn.forensic && txn.forensic.walletCluster
      ? "<tr><td>Forensic wallet screening</td><td>" +
        flag(Number(txn.forensic.chainalysisScore) >= 60) +
        "</td><td>" +
        val(txn.forensic.walletCluster) +
        (txn.forensic.notes ? " &mdash; " + esc(txn.forensic.notes) : "") +
        "</td></tr>"
      : "";

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm 14mm 20mm; }
  /* A filed document is always light. Without this the renderer applies the
     viewer's colour scheme and a dark-mode host produces dark-on-dark output. */
  :root { color-scheme: only light; }
  * { box-sizing: border-box; }
  html, body { background: #ffffff; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 9.5px;
         color: #313132; margin: 0; -webkit-print-color-adjust: exact;
         print-color-adjust: exact; }

  .masthead { border-bottom: 2px solid #005964; padding-bottom: 10px; margin-bottom: 14px; overflow: hidden; }
  .masthead .brand { font-size: 8px; letter-spacing: 0.14em; text-transform: uppercase; color: #005964; font-weight: bold; }
  .masthead h1 { font-size: 17px; margin: 4px 0 2px; color: #313132; }
  .masthead .sub { color: #696969; font-size: 9px; }
  .masthead .right { float: right; text-align: right; font-size: 8.5px; color: #696969; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 8px;
            font-weight: bold; text-transform: uppercase; letter-spacing: 0.06em;
            background: #fff6de; color: #8a6400; border: 1px solid #f6e0a8; }

  h2 { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: #005964;
       border-bottom: 1px solid #e8ebeb; padding-bottom: 4px; margin: 16px 0 8px;
       page-break-after: avoid; }
  h3 { font-size: 9.5px; color: #313132; margin: 12px 0 5px; page-break-after: avoid; }

  table { width: 100%; border-collapse: collapse; }
  table.kv th { text-align: left; width: 32%; background: #f6f8f8; color: #4a4a4d;
                font-weight: 600; padding: 4px 8px; border: 1px solid #e8ebeb; vertical-align: top; }
  table.kv td { padding: 4px 8px; border: 1px solid #e8ebeb; vertical-align: top; }
  table.grid th { background: #005964; color: #fff; text-align: left; padding: 5px 8px; font-size: 8.5px; }
  table.grid td { border: 1px solid #e8ebeb; padding: 4px 8px; vertical-align: top; }
  table.grid tr:nth-child(even) td { background: #fafbfb; }
  tr { page-break-inside: avoid; }

  .narr { font-size: 9.5px; line-height: 1.55; color: #4a4a4d; margin: 0 0 8px; text-align: justify; }
  .muted { color: #ababab; }
  .mono { font-family: Consolas, "Courier New", monospace; font-size: 8.5px; word-break: break-all; }
  .flag { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 8px; font-weight: bold; }
  .flag-yes { background: #fdf1f7; color: #ca2f7f; border: 1px solid #f6dbe8; }
  .flag-no  { background: #f0fbf5; color: #199335; border: 1px solid #cceedd; }
  .notice { margin-top: 16px; padding: 8px 10px; background: #fafbfb; border: 1px solid #e8ebeb;
            font-size: 8px; color: #696969; line-height: 1.5; }
</style></head><body>

  <div class="masthead">
    <div class="right">
      <div><strong>${val(report.uid)}</strong></div>
      <div>Generated ${fmtDateTime(new Date())}</div>
    </div>
    <div class="brand">${esc((report.client && report.client.name) || "Dooit.ai")} &middot; Compliance</div>
    <h1>Enhanced Customer Due Diligence Report</h1>
    <div class="sub">
      Case ${val(report.caseNumber)} &nbsp;&middot;&nbsp;
      <span class="status">${val(report.status || "Pending")}</span>
    </div>
  </div>

  <h2>1. Report particulars</h2>
  <table class="kv">
    ${row("Report UID", '<span class="mono">' + val(report.uid) + "</span>")}
    ${row("Case number", '<span class="mono">' + val(report.caseNumber) + "</span>")}
    ${row("Prepared by", val(report.analystName) + (report.position ? " &mdash; " + esc(report.position) : ""))}
    ${row("Analysis date", fmtDate(report.date))}
    ${row("Analysis period", fmtDate(report.accountCreationDate) + " to " + fmtDate(report.analysisEndDate))}
    ${row("Report status", val(report.status))}
  </table>

  <h2>2. Customer profile</h2>
  <table class="kv">
    ${row("Full name", val(report.fullName || report.customerName))}
    ${row("Customer UID", '<span class="mono">' + val(report.customer && report.customer.uid) + "</span>")}
    ${row("Contact", val(ai.email))}
    ${row("Onboarding date", fmtDate(report.onboardingDate))}
    ${row("Account created", fmtDate(report.accountCreationDate))}
    ${row("Account purpose", val(report.accountPurpose))}
    ${row("Expected volume", money(report.expectedVolume))}
    ${row("Annual income", money(report.annualIncome))}
    ${row("Registered address", val(report.registeredAddress))}
    ${row("Distinct IP locations", val(report.ipLocations))}
  </table>

  <h2>3. Business information</h2>
  <table class="kv">
    ${row("Beneficial owner", val(report.beneficialOwner))}
    ${row("Directors", val(report.directors))}
    ${row("Company name", val(ai.company_name))}
    ${row("ABN", val(report.abn))}
    ${row("Related party", val(report.relatedParty))}
  </table>

  <h2>4. Screening outcome</h2>
  <table class="grid">
    <thead><tr><th style="width:38%">Check</th><th style="width:14%">Result</th><th>Basis</th></tr></thead>
    <tbody>
      <tr>
        <td>Politically exposed person</td>
        <td>${flag(isPep)}</td>
        <td>${isPep ? "Match recorded &mdash; enhanced due diligence required" : "No match recorded"}</td>
      </tr>
      <tr>
        <td>Sanctions screening</td>
        <td>${flag(isSanctioned)}</td>
        <td>${esc(ai.sanction_source || "Powered by ComplyAdvantage CSOM")}</td>
      </tr>
      ${forensicRow}
    </tbody>
  </table>

  ${transactionSection}

  <h2>6. Financial activity</h2>
  <table class="kv">
    ${row("Total deposits (AUD)", money(report.totalDepositsAUD))}
    ${row("Withdrawals &mdash; USDT", qty(report.totalWithdrawalsUSDT, "USDT"))}
    ${row("Withdrawals &mdash; ETH", qty(report.totalWithdrawalsETH, "ETH"))}
    ${row("Withdrawals &mdash; BTC", qty(report.totalWithdrawalsBTC, "BTC"))}
  </table>
  <h3>Deposit detail</h3>
  ${narrative(report.depositDetails)}
  <h3>Withdrawal detail</h3>
  ${narrative(report.withdrawalDetails)}

  <h2>7. Profile summary</h2>
  ${narrative(report.profileSummary || ai.profile_summary)}

  <h2>8. Transaction analysis</h2>
  ${narrative(report.transactionAnalysis || ai.transaction_analysis)}

  <h2>9. Behavioural analysis</h2>
  ${narrative(report.behavioralAnalysis || ai.behavioral_analysis)}

  <h2>10. Recommendation</h2>
  ${narrative(report.recommendation || ai.recommendation)}
  ${report.additionalInfo ? "<h3>Additional information</h3>" + narrative(report.additionalInfo) : ""}

  <h2>11. Reference</h2>
  <table class="kv">
    ${row("Report UID", '<span class="mono">' + val(report.uid) + "</span>")}
    ${row("Case", '<span class="mono">' + val(report.caseId || report.caseNumber) + "</span>")}
    ${row("Originating alert", '<span class="mono">' + val(report.alert) + "</span>")}
    ${row("Customer UID", '<span class="mono">' + val(report.customer && report.customer.uid) + "</span>")}
    ${row("Transaction UID", '<span class="mono">' + val(txn.uid) + "</span>")}
    ${row("Prepared by", val((report.generatedBy && report.generatedBy.name) || report.analystName))}
    ${row("Record created", fmtDate(report.createdAt))}
    ${row("Last updated", fmtDate(report.updatedAt))}
  </table>

  <div class="notice">
    <strong>Confidential &mdash; compliance record.</strong>
    This report is generated from platform data for the stated analysis period and has not been
    independently verified against external records unless noted. It is prepared to support
    obligations under the AML/CTF Act 2006 and is intended solely for the recipient institution
    and, where applicable, AUSTRAC. Unauthorised disclosure may constitute tipping off under s123.
  </div>

</body></html>`;

  return html;
};

exports.buildEcddReportHtml = buildEcddReportHtml;

exports.exportEcddReportPdf = asyncHandler(async (req, res, next) => {
  const { launchPdfBrowser } = require("../utils/puppeteerLaunch");

  const report = await EcddReport.findById(req.params.id)
    .populate("customer")
    .populate("analyst")
    .populate("generatedBy")
    .populate("transaction")
    .populate("client")
    .lean();

  if (!report) {
    return next(
      new ErrorResponse(`ECDD Report not found with id ${req.params.id}`, 404)
    );
  }

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const html = buildEcddReportHtml(report);

  let browser;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      // Page numbering matters once the report is printed and separated from
      // the case pack — a reader must be able to tell a page is missing.
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="width:100%; font-size:7px; color:#8a8a8a; padding:0 14mm;' +
        'font-family: Helvetica, Arial, sans-serif; display:flex; justify-content:space-between;">' +
        "<span>ECDD " + esc(report.uid || "") + " &middot; " + esc(report.caseNumber || "") + "</span>" +
        '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>' +
        "</div>",
      margin: { top: "18mm", bottom: "20mm", left: "14mm", right: "14mm" },
    });

    const safeName = String(report.uid || report._id).replace(/[^A-Za-z0-9._-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="ECDD_' + safeName + '.pdf"');
    res.send(Buffer.from(pdfBuffer));
  } finally {
    if (browser) await browser.close();
  }
});

