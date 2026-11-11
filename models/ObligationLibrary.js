const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const ObligationLibrarySchema = new mongoose.Schema(
  {
    obligationId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    // e.g. "GOV-001" | "AML-010" | "CDD-001" | "CON-001" | "BD-AML-001" (jurisdiction packs are prefixed)

    // ── Jurisdiction pack fields (seed/<jurisdiction>/pack.json) ──
    jurisdiction: { type: String, trim: true, uppercase: true, default: "AU", index: true },
    // ISO-3166 alpha-2: "AU" (AUSTRAC/ASIC content) | "BD" (Bangladesh MLPA 2012)

    displayId: { type: String, trim: true },
    // Blueprint ID shown in the UI when obligationId carries a jurisdiction prefix, e.g. "AML-001" for "BD-AML-001"

    addressee: {
      type: String,
      enum: ["RO", "ControllingAuthority", "BFIU", "Government", "InvestigatingAgency", "Court", "AnyPerson", ""],
      default: "",
    },
    // Who the provision binds. Drives owns / supervises / reference relations per entity.

    kind: {
      type: String,
      enum: ["duty", "power", "penalty", "structural", ""],
      default: "",
    },
    // "may" provisions are powers; ENF-* are penalty references; neither is a control-testable duty.

    amended2015: { type: Boolean, default: false },
    // Bangladesh: provision introduced or changed by Act No. 25 of 2015

    packVersion: { type: String, trim: true },
    // Version of the jurisdiction pack that last wrote this record

    regulatorySource: { type: String, trim: true },
    // e.g. "RG104 s912A(1)(a); Corporations Act"

    category: {
      type: String,
      trim: true,
      index: true,
      // Governance | Conflicts | AML/CTF | CDD | Custody | Reporting | Training | ...
    },

    description: { type: String, required: true, trim: true },

    legislativeRef: { type: String, trim: true },

    // Dynamic filtering — which entities does this obligation apply to?
    applicableEntityTypes: [{ type: String, trim: true }],
    // e.g. ["All AFSL Holders"] | ["Banks", "VASP"] | ["Tranche 2"]

    applicableLicenses: [{ type: String, trim: true }],
    // e.g. ["AFSL"] | ["AUSTRAC_VASP"] | ["Any"]

    applicableServices: [{ type: String, trim: true }],
    // e.g. ["Custody Services"] | ["Any"] | ["Virtual Asset Exchange"]

    applicableDate: { type: Date },
    // For Tranche 2 obligations starting 1 July 2026

    policyTemplate: { type: String, trim: true },
    // e.g. "Governance Policy Template"

    riskCategory: { type: String, trim: true },
    // "Customer Risk" | "Governance" | "Financial" | "AML/CTF" | ...

    testMethod: {
      type: String,
      enum: ["Document Review","Interview","Observation","Inspection","Re-performance","Analytics",""],
      default: "",
    },
    testFrequency: {
      type: String,
      enum: ["Continuous","Daily","Weekly","Monthly","Quarterly","Annually","Ad-hoc",""],
      default: "",
    },
    defaultWeight: { type: Number, default: 0 },

    controlRefs: [{ type: String, trim: true }],
    // e.g. ["CTRL_GOV_001", "CTRL_GOV_002"]

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ObligationLibrarySchema.index({ applicableEntityTypes: 1 });
ObligationLibrarySchema.index({ applicableLicenses: 1 });

ObligationLibrarySchema.plugin(mongoosePaginate);

module.exports = mongoose.model("ObligationLibrary", ObligationLibrarySchema);
