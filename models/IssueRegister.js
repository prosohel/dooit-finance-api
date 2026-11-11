const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const IssueRegisterSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", index: true },

    // unique PER CLIENT (compound index below) — the value is generated from a
    // per-client count, so a global unique index collides across clients
    issueId: { type: String, uppercase: true, trim: true, index: true },

    title:       { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    domain: {
      type: String,
      enum: ["GOV","CDD","SCR","TM","RPT","RA","TECH","FRD","CYB","PRV","TRN","RK","OUT","COM","FC","FR","CM","SUP","INT"],
      index: true,
    },

    severity: {
      type: String,
      enum: ["Critical", "High", "Medium", "Low"],
      default: "Medium",
      index: true,
    },

    status: {
      type: String,
      enum: ["Open", "In Progress", "Under Review", "Closed", "Accepted Risk"],
      default: "Open",
      index: true,
    },

    source: {
      type: String,
      enum: ["Control Test", "EWRA", "Audit", "Self-Identified", "Regulatory", "Complaint", "Other"],
    },

    // Optional links
    linkedControl:  { type: mongoose.Schema.Types.ObjectId, ref: "Control",      default: null },
    linkedTest:     { type: mongoose.Schema.Types.ObjectId, ref: "TestSchedule", default: null },
    linkedEwra:     { type: mongoose.Schema.Types.ObjectId, ref: "EwraAssessment", default: null },

    owner:      { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },
    createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },

    dueDate:    { type: Date },
    closedAt:   { type: Date },
    closedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },

    notes: { type: String },
    tags:  [{ type: String, trim: true }],
  },
  { timestamps: true }
);

// Auto-generate issueId before save
IssueRegisterSchema.pre("save", async function (next) {
  if (this.issueId) return next();
  const count = await this.constructor.countDocuments({ client: this.client });
  this.issueId = `ISS-${String(count + 1).padStart(4, "0")}`;
  next();
});

IssueRegisterSchema.index({ client: 1, domain: 1, status: 1 });
IssueRegisterSchema.index({ client: 1, issueId: 1 }, { unique: true });
IssueRegisterSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("IssueRegister", IssueRegisterSchema);
