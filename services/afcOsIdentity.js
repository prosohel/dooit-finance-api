/**
 * Identity for AFC OS officers on this platform.
 *
 * Every regulator officer who opens the Client Portal or the GRC Platform from
 * AFC OS gets (once) a platform User and a `dooit` membership with the role
 * "AFC OS Administrator", which holds the whole permission catalogue — the
 * full-control seat the regulator asked for. `dooit` already bypasses tenant
 * type checks in middleware/auth.js, so the officer can open any RO's tenant.
 * The password is random and never shown: the only way in is the handoff.
 */
const crypto = require("crypto");
const User = require("../models/User");
const UserType = require("../models/UserType");
const Role = require("../models/Role");
const RolePermission = require("../models/RolePermission");
const permissionCatalog = require("../_data/permissionjson.json");

const ROLE_NAME = "AFC OS Administrator";
const USER_TYPE = "dooit";

/** Upsert the role and grant it every permission string in the catalogue (idempotent). */
async function ensureAfcRole() {
  const allPermissions = (Array.isArray(permissionCatalog) ? permissionCatalog : Object.values(permissionCatalog).find(Array.isArray) ?? []).flatMap((m) => (m.permissions ?? []).map((p) => p.value));
  const role = await Role.findOneAndUpdate(
    { name: ROLE_NAME },
    { $setOnInsert: { name: ROLE_NAME, isActive: true, description: "Regulator (AFC OS) officers: full control over the platform through the SSO handoff. Managed by the AFC OS connector." } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await RolePermission.findOneAndUpdate(
    { role: role._id, client: null, branch: null },
    { $set: { permissions: allPermissions, isActive: true, expiresAt: null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { role, permissions: allPermissions.length };
}

/** Find or create the officer's platform User and `dooit` membership. */
async function ensureAfcOfficer({ email, name, afcUserId = null }) {
  const lower = String(email).trim().toLowerCase();
  const { role } = await ensureAfcRole();
  let user = await User.findOne({ email: lower });
  let created = false;
  if (!user) {
    user = await User.create({
      name: name || lower.split("@")[0],
      userName: `afc_${lower.split("@")[0].replace(/[^a-z0-9]/g, "")}_${crypto.randomBytes(2).toString("hex")}`,
      email: lower,
      password: crypto.randomBytes(24).toString("base64url"),
      isActive: true,
    });
    created = true;
  }
  let membership = await UserType.findOne({ user: user._id, userType: USER_TYPE, isActive: true });
  if (!membership) {
    membership = await UserType.create({ user: user._id, userType: USER_TYPE, role: ROLE_NAME, roleId: role._id, clientBelongs: null, branchBelongs: null, isActive: true });
  } else if (!membership.roleId || membership.role !== ROLE_NAME) {
    membership.role = ROLE_NAME;
    membership.roleId = role._id;
    await membership.save();
  }
  return { user, membership, created, afcUserId };
}

module.exports = { ensureAfcRole, ensureAfcOfficer, ROLE_NAME, USER_TYPE };
