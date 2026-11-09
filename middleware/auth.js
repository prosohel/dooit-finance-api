const jwt = require("jsonwebtoken");
const User = require("../models/User");
const UserType = require("../models/UserType");
const Role = require("../models/Role");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
const ErrorResponse = require("../utils/errorResponse");
const asyncHandler = require("./async");
const { generateQR } = require("../utils/qrService");
const { runWithRole } = require("../utils/roleEncryptionPlugin");
const RolePermission = require("../models/RolePermission");
const CompanyKyc = require("../models/CompanyKyc");

exports.protect = asyncHandler(async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return next(new ErrorResponse("Not authorize to access this route", 401));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // User is now identity-only — load just the user record (no scalar role/tenant fields).
    const u = await User.findById(decoded.id).populate('customer client branch').lean();


    if (!u) {
      return next(new ErrorResponse("Not authorize to access this route", 401));
    }

    // Overlay active context from the token (the hat chosen at login / switch-context).
    u.userTypeId = decoded.userTypeId ?? null;
    u.userType = decoded.userType ?? "user";
    u.role = decoded.role ?? "user";
    const clientId = decoded.clientBelongs ?? null;
    const branchId = decoded.branchBelongs ?? null;

    // Load rich client/branch objects by the active tenant IDs from the token.
    // This is unambiguous even when a user belongs to several clients.
    // let [client, branch] = await Promise.all([
    //   clientId ? Client.findById(clientId).lean() : Promise.resolve(null),
    //   branchId ? Branch.findById(branchId).populate("client").lean() : Promise.resolve(null),
    // ]);

    // Fallback: if the JWT has no clientId/branchId (stale UserType seeded before
    // Client/Branch was created), discover by User reference and self-heal the UserType row.
    // if (!client && u.userType === "client") {
    //   client = await Client.findOne({ user: u._id }).lean();
    //   if (client && decoded.userTypeId) {
    //     UserType.findOneAndUpdate(
    //       { _id: decoded.userTypeId },
    //       { $set: { clientBelongs: client._id } }
    //     ).catch(() => { });
    //   }
    // }
    // if (!branch && u.userType === "branch") {
    //   branch = await Branch.findOne({ user: u._id }).populate("client").lean();
    //   if (branch && decoded.userTypeId) {
    //     UserType.findOneAndUpdate(
    //       { _id: decoded.userTypeId },
    //       { $set: { branchBelongs: branch._id, clientBelongs: branch.client?._id ?? null } }
    //     ).catch(() => { });
    //   }
    // }

    //  "individual",
    // "company",
    // "partnership",
    // "government_body",
    // "association",
    // "cooperative",
    // "trust",



    // let company = [];

    // if (u?.customer) {
    //   u.customer.relations.forEach(async (relation) => {
    //     if (relation) {
    //       const filterObj = {
    //         client: relation.client,
    //         branch: relation.branch,
    //         customer: u?.customer._id,

    //       };
    //       const c = await CompanyKyc.find(filterObj)
    //       company = c;
    //     }
    //   });
    // }
    // console.log(company)
    // let [company, trust] = await Promise.all([
    //   clientId ? Client.findById(clientId).lean() : Promise.resolve(null),
    //   branchId ? Branch.findById(branchId).populate("client").lean() : Promise.resolve(null),
    // ]);

    // Tenant for staff logins (userType client/branch). `u.client`/`u.branch`
    // are populate virtuals keyed on OWNERSHIP (Client.user / Branch.user), so
    // they were null for every staff member who doesn't own the record —
    // compliance officers, managers, non-owner admins — and every
    // `req.user.client._id` tenant filter downstream silently ran unscoped
    // (customer list, exports, privacy bulk encrypt/decrypt, record creation).
    // The token's clientBelongs/branchBelongs come from the membership chosen
    // at login / switch-context, so they decide the tenant. Owners whose token
    // names the client they own need no extra query. Platform (dooit) and
    // customer logins are unchanged.
    let client = u.client ?? null;
    let branch = u.branch ?? null;
    if (u.userType === "client" || u.userType === "branch") {
      const [tokenClient, tokenBranch] = await Promise.all([
        clientId && String(client?._id) !== String(clientId)
          ? Client.findById(clientId).lean()
          : client,
        branchId && String(branch?._id) !== String(branchId)
          ? Branch.findById(branchId).lean()
          : branch,
      ]);
      // The membership's tenant no longer exists — fail closed instead of
      // falling back to unscoped access.
      if ((clientId && !tokenClient) || (branchId && !tokenBranch)) {
        return next(new ErrorResponse("Not authorize to access this route", 401));
      }
      client = tokenClient;
      branch = tokenBranch;
    }

    const resolvedClientId = client?._id ?? clientId ?? null;
    const resolvedBranchId = branch?._id ?? branchId ?? null;

    let qr = null;
    if (resolvedClientId && (u.userType === 'client' || u.userType === 'branch')) {
      qr = await generateQR({
        clientId: resolvedClientId.toString(),
        branchId: resolvedBranchId ? resolvedBranchId.toString() : null,
        format: "base64",
      });
    }

    req.user = {
      ...u,
      id: u._id,

      clientBelongs: resolvedClientId,
      branchBelongs: resolvedBranchId,
      client: client ?? branch?.client ?? null,
      // `branch` is populated one level deep (or loaded lean), so
      // `branch.client` is already the id (not a document) — collapse both
      // shapes to an id.
      branch: branch
        ? { ...branch, client: branch.client?._id ?? branch.client ?? null }
        : null,
      qr,
    };

    let canReadDecrypted = false;
    let permissions = [];
    try {
      // Role names are operator-supplied ("Compliance officer", "C++ Lead"), so
      // escape before building the anchored case-insensitive match.
      const escaped = String(u.role ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const roleDoc = await Role.findOne({
        name: { $regex: new RegExp(`^${escaped}$`, "i") },
      })
        .select("_id")
        .lean();
      const roleId = roleDoc?._id;

      [canReadDecrypted, permissions] = await Promise.all([
        RolePermission.isGranted(u._id, roleId, { clientId: resolvedClientId, branchId: resolvedBranchId }),
        RolePermission.getPermissions(roleId, u._id),
      ]);
    } catch (permErr) {
      console.error("[auth] RolePermission lookup failed:", permErr.message);
    }

    req.user.permissions = permissions;
    runWithRole(req.user.role, canReadDecrypted, next);
  } catch (error) {
    console.log(error);
    return next(new ErrorResponse("Not authorize to access this route", 401));
  }
});

exports.verifyUser = asyncHandler(async (req, res, next) => {
  try {
    if (!req.user?.isActive) {
      return next(
        new ErrorResponse(
          "Your account not verify yet! Please verify by OTP.",
          401
        )
      );
    }
    next();
  } catch (error) {
    return next(new ErrorResponse("Please verify your account first!", 401));
  }
});

// ── Role-based guard (LEGACY — prefer authorizePermission) ───────────────────
// Checks the ACTIVE hat's role name (from the JWT). Pure role check — no
// implicit userType bypass.
//
// Roles are created at runtime from the UI, so any hard-coded name list here
// goes stale the moment an operator adds a role: "Compliance officer" could not
// pass authorize("admin","client","branch","manager","officer") on ANY route.
// Staff routes now use authorizePermission instead. What remains for this guard
// is identity checks, where the role IS the subject of the route (a customer
// reading their own onboarding record), not an access level.
exports.authorize = (...roles) => {
  return (req, res, next) => {
    const userRole = (req.user.role ?? "").toLowerCase();
    if (!roles.map((r) => r.toLowerCase()).includes(userRole)) {
      return next(
        new ErrorResponse(
          `User role "${req.user.role}" is not authorized to access this resource`,
          403
        )
      );
    }
    next();
  };
};

// ── UserType guard ────────────────────────────────────────────────────────────
// Checks the ACTIVE hat's userType (from the JWT).
// "dooit" always passes — platform-level access bypasses all tenant type checks.
// Usage: authorizeUserType("client", "branch")
exports.authorizeUserType = (...types) => {
  return (req, res, next) => {
    const activeType = (req.user.userType ?? "").toLowerCase();
    // dooit = platform admin — unrestricted access across all tenants
    if (activeType === "dooit") return next();
    if (types.map((t) => t.toLowerCase()).includes(activeType)) return next();
    return next(
      new ErrorResponse(
        `User type "${req.user.userType}" is not authorized to access this resource`,
        403
      )
    );
  };
};

// ── Permission guard (ANY-of) ─────────────────────────────────────────────────
// Passes when req.user.permissions contains AT LEAST ONE of the listed strings.
// This is the primary route guard — prefer it over authorize() so access follows
// the RolePermission grant rather than a hard-coded role name.
//
// ANY-of (not ALL-of) because a route is usually reachable by more than one
// grant: /cases DELETE is legitimate for both CASE.DELETE and the broader
// CASE.EDIT-holder in some tenants. Use authorizeAllPermissions when a route
// genuinely needs every listed permission at once.
//
// There is deliberately NO userType bypass here — not even for "dooit". Platform
// admins get through because bootstrapAdmin/syncRolePermissions grants their role
// the full catalog, which keeps RolePermission.restrictedUsers meaningful for them
// too. A code-level bypass would silently void every per-user restriction.
exports.authorizePermission = (...perms) => {
  return (req, res, next) => {
    const userPerms = req.user.permissions ?? [];
    if (perms.some((p) => userPerms.includes(p))) return next();
    return next(
      new ErrorResponse(
        `Missing permission — one of: ${perms.join(", ")} is required`,
        403
      )
    );
  };
};

// ── Permission guard (ALL-of) ─────────────────────────────────────────────────
// Passes only when req.user.permissions contains EVERY listed string.
exports.authorizeAllPermissions = (...perms) => {
  return (req, res, next) => {
    const userPerms = req.user.permissions ?? [];
    const missing = perms.filter((p) => !userPerms.includes(p));
    if (missing.length > 0) {
      return next(
        new ErrorResponse(`Missing permission(s): ${missing.join(", ")}`, 403)
      );
    }
    next();
  };
};

// ── Any-membership guard ──────────────────────────────────────────────────────
// Passes if the user has ANY active UserType row whose role matches.
// Queries the live collection — revoking a membership takes effect immediately.
exports.authorizeAnyMembership = (...roles) =>
  asyncHandler(async (req, res, next) => {
    if ((req.user.userType ?? "").toLowerCase() === "dooit") return next();
    const wanted = roles.map((r) => r.toLowerCase());
    const rows = await UserType.find({ user: req.user.id, isActive: true })
      .select("role")
      .lean();
    const ok = rows.some((m) =>
      wanted.includes(String(m.role ?? "").toLowerCase())
    );
    if (!ok) {
      return next(
        new ErrorResponse("Not authorized for any of your memberships", 403)
      );
    }
    next();
  });
