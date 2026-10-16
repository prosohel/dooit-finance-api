const mongoose = require("mongoose");
const { Schema } = mongoose;

// XeroEntityLink — the external-ID map. One row per (tenant, Dooit entity).
// It is what prevents duplicate creation: before any create we look here, and
// the unique indexes make a racing second create fail instead of duplicating.

const XeroEntityLinkSchema = new Schema(
  {
    tenantId: { type: String, required: true },
    companyId: { type: Schema.Types.ObjectId, ref: "Client", index: true },
    entityType: {
      type: String,
      // "supplier" = Dooit itself as a contact in the client's Xero (localId "dooit").
      // "company" is legacy (the client as its own contact) and no longer written.
      enum: ["customer", "company", "supplier", "invoice", "payment"],
      required: true,
    },
    localId: { type: String, required: true },
    // ContactID / InvoiceID / PaymentID
    xeroId: { type: String, required: true },
    // Hash of the last payload we PUSHED — unchanged hash ⇒ nothing to send.
    payloadHash: { type: String, default: null },
    // Xero's UpdatedDateUTC at the last time we saw it, for inbound conflict checks.
    remoteUpdatedAt: { type: Date, default: null },
    remoteStatus: { type: String, default: null },
    // Contacts: the name used in Xero when the plain name was already taken by
    // a different contact (e.g. two customers called "Jane Citizen").
    displayName: { type: String, default: null },
    // Contacts: archived by Dooit (customer no longer eligible) — as opposed to
    // archived by the client in Xero, which Dooit must respect.
    archivedByDooit: { type: Boolean, default: false },
    lastSyncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

XeroEntityLinkSchema.index({ tenantId: 1, entityType: 1, localId: 1 }, { unique: true });
XeroEntityLinkSchema.index({ tenantId: 1, entityType: 1, xeroId: 1 }, { unique: true });

module.exports =
  mongoose.models.XeroEntityLink ||
  mongoose.model("XeroEntityLink", XeroEntityLinkSchema);
