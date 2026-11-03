// routes/index.js
const express = require("express");
const router = express.Router();

// Import individual route files
const fileUpload = require("./fileupload");
const fileVault = require("./fileVault");
const otp = require("./otp");
const user = require("./user");
const auth = require("./auth");
const role = require("./role");
const location = require("./location");
// const notification = require("./notification");
const client = require("./client");
const branch = require("./branch");
const customer = require("./customer");
const sofVerification = require("./sofVerification");
const onboardingJourney = require("./onboardingJourney");
const sumsub = require("./sumsub");
const transaction = require("./transaction");
const demo = require("./demoData");
const dummyImport = require("./dummyImport");
const ecddReport = require("./ecdd-report");
const smrReport = require("./smr-report");
const gfsReport = require("./gfs-report");
const dismissalReport = require("./dismissal-report");
const iftiReport = require("./ifti-report");
const ttrReport = require("./ttr-report");
const alert = require("./alert");
const rfi = require("./rfi");
const notify = require("./notify");
const leads = require("./leads");
const ruleEngine = require("./ruleEngine");
const workflow = require("./workflow");
const newsletter = require("./newsletter");
const contact = require("./contact");
// const clientRule = require("./clientRules");
const policyHub = require("./policyHub");
const policyHubTemplate = require("./policyHubTemplate");
const riskassessment = require("./riskassessment");
const privacy = require("./privacy");
const rolePermission = require("./rolePermission");
const trainingModule = require("./trainingModule");
const cases = require("./cases");
const tbml = require("./tbml");
const devices = require("./devices");
const audit = require("./audit");
const assignmentRoutes = require("./trainingAssignment");
const progressRoutes = require("./trainingProgress");
const reportRoutes = require("./trainingReport");

// ── Phase 1: EWRA / GRC ───────────────────────────────────────────────────────
const entityType = require("./entity-type");
const entityProfile = require("./entity-profile");
const obligationLibrary = require("./obligation-library");
const entityObligation = require("./entity-obligation");

// ── Phase 2: Controls Library ─────────────────────────────────────────────────
const control = require("./control");
const controlAssignments = require("./control-assignments");

// ── Phase 3: EWRA Risk Assessment ─────────────────────────────────────────────
const ewra = require("./ewra");
const countryRisk = require("./country-risk");
const riskRegister = require("./risk-register");
const riskPool = require("./risk-pool");

// ── Phase 5: Testing Module ───────────────────────────────────────────────────
const testTemplate = require("./test-template");
const testSchedule = require("./test-schedule");

// ── Phase 6: Issues & Remediation ────────────────────────────────────────────
const issue = require("./issue");

// ── Phase 7: Executive Dashboard ─────────────────────────────────────────────
const grcDashboard = require("./grc-dashboard");
const ewraDashboard = require("./ewra-dashboard");
const lawyerDashboard = require("./lawyer-dashboard");

// ── Phase 8: RG Obligation Mapper ─────────────────────────────────────────────
const rgMapper = require("./rg-mapper");

// ── AFC Documents ─────────────────────────────────────────────────────────────
const afcDocument = require("./afc-document");

// ── AML Document Generation ───────────────────────────────────────────────────
const amlDocument = require("./amlDocument");

// ── Onboarding Step ───────────────────────────────────────────────────────────
const onboardingStep = require("./onboardingStep");

// ── Staff Onboarding ──────────────────────────────────────────────────────────
const staff = require("./staff");

// ── Global OCR ────────────────────────────────────────────────────────────────
const ocr = require("./ocr");
 
// ── GRC Notification Engine ───────────────────────────────────────────────────
const appNotification = require("./app-notification");
const monitoringRule = require("./monitoringRule");

// ── Billing & Subscription ────────────────────────────────────────────────────
const product = require("./product");
const billingPlan = require("./billing-plan");
const subscription = require("./subscription");
const usage = require("./usage");
const invoice = require("./invoice");
const payment = require("./payment");

// Mount routes
router.use("/fileupload", fileUpload);
router.use("/file-vault", fileVault);
router.use("/auth", auth);
router.use("/afc-os", require("./afc-os")); // connector to the regulator's AFC OS (client credentials server-side)
router.use("/exchange", require("./exchange")); // cross-platform event hub (AFC OS ↔ portal / GRC / BFIU)
router.use("/otp", otp);
router.use("/user", user);
router.use("/role", role);
router.use("/location", location);
// router.use("/notify", notification);
router.use("/branch", branch);
router.use("/transaction", transaction);
router.use("/demo", demo);
router.use("/dummy-import", dummyImport);
router.use("/customer", customer);
router.use("/sof-verification", sofVerification);
router.use("/onboarding-journey", onboardingJourney);
router.use("/sumsub", sumsub);
router.use("/client", client);
router.use("/smr-report", smrReport);
router.use("/ecdd-report", ecddReport);
router.use("/alert", alert);
router.use("/rfi", rfi);
router.use("/gfs-report", gfsReport);
router.use("/dismissal-report", dismissalReport);
router.use("/ifti-report", iftiReport);
router.use("/ttr-report", ttrReport);
router.use("/report-notify", notify);
router.use("/email", leads);
router.use("/rule-engine", ruleEngine);
router.use("/workflow", workflow);
router.use("/newsletter", newsletter);
router.use("/contact", contact);
// router.use("/client-rule", clientRule);
router.use("/policy-hub", policyHub);
router.use("/policy-hub-templates", policyHubTemplate);
router.use("/risk-assessment", riskassessment);
router.use("/privacy", privacy);
router.use("/role-permissions", rolePermission);

// Case Management
router.use("/cases", cases);
// TBML screening (OSINT Engine), cached and tenant-scoped here
router.use("/tbml", tbml);
router.use("/devices", devices);
router.use("/audit", audit);

//Training module CRUD + quiz management + video progress
router.use("/training-modules", trainingModule);
// Standalone assignment endpoints  (assign, list-mine, list-by-me, detail, delete, status)
router.use("/training-assignments", assignmentRoutes);

// Learner progress + quiz submission + video watch + complete + retake
router.use("/training-progress", progressRoutes);

// Manager/admin reports
router.use("/training-reports", reportRoutes);

// ── Phase 1: EWRA / GRC ───────────────────────────────────────────────────────
router.use("/entity-type", entityType);
router.use("/entity-profile", entityProfile);
router.use("/obligation-library", obligationLibrary);
router.use("/entity-obligation", entityObligation);

// ── Phase 2: Controls Library ─────────────────────────────────────────────────
router.use("/control", control);
router.use("/control-assignments", controlAssignments);

// ── Phase 3: EWRA Risk Assessment ─────────────────────────────────────────────
router.use("/ewra", ewra);
router.use("/country-risk", countryRisk);
router.use("/risk-register", riskRegister);
router.use("/risk-pool", riskPool);

// ── Phase 5: Testing Module ───────────────────────────────────────────────────
router.use("/test-template", testTemplate);
router.use("/test-schedule", testSchedule);

// ── Phase 6: Issues & Remediation ────────────────────────────────────────────
router.use("/issue", issue);

// ── Phase 7: Executive Dashboard ─────────────────────────────────────────────
router.use("/grc-dashboard", grcDashboard);
router.use("/ewra-dashboard", ewraDashboard);
router.use("/lawyer-dashboard", lawyerDashboard);

// ── Phase 8: RG Obligation Mapper ─────────────────────────────────────────────
router.use("/rg-mapper", rgMapper);

// ── AFC Documents ─────────────────────────────────────────────────────────────
router.use("/afc-documents", afcDocument);
router.use("/aml-document", amlDocument);

// ── Onboarding Step ───────────────────────────────────────────────────────────
router.use("/onboarding-step", onboardingStep);

// ── Staff Onboarding ──────────────────────────────────────────────────────────
router.use("/staff", staff);

// ── Global OCR ────────────────────────────────────────────────────────────────
router.use("/ocr", ocr);

// ── GRC Notification Engine ───────────────────────────────────────────────────
router.use("/app-notifications", appNotification);
router.use("/monitoring-rule", monitoringRule);

// ── Billing & Subscription ────────────────────────────────────────────────────
router.use("/product", product);
router.use("/billing-plan", billingPlan);
router.use("/subscription", subscription);
router.use("/usage", usage);
router.use("/invoice", invoice);
router.use("/payment", payment);

module.exports = router;