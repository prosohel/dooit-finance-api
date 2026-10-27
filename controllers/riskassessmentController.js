const asyncHandler = require("../middleware/async");
const CountryRisk = require("../models/CountryRisk");
const Customer = require("../models/Customer");
const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
const RiskFactorOption = require("../models/RiskFactorOption");
const AuditLog = require("../models/AuditLog");
const { logCraEvent } = require("../utils/craAudit");
const { deriveClientEntityTypes } = require("../utils/craEntityType");
const { Parser } = require("json2csv");
const { Readable } = require("stream");



const csv = require("csv-parser");
const fs = require("fs");



function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}
const {
  FACTORS,
  UHRC,
  HRC,
  MRC,
  LRC,
  buildRiskAssessmentFromCustomer,
  buildRiskAssessmentPerRelation,
} = require("../utils/riskAssessment");

// build score map from FACTORS.jurisdiction
const bandScoreMap = FACTORS.jurisdiction.reduce((acc, cur) => {
  acc[cur.value] = cur.score;
  return acc;
}, {});

function titleCase(s) {
  return s.replace(
    /\w\S*/g,
    (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
  );
}

function buildCountryRiskList() {
  const list = [];

  const pushSet = (set, band) => {
    const score = bandScoreMap[band] || 0;
    for (const c of set) {
      list.push({
        country: titleCase(c),
        band,
        score,
      });
    }
  };

  pushSet(UHRC, "UHRC");
  pushSet(HRC, "HRC");
  pushSet(MRC, "MRC");
  pushSet(LRC, "LRC");

  // dedupe (in case any country appears twice with variants)
  const map = new Map();
  for (const item of list) {
    const key = item.country.toLowerCase();
    if (!map.has(key)) map.set(key, item);
  }

  // sort by country name for dropdown UX
  return Array.from(map.values()).sort((a, b) =>
    a.country.localeCompare(b.country),
  );
}

async function buildCountryRiskListFromDB() {
  const rows = await CountryRisk.find({})
    .select("country band score")
    .lean();

  return rows
    .map(r => ({
      country: titleCase(r.country),
      band: r.band,
      score: r.score,
    }))
    .sort((a, b) => a.country.localeCompare(b.country));
}


// exports.getRiskFactors = asyncHandler(async (req, res, next) => {
//   // send FACTORS as-is (client uses value/score lists for dropdowns)
//   const data = buildCountryRiskList();

//   return res.json({ success: true, data: { ...FACTORS, countries: data } });
// });

exports.getRiskFactors = asyncHandler(async (req, res) => {
  // ?entityType=Banks & ADIs — narrows the product catalogue to one entity type
  const { entityType } = req.query;

  const rows = await RiskFactorOption.find({})
    .select("factor value score risk industry entityType ecddOverride notes")
    .lean();

  // group by factor
  const grouped = {};
  const entityTypes = new Set();

  for (const r of rows) {
    if (r.factor === "product" && r.entityType) entityTypes.add(r.entityType);
    if (
      r.factor === "product" &&
      entityType &&
      (r.entityType || "").toLowerCase() !== entityType.toLowerCase()
    )
      continue;

    if (!grouped[r.factor]) grouped[r.factor] = [];
    grouped[r.factor].push({
      value: r.value,
      score: r.score,
      risk: r.risk || null,
      industry: r.industry || null,
      entityType: r.entityType || null,
      ecddOverride: !!r.ecddOverride,
      notes: r.notes || null,
    });
  }

  const countries = await buildCountryRiskListFromDB();

  // entity type(s) registered on the requesting client's EntityProfile(s) —
  // lets the wizard preselect instead of asking
  const derivedEntityTypes = await deriveClientEntityTypes(req.user?.client?._id);

  res.json({
    success: true,
    data: {
      ...grouped,
      entityTypes: [...entityTypes].sort(),
      derivedEntityTypes,
      countries,
    },
  });
});


exports.getJurisdictions = asyncHandler(async (req, res, next) => {
  const data = await buildCountryRiskListFromDB();

  res.json({
    success: true,
    count: data.length,
    data,
  });
});

/**
 * Build display name safely
 */
function buildCustomerName(c) {
  const d = c.personalKyc?.personal_form?.customer_details;

  if (!d) return c.uid || "Unnamed";

  const parts = [d.given_name, d.middle_name, d.surname].filter(Boolean);

  if (parts.length) return parts.join(" ");

  return c.uid || "Unnamed";
}

/**
 * GET /api/customers/dropdown
 * Query:
 *   ?q=search
 *   ?limit=50
 *   ?client=clientId (admins only — filter by relation.client)
 */
exports.getCustomerDropdown = asyncHandler(async (req, res) => {
  const { q = "", limit = 50, client } = req.query;
  const { searchCustomers } = require("../utils/customerSearch");
  // A tenant user is always pinned to their own client (and branch); only a
  // platform user with no tenant may pick one. `?client=` used to override the
  // caller's tenant, which listed other tenants' customers.
  const ownClient = req.user?.client?._id || req.user?.clientBelongs || null;
  const ownBranch = req.user?.branch?._id || req.user?.branchBelongs || null;
  const data = await searchCustomers({
    q,
    limit,
    clientId: ownClient || client || null,
    branchId: ownClient ? ownBranch : null,
  });
  res.json({ success: true, count: data.length, data });
});

/**
 * POST /api/risk/assess
 * Request body: { customer: {...} } OR full customer object body
 * Returns: { riskAssessment, riskScore, riskLabel } from buildRiskAssessmentFromCustomer
 */

/**
 * Reporting entity type vs the client's registered EntityProfile(s):
 *  • payload has no entityType → derive it when unambiguous (exactly one type)
 *  • payload entityType outside the registered types → allowed, but returns a
 *    mismatch warning that the caller records on the assessment's overrides
 *    (and therefore in the audit trail)
 *  • client with no entity profiles → no restriction (legacy behaviour)
 * Returns { mismatch: string|null }.
 */
async function applyDerivedEntityType(payload, req) {
  const derived = await deriveClientEntityTypes(req.user?.client?._id);

  const submitted = payload.entityType || payload.metadata?.entityType || "";
  if (submitted) {
    if (derived.length && !derived.includes(submitted)) {
      return {
        mismatch: `Entity type '${submitted}' differs from the registered entity profile (${derived.join(", ")}) — scored against another sector's product catalogue`,
      };
    }
    return { mismatch: null };
  }

  if (derived.length === 1) {
    payload.entityType = derived[0];
    if (payload.metadata) payload.metadata.entityType = derived[0];
  }
  return { mismatch: null };
}

exports.assessFromBody = asyncHandler(async (req, res) => {
  const payload = req.body;

  if (!payload || Object.keys(payload).length === 0) {
    return res.status(400).json({
      success: false,
      message: "Missing customer payload",
    });
  }

  const { mismatch } = await applyDerivedEntityType(payload, req);

  // 1️⃣ compute
  const result = buildRiskAssessmentFromCustomer(payload);
  if (mismatch) result.overrides = [...(result.overrides || []), mismatch];
  const { summary } = buildRiskAssessmentPerRelation(payload);
  // const { relationRisks } = buildRiskAssessmentPerRelation(payload);

  // 5️⃣ return saved doc
  res.json({
    success: true,
    data: {
      ...result,
      summary,
      // relationRisks
    },

  });
});

exports.assessFromBodySave = asyncHandler(async (req, res) => {
  const payload = req.body;
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  if (!payload || Object.keys(payload).length === 0) {
    return res.status(400).json({
      success: false,
      message: "Missing customer payload",
    });
  }

  const { mismatch } = await applyDerivedEntityType(payload, req);

  // 1️⃣ compute
  const result = buildRiskAssessmentFromCustomer(payload);
  if (mismatch) result.overrides = [...(result.overrides || []), mismatch];

  // 2️⃣ optional — try link real customer
  let customerDoc = null;

  if (payload.customerId) {
    customerDoc = await Customer.findById(payload.customerId)
      .select("uid personalKyc.personal_form.customer_details")
      .lean();
  }

  // 3️⃣ build display name
  const name =
    payload.name ||
    customerDoc?.personalKyc?.personal_form?.customer_details?.given_name ||
    "Unknown";

  // ECDD gate (Section 4): High/Unacceptable or any override blocks service
  // delivery until the CO approves or declines
  const ecddRequired = !!result.ecddRequired;

  // Review schedule (Section 4): next_review_date = today + 3y/2y/1y by band
  let nextReviewDate = null;
  if (result.reviewYears) {
    nextReviewDate = new Date();
    nextReviewDate.setFullYear(nextReviewDate.getFullYear() + result.reviewYears);
  }

  // 4️⃣ store snapshot
  const saved = await IndividualRiskAssessment.create({
    client,
    branch,
    customer: customerDoc?._id,
    customerUid: customerDoc?.uid,

    customerName: name,

    inputSnapshot: payload,
    assessment: result.riskAssessment,
    riskScore: result.riskScore,
    riskLabel: result.riskLabel,
    entityType: payload.entityType || payload.metadata?.entityType || "",
    overrides: result.overrides || [],
    serviceBlocked: !!result.serviceBlocked,

    ecddRequired,
    cddGate: ecddRequired,
    ecddStatus: ecddRequired ? "Pending" : "",
    nextReviewDate,

    assessedBy: req.user?._id || null,
    source: "api",
    version: 2, // CRA V2 scoring scale (1–5; bands 17/20/99/100)
  });

  // 5️⃣ audit trail (Section 4 — every CRA score/status change)
  await logCraEvent({
    req,
    assessment: saved,
    action: "CRA_CREATED",
    after: {
      riskScore: saved.riskScore,
      riskLabel: saved.riskLabel,
      ecddRequired: saved.ecddRequired,
      cddGate: saved.cddGate,
      nextReviewDate: saved.nextReviewDate,
      overrides: saved.overrides,
    },
    target: saved.customerName,
  });
  if (saved.serviceBlocked) {
    await logCraEvent({
      req,
      assessment: saved,
      action: "ESCALATION_RAISED",
      after: {
        riskLabel: saved.riskLabel,
        reason: "Service blocked — Unacceptable risk. Do not alert client. Contact ASO + AFP. SMR assessment.",
      },
      target: saved.customerName,
    });
  }

  // 6️⃣ return saved doc
  res.json({
    success: true,
    data: saved,
  });
});

/**
 * GET /api/customers/:id/risk?scope=relation|overall
 * Fetches customer from DB and runs assessment.
 * - scope=relation (default): run buildRiskAssessmentPerRelation -> returns relationRisks + summary
 * - scope=overall: run buildRiskAssessmentFromCustomer -> returns single overall
 */
exports.assessCustomerById = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const scope = (req.query.scope || "relation").toLowerCase();

  if (!id)
    return res.status(400).json({ success: false, message: "Missing id" });

  const customer = await Customer.findById(id).lean();
  if (!customer)
    return res
      .status(404)
      .json({ success: false, message: "Customer not found" });

  if (scope === "overall") {
    const result = buildRiskAssessmentFromCustomer(customer);
    return res.json({ success: true, data: result });
  } else {
    const result = buildRiskAssessmentPerRelation(customer);
    return res.json({ success: true, data: result });
  }
});

exports.getIndividualRiskAssessments = asyncHandler(async (req, res, next) => {
  // assumes advancedResults middleware populates res.advancedResults
  res.status(200).json(res.advancedResults);
});

exports.getIndividualRiskAssessment = asyncHandler(async (req, res) => {
  const doc = await IndividualRiskAssessment.findById(req.params.id)
    .populate("customer", "uid personalKyc")
    .populate("assessedBy", "name email")
    .populate("ecddReport", "uid analystName status recommendation date")
    .lean();
  if (!doc) return res.status(404).json({ success: false, message: "Assessment not found" });

  // Score display (spec Section 4): previous score + trend for re-assessed customers
  let previousAssessment = null;
  if (doc.customer) {
    previousAssessment = await IndividualRiskAssessment.findOne({
      customer: doc.customer._id || doc.customer,
      createdAt: { $lt: doc.createdAt },
      _id: { $ne: doc._id },
    })
      .sort({ createdAt: -1 })
      .select("uid riskScore riskLabel createdAt assessedBy")
      .populate("assessedBy", "name")
      .lean();
  }

  res.json({ success: true, data: { ...doc, previousAssessment } });
});

exports.updateIndividualRiskAssessment = asyncHandler(async (req, res) => {
  const existing = await IndividualRiskAssessment.findById(req.params.id).select("notes customer client branch customerName").lean();
  if (!existing) return res.status(404).json({ success: false, message: "Assessment not found" });

  const allowed = { notes: req.body.notes };
  const doc = await IndividualRiskAssessment.findByIdAndUpdate(req.params.id, allowed, { new: true });

  if ((existing.notes || "") !== (doc.notes || "")) {
    await logCraEvent({
      req,
      assessment: doc,
      action: "CRA_NOTES_UPDATED",
      before: { notes: existing.notes || "" },
      after: { notes: doc.notes || "" },
      target: doc.customerName,
    });
  }
  res.json({ success: true, data: doc });
});


//// Risk dynamic model manipulation 

// GET /risk/countries
// exports.getCountryRisks = asyncHandler(async (req, res) => {
//   const { q, band } = req.query;

//   const filter = {};

//   if (band) {
//     filter.band = band.toUpperCase();
//   }

//   if (q) {
//     filter.country = new RegExp(q, "i");
//   }

//   const rows = await CountryRisk.find(filter)
//     .sort({ country: 1 })
//     .lean();

//   res.json({
//     success: true,
//     count: rows.length,
//     data: rows,
//   });
// });

exports.getCountryRisks = asyncHandler(async (req, res, next) => {
  // assumes advancedResults middleware populates res.advancedResults
  res.status(200).json(res.advancedResults);
});


// POST /risk/countries
exports.createCountryRisk = asyncHandler(async (req, res) => {
  const payload = req.body;

  const createOne = (row) => {
    const band = row.band.toUpperCase();

    return {
      country: titleCase(row.country),
      band,
      score: row.score ?? bandScoreMap[band] ?? 0,
    };
  };

  let docs;

  if (Array.isArray(payload)) {
    docs = payload.map(createOne);
    docs = await CountryRisk.insertMany(docs);
  } else {
    docs = await CountryRisk.create(createOne(payload));
  }

  res.status(201).json({
    success: true,
    data: docs,
  });
});

// PUT /risk/countries/:id
exports.updateCountryRisk = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const update = { ...req.body };

  if (update.country) {
    update.country = titleCase(update.country);
  }

  if (update.band) {
    update.band = update.band.toUpperCase();
    if (update.score == null) {
      update.score = bandScoreMap[update.band] ?? 0;
    }
  }

  const doc = await CountryRisk.findByIdAndUpdate(id, update, {
    new: true,
    runValidators: true,
  });

  if (!doc) {
    return res.status(404).json({
      success: false,
      message: "Country risk not found",
    });
  }

  res.json({
    success: true,
    data: doc,
  });
});

exports.deleteCountryRisk = asyncHandler(async (req, res) => {


  const countryRisk = await CountryRisk.findById(req.params.id);
  if (!countryRisk) {
    return next(
      new ErrorResponse(`countryRisk not found with id of ${req.params.id}`, 404),
    );
  }

  user.deleteOne();

  res.status(200).json({
    success: true,
    data: req.params.id,
  });

  res.status(201).json({
    success: true,
    data: docs,
  });
});




// GET /risk/factors
// exports.getRiskFactorOptions = asyncHandler(async (req, res) => {
//   const { factor } = req.query;

//   const filter = {};
//   if (factor) filter.factor = factor;

//   const rows = await RiskFactorOption.find(filter)
//     .sort({ factor: 1, score: -1 })
//     .lean();

//   // if factor specified → return flat
//   if (factor) {
//     return res.json({
//       success: true,
//       count: rows.length,
//       data: rows,
//     });
//   }

//   // else group by factor
//   const grouped = {};

//   for (const r of rows) {
//     if (!grouped[r.factor]) grouped[r.factor] = [];

//     grouped[r.factor].push({
//       id: r._id,
//       value: r.value,
//       score: r.score,
//       risk: r.risk,
//       industry: r.industry,
//     });
//   }

//   res.json({
//     success: true,
//     data: grouped,
//   });
// });

exports.getRiskFactorOptions = asyncHandler(async (req, res, next) => {
  // assumes advancedResults middleware populates res.advancedResults
  res.status(200).json(res.advancedResults);
});



// POST /risk/factors
exports.createRiskFactorOption = asyncHandler(async (req, res) => {
  const payload = req.body;

  const normalize = (r) => ({
    factor: r.factor.toLowerCase(),
    value: r.value,
    score: r.score,
    risk: r.risk || null,
    industry: r.industry || null,
  });

  let docs;

  if (Array.isArray(payload)) {
    docs = await RiskFactorOption.insertMany(payload.map(normalize));
  } else {
    docs = await RiskFactorOption.create(normalize(payload));
  }

  res.status(201).json({
    success: true,
    data: docs,
  });
});


// PUT /risk/factors/:id
exports.updateRiskFactorOption = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const update = { ...req.body };

  if (update.factor) {
    update.factor = update.factor.toLowerCase();
  }

  const doc = await RiskFactorOption.findByIdAndUpdate(
    id,
    update,
    {
      new: true,
      runValidators: true,
    }
  );

  if (!doc) {
    return res.status(404).json({
      success: false,
      message: "Risk factor option not found",
    });
  }

  res.json({
    success: true,
    data: doc,
  });
});


// DELETE /risk/factors/:id
exports.deleteRiskFactorOption = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const doc = await RiskFactorOption.findByIdAndDelete(id);

  if (!doc) {
    return res.status(404).json({
      success: false,
      message: "Risk factor option not found",
    });
  }

  res.json({
    success: true,
    message: "Risk factor option deleted",
    data: doc._id,
  });
});

// =========================
// ✅ EXPORT — COUNTRY RISK → CSV
// =========================

exports.exportCountryRiskCsv = asyncHandler(async (req, res) => {
  const rows = await CountryRisk.find({})
    .select("country band score")
    .lean();

  const parser = new Parser({
    fields: ["country", "band", "score", "aliases", "source"],
  });

  const csv = parser.parse(rows);

  res.header("Content-Type", "text/csv");
  res.attachment("country-risk.csv");
  return res.send(csv);
});

// =========================
// ✅ EXPORT — RISK FACTORS → CSV
// =========================
exports.exportRiskFactorsCsv = asyncHandler(async (req, res) => {
  const rows = await RiskFactorOption.find({})
    .select("factor value score risk industry")
    .lean();

  const parser = new Parser({
    fields: ["factor", "value", "score", "risk", "industry"],
  });

  const csv = parser.parse(rows);

  res.header("Content-Type", "text/csv");
  res.attachment("risk-factors.csv");
  res.send(csv);
});




exports.importCountryRiskCsv = asyncHandler(async (req, res) => {

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "CSV file required",
    });
  }

  const rows = [];

  await new Promise((resolve, reject) => {
    bufferToStream(req.file.buffer)
      .pipe(csv())
      .on("data", (row) => {
        rows.push({
          country: row.country.toLowerCase().trim(),
          band: row.band.trim(),
          score: Number(row.score),
        });
      })
      .on("end", resolve)
      .on("error", reject);
  });

  await CountryRisk.deleteMany({});
  await CountryRisk.insertMany(rows);

  res.json({
    success: true,
    inserted: rows.length,
  });
});


exports.importRiskFactorsCsv = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "CSV file required",
    });
  }

  const rows = [];

  await new Promise((resolve, reject) => {
    bufferToStream(req.file.buffer)
      .pipe(csv())
      .on("data", (row) => {
        rows.push({
          factor: row.factor.toLowerCase().trim(),
          value: row.value.trim(),
          score: Number(row.score),
          risk: row.risk || null,
          industry: row.industry || null,
        });
      })
      .on("end", resolve)
      .on("error", reject);
  });

  await RiskFactorOption.deleteMany({});
  await RiskFactorOption.insertMany(rows);

  res.json({
    success: true,
    inserted: rows.length,
  });
});

// ── ECDD Gate ──────────────────────────────────────────────────────────────────

// @route POST /api/v1/risk-assessment/:id/ecdd-approve
/**
 * Resolve an optional ECDD report reference (Mongo _id or ECDD uid) supplied
 * with a gate decision. Returns the report (lean) or null; throws 404 via
 * ErrorResponse when an id was supplied but nothing matches.
 */
async function resolveEcddReport(ecddReportId) {
  if (!ecddReportId) return null;
  const EcddReport = require("../models/EcddReport");
  const mongoose = require("mongoose");
  const report = mongoose.isValidObjectId(ecddReportId)
    ? await EcddReport.findById(ecddReportId).select("uid riskAssessment").lean()
    : await EcddReport.findOne({ uid: ecddReportId }).select("uid riskAssessment").lean();
  if (!report) {
    const ErrorResponse = require("../utils/errorResponse");
    throw new ErrorResponse(`ECDD report not found: ${ecddReportId}`, 404);
  }
  return report;
}

exports.ecddApprove = asyncHandler(async (req, res, next) => {
  const { ecddReviewDate, ecddReportId } = req.body;
  // UI clients historically send `decision`; accept both keys
  const ecddDecision = req.body.ecddDecision ?? req.body.decision ?? "";
  const ErrorResponse = require("../utils/errorResponse");

  const existing = await IndividualRiskAssessment.findById(req.params.id)
    .select("ecddStatus cddGate ecddDecision customer client branch customerName").lean();
  if (!existing) return next(new ErrorResponse("CRA record not found", 404));

  const ecddReport = await resolveEcddReport(ecddReportId);

  const update = {
    ecddStatus: "Approved",
    cddGate: false,
    ecddDecision,
    ecddDecidedBy: req.user?.id || null,
    ecddDecidedAt: new Date(),
    ecddReviewDate: ecddReviewDate ? new Date(ecddReviewDate) : null,
  };
  if (ecddReport) update.ecddReport = ecddReport._id;
  const doc = await IndividualRiskAssessment.findByIdAndUpdate(req.params.id, update, { new: true });

  if (ecddReport && !ecddReport.riskAssessment) {
    const EcddReport = require("../models/EcddReport");
    await EcddReport.updateOne({ _id: ecddReport._id }, { $set: { riskAssessment: doc._id } });
  }

  await logCraEvent({
    req,
    assessment: doc,
    action: "ECDD_APPROVED",
    before: { ecddStatus: existing.ecddStatus, cddGate: existing.cddGate },
    after: {
      ecddStatus: doc.ecddStatus,
      cddGate: doc.cddGate,
      ecddDecision: doc.ecddDecision,
      ...(ecddReport ? { ecddReport: ecddReport.uid } : {}),
    },
    target: doc.customerName,
  });

  res.status(200).json({ success: true, data: doc });
});

// @route POST /api/v1/risk-assessment/:id/ecdd-decline
exports.ecddDecline = asyncHandler(async (req, res, next) => {
  const { ecddReportId } = req.body;
  // UI clients historically send `decision`; accept both keys
  const ecddDecision = req.body.ecddDecision ?? req.body.decision ?? "";
  const ErrorResponse = require("../utils/errorResponse");

  const existing = await IndividualRiskAssessment.findById(req.params.id)
    .select("ecddStatus cddGate ecddDecision customer client branch customerName").lean();
  if (!existing) return next(new ErrorResponse("CRA record not found", 404));

  const ecddReport = await resolveEcddReport(ecddReportId);

  const update = {
    ecddStatus: "Declined",
    cddGate: true,
    ecddDecision,
    ecddDecidedBy: req.user?.id || null,
    ecddDecidedAt: new Date(),
  };
  if (ecddReport) update.ecddReport = ecddReport._id;
  const doc = await IndividualRiskAssessment.findByIdAndUpdate(req.params.id, update, { new: true });

  if (ecddReport && !ecddReport.riskAssessment) {
    const EcddReport = require("../models/EcddReport");
    await EcddReport.updateOne({ _id: ecddReport._id }, { $set: { riskAssessment: doc._id } });
  }

  await logCraEvent({
    req,
    assessment: doc,
    action: "ECDD_DECLINED",
    before: { ecddStatus: existing.ecddStatus, cddGate: existing.cddGate },
    after: {
      ecddStatus: doc.ecddStatus,
      cddGate: doc.cddGate,
      ecddDecision: doc.ecddDecision,
      ...(ecddReport ? { ecddReport: ecddReport.uid } : {}),
    },
    target: doc.customerName,
  });

  // Offboard the linked customer (spec Section 4 ECDD gate:
  // "If CO clicks 'Decline': client status = 'Offboarded'.
  //  Audit log: CLIENT_OFFBOARDED with reason.")
  let customerOffboarded = false;
  if (doc.customer) {
    const customerBefore = await Customer.findById(doc.customer)
      .select("status isActive").lean();
    if (customerBefore) {
      const reason = ecddDecision || "ECDD declined by Compliance Officer";
      await Customer.updateOne(
        { _id: doc.customer },
        {
          $set: {
            status: "Offboarded",
            isActive: false, // drops out of customer dropdowns / active flows
            offboardedAt: new Date(),
            offboardedBy: req.user?.id || null,
            offboardReason: reason,
          },
        },
      );
      customerOffboarded = true;
      await logCraEvent({
        req,
        assessment: doc,
        action: "CLIENT_OFFBOARDED",
        before: { status: customerBefore.status || "", isActive: customerBefore.isActive },
        after: { status: "Offboarded", isActive: false, reason },
        target: doc.customerName,
      });
    }
  }

  res.status(200).json({ success: true, data: doc, customerOffboarded });
});

// ── CRA Activity Audit Trail (Section 4) ─────────────────────────────────────

// @route GET /api/v1/risk-assessment/:id/audit
exports.getCraAuditTrail = asyncHandler(async (req, res) => {
  const entries = await AuditLog.find({ service: "cra", assessment: req.params.id })
    .select("action actorName actorRole beforeValue afterValue target linkedMatterId createdAt")
    .sort({ createdAt: -1 })
    .lean();

  res.json({ success: true, count: entries.length, data: entries });
});

// @route GET /api/v1/risk-assessment/:id/audit/export
// InfoTrack-style Activity Audit Trail PDF
exports.exportCraAuditPdf = asyncHandler(async (req, res, next) => {
  const ErrorResponse = require("../utils/errorResponse");
  const { launchPdfBrowser } = require("../utils/puppeteerLaunch");

  const assessment = await IndividualRiskAssessment.findById(req.params.id).lean();
  if (!assessment) return next(new ErrorResponse("CRA record not found", 404));

  const entries = await AuditLog.find({ service: "cra", assessment: req.params.id })
    .sort({ createdAt: 1 })
    .lean();

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
  const fmtJson = (v) =>
    v == null ? "—" : esc(typeof v === "string" ? v : JSON.stringify(v, null, 1));
  const fmtDate = (d) =>
    new Date(d).toLocaleString("en-AU", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });

  const rows = entries
    .map(
      (e) => `
      <tr>
        <td>${fmtDate(e.createdAt)}</td>
        <td>${esc(e.actorName)}<br/><span class="muted">${esc(e.actorRole)}</span></td>
        <td><span class="chip">${esc(e.action)}</span></td>
        <td class="json">${fmtJson(e.beforeValue)}</td>
        <td class="json">${fmtJson(e.afterValue)}</td>
      </tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10px; color: #1a1a1a; margin: 28px; }
  h1 { font-size: 16px; margin: 0 0 2px; color: #1F3864; }
  .sub { color: #666; margin-bottom: 14px; }
  .meta { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  .meta td { padding: 4px 8px; border: 1px solid #DCE6F1; }
  .meta td:first-child { background: #DCE6F1; color: #1F3864; font-weight: bold; width: 130px; }
  table.trail { width: 100%; border-collapse: collapse; }
  table.trail th { background: #1F3864; color: #fff; text-align: left; padding: 5px 7px; font-size: 9px; }
  table.trail td { border: 1px solid #ddd; padding: 5px 7px; vertical-align: top; }
  table.trail tr:nth-child(even) td { background: #F2F7FD; }
  .chip { background: #EAF1FB; color: #1F3864; padding: 1px 6px; border-radius: 8px; font-weight: bold; font-size: 9px; }
  .muted { color: #888; font-size: 9px; }
  .json { font-family: Consolas, monospace; font-size: 8.5px; white-space: pre-wrap; word-break: break-word; max-width: 180px; }
  .footer { margin-top: 14px; color: #888; font-size: 8.5px; }
</style></head><body>
  <h1>Activity Audit Trail — Customer Risk Assessment</h1>
  <div class="sub">dooit.ai compliance record · generated ${fmtDate(new Date())}</div>
  <table class="meta">
    <tr><td>Customer</td><td>${esc(assessment.customerName || "—")}</td></tr>
    <tr><td>Assessment UID</td><td>${esc(assessment.uid || assessment._id)}</td></tr>
    <tr><td>Risk Score / Label</td><td>${esc(assessment.riskScore)} / 100 — ${esc(assessment.riskLabel)}</td></tr>
    <tr><td>ECDD Status</td><td>${esc(assessment.ecddStatus || "Not required")}</td></tr>
    <tr><td>Entity Type</td><td>${esc(assessment.entityType || "—")}</td></tr>
    <tr><td>Audit Entries</td><td>${entries.length}</td></tr>
  </table>
  <table class="trail">
    <thead><tr>
      <th style="width:110px">Timestamp</th><th style="width:95px">Actor</th>
      <th style="width:120px">Action</th><th>Before</th><th>After</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No audit entries recorded.</td></tr>'}</tbody>
  </table>
  <div class="footer">This document is a system-generated compliance audit trail (CRA_Scoring_Method.md §4). All times local server time.</div>
</body></html>`;

  let browser;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="CRA_Audit_Trail_${assessment.uid || assessment._id}.pdf"`,
    );
    res.send(Buffer.from(pdfBuffer));
  } finally {
    if (browser) await browser.close();
  }
});
