/**
 * Who is calling the exchange hub?
 *   - a service (AFC OS worker) with the shared-key request signature → caller { app: "afcos" }
 *   - a platform user (ui / ewra_ui server actions) with the normal bearer token → caller
 *     { app: X-Exchange-App (portal | grc, default portal), client: req.user.clientBelongs }
 * Tenants may only see / receipt / produce events for their own client; AFC OS may see everything.
 */
const asyncHandler = require("./async");
const ErrorResponse = require("../utils/errorResponse");
const { protect } = require("./auth");
const { verifyRequest } = require("../utils/exchangeCrypto");

const exchangeCaller = asyncHandler(async (req, res, next) => {
  if (req.get("x-exchange-signature")) {
    if (!verifyRequest(req)) return next(new ErrorResponse("Invalid or stale exchange signature", 401));
    const app = String(req.get("x-exchange-app") || "afcos").toLowerCase();
    if (!["afcos", "bfiu"].includes(app)) return next(new ErrorResponse("Service signatures are accepted for afcos or bfiu only", 403));
    req.exchangeCaller = { app, service: true, client: null, user: null };
    return next();
  }
  return protect(req, res, (err) => {
    if (err) return next(err);
    const app = String(req.get("x-exchange-app") || "portal").toLowerCase();
    if (!["portal", "grc"].includes(app)) return next(new ErrorResponse("X-Exchange-App must be portal or grc for a platform user", 400));
    const client = req.user?.clientBelongs ?? null;
    if (!client) return next(new ErrorResponse("Only tenant users (a client or branch membership) use the exchange as portal / grc", 403));
    req.exchangeCaller = { app, service: false, client, user: req.user };
    return next();
  });
});

module.exports = { exchangeCaller };
