// routes/sofVerification.js
// Source of Funds (SOF) verification — admin read/email/review of a
// customer-id-keyed, auto-provisioned upload session, and the public
// no-login mobile upload flow (cid only — no per-link token).
const express = require("express");
const multer = require("multer");

const {
  getSofVerification,
  sendSofEmail,
  reviewSofDocument,
  reprocessSofDocument,
  uploadSofDocumentAsStaff,
  validateSofCustomer,
  uploadSofDocument,
} = require("../controllers/sofVerificationController");

const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();

// Memory storage — buffer is forwarded as-is to FileVault + the OCR service,
// mirrors middleware/ocrUpload.js.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// ── Public: no-login mobile upload flow ───────────────────────────────────────
// Declared before express.json() so multer alone parses these bodies —
// mirrors routes/fileVault.js's reasoning about not double-parsing multipart.
router.get("/validate", validateSofCustomer);
router.post("/upload", upload.single("file"), uploadSofDocument);

router.use(express.json({ limit: "100kb" }));

// ── Admin (dashboard) ─────────────────────────────────────────────────────────
router.get(
  "/customer/:customerId",
  protect,
  authorizePermission("CUSTOMER.GET"),
  getSofVerification,
);
router.post(
  "/:customerId/send-email",
  protect,
  authorizePermission("CUSTOMER.EDIT"),
  sendSofEmail,
);
// Staff upload on the customer's behalf. Auth runs before multer so an
// unauthenticated request is refused before its file is buffered.
router.post(
  "/:customerId/documents",
  protect,
  authorizePermission("CUSTOMER.EDIT"),
  upload.single("file"),
  uploadSofDocumentAsStaff,
);
router.patch(
  "/:customerId/documents/:docId",
  protect,
  authorizePermission("CUSTOMER.EDIT"),
  reviewSofDocument,
);
router.post(
  "/:customerId/documents/:docId/reprocess",
  protect,
  authorizePermission("CUSTOMER.EDIT"),
  reprocessSofDocument,
);

module.exports = router;
