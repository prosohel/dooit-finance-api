const express = require("express");
const { exchangeCaller } = require("../middleware/exchangeAuth");
const c = require("../controllers/exchangeController");

/**
 * @swagger
 * tags:
 *   name: Exchange
 *   description: Cross-platform event hub (AFC OS ↔ Client Portal / GRC / BFIU). Service callers sign requests with the shared exchange key; tenant users use their bearer token.
 */
const router = express.Router();
router.use(express.json({ limit: "2mb" }));
router.use(exchangeCaller);

/**
 * @swagger
 * /exchange/events:
 *   get:
 *     summary: Events addressed to the caller, oldest first (cursor = seq)
 *     tags: [Exchange]
 *     parameters:
 *       - { in: query, name: to, schema: { type: string } }
 *       - { in: query, name: after, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *   post:
 *     summary: Deliver a signed event (service) or produce one (tenant)
 *     tags: [Exchange]
 */
router.route("/events").get(c.feed).post(c.ingest);
router.get("/events/:eventId", c.get);
/**
 * @swagger
 * /exchange/events/{eventId}/receipt:
 *   post:
 *     summary: Record delivered / read / acknowledged; echoed to the producer as receipt.*
 *     tags: [Exchange]
 */
router.post("/events/:eventId/receipt", c.receipt);
router.get("/status", c.status);

module.exports = router;
