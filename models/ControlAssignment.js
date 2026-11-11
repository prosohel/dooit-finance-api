"use strict";

const mongoose = require("mongoose");

/**
 * One document per (controlId × entityType) pair.
 * Global defaults have client = null.
 * A client-specific override overrides the global for that (controlId, entityType, client) triple.
 */
const ControlAssignmentSchema = new mongoose.Schema(
  {
    controlId: { type: String, required: true, uppercase: true, trim: true, index: true },
    domain: {
      type: String, required: true,
      enum: ["GOV", "CDD", "SCR", "TM", "RPT", "RA", "TECH", "FRD", "CYB", "PRV", "TRN", "RK", "OUT", "COM", "FC", "FR", "CM", "SUP", "INT"]
    },
    entityType: {
      type: String, required: true,
      enum: [
        "Lawyers/Conveyancers", "Accountants", "Real Estate Agents",
        "Precious Metal Dealers", "TCSPs",
        "Banks & ADIs", "Remittance", "VASP/DCEP", "Gambling/Casino", "Insurance",
      ],
      index: true,
    },
    isActive: { type: Boolean, default: true },
    client: { type: mongoose.Schema.ObjectId, ref: "Client", default: null, index: true },
  },
  {
    timestamps: true,
    // collection: "ControlAssignment",
  }
);

// Unique: one assignment per (controlId + entityType + client)
ControlAssignmentSchema.index({ controlId: 1, entityType: 1, client: 1 }, { unique: true });
ControlAssignmentSchema.index({ domain: 1, entityType: 1 });
ControlAssignmentSchema.index({ client: 1, entityType: 1 });

module.exports = mongoose.model("ControlAssignment", ControlAssignmentSchema);
