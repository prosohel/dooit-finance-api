const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const TestTemplateSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", index: true },

    name:        { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    // Linked control (optional — template may cover a domain rather than a single control)
    controlRef:  { type: mongoose.Schema.Types.ObjectId, ref: "Control", default: null },
    domain: {
      type: String,
      enum: ["GOV","CDD","SCR","TM","RPT","RA","TECH","FRD","CYB","PRV","TRN","RK","OUT","COM","FC","FR","CM","SUP","INT"],
    },

    testType: {
      type: String,
      enum: ["Design", "Performance", "Walkthrough", "Substantive", "Analytical"],
      default: "Performance",
    },

    testingProcedure: { type: String },          // step-by-step instructions
    expectedEvidence: [String],                  // list of required evidence items
    sampleSize:       { type: String },          // "5 transactions", "10%", etc.

    frequency: {
      type: String,
      enum: ["Monthly", "Quarterly", "Semi-Annual", "Annual", "Ad-Hoc"],
      default: "Annual",
    },

    fatfRecommendations: [String],
    active: { type: Boolean, default: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },
  },
  { timestamps: true }
);

TestTemplateSchema.index({ client: 1, domain: 1 });
TestTemplateSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("TestTemplate", TestTemplateSchema);
