// routes/customers.js
const express = require("express");
const {
  createInvite,
  validateInvite,

  acceptInvite,
  filterCustomerSection,
  getCustomers,
  getCustomerStats,
  getCustomer,
  getCustomerReports,
  createCustomerDummy,
  getCompanyKycs,
  getCompanyKyc,
  getCompanyKycStats,
  createCompanyKyc,
  updateCompanyKyc,
  ocrExtractCompany,
  updateCompanyReviewStatus,
  getCompanyKycAudit,
  addCompanyDocuments,
  removeCompanyDocument,
  updateCompanyDocument,
  getTrustKycs,
  getTrustKyc,
  getCompaniesForTrust,
  createTrustKyc,
  updateTrustKyc,
  ocrExtractTrust,
  getNonIndividualKycs,
  createInviteFromQr,
  downloadQR,
  getCustomerOnBoardData,
  submitCustomerOnboardRequest,
  // merged in from the former per-concern customer controllers
  exportCustomers,
  exportCustomerKycPdf,
  updateCustomerKycStatus,
  reviewJourneyStep,
  addCustomerDocuments,
  removeCustomerDocument,
  manualImportCustomer,
} = require("../controllers/customerController");

const Customer = require("../models/Customer");
const ocrUpload = require("../middleware/ocrUpload");

const router = express.Router();

// Staff access is granted by CUSTOMER.* permissions (RolePermission), not by a
// hard-coded role-name list. authorize() survives only on the customer-self
// routes below, where "customer" identifies the subject of the request rather
// than an access level.
const { protect, authorize, authorizePermission } = require("../middleware/auth");

// Staff-side manual import of an individual customer (in-branch onboarding).
// Registered BEFORE the router-level 100kb json parser — signature images
// (base64 data-URIs) in the declaration need a larger body limit.
router.post(
  "/manual-import",
  express.json({ limit: "5mb" }),
  protect,
  authorizePermission("CUSTOMER.ADD"),
  manualImportCustomer,
);

router.use(express.json({ limit: "100kb" }));
const advancedCustomerResultsQueryOnly = require("../middleware/advancedCustomerResultsQueryOnly");
const kybListQuery = require("../middleware/kybListQuery");
// Protect all routes and allow only authorized roles (adjust as needed)

router.route("/").get(
  protect,
  authorizePermission("CUSTOMER.GET"),
  advancedCustomerResultsQueryOnly({
    model: Customer,
    populate: [
      { path: "user", select: "name email userName photoUrl" },
      { path: "relations.client", select: "name" },
      { path: "relations.branch", select: "name" },
    ],
    // Plain Mongo regex fields only. `user` is a ref (ObjectId) on Customer, so
    // "user.name" can't be queried here — the linked user's name is matched
    // by findIdsByDecryptedKyc inside the middleware instead.
    searchFields: [
      "uid",
      "personalKyc.personal_form.customer_details.given_name",
      "personalKyc.personal_form.customer_details.surname",
    ],
  }),
  getCustomers,
);

// protect: inviting a customer is a create action on the customer record
router.post(
  "/invite",
  protect,
  authorizePermission("CUSTOMER.ADD"),
  createInvite,
);
router.post(
  "/invite-from-qr",
  createInviteFromQr,
);
router.get(
  "/download-qr",
  protect,
  authorizePermission("CUSTOMER.GET"),
  downloadQR,
);

// Analytics for the customer queue dashboard.
// Must be declared before the "/:id" route so "stats" isn't matched as an id.
router.get(
  "/stats",
  protect,
  authorizePermission("CUSTOMER.GET"),
  getCustomerStats,
);

// Professional Excel export of the customer queue (before "/:id").
router.get(
  "/export",
  protect,
  authorizePermission("CUSTOMER.GET"),
  exportCustomers,
);

// Sumsub-style per-customer KYC applicant report (PDF).
router.get(
  "/:id/kyc-export",
  protect,
  authorizePermission("CUSTOMER.GET"),
  exportCustomerKycPdf,
);

// Manual KYC decision (approve / reject / status change) with audit note.
router.patch(
  "/:id/kyc-status",
  protect,
  authorizePermission("CUSTOMER.EDIT"),
  updateCustomerKycStatus,
);

// Manual approve/reject of a single verification journey step (e.g. ID Document).
router.patch(
  "/:id/journeys/:journeyId/steps/:stepType/review",
  protect,
  authorizePermission("ONBOARDING.REVIEW", "CUSTOMER.EDIT"),
  reviewJourneyStep,
);

// Reviewer-side customer documents (Documents tab): add / remove by URL.
router
  .route("/:id/documents")
  .post(
    protect,
    authorizePermission("CUSTOMER.EDIT"),
    addCustomerDocuments,
  )
  .delete(
    protect,
    authorizePermission("CUSTOMER.EDIT"),
    removeCustomerDocument,
  );




// Compliance reports (ECDD/SMR/TTR/IFTI/GFS/RFI) filed against this customer
router
  .route("/:id/reports")
  .get(protect, authorizePermission("CUSTOMER.GET"), getCustomerReports);

router
  .route("/:id")
  .get(protect, authorizePermission("CUSTOMER.GET"), getCustomer);
// .put(updateClient)
// .delete(deleteClient);

// public endpoints (token validation, registration from invite)
router.get("/invite/validate", validateInvite);

// Customer-self: the caller IS the customer, so this stays a role identity check.
router.post(
  "/register/onboarding",
  protect,
  authorize("customer"),
  acceptInvite,
);
router.post(
  "/dummy/create",
  protect,
  authorizePermission("CUSTOMER.ADD"),
  createCustomerDummy,
);


///Company:
router.post(
  "/company",
  protect,
  authorizePermission("CUSTOMER.ADD"),
  createCompanyKyc,
);
router.put(
  "/company/:id",
  protect,
  authorizePermission("CUSTOMER.EDIT"),
  updateCompanyKyc,
);
// eKYB OCR pre-fill (docs/65 Step 48) — extraction only, no CompanyKyc
// write; the wizard merges the result into its own local state.
router.post(
  "/company/ocr",
  protect,
  authorizePermission("CUSTOMER.ADD", "CUSTOMER.EDIT"),
  ocrUpload.single("image"),
  ocrExtractCompany,
);
// KYB review decision (docs/65 Step 31) — approve / escalate / decline with
// history + audit; distinct from the registry status on the record itself.
router.patch(
  "/company/:id/review-status",
  protect,
  authorizePermission("CUSTOMER.EDIT"),
  updateCompanyReviewStatus,
);
router.get(
  "/company/:id/audit",
  protect,
  authorizePermission("CUSTOMER.GET"),
  getCompanyKycAudit,
);
router
  .route("/company/:id/documents")
  .post(
    protect,
    authorizePermission("CUSTOMER.EDIT"),
    addCompanyDocuments,
  )
  .delete(
    protect,
    authorizePermission("CUSTOMER.EDIT"),
    removeCompanyDocument,
  );
router.patch(
  "/company/:id/documents/:docId",
  protect,
  authorizePermission("CUSTOMER.EDIT"),
  updateCompanyDocument,
);
router.get(
  "/company/all",
  protect,
  authorizePermission("CUSTOMER.GET"),
  // advancedResults stays removed (docs/65 Step 30): it ran a second,
  // discarded query per call, and it turns any leftover query param into a
  // Mongo filter key. kybListQuery only BUILDS a whitelisted query onto
  // req.kybQuery (docs/65 Step 68) — the controller still runs exactly one.
  kybListQuery("company"),
  getCompanyKycs
);
// Portfolio analytics for the companies-list dashboard (docs/65 Step 58).
// MUST stay above "/company/:id" — otherwise "stats" is captured as an id
// and answered by getCompanyKyc as a 404.
router.get(
  "/company/stats",
  protect,
  authorizePermission("CUSTOMER.GET"),
  getCompanyKycStats,
);
router.get(
  "/company/:id",
  protect,
  authorizePermission("CUSTOMER.GET"),

  getCompanyKyc
);

//Trust
router.get(
  "/trust/all",
  protect,
  authorizePermission("CUSTOMER.GET"),
  kybListQuery("trust"),
  getTrustKycs
);
// Reverse lookup: which companies this trust holds an interest in (docs/65
// Step 70). Declared before "/trust/:id" for readability — Express matches on
// segment count, so the order is not load-bearing here, unlike "/trust/ocr".
router.get(
  "/trust/:id/companies",
  protect,
  authorizePermission("CUSTOMER.GET"),
  getCompaniesForTrust,
);
router.get(
  "/trust/:id",
  protect,
  authorizePermission("CUSTOMER.GET"),

  getTrustKyc
);
// eKYB OCR pre-fill for a Trust Deed (docs/65 Step 50) — extraction only;
// consumed by the company wizard's "held on behalf of a trust" form
// (TrustFields), same pattern as /company/ocr.
router.post(
  "/trust/ocr",
  protect,
  authorizePermission("CUSTOMER.ADD", "CUSTOMER.EDIT"),
  ocrUpload.single("image"),
  ocrExtractTrust,
);
// Standalone trust writers (docs/65 Step 57) — a trust can now be saved on
// its own, so another company can connect to it later. Declared after
// "/trust/ocr" above so that literal path is never parsed as "/trust/:id".
router.post(
  "/trust",
  protect,
  authorizePermission("CUSTOMER.ADD"),
  createTrustKyc,
);
router.put(
  "/trust/:id",
  protect,
  authorizePermission("CUSTOMER.EDIT"),
  updateTrustKyc,
);

router.get(
  "/non-individual/all",
  protect,
  authorizePermission("CUSTOMER.GET"),
  getNonIndividualKycs
);
// router.get(
//   "/non-individual/all",
//   protect,
//   authorizePermission("CUSTOMER.GET"),

//   getTrustKyc
// );

// Customer-self onboarding — role identity check, not an access level.
router.get(
  "/onboarding/:id",
  protect,
  authorize("customer"),

  getCustomerOnBoardData
);
router.put(
  "/onboarding/:id/request",
  protect,
  authorize("customer"),

  submitCustomerOnboardRequest
);
module.exports = router;
