const mongoose = require("mongoose");
const { Schema } = mongoose;

// XeroSyncLog — append-only record of every sync / auth / webhook event.
// Doubles as the Xero audit trail (who connected, who disconnected, what moved).
// Never holds tokens or full payloads — only a hash of the payload.

const XeroSyncLogSchema = new Schema(
  {
    tenantId: { type: String, index: true, default: null },
    companyId: { type: Schema.Types.ObjectId, ref: "Client", index: true, default: null },
    entity: {
      type: String,
      enum: ["contact", "invoice", "payment", "connection", "webhook", "sync", "settings"],
      required: true,
    },
    entityId: { type: String, default: null }, // Dooit id or Xero id
    action: { type: String, required: true }, // create | update | skip | connect | refresh | ...
    direction: { type: String, enum: ["outbound", "inbound", "system"], default: "system" },
    status: { type: String, enum: ["success", "failed", "skipped"], required: true },
    error: { type: String, default: null },
    payloadHash: { type: String, default: null },
    actor: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    // Small, non-secret context (request id, masked emails…). Never tokens.
    meta: { type: Schema.Types.Mixed, default: null },
    timestamp: { type: Date, default: Date.now },
  },
  { collection: "xerosynclogs", versionKey: false }
);

XeroSyncLogSchema.index({ tenantId: 1, timestamp: -1 });
XeroSyncLogSchema.index({ tenantId: 1, status: 1, timestamp: -1 });
// Keep a year of history.
XeroSyncLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

module.exports =
  mongoose.models.XeroSyncLog || mongoose.model("XeroSyncLog", XeroSyncLogSchema);
