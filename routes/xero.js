"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");

const {
  startAuth,
  callback,
  refresh,
  disconnect,
  status,
  syncNow,
  logs,
  getSettings,
  saveSettings,
  webhook,
  signupStart,
  signupPrefill,
  signupComplete,
  signupSession,
  signupPending,
  signupPendingContinue,
  connectionRequestDetails,
  connectionRequestApprove,
  connectionRequestReject,
  requireEnabled,
} = require("../controllers/xeroController");
const { protect, authorize, authorizeUserType } = require("../middleware/auth");

const router = express.Router();

// Connection state and tokens must never be cached by a browser or proxy.
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// ── Webhook — raw body REQUIRED for the HMAC (mounted before json()) ─────────
router.post("/webhook", express.raw({ type: "*/*", limit: "1mb" }), webhook);

// ── OAuth callback — public (Xero's browser redirect); state-authenticated ───
const oauthLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
router.get("/callback", oauthLimiter, requireEnabled, callback);

// ── Sign up with Xero — public; each step is authenticated by a one-time,
// short-lived secret (ticket / loginCode), never by cookies.
const signupRouter = express.Router();
signupRouter.use(express.json({ limit: "20kb" }));
signupRouter.use(oauthLimiter, requireEnabled);
signupRouter.get("/start", signupStart);
signupRouter.get("/prefill", signupPrefill);
signupRouter.post("/complete", signupComplete);
signupRouter.post("/session", signupSession);
signupRouter.get("/pending", signupPending);
signupRouter.post("/pending/continue", signupPendingContinue);
router.use("/signup", signupRouter);

// ── Existing-client approval. The emailed token identifies the request; approving
// additionally requires the caller to be that client's administrator. Tighter
// limit than the OAuth endpoints: these take a secret in the URL.
const approvalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const requestRouter = express.Router();
requestRouter.use(express.json({ limit: "10kb" }));
requestRouter.use(approvalLimiter, requireEnabled);
requestRouter.get("/:token", connectionRequestDetails);
requestRouter.post("/:token/reject", connectionRequestReject);
requestRouter.post(
  "/:token/approve",
  protect,
  authorizeUserType("client"),
  authorize("admin"),
  connectionRequestApprove
);
router.use("/connection-requests", requestRouter);

// ── Everything below: authenticated, admin of a client/branch (or dooit) ─────
router.use(express.json({ limit: "100kb" }));
router.use((req, _res, next) => {
  if (req.body == null) req.body = {};
  next();
});
router.use(protect);
router.use(authorizeUserType("client", "branch", "dooit"), authorize("admin"));

router.get("/auth", oauthLimiter, requireEnabled, startAuth);
router.post("/refresh", requireEnabled, refresh);
router.post("/disconnect", disconnect);
router.get("/status", status);
router.post("/sync", requireEnabled, syncNow);
router.get("/logs", logs);
router.get("/settings", requireEnabled, getSettings);
router.put("/settings", requireEnabled, saveSettings);

module.exports = router;
