const express = require("express");
const { protect } = require("../middleware/auth");
const multer = require("multer");
const { status, handoff, handoffInbound, handoffExchange, fileForAfcOs, fileStoreForAfcOs } = require("../controllers/afcOsController");
// Memory storage: the bytes go straight to the vault service; 25 MB per document (docs/78 §8).
const uploadForAfcOs = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const { exchangeCaller } = require("../middleware/exchangeAuth");

const router = express.Router();
// JSON parsing is mounted per router in this API (uploads must reach multer untouched).
router.use(express.json({ limit: "50kb" }));

/**
 * @swagger
 * tags:
 *   name: AFC OS
 *   description: Connector to the regulator's AFC OS platform (client credentials held server-side)
 */

/**
 * @swagger
 * /afc-os/status:
 *   get:
 *     summary: Whether AFC OS is configured and reachable, and the scopes this platform holds there
 *     tags: [AFC OS]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ configured, connected, clientId, scopes }" }
 */
router.get("/status", protect, status);

/**
 * @swagger
 * /afc-os/handoff:
 *   post:
 *     summary: Single sign-on into AFC OS for the logged-in user (15-minute single-use link)
 *     tags: [AFC OS]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { userType: { type: string }, returnTo: { type: string } } }
 *     responses:
 *       200: { description: "{ url, expiresAt, context }" }
 *       403: { description: No AFC OS account for this user }
 */
router.post("/handoff", protect, handoff);

/**
 * @swagger
 * /afc-os/handoff/inbound:
 *   post:
 *     summary: AFC OS → platform — issue a single-use SSO ticket for a regulator officer (signed service call)
 *     tags: [AFC OS]
 */
router.post("/handoff/inbound", exchangeCaller, handoffInbound);
/**
 * @swagger
 * /afc-os/handoff/exchange:
 *   post:
 *     summary: Exchange a handoff ticket once for a platform session as the officer's dooit membership
 *     tags: [AFC OS]
 */
router.post("/handoff/exchange", handoffExchange);

/**
 * @swagger
 * /afc-os/files/{id}:
 *   get:
 *     summary: Stream a file-vault object to AFC OS (signed service call) — the intake pipeline fetches RO documents this way
 *     tags: [AFC OS]
 */
router.get("/files/:id", exchangeCaller, fileForAfcOs);
/**
 * @swagger
 * /afc-os/files:
 *   post:
 *     summary: Store a document AFC OS received (MLTFPD upload on an RO's behalf) in the file vault — signed service call, multipart `file`
 *     tags: [AFC OS]
 */
router.post("/files", exchangeCaller, uploadForAfcOs.single("file"), fileStoreForAfcOs);

module.exports = router;
