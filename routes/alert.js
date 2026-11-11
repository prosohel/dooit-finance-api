// routes/alerts.js
const express = require("express");
const {
  getAlerts,
  getAlertsPost,
  createAlert,
  createDummyAlert,
  getAlert,
  updateAlert,
  deleteAlert,
  filterAlertSection,
  assignAnalyst,
  getDummyEccdData,
  reviewAlert,
  dismissAlert,
  escalateAlertToCase,
  addAlertNote,
  getAlertAudit,
  getRelatedTransactions,
  getAlertReports,
  getAlertMonitoringResult,
  getAttachableCases,
} = require("../controllers/alertController");

const Alert = require("../models/Alert");
const advancedResults = require("../middleware/advancedResults");

const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();

router.use(express.json({ limit: "100kb" }));

// Every alert route needs an ALERT grant; each route below narrows by verb.
router.use(protect);
router.use(
  authorizePermission("ALERT.GET", "ALERT.ADD", "ALERT.EDIT", "ALERT.DELETE"),
);

// List alerts (GET with query params, POST with body filter via advancedResults)
router
  .route("/")
  .get(
    authorizePermission("ALERT.GET"),
    advancedResults(Alert, "customer analyst transaction"),
    getAlerts,
  )
  .post(
    authorizePermission("ALERT.GET"),
    advancedResults(Alert, "customer analyst transaction", filterAlertSection),
    getAlertsPost,
  );

// Create new alert
router.route("/new").post(authorizePermission("ALERT.ADD"), createAlert);

// Create dummy alert
router.route("/dummy").post(authorizePermission("ALERT.ADD"), createDummyAlert);

// CRUD by id
router
  .route("/:id")
  .get(authorizePermission("ALERT.GET"), getAlert)
  .put(authorizePermission("ALERT.EDIT"), updateAlert)
  .delete(authorizePermission("ALERT.DELETE"), deleteAlert);

router
  .route("/:id/assign-analyst")
  .put(authorizePermission("ALERT.EDIT"), assignAnalyst);

// ── Details-page companions ──────────────────────────────────────────────────
// Analyst notes live on alert.activity (type 'note'); this is the only writer.
router.route("/:id/notes").post(authorizePermission("ALERT.EDIT"), addAlertNote);
// Alert-scoped audit trail (AuditLog.alert) — readable with the alert itself.
router.route("/:id/audit").get(authorizePermission("ALERT.GET"), getAlertAudit);
// Other transactions of the alert's customer, for the Transaction & Parties tab.
router.route("/:id/related-transactions").get(authorizePermission("ALERT.GET"), getRelatedTransactions);
// Compliance reports raised from this alert (works before and after escalation).
router.route("/:id/reports").get(authorizePermission("ALERT.GET"), getAlertReports);
// AI transaction-monitoring result (transaction-monitoring-ai-results) behind the alert.
router.route("/:id/monitoring-result").get(authorizePermission("ALERT.GET"), getAlertMonitoringResult);

// ── AML alert lifecycle ───────────────────────────────────────────────────────
// Analyst picks up an alert for review
router.route("/:id/review").put(authorizePermission("ALERT.EDIT"), reviewAlert);

// Dismiss an alert (dismissed | false_positive)
router.route("/:id/dismiss").put(authorizePermission("ALERT.EDIT"), dismissAlert);

// Open cases of the alert's customer it could be attached to (escalate dialog)
router
  .route("/:id/attachable-cases")
  .get(authorizePermission("ALERT.GET"), getAttachableCases);

// Promote an alert to an investigation case — body { caseId? | attach: 'auto' }
// attaches to an existing case of the same customer, otherwise a case is created.
router
  .route("/:id/escalate")
  .post(authorizePermission("CASE.ADD", "ALERT.EDIT"), escalateAlertToCase);

router
  .route("/:caseNumber/eccd-dummy")
  .get(authorizePermission("ALERT.GET"), getDummyEccdData);

module.exports = router;
