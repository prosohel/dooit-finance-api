const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const RolePermission = require("../models/RolePermission");
const Role = require("../models/Role");
const UserType = require("../models/UserType");
const permissionList = require("../_data/permissionjson.json");
const { logEvent } = require("../utils/audit");
const { recordDevice } = require("../utils/deviceContext");

const populate = (q) =>
  q
    .populate("role", "name description")
    .populate("grantedBy", "name email uid")
    .populate("restrictedUsers.user", "name email uid");

// ── Grant scope ───────────────────────────────────────────────────────────────
// A role can have one grant per scope: global (client and branch null), a
// client, or a branch. Tenant staff manage their own tenant's grant — the
// scope createRolePermission stores — and platform users (no client/branch)
// the global ones. Reads fall back to the grant the caller inherits
// (RolePermission.resolveGrant: own → client-wide → global). Writes never
// touch an inherited grant: a tenant admin editing one gets their own copy
// first (copy-on-write), so the global grant — and every other tenant using
// it — is unchanged. Previously every by-role operation used
// findOne({ role }), i.e. an arbitrary grant once a role had several, and a
// tenant admin could edit or delete the global grant for all tenants.
const callerScope = (req) => ({
  client: req.user?.client?._id ?? null,
  branch: req.user?.branch?._id ?? null,
});

const isPlatformCaller = (req) => {
  const { client, branch } = callerScope(req);
  return !client && !branch;
};

const isOwnGrant = (req, grant) => {
  const { client, branch } = callerScope(req);
  return (
    String(grant.client?._id ?? grant.client ?? "") === String(client ?? "") &&
    String(grant.branch?._id ?? grant.branch ?? "") === String(branch ?? "")
  );
};

// Grants a caller may list: their own scope plus the broader ones they
// inherit from. Platform callers see every grant.
const visibleGrantsFilter = (req) => {
  const { client, branch } = callerScope(req);
  if (!client && !branch) return {};
  const scopes = [{ client: null, branch: null }];
  if (client) scopes.push({ client, branch: null });
  if (branch) scopes.push(client ? { client, branch } : { branch });
  return { $or: scopes };
};

// Users with an active membership in the caller's tenant. Restrictions on an
// inherited grant can name users of other tenants: a tenant caller must not
// see those users, nor copy them into its own grant.
const tenantMemberIds = async (req) => {
  const { client, branch } = callerScope(req);
  const filter = { isActive: true };
  if (branch) filter.branchBelongs = branch;
  else filter.clientBelongs = client;
  return new Set((await UserType.distinct("user", filter)).map(String));
};

// For tenant callers, drop restrictions on non-members from grants they only
// inherit. `grants` are plain (toJSON) objects.
const hideForeignRestrictions = async (req, grants) => {
  if (isPlatformCaller(req)) return grants;
  const inherited = grants.filter((g) => !isOwnGrant(req, g));
  if (!inherited.length) return grants;
  const members = await tenantMemberIds(req);
  inherited.forEach((g) => {
    g.restrictedUsers = (g.restrictedUsers || []).filter((r) =>
      members.has(String(r.user?._id ?? r.user)),
    );
  });
  return grants;
};

// The caller's own grant for a role, for a write. If they only inherit one,
// create their own copy of it first (copy-on-write).
// Returns { grant: mongoose doc | null, before: plain | null, copied }.
const ownGrantForWrite = async (req, roleId) => {
  const { client, branch } = callerScope(req);
  const own = await RolePermission.findOne({ role: roleId, client, branch });
  if (own) return { grant: own, before: own.toObject(), copied: false };

  const inherited = await RolePermission.resolveGrant(roleId, { clientId: client, branchId: branch });
  if (!inherited) return { grant: null, before: null, copied: false };

  const members = await tenantMemberIds(req);
  const grant = await RolePermission.create({
    role: roleId,
    client,
    branch,
    permissions: inherited.permissions ?? [],
    restrictedUsers: (inherited.restrictedUsers ?? []).filter((r) => members.has(String(r.user))),
    expiresAt: inherited.expiresAt ?? null,
    isActive: true,
    grantedBy: req.user.id,
  });
  return { grant, before: inherited, copied: true };
};

const COPIED_NOTE = " (created this tenant's own grant from the inherited one)";



// @desc   Get all available permission definitions
// @route  GET /api/v1/role-permissions/permissions
// @access Admin
exports.getAllPermission = asyncHandler(async (_req, res) => {
  res.status(200).json({
    success: true,
    count: permissionList.length,
    data: permissionList
  });
});

// @desc   Create a role permission
// @route  POST /api/v1/role-permissions
// @access Admin
exports.createRolePermission = asyncHandler(async (req, res, next) => {
  const { role, permissions, restrictedUsers, expiresAt } = req.body;

  if (!role) {
    return next(new ErrorResponse("role (Role ObjectId) is required", 400));
  }

  // Verify the role exists
  const roleDoc = await Role.findById(role).lean();
  if (!roleDoc) {
    return next(new ErrorResponse("Role not found", 404));
  }

  // Duplicate check — one RolePermission per role per client+branch scope
  const clientId = req.user.client?._id ?? null;
  const branchId = req.user.branch?._id ?? null;

  const existing = await RolePermission.findOne({
    role,
    client: clientId,
    branch: branchId,
  }).lean();

  if (existing) {
    return next(
      new ErrorResponse(
        `A permission document already exists for this role. Use PUT /role-permissions/${role} to update it.`,
        409
      )
    );
  }

  const rolePermission = await RolePermission.create({
    role,
    permissions: permissions ?? [],
    restrictedUsers: restrictedUsers ?? [],
    expiresAt: expiresAt ?? null,
    grantedBy: req.user.id,
    client: clientId,
    branch: branchId,
  });

  logEvent({
    req,
    service: "auth",
    action: "role_permission_created",
    target: String(role),
    details: `Role permission created for role "${roleDoc.name}" (${rolePermission.permissions.length} permission(s))`,
    afterValue: {
      permissions: rolePermission.toObject().permissions,
      restrictedUsers: rolePermission.toObject().restrictedUsers,
    },
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(201).json({ success: true, data: rolePermission });
});

// @desc   Get all role permissions
// @route  GET /api/v1/role-permissions
// @access Admin
exports.getRolePermissions = asyncHandler(async (req, res) => {
  const filter = visibleGrantsFilter(req);

  if (req.query.isActive !== undefined) {
    filter.isActive = req.query.isActive === "true";
  }
  if (req.query.role) {
    filter.role = req.query.role;
  }

  const docs = await populate(
    RolePermission.find(filter).sort({ createdAt: -1 })
  );
  const rolePermissions = await hideForeignRestrictions(req, docs.map((d) => d.toJSON()));

  res.status(200).json({
    success: true,
    count: rolePermissions.length,
    data: rolePermissions,
  });
});

// @desc   Get a single role permission by roleId
// @route  GET /api/v1/role-permissions/:roleId
// @access Admin
exports.getRolePermission = asyncHandler(async (req, res, next) => {
  // The caller's own grant (in any state), else the one they inherit.
  const { client, branch } = callerScope(req);
  const own = await RolePermission.findOne({ role: req.params.roleId, client, branch })
    .select("_id")
    .lean();
  const target =
    own ?? (await RolePermission.resolveGrant(req.params.roleId, { clientId: client, branchId: branch }));

  if (!target) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  const doc = await populate(RolePermission.findById(target._id));
  const [rolePermission] = await hideForeignRestrictions(req, [doc.toJSON()]);

  // inherited: saving creates this tenant's own copy (see ownGrantForWrite).
  res.status(200).json({ success: true, data: rolePermission, inherited: !own });
});

// @desc   Update a role permission by roleId
// @route  PUT /api/v1/role-permissions/:roleId
// @access Admin
exports.updateRolePermission = asyncHandler(async (req, res, next) => {
  const allowed = ["permissions", "restrictedUsers", "isActive", "expiresAt"];
  // Moving a grant to another client/branch is a platform-only operation.
  if (isPlatformCaller(req)) allowed.push("client", "branch");
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );

  if (Object.keys(updates).length === 0) {
    return next(new ErrorResponse("No valid fields provided to update", 400));
  }

  // The caller's own grant (copied from the inherited one on first write);
  // `before` is the pre-update snapshot for the audit diff.
  const { grant, before: beforeDoc, copied } = await ownGrantForWrite(req, req.params.roleId);
  if (!grant) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  const rolePermission = await populate(
    RolePermission.findByIdAndUpdate(grant._id, updates, { new: true, runValidators: true })
  );

  const beforeValue = {};
  const afterValue = {};
  Object.keys(updates).forEach((k) => {
    beforeValue[k] = beforeDoc ? beforeDoc[k] : undefined;
    afterValue[k] = updates[k];
  });
  logEvent({
    req,
    service: "auth",
    action: "role_permission_updated",
    target: String(req.params.roleId),
    details: `Role permission updated: ${Object.keys(updates).join(", ")}${copied ? COPIED_NOTE : ""}`,
    beforeValue,
    afterValue,
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(200).json({ success: true, data: rolePermission });
});

// @desc   Delete a role permission by roleId
// @route  DELETE /api/v1/role-permissions/:roleId
// @access Admin
exports.deleteRolePermission = asyncHandler(async (req, res, next) => {
  // Only the caller's own grant — an inherited (e.g. global) grant is never
  // deleted from a tenant.
  const { client, branch } = callerScope(req);
  const rolePermission = await RolePermission.findOneAndDelete({
    role: req.params.roleId,
    client,
    branch,
  });

  if (!rolePermission) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  // findOneAndDelete returns the deleted doc — that is the before snapshot.
  const snapshot = rolePermission.toObject();
  logEvent({
    req,
    service: "auth",
    action: "role_permission_deleted",
    target: String(req.params.roleId),
    details: "Role permission document deleted",
    beforeValue: {
      permissions: snapshot.permissions,
      restrictedUsers: snapshot.restrictedUsers,
      isActive: snapshot.isActive,
      client: snapshot.client,
      branch: snapshot.branch,
    },
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(200).json({ success: true, data: {} });
});

// @desc   Add permission strings to a role permission
// @route  PATCH /api/v1/role-permissions/:roleId/permissions/add
// @access Admin
exports.addPermissions = asyncHandler(async (req, res, next) => {
  const { permissions } = req.body;

  if (!Array.isArray(permissions) || permissions.length === 0) {
    return next(new ErrorResponse("permissions must be a non-empty array of strings", 400));
  }

  const { grant, copied } = await ownGrantForWrite(req, req.params.roleId);
  if (!grant) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  const rolePermission = await populate(
    RolePermission.findByIdAndUpdate(
      grant._id,
      { $addToSet: { permissions: { $each: permissions } } },
      { new: true }
    )
  );

  logEvent({
    req,
    service: "auth",
    action: "permissions_granted",
    target: String(req.params.roleId),
    details: `Granted permission(s): ${permissions.join(", ")}${copied ? COPIED_NOTE : ""}`,
    afterValue: { added: permissions },
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(200).json({ success: true, data: rolePermission });
});

// @desc   Remove permission strings from a role permission
// @route  PATCH /api/v1/role-permissions/:roleId/permissions/remove
// @access Admin
exports.removePermissions = asyncHandler(async (req, res, next) => {
  const { permissions } = req.body;

  if (!Array.isArray(permissions) || permissions.length === 0) {
    return next(new ErrorResponse("permissions must be a non-empty array of strings", 400));
  }

  const { grant, copied } = await ownGrantForWrite(req, req.params.roleId);
  if (!grant) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  const rolePermission = await populate(
    RolePermission.findByIdAndUpdate(
      grant._id,
      { $pull: { permissions: { $in: permissions } } },
      { new: true }
    )
  );

  logEvent({
    req,
    service: "auth",
    action: "permissions_revoked",
    target: String(req.params.roleId),
    details: `Revoked permission(s): ${permissions.join(", ")}${copied ? COPIED_NOTE : ""}`,
    afterValue: { removed: permissions },
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(200).json({ success: true, data: rolePermission });
});

// @desc   Add or update restricted users on a role permission
// @route  PATCH /api/v1/role-permissions/:roleId/restrict
// @access Admin
//
// Body: { user: ObjectId, modules: [String], options: [String] }
//   modules: [], options: []          → blocked from ALL permissions in this role
//   modules: ["USER","RFI"]           → blocked from all USER.* and RFI.* permissions
//   options: ["USER.ADD","PRIVACY.ENCRYPTVIEW"] → blocked from specific permission strings only
//
// If the user already exists in restrictedUsers their entry is replaced.
exports.addRestrictedUsers = asyncHandler(async (req, res, next) => {
  const { user, modules, options } = req.body;

  if (!user) {
    return next(new ErrorResponse("user (ObjectId) is required", 400));
  }
  if (!Array.isArray(modules)) {
    return next(new ErrorResponse("modules must be an array (can be empty to block all)", 400));
  }
  if (!Array.isArray(options)) {
    return next(new ErrorResponse("options must be an array of specific permission strings", 400));
  }

  const { grant } = await ownGrantForWrite(req, req.params.roleId);
  if (!grant) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  // Remove existing entry for this user then push the new one (upsert behaviour)
  const rolePermission = await populate(
    RolePermission.findByIdAndUpdate(
      grant._id,
      {
        $pull: { restrictedUsers: { user } },
      },
      { new: true }
    )
  );

  // Push the new/updated entry
  rolePermission.restrictedUsers.push({ user, modules, options });
  await rolePermission.save();

  // Re-populate after save
  await rolePermission.populate("restrictedUsers.user", "name email uid");

  logEvent({
    req,
    service: "auth",
    action: "user_restricted",
    user,
    target: String(user),
    details: `User restricted on role permission (modules: ${modules.length ? modules.join(", ") : "all"})`,
    afterValue: { user, modules, options },
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(200).json({ success: true, data: rolePermission });
});

// @desc   Remove a restricted user from a role permission
// @route  PATCH /api/v1/role-permissions/:roleId/unrestrict
// @access Admin
//
// Body: { user: ObjectId }
exports.removeRestrictedUsers = asyncHandler(async (req, res, next) => {
  const { user } = req.body;

  if (!user) {
    return next(new ErrorResponse("user (ObjectId) is required", 400));
  }

  const { grant } = await ownGrantForWrite(req, req.params.roleId);
  if (!grant) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  const rolePermission = await populate(
    RolePermission.findByIdAndUpdate(
      grant._id,
      { $pull: { restrictedUsers: { user } } },
      { new: true }
    )
  );

  logEvent({
    req,
    service: "auth",
    action: "user_unrestricted",
    user,
    target: String(user),
    details: "User restriction removed from role permission",
    afterValue: { user },
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(200).json({ success: true, data: rolePermission });
});
