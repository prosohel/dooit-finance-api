/**
 * Source of Funds (SOF) Verification Controller
 * ─────────────────────────────────────────────────────────────────────────────
 * Lets a customer upload SOF evidence (bank_statement | payslip |
 * bank_cheque | bank_certificate) from their own mobile device via a QR /
 * link, without logging in. The link is just `/sof-upload?cid=<customerId>`
 * — there's no per-link token to mint or expire, so a session (+ its QR
 * image) is auto-provisioned for a customer the first time it's needed
 * (ensureSofSession) and the same link/QR always works. The admin tab never
 * needs a "Generate" click — it just appears.
 *
 * Verified/uploaded documents are ALSO written into Customer.documents
 * (the same array the reviewer Documents tab reads/writes via
 * addCustomerDocuments), so a SOF upload shows up there too.
 *
 * Routes (see routes/sofVerification.js):
 *   GET  /api/v1/sof-verification/customer/:customerId          (admin)  read (auto-create) the session + QR + documents
 *   POST /api/v1/sof-verification/:customerId/send-email         (admin)  email the (always-available) upload link
 *   POST /api/v1/sof-verification/:customerId/documents          (admin)  staff upload on the customer's behalf
 *   PATCH /api/v1/sof-verification/:customerId/documents/:docId  (admin)  manual verify/reject override
 *   GET  /api/v1/sof-verification/validate                       (public) look up the customer before showing the upload UI
 *   POST /api/v1/sof-verification/upload                         (public) upload + auto-verify one document
 */

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const sendEmail = require("../utils/sendEmail");
const SofRequestEmailTemplate = require("../utils/email-template/sofRequest");
const { generateQRFromUrl } = require("../utils/qrService");
const fileVaultService = require("../utils/fileVaultService");
const ocrService = require("../utils/ocrService");
const { customerRelatedToTenant } = require("../utils/customerTenantGuard");
const { logEvent } = require("../utils/audit");
const { recordDevice } = require("../utils/deviceContext");

const { resolveCaseLinkage } = require("../utils/resolveCaseLinkage");

const Customer = require("../models/Customer");
const Client = require("../models/Client");
const SofVerification = require("../models/SofVerification");
const RFI = require("../models/Rfi");

const DOC_TYPES = SofVerification.DOC_TYPES;

// ── Shared helpers ────────────────────────────────────────────────────────────

const loadGuardedCustomer = async (req, next) => {
  const customer = await Customer.findById(req.params.customerId).select(
    "documents relations personalKyc metadata",
  );
  if (!customer) {
    next(new ErrorResponse(`Customer not found with id of ${req.params.customerId}`, 404));
    return null;
  }
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  if (!customerRelatedToTenant(customer, client, branch)) {
    next(new ErrorResponse(`Customer not found with id of ${req.params.customerId}`, 404));
    return null;
  }
  return customer;
};

const customerDisplayName = (customer) => {
  const d = customer?.personalKyc?.personal_form?.customer_details || {};
  const name = [d.given_name, d.surname].filter(Boolean).join(" ").trim();
  return name || customer?.uid || "Customer";
};

/**
 * The tenant making this SOF request. Prefer the signed-in staff member's
 * client — a customer can hold relations with several clients, so
 * `relations[0]` is not necessarily the organisation asking; auth.js resolves
 * the caller's own client onto req.user.clientBelongs. Falls back to the
 * customer's first relation on sessionless (public) calls.
 */
const resolveRequestingClientId = (customer, req) =>
  req?.user?.clientBelongs ||
  req?.user?.client?._id ||
  req?.user?.client ||
  customer?.relations?.[0]?.client ||
  null;

/**
 * Client (tenant) branding for anything shown to the customer — the request
 * email header and the public upload page both co-brand Dooit with the
 * organisation that asked for the document. Client has no dedicated logo
 * field, so read the conventional Mixed keys (same as userController).
 * Best-effort: a missing client just means plain Dooit branding.
 */
const resolveClientBranding = async (clientId) => {
  try {
    if (!clientId) return { name: "", logoUrl: "" };
    const clientDoc = await Client.findById(clientId)
      .select("name settings metadata")
      .lean();
    return {
      name: clientDoc?.name || "",
      logoUrl: clientDoc?.settings?.logoUrl || clientDoc?.metadata?.logoUrl || "",
    };
  } catch (err) {
    console.error("[resolveClientBranding] lookup failed:", err.message);
    return { name: "", logoUrl: "" };
  }
};

const toStringList = (v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : [];

/**
 * Map a /process-bank-documents response onto the stored per-document OCR
 * record (SofOcrResultSchema). Which buckets fill depends on the document
 * type — statements carry an account block + paginated transactions, payslips
 * carry a payslips[] array, cheques carry neither. `raw` always keeps the
 * untouched response so a shape change upstream can never lose data.
 *
 * Safe to call with ocrResult === null (OCR outage): everything comes back
 * empty with ocrError recorded as the rejection reason.
 */
const buildSofOcrRecord = (ocrResult, { docType = null, ocrError = null } = {}) => {
  const data = ocrResult?.data || {};
  const analysis = ocrResult?.analysis || {};

  // Statements are returned page by page. Flatten into one ledger, carrying
  // the page number onto each row so the reviewer table stays a flat list.
  const transactions = Array.isArray(data.pages)
    ? data.pages.flatMap((page) =>
        (Array.isArray(page?.transactions) ? page.transactions : []).map((t) => ({
          page_number: page?.page_number ?? null,
          ...t,
        })),
      )
    : [];

  return {
    isValid: ocrResult?.is_valid ?? null,
    rejectionReason:
      ocrResult?.rejection_reason || data.rejection_reason || ocrError || null,
    documentType: ocrResult?.document_type || docType,
    processedAt: ocrResult ? new Date() : null,

    accountInformation: data.account_information || null,
    payslips: Array.isArray(data.payslips) ? data.payslips : [],
    transactions,
    statementSummary: data.summary || null,

    analysis: {
      patterns: toStringList(analysis.patterns),
      anomalies: toStringList(analysis.anomalies),
      insights: toStringList(analysis.insights),
      summary: typeof analysis.summary === "string" ? analysis.summary : null,
    },
    raw: ocrResult || null,
  };
};

// Exported for tests — not routed.
exports.buildSofOcrRecord = buildSofOcrRecord;

// Deadlines mirror an "initial" RFI send in rfiController.sendRFI.
const DAY_MS = 24 * 60 * 60 * 1000;
const SOF_RFI_SOURCE = "sof_verification";

/**
 * Record the SOF request as an RFI so it appears in the RFI register and on
 * the case's Reports section — a source of funds request is a formal request
 * for information and needs the same audit trail and deadline clock.
 *
 * One RFI per customer SOF session: re-sending the link is a follow-up on the
 * open request, not a new one, so it appends an activity note and refreshes
 * sentAt instead of creating a duplicate. A closed RFI is left alone and a new
 * one is opened.
 *
 * Best-effort — the email has already gone out by the time this runs, so a
 * failure here is logged and swallowed rather than failing the request.
 */
const recordSofRfi = async ({ req, customer, sof, email, url, caseId }) => {
  try {
    // caseId is optional: the onboarding tab has no case, the case-manager tab
    // passes one so the RFI lands on that case's register.
    const link = caseId ? await resolveCaseLinkage({ caseId }) : {};
    const contactName = customerDisplayName(customer);
    const now = new Date();

    const existing = await RFI.findOne({
      customer: customer._id,
      "metadata.source": SOF_RFI_SOURCE,
      status: { $ne: "Closed" },
    }).sort({ createdAt: -1 });

    if (existing) {
      existing.replyToEmail = email;
      existing.sentAt = now;
      existing.sentBy = req?.user?._id || existing.sentBy || null;
      existing.followupDeadline = new Date(now.getTime() + 7 * DAY_MS);
      existing.status = "Pending FollowUp";
      // Attach the case the moment one exists, so an RFI opened during
      // onboarding follows the customer into their investigation.
      if (!existing.case && link.caseId) existing.case = link.caseId;
      if (!existing.alert && link.alert) existing.alert = link.alert;
      existing.activityNote.push({
        note: `Source of funds upload link re-sent to ${email}`,
        uploadedAt: now,
        by: req?.user?._id || null,
      });
      await existing.save();
      return existing;
    }

    return await RFI.create({
      case: link.caseId || null,
      alert: link.alert || null,
      // Tenant of the signed-in staff member raising it (auth.js resolves
      // clientBelongs/branchBelongs for both client and branch users), same as
      // rfiController.createRFI. Case linkage is the only fallback — for
      // platform admins with no tenant of their own; never guessed from
      // relations[0].
      client: req?.user?.clientBelongs || link.client || null,
      branch: req?.user?.branchBelongs || link.branch || null,
      customer: customer._id,
      primaryContactName: contactName,
      replyToEmail: email,
      requestedItems: DOC_TYPES.map((docType) => ({
        text: `Source of funds evidence — ${docType.replace(/_/g, " ")}`,
      })),
      responseDeadline: new Date(now.getTime() + 14 * DAY_MS),
      followupDeadline: new Date(now.getTime() + 21 * DAY_MS),
      finalDeadline: new Date(now.getTime() + 28 * DAY_MS),
      status: "Sent",
      sentAt: now,
      sentBy: req?.user?._id || null,
      activityNote: [
        {
          note: `Source of funds upload link sent to ${email}`,
          uploadedAt: now,
          by: req?.user?._id || null,
        },
      ],
      metadata: {
        source: SOF_RFI_SOURCE,
        sofVerification: sof._id,
        uploadUrl: url,
        // Any one of these satisfies the request — see SofVerification.DOC_TYPES.
        acceptedDocTypes: DOC_TYPES,
      },
    });
  } catch (err) {
    console.error("[recordSofRfi] failed:", err.message);
    return null;
  }
};

// The upload page lives at /accept-invite/sof-upload on the customer-facing
// app. Built from FRONTEND_URL (the app's origin) rather than
// CLIENT_INVITE_URL, so the SOF link doesn't move if the invite path changes.
const SOF_UPLOAD_BASE = `${(process.env.FRONTEND_URL || "http://localhost:3000").replace(
  /\/+$/,
  "",
)}/accept-invite`;

// `client` rides along so the public page can brand for the tenant that
// actually raised the request instead of guessing from the customer's first
// relation — validateSofCustomer checks it against the customer's relations
// before honouring it.
const buildSofUrl = (customerId, clientId) =>
  `${SOF_UPLOAD_BASE}/sof-upload?cid=${customerId}` +
  (clientId ? `&client=${clientId}` : "");

/**
 * Get-or-create the customer's SOF session. Idempotent: safe to call on every
 * admin tab load and on every public validate/upload hit.
 *
 * No QR work here — the code is rendered on read (see getSofVerification), so
 * there is nothing to persist or invalidate.
 */
const ensureSofSession = async (customer) => {
  const existing = await SofVerification.findOne({ customer: customer._id });
  if (existing) return existing;

  // Customer-scoped only — no client/branch on the session (see the model);
  // tenant attribution belongs to the RFI raised at send time.
  return SofVerification.create({ customer: customer._id });
};

/**
 * Render an upload link as a base64 data URL, ready to drop straight into an
 * <img src>. Same approach as the client/branch QR in middleware/auth.js —
 * cheap to regenerate, and it always reflects the current FRONTEND_URL
 * instead of an address baked in whenever the record was created.
 */
const renderSofQr = async (url) => {
  try {
    return await generateQRFromUrl(url, "base64");
  } catch (err) {
    console.error("[renderSofQr] QR generation failed:", err.message);
    return null;
  }
};

/** Human-readable result message shared by every upload/re-run response. */
const sofStatusMessage = (status) =>
  status === "verified"
    ? "Document verified"
    : status === "rejected"
      ? "Document could not be verified"
      : "Document uploaded — pending review";

/**
 * The one SOF upload pipeline, used by both the public QR upload and the
 * staff upload from the dashboard, so the two can never drift apart:
 *
 *   1. OCR first, storage second. A document OCR positively rejects (not a
 *      valid bank document) is junk and never reaches the file server or the
 *      customer's document register. An OCR *outage* is different — the doc
 *      may well be valid, so it is stored as needs_review and can be re-run
 *      later via reprocessSofDocument.
 *   2. Store the file in FileVault (skipped for rejected docs).
 *   3. Append the entry to the SOF session and recompute the session status.
 *   4. Mirror the stored file into Customer.documents (the Documents tab).
 *
 * Throws an ErrorResponse (502) if the file store fails — callers pass it to
 * next(). `sourceType` tags where the upload came from ("sof_qr_upload" for the
 * customer, "sof_staff_upload" for a reviewer); `uploadedBy` is the staff user
 * for a staff upload, null for the public flow.
 */
const processSofUpload = async ({ customer, file, docType, sourceType, uploadedBy = null }) => {
  const sof = await ensureSofSession(customer);
  const { buffer, originalname, mimetype } = file;

  // 1. OCR
  let ocrResult = null;
  let ocrError = null;
  try {
    ocrResult = await ocrService.processBankDocument(buffer, originalname, mimetype, docType);
  } catch (err) {
    ocrError = err.message;
    console.error("[processSofUpload] OCR failed:", err.message);
  }

  let status = "needs_review";
  if (ocrResult?.success === true) {
    status = ocrResult.is_valid ? "verified" : "rejected";
  }

  // 2. Store the file (not for rejected docs)
  let publicUrl = null;
  if (status !== "rejected") {
    try {
      const uploadRes = await fileVaultService.uploadFile(buffer, originalname, mimetype);
      publicUrl = uploadRes?.file?.publicUrl;
      if (!uploadRes?.success || !publicUrl) {
        throw new Error(uploadRes?.message || "Upload failed");
      }
    } catch (err) {
      throw new ErrorResponse(`File upload failed: ${err.message}`, 502);
    }
  }

  // 3. Record on the SOF session
  sof.documents.push({
    docType,
    type: sourceType,
    name: originalname,
    // null for rejected docs — the attempt (and why) is still recorded via
    // the OCR block below, there's just no stored file behind it.
    url: publicUrl,
    mimeType: mimetype,
    status,
    ocr: buildSofOcrRecord(ocrResult, { docType, ocrError }),
    uploadedBy,
    uploadedAt: new Date(),
  });
  sof.status = sof.documents.some((d) => d.status === "verified") ? "verified" : "in_review";
  await sof.save();

  // 4. Mirror into Customer.documents (DocumentMetaSchema) — same store the
  // reviewer Documents tab reads. updateOne + $push avoids re-running the
  // Customer pre-save encryption hooks over untouched PII fields. Rejected
  // docs have no stored file, so there is nothing to mirror.
  if (publicUrl) {
    await Customer.updateOne(
      { _id: customer._id },
      {
        $push: {
          documents: {
            name: originalname,
            url: publicUrl,
            mimeType: mimetype,
            type: sourceType,
            docType,
            uploadedAt: new Date(),
          },
        },
      },
    );
  }

  return { sof, status, savedDoc: sof.documents[sof.documents.length - 1] };
};

// ── Admin: read (auto-create) the session ─────────────────────────────────────

// @desc   Get (or lazily create) the SOF verification session + QR + documents
// @route  GET /api/v1/sof-verification/customer/:customerId
// @access Private (CUSTOMER.GET)
exports.getSofVerification = asyncHandler(async (req, res, next) => {
  const customer = await loadGuardedCustomer(req, next);
  if (!customer) return;

  const url = buildSofUrl(customer._id, resolveRequestingClientId(customer, req));
  const [sof, qrCode] = await Promise.all([
    ensureSofSession(customer),
    renderSofQr(url),
  ]);

  res.status(200).json({
    success: true,
    data: sof,
    url,
    // base64 data URL, rendered per request — not stored on the session.
    qrCode,
    docTypes: DOC_TYPES,
  });
});

// @desc   Email the customer's (always-available) SOF upload link
// @route  POST /api/v1/sof-verification/:customerId/send-email
// @access Private (CUSTOMER.EDIT)
exports.sendSofEmail = asyncHandler(async (req, res, next) => {
  const customer = await loadGuardedCustomer(req, next);
  if (!customer) return;

  const { email, caseId } = req.body || {};
  const targetEmail =
    email ||
    customer.personalKyc?.personal_form?.contact_details?.email ||
    customer.metadata?.email ||
    null;

  if (!targetEmail) {
    return next(new ErrorResponse("No email address available for this customer", 400));
  }

  const sof = await ensureSofSession(customer);
  const requestingClientId = resolveRequestingClientId(customer, req);
  const url = buildSofUrl(customer._id, requestingClientId);

  const { name: clientName, logoUrl: clientLogoUrl } =
    await resolveClientBranding(requestingClientId);

  try {
    await sendEmail({
      email: targetEmail,
      subject: clientName
        ? `${clientName}: please verify your source of funds`
        : "Please verify your source of funds",
      message: SofRequestEmailTemplate({
        clientName,
        clientLogoUrl,
        customerName: customerDisplayName(customer),
        uploadLink: url,
      }),
    });
  } catch (e) {
    console.error("[sendSofEmail] email failed:", e.message);
    return next(new ErrorResponse("Failed to send the email", 502));
  }

  sof.sentTo = { email: targetEmail, sentAt: new Date() };
  await sof.save();

  // Log the request in the RFI register so it carries a deadline clock and
  // shows up alongside every other information request on the case.
  const rfi = await recordSofRfi({
    req,
    customer,
    sof,
    email: targetEmail,
    url,
    caseId,
  });

  logEvent({
    req,
    service: "kyc",
    action: "sof_link_emailed",
    customer: customer._id,
    afterValue: { to: targetEmail, rfi: rfi?.uid || null },
  });

  res.status(200).json({
    success: true,
    message: `Upload link emailed to ${targetEmail}`,
    data: sof,
    url,
    rfi: rfi ? { _id: rfi._id, uid: rfi.uid, status: rfi.status } : null,
  });
});

// @desc   Manually override a single uploaded document's verification status
// @route  PATCH /api/v1/sof-verification/:customerId/documents/:docId
// @access Private (CUSTOMER.EDIT)
exports.reviewSofDocument = asyncHandler(async (req, res, next) => {
  const customer = await loadGuardedCustomer(req, next);
  if (!customer) return;

  const { status, note = "" } = req.body || {};
  if (!["verified", "rejected", "needs_review"].includes(status)) {
    return next(new ErrorResponse("status must be one of verified | rejected | needs_review", 400));
  }

  const sof = await SofVerification.findOne({ customer: customer._id });
  if (!sof) return next(new ErrorResponse("No SOF verification session for this customer", 404));

  const doc = sof.documents.id(req.params.docId);
  if (!doc) return next(new ErrorResponse("Document not found in this SOF session", 404));

  doc.status = status;
  doc.reviewNote = note;
  doc.reviewedBy = req.user?._id || null;
  doc.reviewedAt = new Date();

  sof.status = sof.documents.some((d) => d.status === "verified") ? "verified" : "in_review";

  await sof.save();

  logEvent({
    req,
    service: "kyc",
    action: "sof_document_reviewed",
    customer: customer._id,
    afterValue: { docId: req.params.docId, status },
  });

  res.status(200).json({ success: true, message: "Document updated", data: sof });
});

// @desc   Re-run OCR on an already-stored document (e.g. after an OCR outage
//         left it in needs_review). Pulls the file back from the vault and
//         runs the same verification pipeline as the original upload.
// @route  POST /api/v1/sof-verification/:customerId/documents/:docId/reprocess
// @access Private (CUSTOMER.EDIT)
exports.reprocessSofDocument = asyncHandler(async (req, res, next) => {
  const customer = await loadGuardedCustomer(req, next);
  if (!customer) return;

  const sof = await SofVerification.findOne({ customer: customer._id });
  if (!sof) return next(new ErrorResponse("No SOF verification session for this customer", 404));

  const doc = sof.documents.id(req.params.docId);
  if (!doc) return next(new ErrorResponse("Document not found in this SOF session", 404));
  if (!doc.url) {
    // Rejected-at-upload docs are never stored — nothing to re-run.
    return next(new ErrorResponse("No stored file for this document — ask the customer to upload again", 400));
  }

  let buffer;
  try {
    const fileRes = await fetch(doc.url);
    if (!fileRes.ok) throw new Error(`file store responded ${fileRes.status}`);
    buffer = Buffer.from(await fileRes.arrayBuffer());
  } catch (err) {
    return next(new ErrorResponse(`Could not retrieve the stored file: ${err.message}`, 502));
  }

  let ocrResult = null;
  let ocrError = null;
  try {
    ocrResult = await ocrService.processBankDocument(
      buffer,
      doc.name || `sof-${doc.docType}`,
      doc.mimeType || "application/octet-stream",
      doc.docType,
    );
  } catch (err) {
    ocrError = err.message;
    console.error("[reprocessSofDocument] OCR failed:", err.message);
  }

  // Same verdict rule as the original upload; another outage just leaves the
  // doc in needs_review with the fresh error recorded.
  doc.status =
    ocrResult?.success === true
      ? ocrResult.is_valid
        ? "verified"
        : "rejected"
      : "needs_review";
  doc.ocr = buildSofOcrRecord(ocrResult, { docType: doc.docType, ocrError });

  sof.status = sof.documents.some((d) => d.status === "verified") ? "verified" : "in_review";
  await sof.save();

  logEvent({
    req,
    service: "kyc",
    action: "sof_document_reprocessed",
    customer: customer._id,
    afterValue: { docId: req.params.docId, status: doc.status },
  });

  res.status(200).json({
    success: true,
    message:
      doc.status === "verified"
        ? "Document verified"
        : doc.status === "rejected"
          ? "Document could not be verified"
          : "OCR still unavailable — document left in review",
    data: sof,
  });
});

// @desc   Staff upload of a SOF document on the customer's behalf — e.g. the
//         customer emailed a statement or handed it over in branch. Runs the
//         exact same OCR + storage pipeline as the customer's QR upload.
// @route  POST /api/v1/sof-verification/:customerId/documents
//         (multipart/form-data: docType, file, caseId?)
// @access Private (CUSTOMER.EDIT)
exports.uploadSofDocumentAsStaff = asyncHandler(async (req, res, next) => {
  const customer = await loadGuardedCustomer(req, next);
  if (!customer) return;

  const { docType, caseId } = req.body || {};
  if (!DOC_TYPES.includes(docType)) {
    return next(new ErrorResponse(`docType must be one of: ${DOC_TYPES.join(", ")}`, 400));
  }
  if (!req.file) return next(new ErrorResponse("Please attach a file", 400));

  let result;
  try {
    result = await processSofUpload({
      customer,
      file: req.file,
      docType,
      sourceType: "sof_staff_upload",
      uploadedBy: req.user?._id || null,
    });
  } catch (err) {
    return next(err);
  }
  const { sof, status } = result;

  logEvent({
    req,
    service: "kyc",
    action: "sof_document_uploaded",
    customer: customer._id,
    details:
      `SOF ${docType} uploaded by staff — ${status}` +
      (caseId ? ` (case ${caseId})` : ""),
  });

  // Authenticated reviewer response — return the full session, same as the
  // review/reprocess endpoints, so the panel can just replace its state.
  res.status(201).json({ success: true, message: sofStatusMessage(status), data: sof });
});

// ── Public: no-login mobile upload flow ───────────────────────────────────────

// @desc   Look up a customer before showing the mobile upload page
// @route  GET /api/v1/sof-verification/validate?cid=
// @access Public
exports.validateSofCustomer = asyncHandler(async (req, res, next) => {
  const { cid, client: clientParam } = req.query;
  if (!cid) return next(new ErrorResponse("cid required", 400));

  const customer = await Customer.findById(cid).select("personalKyc uid relations");
  if (!customer) return next(new ErrorResponse("Customer not found", 404));

  const sof = await ensureSofSession(customer);

  // Co-branding for the public page: it is Dooit's page, but the customer was
  // asked for the document by their own provider, so name (and where set, show)
  // that organisation. The link carries the requesting tenant as ?client=
  // (stamped by buildSofUrl from the sender's login). Honour it only if that
  // client actually holds a relation with this customer — the param is
  // public-facing, and a crafted URL must not brand the page as an arbitrary
  // tenant. Otherwise fall back to the customer's first relation.
  const relatedClientIds = (customer.relations || [])
    .map((r) => (r?.client ? String(r.client) : null))
    .filter(Boolean);
  const brandingClientId =
    clientParam && relatedClientIds.includes(String(clientParam))
      ? clientParam
      : relatedClientIds[0] || null;
  const client = await resolveClientBranding(brandingClientId);

  res.status(200).json({
    success: true,
    data: {
      customerId: cid,
      customerName: customerDisplayName(customer),
      client,
      docTypes: DOC_TYPES,
      documents: sof.documents.map((d) => ({
        _id: d._id,
        docType: d.docType,
        name: d.name,
        status: d.status,
        uploadedAt: d.uploadedAt,
      })),
    },
  });
});

// @desc   Upload + auto-verify one SOF document (public)
// @route  POST /api/v1/sof-verification/upload  (multipart/form-data: cid, docType, file)
// @access Public
exports.uploadSofDocument = asyncHandler(async (req, res, next) => {
  const { cid, docType } = req.body || {};

  if (!cid) return next(new ErrorResponse("cid required", 400));
  if (!DOC_TYPES.includes(docType)) {
    return next(new ErrorResponse(`docType must be one of: ${DOC_TYPES.join(", ")}`, 400));
  }
  if (!req.file) return next(new ErrorResponse("Please attach a file", 400));

  const customer = await Customer.findById(cid).select("relations");
  if (!customer) return next(new ErrorResponse("Customer not found", 404));

  let result;
  try {
    result = await processSofUpload({
      customer,
      file: req.file,
      docType,
      sourceType: "sof_qr_upload",
    });
  } catch (err) {
    return next(err);
  }
  const { sof, status, savedDoc } = result;

  // Public route — req.user is undefined; logEvent/recordDevice leave actor null.
  logEvent({
    req,
    service: "kyc",
    action: "sof_document_uploaded",
    customer: cid,
    details: `SOF ${docType} uploaded via QR — ${status}`,
  });
  recordDevice({ req, customerId: cid, purpose: "other", details: { event: "sof_upload", docType } });

  // Public, unauthenticated response — return only what the upload page shows.
  // The rest of the OCR record (analysis, transactions, raw) is internal
  // compliance commentary and stays on the reviewer side.
  res.status(201).json({
    success: true,
    message: sofStatusMessage(status),
    data: {
      document: {
        _id: savedDoc._id,
        docType: savedDoc.docType,
        name: savedDoc.name,
        status: savedDoc.status,
        uploadedAt: savedDoc.uploadedAt,
        ocr: {
          rejectionReason: savedDoc.ocr?.rejectionReason || null,
          accountInformation: savedDoc.ocr?.accountInformation || null,
        },
      },
      sofStatus: sof.status,
    },
  });
});
