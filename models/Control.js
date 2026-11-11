const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const ControlSchema = new mongoose.Schema(
  {
    controlId: {
      type: String,
      required: [true, "controlId is required"],
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    domain: {
      type: String,
      required: true,
      enum: ["GOV","CDD","SCR","TM","RPT","RA","TECH","FRD","CYB","PRV","TRN","RK","OUT","COM","FC","FR","CM","SUP","INT"],
      // SUP = Supervision & Enforcement, INT = International Cooperation (regulator-side packs)
      index: true,
    },
    prefix: { type: String, trim: true }, // e.g. "CTRL_GOV" | "BD-CTRL"

    // ── Jurisdiction pack fields (seed/<jurisdiction>/pack.json) ──
    jurisdiction: { type: String, trim: true, uppercase: true, default: "AU", index: true },
    displayId: { type: String, trim: true }, // e.g. "CTRL-001" for "BD-CTRL-001"
    packVersion: { type: String, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    controlType: {
      type: String,
      enum: ["Preventative", "Detective", "Corrective", "Directive", "Compensating"],
    },
    automationLevel: {
      type: String,
      enum: ["Manual", "Semi-Automated", "Fully Automated", "AI-Powered"],
      default: "Manual",
    },
    owner: { type: String, trim: true }, // e.g. "Board", "CRO", "AMLCO"
    testingProcedure: { type: String, trim: true },
    testingFrequency: {
      type: String,
      enum: ["Daily", "Weekly", "Monthly", "Quarterly", "Annually", "Event-driven"],
      // Event-driven = per inspection / per order / per breach / per RFI
      default: "Annually",
    },
    fatfRecommendations: [{ type: String }], // e.g. ["Rec 1", "Rec 2"]
    industryTags: [{ type: String }],        // e.g. ["All", "Banks", "VASPs"]
    riskMitigationLevel: {
      type: String,
      enum: ["Critical", "High", "Medium", "Low"],
      default: "Medium",
    },
    effectivenessScore: {
      type: Number,
      min: 0,
      max: 5,
      default: null,
    },
    obligationRefs: [{ type: String }], // obligation IDs this control addresses
    notes:  { type: String, default: "" },
    active: { type: Boolean, default: true },
    client: { type: mongoose.Schema.ObjectId, ref: "Client", default: null },
  },
  { timestamps: true }
);

ControlSchema.index({ domain: 1, controlId: 1 });
ControlSchema.index({ active: 1, domain: 1 });
ControlSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("Control", ControlSchema);
