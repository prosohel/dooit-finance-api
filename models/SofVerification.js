// models/SofVerification.js
// Source of Funds (SOF) verification — a customer-id-keyed upload session
// that lets a customer submit bank_statement / payslip / bank_cheque /
// bank_certificate documents from their own mobile device, without logging
// in. The link/QR is just `/sof-upload?cid=<customerId>` — there is no
// per-link token to rotate or expire, so one session is auto-provisioned
// per customer the first time it's needed (see ensureSofSession() in
// controllers/sofVerificationController.js) and the same QR always works.
//
// Uploaded documents are ALSO pushed into Customer.documents (see the
// controller) so they show up in the existing Documents tab — this model is
// the SOF-specific session/audit trail on top of that shared store.

const mongoose = require("mongoose");
const { Schema } = mongoose;
const { DocumentMetaSchema } = require("./Customer");

const SOF_DOC_TYPES = ["bank_statement", "payslip", "bank_cheque", "bank_certificate"];

// The narrative block the OCR service returns for bank_statement / payslip.
// Typed because the reviewer UI renders each list separately.
const SofOcrAnalysisSchema = new Schema(
  {
    patterns: { type: [String], default: [] },
    anomalies: { type: [String], default: [] },
    insights: { type: [String], default: [] },
    summary: { type: String, default: null },
  },
  { _id: false },
);

// Per-document OCR record. The extraction buckets are Mixed and keep the
// upstream key names (snake_case) verbatim: the OCR service owns that shape
// and a strict sub-schema would silently drop any field it adds. Which bucket
// is populated depends on the document type —
//   bank_statement  -> accountInformation + transactions + statementSummary
//   bank_certificate-> accountInformation
//   payslip         -> payslips
//   bank_cheque     -> raw only
// `raw` always holds the untouched response, so nothing is ever lost.
const SofOcrResultSchema = new Schema(
  {
    isValid: { type: Boolean, default: null },
    rejectionReason: { type: String, default: null },
    documentType: { type: String, default: null },
    processedAt: { type: Date, default: null },

    accountInformation: { type: Schema.Types.Mixed, default: null },
    payslips: { type: [Schema.Types.Mixed], default: [] },
    // Flattened across data.pages[] with page_number carried onto each row,
    // so the reviewer table doesn't have to walk the page structure.
    transactions: { type: [Schema.Types.Mixed], default: [] },
    statementSummary: { type: Schema.Types.Mixed, default: null },

    analysis: { type: SofOcrAnalysisSchema, default: () => ({}) },
    raw: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

// Same shape as Customer.js's DocumentMetaSchema (name/url/mimeType/type/
// docType/uploadedAt) — cloned rather than redefined so the two never drift
// apart — plus the verification bookkeeping that's specific to a SOF upload.
// _id is re-enabled (DocumentMetaSchema uses _id:false as a Customer
// subdocument) because reviewSofDocument() addresses entries by id.
const SofDocumentSchema = DocumentMetaSchema.clone();
SofDocumentSchema.set("_id", true);
SofDocumentSchema.add({
  docType: { type: String, enum: SOF_DOC_TYPES, required: true },
  // "sof_qr_upload" = customer via the QR/link, "sof_staff_upload" = a
  // reviewer uploaded it on the customer's behalf from the dashboard.
  type: { type: String, default: "sof_qr_upload" },
  // Staff member who uploaded it — null for the customer's own QR upload.
  uploadedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
  status: {
    type: String,
    enum: ["verified", "rejected", "needs_review"],
    default: "needs_review",
  },
  ocr: { type: SofOcrResultSchema, default: () => ({}) },
  reviewedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, default: "" },
});

const SofVerificationSchema = new Schema(
  {
    // One session per customer, across every tenant — the SOF evidence is the
    // customer's, not any one client's, so there is deliberately no
    // client/branch on this model. Tenant attribution lives on the RFI a send
    // raises (recordSofRfi) and on Customer.relations.
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      unique: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["pending", "in_review", "verified", "rejected"],
      default: "pending",
    },

    documents: { type: [SofDocumentSchema], default: [] },

    // No qrCode field by design: the QR encodes only the upload URL, so it is
    // rendered on read as a base64 data URL (see getSofVerification) rather
    // than stored. Nothing to invalidate when the frontend origin changes.

    sentTo: {
      email: { type: String, default: null },
      sentAt: { type: Date, default: null },
    },

    createdBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
  },
  { timestamps: true },
);

SofVerificationSchema.statics.DOC_TYPES = SOF_DOC_TYPES;

module.exports = mongoose.model("SofVerification", SofVerificationSchema);
