// models/EcddReport.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const { riskFields } = require("./schemas/riskShared");
const { draftFields, ReportIpSchema } = require("./schemas/reportShared");

const { Schema } = mongoose;

// Who the ECDD is about: the case's customers and the non-customer persons of
// interest the analyst recorded (Case.externalPois). Deliberately a summary —
// identity details (DOB, ID numbers, accounts) stay on the case, encrypted.
const EcddPoiSchema = new Schema(
  {
    customer: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
    poi: { type: String, default: null }, // Case.externalPois _id
    kind: { type: String, default: null }, // individual | entity (external only)
    name: { type: String, trim: true, default: "" },
    role: { type: String, trim: true, default: "" },
    relationship: { type: String, trim: true, default: "" },
    nationality: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    source: { type: String, default: "" }, // customer | manual | alert
  },
  { _id: false }
);

const EcddReportSchema = new Schema(
  {
    // Auto-generated unique id for UI (e.g. #ECDD_001)
    uid: { type: String, index: true, unique: true, sparse: true },

    // Auto increment sequence number
    sequence: { type: Number, index: true },

    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      index: true,
      default: null,
    },
    branch: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      index: true,
      default: null,
    },

    // Core relations
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      index: true,
      required: false,
      default: null,
    },
    analyst: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: false,
      default: null,
    },
    generatedBy: { type: Schema.Types.ObjectId, ref: "Users", required: false },
    transaction: {
      type: Schema.Types.ObjectId,
      ref: "Transaction",
      required: false,
    },

    // Basic case fields (matches your form)
    analystName: { type: String, trim: true, default: "" },
    position: { type: String, trim: true, default: "" },
    date: { type: Date, default: null },

    caseNumber: { type: String, trim: true, index: true, default: null },
    // Investigation hub — the Case this ECDD belongs to. Null until the
    // originating alert is escalated to a Case (then resolved via Alert.linkedCase).
    caseId: {
      type: Schema.Types.ObjectId,
      ref: "Case",
      index: true,
      required: false,
      default: null,
    },
    // Provenance — the TM Alert that triggered this ECDD (kept for traceability).
    alert: {
      type: Schema.Types.ObjectId,
      ref: "Alert",
      index: true,
      required: false,
      default: null,
    },

    // CRA-origin ECDD: report backs a CRA ECDD gate decision instead of a TM alert
    riskAssessment: {
      type: Schema.Types.ObjectId,
      ref: "IndividualRiskAssessment",
      index: true,
      default: null,
    },

    // Customer profile fields
    userId: { type: String, trim: true, default: "" },
    fullName: { type: String, trim: true, default: "" },
    customerName: { type: String, trim: true, default: "" },
    abn: { type: String, trim: true, default: "" },
    onboardingDate: { type: Date, default: null },
    // No default: an unset purpose must read as unknown, not as a guess.
    accountPurpose: { type: String, default: "" },
    expectedVolume: { type: Number, default: null }, // store numeric if possible
    // The customer's own words ("$1,000 – $5,000 per month") — a range cannot
    // be forced into `expectedVolume` without inventing a number.
    expectedVolumeText: { type: String, trim: true, default: "" },
    annualIncome: { type: Number, default: null }, // millions or raw, be consistent
    beneficialOwner: { type: String, trim: true, default: "" },
    directors: { type: String, trim: true, default: "" },

    // Flags
    isPEP: { type: String, enum: ["Yes", "No"], default: "No" },
    isSanctioned: { type: String, enum: ["Yes", "No"], default: "No" },
    relatedParty: { type: String, trim: true, default: "N/A" },
    personsOfInterest: { type: [EcddPoiSchema], default: [] },

    // Transaction analysis — the review window and its AUD totals
    accountCreationDate: { type: Date, default: null },
    analysisStartDate: { type: Date, default: null },
    analysisEndDate: { type: Date, default: null },
    totalDepositsAUD: { type: Number, default: 0 },
    totalWithdrawalsAUD: { type: Number, default: 0 },
    totalWithdrawalsUSDT: { type: Number, default: 0 },
    totalWithdrawalsETH: { type: Number, default: 0 },
    totalWithdrawalsBTC: { type: Number, default: 0 },
    depositDetails: { type: String, default: "" },
    withdrawalDetails: { type: String, default: "" },
    additionalInfo: { type: String, default: "" },

    // Behavioral — the count stays (the form and PDF read it); the detail
    // behind it lives in `ipAddresses`.
    ipLocations: { type: Number, default: null },
    ipAddresses: { type: [ReportIpSchema], default: [] },
    registeredAddress: { type: String, default: "" },

    // ── Narrative (the ONLY fields the AI service may fill; docs/74 §4.1) ──
    profileSummary: { type: String, default: "" },
    transactionAnalysis: { type: String, default: "" },
    behavioralAnalysis: { type: String, default: "" },
    recommendation: { type: String, default: "" },
    recommendationType: {
      type: String,
      enum: ["SMR", "RFI", "ECDD", "monitor", "offboard", "no_action", null],
      default: null,
    },
    decisionRationale: { type: String, default: "" },
    immediateActions: { type: [String], default: [] },
    keyIndicators: { type: [String], default: [] },
    typologies: { type: [String], default: [] },

    // ── Risk, as our Case derived it (never the AI's own score) ──
    ...riskFields({ nullable: true }),

    // ── Draft provenance (alerts snapshot, aiMeta, editedFields, analysis) ──
    ...draftFields({ withAnalysis: true }),

    // operational
    status: {
      type: String,
      enum: ["Pending", "Active", "Inactive", "Blocked"],
      default: "Pending",
    },

    // flexible fields
    settings: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/** Remove or correct invalid index */
// EcddReportSchema.index({ user: 1 }); // removed — no `user` field

// Post-save UID generation — generate padded uid like #CA_001
// EcddReportSchema.post("save", async function (doc, next) {
//   try {
//     if (!doc.uid && doc.sequence) {
//       const padded = String(doc.sequence).padStart(3, "0");
//       const newUid = `ECDD_${padded}`;
//       // Use updateOne to avoid triggering middleware recursively
//       await doc.constructor.updateOne(
//         { _id: doc._id },
//         { $set: { uid: newUid } }
//       );
//     }
//   } catch (err) {
//     // log and continue
//     /* eslint-disable no-console */
//     console.error("EcddReport post-save UID generation error:", err);
//   } finally {
//     next();
//   }
// });

// Tenant-scoped list queries
EcddReportSchema.index({ client: 1, status: 1, createdAt: -1 });

EcddReportSchema.pre("save", async function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `ECDD_${Date.now()}`;
  }
  next();
});

// Plugins
// Keep uniqueValidator if you plan to have unique fields (uid, caseNumber, etc.)
EcddReportSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
EcddReportSchema.plugin(mongoosePaginate);

EcddReportSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "ecdd_report_sequence", // unique id for this schema
  start_seq: 1,
});

const EcddReport = mongoose.model("EcddReport", EcddReportSchema);

module.exports = EcddReport;
