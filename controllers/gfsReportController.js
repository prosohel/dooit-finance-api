// controllers/gfsController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const GFS = require("../models/gfsReport");
const { resolveCaseLinkage, hasLinkageRef, linkageOverrides } = require("../utils/resolveCaseLinkage");
const sendEmail = require("../utils/sendEmail");
const { logEvent } = require("../utils/audit");

/**
 * Helper: try to parse stringified JSON input for fields that might arrive as strings.
 * (Same approach recommended earlier.)
 */
function tryParseJSON(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    try {
      const fixed = trimmed
        .replace(/(\r\n|\n|\r)/gm, " ")
        .replace(/(\s)+/g, " ")
        .replace(/'/g, '"');
      return JSON.parse(fixed);
    } catch (err2) {
      return value;
    }
  }
}

/**
 * Basic normalization for array/object fields that are often stringified by clients.
 */
function normalizeInput(body) {
  if (!body || typeof body !== "object") return body;
  const normalized = { ...body };

  // parse arrays/objects commonly stringified
  const fieldsToTry = [
    "transactions",
    "ofis",
    "pois",
    "cryptoAddresses",
    "ipAddresses",
    "attachments",
  ];

  fieldsToTry.forEach((f) => {
    if (normalized[f] !== undefined) {
      const parsed = tryParseJSON(normalized[f]);
      // wrap single object into array when appropriate
      if (
        parsed &&
        !Array.isArray(parsed) &&
        f !== "cryptoAddresses" &&
        f !== "attachments"
      ) {
        normalized[f] = [parsed];
      } else if (parsed !== undefined) {
        normalized[f] = parsed;
      } else {
        normalized[f] = normalized[f];
      }
    }
  });

  return normalized;
}

/* Filter helper for advancedResults POST filtering */
exports.filterGFSSection = (doc, requestBody = {}) => {
  if (!requestBody) return true;
  if (requestBody.customerName) {
    return (
      doc.customerName &&
      doc.customerName
        .toLowerCase()
        .includes(requestBody.customerName.toLowerCase())
    );
  }
  if (requestBody.customerUID) {
    return doc.customerUID && doc.customerUID === requestBody.customerUID;
  }
  return true;
};

// @desc Get list (via advancedResults)
exports.getGFSList = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// @desc POST search list (body filter)
exports.getGFSListPost = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// @desc Create new GFS
exports.createGFS = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  const body = normalizeInput(req.body || {});

  // minimal server-side validation - ensure customerName or customerUID present
  if (!body.customerName && !body.customerUID) {
    return next(
      new ErrorResponse("customerName or customerUID is required", 400)
    );
  }

  const link = await resolveCaseLinkage({
    caseId: body.caseId || body.case,
    caseNumber: body.caseNumber || body.referenceNumber,
  });

  // create document
  const gfs = await GFS.create({
    ...body,
    client,
    branch,
    customer: body.customer || link.customer,
    case: link.caseId, // Case hub (null until the alert is escalated)
    alert: link.alert, // originating Alert (provenance)
    // ensure numeric defaults
    totalDeposited: Number(body.totalDeposited) || 0,
    totalWithdrawn: Number(body.totalWithdrawn) || 0,
    totalSuspicionAmount: Number(body.totalSuspicionAmount) || 0,
    metadata: {
      ...body.metadata,
      createdBy: req.user?.id || body.metadata?.createdBy,
    },
  });

  logEvent({
    req,
    service: "report",
    action: "gfs_created",
    reportType: "GFS",
    target: gfs.uid || String(gfs._id),
    case: gfs.case || null,
    customer: gfs.customer || null,
    afterValue: { status: gfs.status },
  });

  res.status(201).json({ succeed: true, data: gfs, id: gfs._id });
});

// @desc Create dummy GFS (quickly create a test record)
exports.createDummyGFS = asyncHandler(async (req, res, next) => {
  const {
    customerName = "John Doe",
    customerUID = `DUMMY_${Date.now()}`,
    companyName = "Acme Bank",
  } = req.body || {};

  const gfs = await GFS.create({
    customerName,
    customerUID,
    companyName,
    suspicionReason: "Unusually large transfer",
    reviewStartDate: new Date(),
    reviewEndDate: new Date(),
    totalDeposited: 10000,
    totalSuspicionAmount: 10000,
    ofis: [
      {
        id: Date.now().toString(),
        name: "Reporting Bank",
        reportDate: new Date(),
        scamType: "Fraud",
      },
    ],
    transactions: [
      {
        id: Date.now().toString(),
        date: new Date(),
        amount: 10000,
        type: "transfer",
        fromBank: "XYZ Bank",
        fromAccount: "123456",
        fromName: "Unknown",
        toAccount: customerUID,
        reference: "TX-12345",
      },
    ],
    metadata: {
      createdBy: req.user?.id || null,
    },
    status: "draft",
  });

  res.status(201).json({ succeed: true, data: gfs, id: gfs._id });
});

// @desc Get single GFS by id
exports.getGFS = asyncHandler(async (req, res, next) => {
  const gfs = await GFS.findById(req.params.id);
  if (!gfs)
    return next(
      new ErrorResponse(`GFS not found with id ${req.params.id}`, 404)
    );
  res.status(200).json({ succeed: true, data: gfs });
});

// @desc Update GFS
exports.updateGFS = asyncHandler(async (req, res, next) => {
  const gfsId = req.params.id;
  let gfs = await GFS.findById(gfsId);
  if (!gfs)
    return next(new ErrorResponse(`GFS not found with id ${gfsId}`, 404));

  const body = normalizeInput(req.body || {});

  // Fields the analyst actually changed become theirs: a re-draft from the
  // case (Investigation Hub) must not overwrite them. The form re-sends every
  // value, so only real changes count.
  const { changedKeys, EDITABLE_FIELDS } = require("../services/reportDrafts");
  delete body.editedFields;
  const edited = changedKeys(gfs, body, EDITABLE_FIELDS.gfs);

  // merge updates
  const prevStatus = gfs.status;
  Object.assign(gfs, body);
  if (edited.length) {
    gfs.editedFields = [...new Set([...(gfs.editedFields || []), ...edited])];
  }
  if (hasLinkageRef(body)) Object.assign(gfs, await linkageOverrides(body, "case"));
  gfs.metadata = gfs.metadata || {};
  gfs.metadata.updatedBy = req.user?.id || gfs.metadata.updatedBy;

  await gfs.save();

  logEvent({
    req,
    service: "report",
    action: "gfs_updated",
    reportType: "GFS",
    target: gfs.uid || String(gfs._id),
    case: gfs.case || null,
    customer: gfs.customer || null,
    ...(prevStatus !== gfs.status
      ? { beforeValue: { status: prevStatus }, afterValue: { status: gfs.status } }
      : {}),
  });

  res.status(200).json({ succeed: true, data: gfs });
});

// @desc Delete GFS
exports.deleteGFS = asyncHandler(async (req, res, next) => {
  const gfs = await GFS.findById(req.params.id);
  if (!gfs)
    return next(
      new ErrorResponse(`GFS not found with id ${req.params.id}`, 404)
    );
  // Snapshot before the delete — this is the only surviving record once the
  // doc (and any workflow history on it) is gone.
  const snapshot = {
    uid: gfs.uid,
    status: gfs.status,
    case: gfs.case,
    customer: gfs.customer,
  };
  await gfs.deleteOne();

  logEvent({
    req,
    service: "report",
    action: "gfs_deleted",
    reportType: "GFS",
    target: snapshot.uid || String(gfs._id),
    case: snapshot.case || null,
    customer: snapshot.customer || null,
    beforeValue: snapshot,
  });

  res.status(200).json({ succeed: true, data: req.params.id });
});

/**
 * @desc Generate a plain-text report from stored GFS data (and optionally store it)
 * @route PUT /api/v1/gfs/:id/generate-report
 * @body { save: boolean } -> if save true store generatedReport in doc
 */
exports.generateReport = asyncHandler(async (req, res, next) => {
  const gfs = await GFS.findById(req.params.id);
  if (!gfs)
    return next(
      new ErrorResponse(`GFS not found with id ${req.params.id}`, 404)
    );

  // build report text similar to client-side generator
  const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString() : n || 0);
  const ofiText = (gfs.ofis || [])
    .map(
      (ofi) =>
        `On ${
          ofi.reportDate
            ? new Date(ofi.reportDate).toISOString().split("T")[0]
            : "N/A"
        }, "${gfs.companyName}" received multiple third-party requests from ${
          ofi.name
        } pertaining to fraudulent transactions related to ${ofi.scamType}.`
    )
    .join("\n\n");

  const txText = (gfs.transactions || [])
    .map((t) => {
      const dateStr = t.date
        ? new Date(t.date).toISOString().split("T")[0]
        : "N/A";
      const reportedBy = gfs.ofis && gfs.ofis[0] ? gfs.ofis[0].name : "OFI";
      return `• ${t.type || "Transaction"} of $${fmtNum(t.amount)} from ${
        t.fromBank || "N/A"
      } account ${t.fromAccount || "N/A"} in the name of "${
        t.fromName || "N/A"
      }" to "${gfs.companyName}" account "${
        t.toAccount || gfs.customerUID
      }" on "${dateStr}"${
        t.reference
          ? ` which was reported as a fraudulent transaction by ${reportedBy} with reference number "${t.reference}"`
          : ""
      }.`;
    })
    .join("\n\n");

  const cryptoList = (gfs.cryptoAddresses || [])
    .map((a) => `"${a}"`)
    .join(", ");
  const ipNote =
    gfs.ipAddresses && gfs.ipAddresses.length > 0
      ? `In addition, IP addresses used were located within ${
          gfs.ipAddresses[0].country || "N/A"
        } whereas identification is from ${gfs.customerCountry || "N/A"}.`
      : "";

  const report = `This report relates to suspicion: ${
    gfs.suspicionReason || "(not specified)"
  } for "${gfs.customerName || "(unknown)"}".
It appears the customer's identity might have been used to attempt to transfer funds of fraudulent origin.

Customer Profile:
"${gfs.companyName || ""}" account "${gfs.customerUID || ""}" in the name of "${
    gfs.customerName || ""
  }", aged ${gfs.customerAge || "N/A"} years, opened on "${
    gfs.accountOpeningDate
      ? new Date(gfs.accountOpeningDate).toISOString().split("T")[0]
      : "N/A"
  }".
Source of funds: ${gfs.sourceOfFunds || "N/A"}. Account opening purpose: ${
    gfs.accountOpeningPurpose || "N/A"
  }.

Transaction Analysis:
Review period: ${
    gfs.reviewStartDate
      ? new Date(gfs.reviewStartDate).toISOString().split("T")[0]
      : "N/A"
  } to ${
    gfs.reviewEndDate
      ? new Date(gfs.reviewEndDate).toISOString().split("T")[0]
      : "N/A"
  }.
Total deposited: $${fmtNum(gfs.totalDeposited)}. ${
    gfs.transactions && gfs.transactions.length > 0
      ? "Key transactions:\n\n" + txText
      : "No transactions recorded."
  }

${ofiText ? ofiText + "\n\n" : ""}

All funds were transferred to ${
    gfs.cryptoAddresses.length
  } crypto wallet address(es): ${cryptoList}.

Conclusion:
It was reported by ${
    (gfs.ofis || []).map((o) => `"${o.name}"`).join(", ") || "N/A"
  } that the account held by "${
    gfs.customerName || ""
  }" is the recipient of funds of suspected fraudulent origin totalling $${fmtNum(
    gfs.totalSuspicionAmount
  )}.

${ipNote}

${gfs.additionalNotes ? "Additional Notes:\n" + gfs.additionalNotes : ""}`;

  // optionally save generated report into doc
  if (req.body && req.body.save) {
    gfs.generatedReport = report;
    gfs.metadata = gfs.metadata || {};
    gfs.metadata.updatedBy = req.user?.id || gfs.metadata.updatedBy;
    await gfs.save();
  }

  logEvent({
    req,
    service: "report",
    action: "gfs_generated",
    reportType: "GFS",
    target: gfs.uid || String(gfs._id),
    case: gfs.case || null,
    customer: gfs.customer || null,
    afterValue: { saved: !!req.body?.save },
  });

  res
    .status(200)
    .json({ succeed: true, data: { report, saved: !!req.body?.save } });
});

/**
 * Submit GFS
 * PUT /api/v1/gfs/:id/submit
 * Body (optional): { notes: string, notify: boolean, notifyEmail: string }
 */
exports.submitGFS = asyncHandler(async (req, res, next) => {
  const gfs = await GFS.findById(req.params.id);
  if (!gfs)
    return next(
      new ErrorResponse(`GFS not found with id ${req.params.id}`, 404)
    );

  // prevent re-submitting closed records
  if (
    gfs.status === "submitted" ||
    gfs.status === "closed" ||
    gfs.status === "review"
  ) {
    return next(
      new ErrorResponse(`GFS already submitted / in review or closed`, 400)
    );
  }

  const fromStatus = gfs.status;
  gfs.status = "submitted";
  gfs.metadata = gfs.metadata || {};
  gfs.metadata.submissionDate = new Date();
  gfs.metadata.updatedBy = req.user?.id || gfs.metadata.updatedBy;

  // append workflow event
  gfs.metadata.workflowHistory = gfs.metadata.workflowHistory || [];
  gfs.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "submitted",
    fromStatus,
    toStatus: gfs.status,
    notes: req.body?.notes || "Submitted via API",
  });

  await gfs.save();

  logEvent({
    req,
    service: "report",
    action: "gfs_submitted",
    reportType: "GFS",
    target: gfs.uid || String(gfs._id),
    case: gfs.case || null,
    customer: gfs.customer || null,
    beforeValue: { status: fromStatus },
    afterValue: { status: gfs.status },
  });

  // optional notify email (basic)
  if (req.body?.notify && req.body?.notifyEmail) {
    try {
      const subject = `GFS submitted — ${
        gfs.customerName || gfs.customerUID || gfs.uid
      }`;
      const text = `GFS ${gfs.uid || ""} for ${
        gfs.customerName || gfs.customerUID || "unknown"
      } has been submitted by ${
        req.user?.name || req.user?.id || "system"
      }.\n\nNotes: ${req.body?.notes || ""}\n\nView in the admin panel.`;
      await sendEmail({
        to: req.body.notifyEmail,
        subject,
        text,
      });
    } catch (err) {
      // don't fail the submission due to email failure; log and continue
      console.warn("GFS submit: notify email failed", err);
    }
  }

  res.status(200).json({ succeed: true, data: gfs });
});

// @desc   Export a single GFS report as a filing-grade PDF
// @route  GET /api/v1/gfs-report/:id/export-pdf
// @access Private
//
// The on-screen detail view is a working surface; this is the artefact an
// analyst attaches to a case pack or hands to a compliance officer, so it
// carries its own provenance (report UID, case, status, generation time) and
// a page footer, the same way the SMR and ECDD exports do. Document
// composition is kept separate from transport so the layout can be inspected
// without launching a browser — exported for that reason; the handler below
// is its only caller in production.
const buildGfsReportHtml = (report) => {
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  // Every empty value renders as an em dash rather than "undefined" — a filed
  // report must not look like a rendering fault.
  const val = (v) => (v === 0 ? "0" : v ? esc(v) : "&mdash;");

  const fmtDate = (d) =>
    d && !Number.isNaN(new Date(d).getTime())
      ? new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" })
      : "&mdash;";

  const fmtDateTime = (d) =>
    d && !Number.isNaN(new Date(d).getTime())
      ? new Date(d).toLocaleString("en-AU", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "&mdash;";

  const money = (n) =>
    Number.isFinite(Number(n))
      ? "$" + Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "&mdash;";

  const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;

  const narrative = (text) =>
    text ? `<p class="narr">${esc(text).replace(/\n/g, "<br/>")}</p>` : `<p class="narr muted">Not recorded.</p>`;

  const meta = report.metadata || {};
  const caseUid = meta.caseUid || (report.case ? String(report.case) : null);
  const totalDeposited = Number(report.totalDeposited) || 0;
  const totalWithdrawn = Number(report.totalWithdrawn) || 0;
  const totalSuspicion = Number(report.totalSuspicionAmount) || 0;
  const percentOfInflow = totalDeposited ? Math.round((totalSuspicion / totalDeposited) * 100) : 0;

  const parties = [
    ...(report.ofis || []).map((o) => ({ ...o, kind: "OFI" })),
    ...(report.pois || []).map((p) => ({ ...p, kind: "POI" })),
  ];

  const partiesRows = parties.length
    ? parties
        .map(
          (p) => `<tr>
        <td><span class="tag">${esc(p.kind)}</span></td>
        <td><strong>${val(p.name)}</strong></td>
        <td>${p.kind === "OFI" ? val(p.scamType) : [p.bank, p.account].filter(Boolean).map(esc).join(" &middot; ") || "&mdash;"}</td>
        <td>${p.kind === "OFI" ? fmtDate(p.reportDate) : val(p.reference)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="muted">No institutions or parties recorded.</td></tr>`;

  const transactionBlocks = (report.transactions || []).length
    ? report.transactions
        .map(
          (t, i) => `
    <div class="txn">
      <div class="txn-head">
        <span><strong>Transaction ${i + 1} of ${report.transactions.length}</strong> &nbsp;&middot;&nbsp; ${val(t.type)}</span>
        <span class="amt">${money(t.amount)}</span>
      </div>
      <table class="kv">
        ${row("Date", fmtDateTime(t.date))}
        ${row("From bank", val(t.fromBank))}
        ${row("From name", val(t.fromName))}
        ${row("From account", `<span class="mono">${val(t.fromAccount)}</span>`)}
        ${row("To account", `<span class="mono">${val(t.toAccount)}</span>`)}
        ${row("Reference", `<span class="mono">${val(t.reference)}</span>`)}
        ${t.cryptoAddress ? row("Crypto address", `<span class="mono">${esc(t.cryptoAddress)}</span>`) : ""}
      </table>
    </div>`
        )
        .join("")
    : `<p class="narr muted">No transactions recorded.</p>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 16mm 13mm 18mm; }
  :root { color-scheme: only light; }
  * { box-sizing: border-box; }
  html, body { background: #ffffff; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 9px;
         color: #20232a; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .masthead { border-bottom: 2px solid #005964; padding-bottom: 9px; margin-bottom: 13px; overflow: hidden; }
  .masthead .brand { font-size: 7.5px; letter-spacing: 0.14em; text-transform: uppercase; color: #005964; font-weight: bold; }
  .masthead h1 { font-size: 16px; margin: 4px 0 2px; color: #14161a; }
  .masthead .sub { color: #71767f; font-size: 8.5px; }
  .masthead .right { float: right; text-align: right; font-size: 8px; color: #71767f; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 7.5px;
            font-weight: bold; text-transform: uppercase; letter-spacing: 0.06em;
            background: #fff1f6; color: #ca2f7f; border: 1px solid #fbd3e3; }

  h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #005964;
       border-bottom: 1px solid #e4e6ea; padding-bottom: 4px; margin: 15px 0 8px; page-break-after: avoid; }

  table { width: 100%; border-collapse: collapse; }
  table.kv th { text-align: left; width: 30%; background: #f6f8f8; color: #3d4048; font-weight: 600;
                padding: 4px 7px; border: 1px solid #e4e6ea; vertical-align: top; }
  table.kv td { padding: 4px 7px; border: 1px solid #e4e6ea; vertical-align: top; }
  table.grid th { background: #005964; color: #fff; text-align: left; padding: 4px 7px; font-size: 8px; }
  table.grid td { border: 1px solid #e4e6ea; padding: 4px 7px; vertical-align: top; }
  tr { page-break-inside: avoid; }
  .tag { display: inline-block; font-size: 7px; font-weight: bold; letter-spacing: 0.05em; text-transform: uppercase;
         color: #005964; background: #eef6f7; border: 1px solid #cfe3e6; border-radius: 8px; padding: 1px 6px; }

  .narr { font-size: 9px; line-height: 1.55; color: #3d4048; margin: 0 0 7px; text-align: justify; }
  .quote { border-left: 3px solid #005964; padding-left: 12px; }
  .muted { color: #9aa0aa; }
  .mono { font-family: Consolas, "Courier New", monospace; font-size: 8px; word-break: break-all; }

  .amounts { display: flex; gap: 18px; margin: 4px 0 10px; }
  .amounts .item { border: 1px solid #e4e6ea; border-radius: 6px; padding: 7px 10px; flex: 1; }
  .amounts .item .lbl { font-size: 7px; text-transform: uppercase; letter-spacing: 0.06em; color: #9aa0aa; }
  .amounts .item .val { font-size: 13px; font-weight: bold; color: #14161a; margin-top: 2px; }
  .amounts .item.flag .val { color: #ca2f7f; }

  .txn { border: 1px solid #e4e6ea; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; page-break-inside: avoid; }
  .txn-head { display: flex; justify-content: space-between; align-items: center; gap: 10px;
              background: #faf7f4; border: 1px solid #f0e6dc; border-radius: 5px; padding: 6px 10px; margin-bottom: 8px; font-size: 8.5px; }
  .txn-head .amt { font-size: 12px; font-weight: bold; color: #14161a; }

  .notice { margin-top: 14px; padding: 8px 10px; background: #fafbfb; border: 1px solid #e4e6ea;
            font-size: 7.5px; color: #71767f; line-height: 1.5; }
</style></head><body>

  <div class="masthead">
    <div class="right">
      <div><strong>${val(report.uid)}</strong></div>
      <div>Generated ${fmtDateTime(new Date())}</div>
    </div>
    <div class="brand">${esc(report.client?.name || "Dooit.ai")} &middot; Compliance</div>
    <h1>Grounds for Suspicion Report</h1>
    <div class="sub">
      ${caseUid ? `Case ${val(caseUid)} &nbsp;&middot;&nbsp; ` : ""}<span class="status">${val(report.status || "draft")}</span>
      &nbsp;&middot;&nbsp; Prepared in support of an AML/CTF Act suspicious matter escalation
    </div>
  </div>

  <h2>Report particulars</h2>
  <table class="kv">
    ${row("Report UID", `<span class="mono">${val(report.uid)}</span>`)}
    ${caseUid ? row("Case number", `<span class="mono">${val(caseUid)}</span>`) : ""}
    ${row("Sequence", report.sequence != null ? `#${esc(report.sequence)}` : "&mdash;")}
    ${row("Created", fmtDate(report.createdAt))}
    ${row("Status", val(report.status))}
  </table>

  <h2>Suspicion overview</h2>
  <table class="kv">
    ${row("Suspicion type", val(report.suspicionType))}
    ${row("Suspicion intensity", val(report.suspicionIntensity))}
    ${row("Suspicion dates", val(report.suspicionDates))}
    ${row("Review period", `${fmtDate(report.reviewStartDate)} &ndash; ${fmtDate(report.reviewEndDate)}`)}
  </table>
  <div class="amounts">
    <div class="item"><div class="lbl">Deposited</div><div class="val">${money(totalDeposited)}</div></div>
    <div class="item"><div class="lbl">Withdrawn</div><div class="val">${money(totalWithdrawn)}</div></div>
    <div class="item flag"><div class="lbl">Assessed suspicious</div><div class="val">${money(totalSuspicion)}</div></div>
    <div class="item"><div class="lbl">Of inflow</div><div class="val">${percentOfInflow}%</div></div>
  </div>
  <h3 style="font-size:9px;margin:8px 0 4px;">Suspicion reason</h3>
  <div class="quote">${narrative(report.suspicionReason)}</div>

  ${
    report.suspicionBehaviour
      ? `<h2>Behavioural analysis</h2>${narrative(report.suspicionBehaviour)}`
      : ""
  }

  <h2>Customer information</h2>
  <table class="kv">
    ${row("Customer name", val(report.customerName))}
    ${row("Customer UID", `<span class="mono">${val(report.customerUID)}</span>`)}
    ${row("Company name", val(report.companyName))}
    ${row("Age", val(report.customerAge))}
    ${row("Account opening date", fmtDateTime(report.accountOpeningDate))}
    ${row("Source of funds", val(report.sourceOfFunds))}
    ${row("Account opening purpose", val(report.accountOpeningPurpose))}
    ${row("Customer country", val(report.customerCountry))}
  </table>

  <h2>Institutions and parties</h2>
  <table class="grid">
    <thead><tr><th style="width:10%">Type</th><th style="width:28%">Name</th><th style="width:37%">Detail</th><th style="width:25%">Date / reference</th></tr></thead>
    <tbody>${partiesRows}</tbody>
  </table>

  <h2>Transactions</h2>
  ${transactionBlocks}

  ${
    (report.cryptoAddresses || []).length || (report.ipAddresses || []).length
      ? `<h2>Digital footprint</h2>
    ${
      (report.cryptoAddresses || []).length
        ? `<h3 style="font-size:9px;margin:8px 0 4px;">Crypto addresses</h3><p class="narr mono">${report.cryptoAddresses.map(esc).join("<br/>")}</p>`
        : ""
    }
    ${
      (report.ipAddresses || []).length
        ? `<table class="kv">${report.ipAddresses
            .map((ip) => row(`<span class="mono">${val(ip.address)}</span>`, `${val(ip.country)} &middot; ${fmtDateTime(ip.date)}`))
            .join("")}</table>`
        : ""
    }`
      : ""
  }

  ${
    report.additionalNotes || (report.attachments || []).length
      ? `<h2>Additional notes</h2>
    ${report.additionalNotes ? narrative(report.additionalNotes) : ""}
    ${
      (report.attachments || []).length
        ? `<p class="narr muted">Attachments: ${report.attachments.map(esc).join(", ")}</p>`
        : ""
    }`
      : ""
  }

  <div class="notice">
    This document is a system-generated Grounds for Suspicion report prepared for internal AML/CTF review.
    Figures are derived from platform data as at the time of generation and have not been independently verified.
  </div>

</body></html>`;
};

exports.buildGfsReportHtml = buildGfsReportHtml;

exports.exportGfsReportPdf = asyncHandler(async (req, res, next) => {
  const { launchPdfBrowser } = require("../utils/puppeteerLaunch");

  const report = await GFS.findById(req.params.id).populate("client").lean();

  if (!report) {
    return next(new ErrorResponse(`GFS not found with id ${req.params.id}`, 404));
  }

  const html = buildGfsReportHtml(report);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  let browser;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      // A filed report is photocopied and separated from the rest of the pack;
      // every page carries the uid and its position so a loose sheet stays identifiable.
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="width:100%; font-size:7px; color:#8a8a8a; padding:0 13mm;' +
        'font-family: Helvetica, Arial, sans-serif; display:flex; justify-content:space-between;">' +
        "<span>GFS " +
        esc(report.uid || "") +
        "</span>" +
        '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>' +
        "</div>",
      margin: { top: "16mm", bottom: "18mm", left: "13mm", right: "13mm" },
    });

    const safeName = String(report.uid || report._id).replace(/[^A-Za-z0-9._-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="GFS_' + safeName + '.pdf"');
    res.send(Buffer.from(pdfBuffer));
  } finally {
    if (browser) await browser.close();
  }
});

/**
 * Approve GFS
 * PUT /api/v1/gfs/:id/approve
 * Body (optional): { notes: string, notify: boolean, notifyEmail: string, finalStatus: "closed"|"review" }
 *
 * - this will set status to 'closed' by default and record approvedBy/approvedAt
 */
exports.approveGFS = asyncHandler(async (req, res, next) => {
  const gfs = await GFS.findById(req.params.id);
  if (!gfs)
    return next(
      new ErrorResponse(`GFS not found with id ${req.params.id}`, 404)
    );

  // Only allow approve if submitted or in review (you can relax/adjust logic)
  if (!["submitted", "review"].includes(gfs.status)) {
    return next(
      new ErrorResponse(
        `Only submitted/review GFS can be approved. Current status: ${gfs.status}`,
        400
      )
    );
  }

  const fromStatus = gfs.status;
  const finalStatus = req.body?.finalStatus || "closed"; // default to closed
  gfs.status = finalStatus;
  gfs.metadata = gfs.metadata || {};
  gfs.metadata.approvedBy = req.user?.id;
  gfs.metadata.approvedAt = new Date();
  gfs.metadata.updatedBy = req.user?.id;

  // append workflow event
  gfs.metadata.workflowHistory = gfs.metadata.workflowHistory || [];
  gfs.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "approved",
    fromStatus,
    toStatus: gfs.status,
    notes: req.body?.notes || "Approved via API",
  });

  await gfs.save();

  logEvent({
    req,
    service: "report",
    action: "gfs_approved",
    reportType: "GFS",
    target: gfs.uid || String(gfs._id),
    case: gfs.case || null,
    customer: gfs.customer || null,
    beforeValue: { status: fromStatus },
    afterValue: { status: gfs.status }, // finalStatus: "closed" by default, or "review"
  });

  // optional notify email
  if (req.body?.notify && req.body?.notifyEmail) {
    try {
      const subject = `GFS approved — ${
        gfs.customerName || gfs.customerUID || gfs.uid
      }`;
      const text = `GFS ${gfs.uid || ""} for ${
        gfs.customerName || gfs.customerUID || "unknown"
      } has been approved by ${
        req.user?.name || req.user?.id || "system"
      }.\n\nNotes: ${req.body?.notes || ""}\n\nStatus: ${gfs.status}`;
      await sendMail({
        to: req.body.notifyEmail,
        subject,
        text,
      });
    } catch (err) {
      console.warn("GFS approve: notify email failed", err);
    }
  }

  res.status(200).json({ succeed: true, data: gfs });
});
