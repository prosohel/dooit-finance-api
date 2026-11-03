const mongoose = require("mongoose");

const { Schema } = mongoose;

/**
 * HandoffToken — single-use, short-lived SSO ticket issued to an AFC OS
 * officer so they can open the Client Portal (ui) or the GRC Platform
 * (ewra_ui) as their `dooit` membership. The dashboard asks AFC OS, AFC OS
 * asks this API (signed service call), the officer's browser follows the URL,
 * the target app exchanges the ticket once for a normal session JWT.
 */
const HandoffTokenSchema = new Schema(
  {
    jti: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: "Users", required: true },
    membership: { type: Schema.Types.ObjectId, ref: "UserType", required: true },
    target: { type: String, enum: ["portal", "grc"], required: true },
    scope: { type: String, enum: ["admin", "supervisory"], default: "admin" },
    tenant: { type: Schema.Types.ObjectId, ref: "Client", default: null },
    returnTo: { type: String, default: null },
    requested: { email: String, name: String, afcUserId: String, body: String, role: String },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    issuedIp: { type: String, default: null },
  },
  { timestamps: true, collection: "afc_handoff_tokens" }
);

HandoffTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model("AfcHandoffToken", HandoffTokenSchema);
