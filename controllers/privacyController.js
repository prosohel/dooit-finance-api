const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const User = require("../models/User");
const Customer = require("../models/Customer");
const PrivacySnapshot = require("../models/PrivacySnapshot");
const { encrypt, decrypt } = require("../utils/encryption");
const { Types } = require("mongoose");
const { logEvent } = require("../utils/audit");
const { recordDevice } = require("../utils/deviceContext");

/**
 * Check that the requesting user holds the required privacy permission string.
 * Returns an ErrorResponse if not, otherwise returns null (ok to proceed).
 *
 * @param {boolean} shouldEncrypt - true = PRIVACY.ENCRYPT, false = PRIVACY.DECRYPT
 * @param {string[]} userPerms    - req.user.permissions
 * @returns {ErrorResponse|null}
 */
function checkPrivacyPermission(shouldEncrypt, userPerms = []) {
  const required = shouldEncrypt ? "PRIVACY.ENCRYPT" : "PRIVACY.DECRYPT";
  if (!userPerms.includes(required)) {
    return new ErrorResponse(`Missing permission: ${required}`, 403);
  }
  return null;
}

/**
 * Resolve a dot-notation path on a plain object.
 * e.g. getDeep({ a: { b: 1 } }, "a.b") → 1
 */
function getDeep(obj, path) {
  return path.split(".").reduce((acc, k) => acc?.[k], obj);
}

/**
 * Detect whether a string value looks like our AES-256-GCM output:
 * <32-char iv hex>:<32-char authTag hex>:<encrypted hex>
 */
function looksEncrypted(val) {
  if (!val || typeof val !== "string") return false;
  const parts = val.split(":");
  return parts.length === 3 && parts[0].length === 32 && parts[1].length === 32;
}

/**
 * Check if ANY encrypted path on the document actually looks encrypted,
 * regardless of the isDataEncrypted flag.
 */
function detectActualEncryption(plain, paths) {
  return paths.some((path) => looksEncrypted(getDeep(plain, path)));
}

/**
 * Build the base encryption-state filter scoped to the requesting admin's
 * client and branch. Passing null for either skips that constraint.
 *
 * @param {boolean} encrypt   true = find un-encrypted, false = find encrypted
 * @param {*}       clientId  ObjectId or null
 * @param {*}       branchId  ObjectId or null
 * @param {'user'|'customer'} modelType  field name convention differs per model
 */
function buildFilter(encrypt, clientId, branchId, modelType) {
  // When encrypting: only target docs not yet encrypted.
  // When decrypting: fetch ALL docs in scope — the isDataEncrypted flag may be
  // corrupted (false on actually-encrypted data). setEncryption() reads raw field
  // values to detect the real state and skips docs that are already plaintext.
  const base = encrypt ? { isDataEncrypted: { $ne: true } } : {};

  // Use $or so a user matching EITHER clientBelongs OR branchBelongs is included.
  // AND logic would silently exclude users who only have one of the two fields set.
  function applyScopeOr(conditions) {
    if (conditions.length === 1) {
      Object.assign(base, conditions[0]);
    } else if (conditions.length > 1) {
      base.$or = conditions;
    }
  }

  if (modelType === "user") {
    const scope = [];
    if (clientId) scope.push({ clientBelongs: clientId });
    if (branchId) scope.push({ branchBelongs: branchId });
    applyScopeOr(scope);
  }

  if (modelType === "customer") {
    const scope = [];
    if (clientId) scope.push({ "relations.client": clientId });
    if (branchId) scope.push({ "relations.branch": branchId });
    applyScopeOr(scope);
  }

  return base;
}

/**
 * Build a Customer filter scoped by customer.user.
 *
 * customer.user references a Users document. To scope bulk operations to the
 * admin's client/branch, we first resolve the User _ids in that scope, then
 * filter customers whose .user field is in that set.
 *
 * @param {boolean} encrypt
 * @param {*}       clientId
 * @param {*}       branchId
 * @returns {Promise<object>} MongoDB filter for Customer collection
 */
async function buildCustomerFilter(encrypt, clientId, branchId) {
  const base = encrypt ? { isDataEncrypted: { $ne: true } } : {};

  const orConditions = [];
  if (clientId) orConditions.push({ 'relations.client': clientId });
  if (branchId) orConditions.push({ 'relations.branch': branchId });
  if (orConditions.length === 1) Object.assign(base, orConditions[0]);
  else if (orConditions.length > 1) base['$or'] = orConditions;

  return base;
}


/**
 * Build a User filter scoped to users who have a linked Customer document.
 * Only users where Customer.user === user._id are targeted in bulk operations,
 * and only through customers in the caller's tenant scope (the same scope
 * buildCustomerFilter uses) — one tenant's bulk run must not rewrite another
 * tenant's portal users. getMe's encryptionStatus counts this same set.
 *
 * @param {boolean} encrypt
 * @param {*}       clientId
 * @param {*}       branchId
 * @returns {Promise<object>} MongoDB filter for User collection
 */
async function buildUserFilter(encrypt, clientId = null, branchId = null) {
  const base = encrypt ? { isDataEncrypted: { $ne: true } } : {};

  const customerScope = await buildCustomerFilter(false, clientId, branchId);
  const linkedUserIds = await Customer.distinct('user', { ...customerScope, user: { $ne: null } });
  base['_id'] = { '$in': linkedUserIds };

  return base;
}

/**
 * Save a before-image of restricted field values for a document.
 * Called before any encrypt or decrypt write so the state can be restored.
 *
 * @param {'user'|'customer'} modelType
 * @param {ObjectId}          documentId
 * @param {object}            raw        — plain raw document from collection
 * @param {string[]}          paths      — restricted field paths to snapshot
 * @param {'pre_encrypt'|'pre_decrypt'} operation
 * @param {ObjectId|null}     performedBy
 * @returns {Promise<string|null>}  snapshot _id as string, or null on failure
 */
async function takeSnapshot(modelType, documentId, raw, paths, operation, performedBy) {
  try {
    const fields = {};
    paths.forEach((path) => {
      const val = getDeep(raw, path);
      if (val != null) fields[path] = val;
    });

    // Auto-increment version per (modelType, documentId)
    const latest = await PrivacySnapshot.findOne({ modelType, documentId })
      .sort({ version: -1 })
      .select("version")
      .lean();
    const version = (latest?.version ?? 0) + 1;

    const snap = await PrivacySnapshot.create({
      modelType,
      documentId,
      operation,
      version,
      fields,
      performedBy: performedBy ?? null,
    });
    return snap._id.toString();
  } catch (err) {
    // Snapshot failure must never abort the main operation
    console.error("[privacy] snapshot creation failed:", err.message);
    return null;
  }
}

/**
 * Core helper — encrypt or decrypt a single document.
 *
 * Reads via raw MongoDB collection driver to bypass all Mongoose pre/post
 * hooks. This is critical: post-find hooks transform field values in memory
 * (decrypt → plaintext, or mask → "***"), so Model.findById() cannot be used
 * to detect the true stored encryption state.
 *
 * @param {Model}   Model
 * @param {*}       id
 * @param {boolean} shouldEncrypt
 * @param {object}  [opts]
 * @param {'user'|'customer'} [opts.modelType]  — required for snapshot creation
 * @param {ObjectId} [opts.performedBy]          — admin user ID for snapshot
 * @returns {{ doc: mongoose.Document, snapshotId: string|null }}
 */
async function setEncryption(Model, id, shouldEncrypt, opts = {}) {
  const { modelType, performedBy } = opts;

  const oid = Types.ObjectId.isValid(id) ? new Types.ObjectId(String(id)) : null;
  if (!oid) return null;

  // Raw read — no Mongoose hooks, no masking, no in-memory decryption
  const raw = await Model.collection.findOne({ _id: oid });
  if (!raw) return null;

  const paths =
    typeof Model.restrictedProperty === "object"
      ? Model.restrictedProperty
      : typeof Model.getEncryptedPaths === "function"
        ? Model.getEncryptedPaths()
        : [];

  // Detect real encryption state from actual stored values — don't trust the flag
  const actuallyEncrypted = detectActualEncryption(raw, paths);

  // ── encrypt ────────────────────────────────────────────────────────────────
  if (shouldEncrypt) {
    if (actuallyEncrypted) {
      // Already encrypted — repair flag if wrong, then return (no-op, no snapshot)
      if (!raw.isDataEncrypted) {
        await Model.collection.updateOne({ _id: oid }, { $set: { isDataEncrypted: true } });
      }
      return { doc: await Model.findById(id), snapshotId: null };
    }

    // Snapshot plaintext values BEFORE encrypting
    let snapshotId = null;
    if (modelType) {
      snapshotId = await takeSnapshot(modelType, oid, raw, paths, "pre_encrypt", performedBy);
    }

    const $set = { isDataEncrypted: true };
    paths.forEach((path) => {
      const val = getDeep(raw, path);
      if (val && typeof val === "string") {
        $set[path] = encrypt(val);
      }
    });

    await Model.collection.updateOne({ _id: oid }, { $set });
    return { doc: await Model.findById(id), snapshotId };
  }

  // ── decrypt ────────────────────────────────────────────────────────────────
  if (!actuallyEncrypted) {
    // Already plaintext — repair flag if wrong, then return (no-op, no snapshot)
    if (raw.isDataEncrypted) {
      await Model.collection.updateOne({ _id: oid }, { $set: { isDataEncrypted: false } });
    }
    return { doc: await Model.findById(id), snapshotId: null };
  }

  // Snapshot encrypted values BEFORE decrypting
  let snapshotId = null;
  if (modelType) {
    snapshotId = await takeSnapshot(modelType, oid, raw, paths, "pre_decrypt", performedBy);
  }


  const $set = {};
  let decryptErrors = 0;
  paths.forEach((path) => {
    const val = getDeep(raw, path);
    if (val && looksEncrypted(val)) {
      try {
        $set[path] = decrypt(val);
      } catch (err) {
        console.error(`[privacy] decrypt failed for ${path}:`, err.message);
        decryptErrors++;
      }
    }
  });

  // Only clear the encrypted flag when every field decrypted successfully.
  // If any field failed (e.g. given_name / surname ciphertext is corrupt),
  // keep isDataEncrypted: true so the next decrypt attempt can retry them
  // rather than leaving the flag permanently desynced.
  $set.isDataEncrypted = decryptErrors > 0;

  await Model.collection.updateOne({ _id: oid }, { $set });
  return { doc: await Model.findById(id), snapshotId };
}

// ─────────────────────────────────────────────────────────────────────────────
// User endpoints
// ─────────────────────────────────────────────────────────────────────────────

// @desc   Get encryption status for a user
// @route  GET /api/v1/privacy/user/:id
// @access Admin
exports.getUserPrivacyStatus = asyncHandler(async (req, res, next) => {
  const oid = Types.ObjectId.isValid(req.params.id)
    ? new Types.ObjectId(String(req.params.id))
    : null;
  if (!oid) return next(new ErrorResponse("Invalid user id", 400));

  // Raw read — flag may be corrupted; derive actual state from field values
  const raw = await User.collection.findOne({ _id: oid });
  if (!raw) return next(new ErrorResponse("User not found", 404));

  const paths = User.restrictedProperty ?? User.getEncryptedPaths?.() ?? [];
  const actuallyEncrypted = detectActualEncryption(raw, paths);

  res.status(200).json({
    success: true,
    data: {
      _id: raw._id,
      uid: raw.uid,
      isDataEncrypted: actuallyEncrypted,
      flagInDb: raw.isDataEncrypted,
      flagMismatch: actuallyEncrypted !== !!raw.isDataEncrypted,
      encryptedFields: paths,
    },
  });
});

// @desc   Encrypt or decrypt a single user's sensitive fields
// @route  PUT /api/v1/privacy/user/:id
// @body   { encrypted: Boolean }
// @access Admin
exports.updateUserEncryption = asyncHandler(async (req, res, next) => {
  const { encrypted } = req.body;
  if (typeof encrypted !== "boolean") {
    return next(new ErrorResponse("Body must contain { encrypted: Boolean }", 400));
  }

  const permErr = checkPrivacyPermission(encrypted, req.user.permissions);
  if (permErr) return next(permErr);

  const result = await setEncryption(User, req.params.id, encrypted, {
    modelType: "user",
    performedBy: req.user.id,
  });
  if (!result) return next(new ErrorResponse("User not found", 404));

  const { doc, snapshotId } = result;

  logEvent({
    req,
    service: "privacy",
    action: "pii_encryption_changed",
    user: req.params.id,
    afterValue: { encrypted },
  });

  res.status(200).json({
    success: true,
    message: encrypted ? "User data encrypted" : "User data decrypted",
    snapshotId,
    data: {
      _id: doc._id,
      uid: doc.uid,
      isDataEncrypted: doc.isDataEncrypted,
    },
  });
});

// @desc   Bulk encrypt or decrypt all users
// @route  PUT /api/v1/privacy/users/bulk
// @body   { encrypted: Boolean }
// @access Admin
exports.bulkUpdateUserEncryption = asyncHandler(async (req, res, next) => {
  const { encrypted } = req.body;
  if (typeof encrypted !== "boolean") {
    return next(new ErrorResponse("Body must contain { encrypted: Boolean }", 400));
  }

  const permErr = checkPrivacyPermission(encrypted, req.user.permissions);
  if (permErr) return next(permErr);

  const clientId = req?.user?.client?._id ?? null;
  const branchId = req?.user?.branch?._id ?? null;

  // Pre-check: skip if all users in scope are already encrypted
  if (encrypted) {
    const scopeFilter = await buildUserFilter(false, clientId, branchId);
    const [total, alreadyEncrypted] = await Promise.all([
      User.countDocuments(scopeFilter),
      User.countDocuments({ ...scopeFilter, isDataEncrypted: true }),
    ]);
    if (total > 0 && alreadyEncrypted === total) {
      return res.status(200).json({
        success: true,
        alreadyEncrypted: true,
        message: `All ${total} user(s) are already encrypted — no action taken`,
        processed: 0,
        failed: 0,
      });
    }
  }

  const filter = await buildUserFilter(encrypted, clientId, branchId);
  const users = await User.find(filter).select("_id isDataEncrypted");

  let processed = 0;
  let failed = 0;
  for (const user of users) {
    try {
      await setEncryption(User, user._id, encrypted, {
        modelType: "user",
        performedBy: req.user.id,
      });
      processed++;
    } catch (err) {
      console.error(`[privacy] user ${user._id} failed:`, err.message);
      failed++;
    }
  }

  logEvent({
    req,
    service: "privacy",
    action: encrypted ? "pii_bulk_encrypted" : "pii_bulk_decrypted",
    afterValue: { scope: "users", count: processed },
  });

  res.status(200).json({
    success: true,
    message: encrypted
      ? `Encrypted ${processed} user(s)`
      : `Decrypted ${processed} user(s)`,
    processed,
    failed,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Customer endpoints
// ─────────────────────────────────────────────────────────────────────────────

// @desc   Get encryption status for a customer
// @route  GET /api/v1/privacy/customer/:id
// @access Admin
exports.getCustomerPrivacyStatus = asyncHandler(async (req, res, next) => {
  const oid = Types.ObjectId.isValid(req.params.id)
    ? new Types.ObjectId(String(req.params.id))
    : null;
  if (!oid) return next(new ErrorResponse("Invalid customer id", 400));

  // Raw read — flag may be corrupted; derive actual state from field values
  const raw = await Customer.collection.findOne({ _id: oid });
  if (!raw) return next(new ErrorResponse("Customer not found", 404));

  const paths = Customer.restrictedProperty ?? Customer.getEncryptedPaths?.() ?? [];
  const actuallyEncrypted = detectActualEncryption(raw, paths);

  res.status(200).json({
    success: true,
    data: {
      _id: raw._id,
      uid: raw.uid,
      kycStatus: raw.kycStatus,
      isDataEncrypted: actuallyEncrypted,
      flagInDb: raw.isDataEncrypted,
      flagMismatch: actuallyEncrypted !== !!raw.isDataEncrypted,
      encryptedFields: paths,
    },
  });
});

// @desc   Encrypt or decrypt a single customer's sensitive fields
// @route  PUT /api/v1/privacy/customer/:id
// @body   { encrypted: Boolean }
// @access Admin
exports.updateCustomerEncryption = asyncHandler(async (req, res, next) => {
  const { encrypted } = req.body;
  if (typeof encrypted !== "boolean") {
    return next(new ErrorResponse("Body must contain { encrypted: Boolean }", 400));
  }

  const permErr = checkPrivacyPermission(encrypted, req.user.permissions);
  if (permErr) return next(permErr);

  const result = await setEncryption(Customer, req.params.id, encrypted, {
    modelType: "customer",
    performedBy: req.user.id,
  });
  if (!result) return next(new ErrorResponse("Customer not found", 404));

  const { doc, snapshotId } = result;

  logEvent({
    req,
    service: "privacy",
    action: "pii_encryption_changed",
    customer: req.params.id,
    afterValue: { encrypted },
  });

  res.status(200).json({
    success: true,
    message: encrypted ? "Customer data encrypted" : "Customer data decrypted",
    snapshotId,
    data: {
      _id: doc._id,
      uid: doc.uid,
      isDataEncrypted: doc.isDataEncrypted,
    },
  });
});

// @desc   Bulk encrypt or decrypt all customers
// @route  PUT /api/v1/privacy/customers/bulk
// @body   { encrypted: Boolean }
// @access Admin
exports.bulkUpdateCustomerEncryption = asyncHandler(async (req, res, next) => {
  const { encrypted } = req.body;
  if (typeof encrypted !== "boolean") {
    return next(new ErrorResponse("Body must contain { encrypted: Boolean }", 400));
  }

  const permErr = checkPrivacyPermission(encrypted, req.user.permissions);
  if (permErr) return next(permErr);

  const clientId = req?.user?.client?._id ?? null;
  const branchId = req?.user?.branch?._id ?? null;

  // Pre-check: skip if all customers in scope are already encrypted
  if (encrypted) {
    const scopeFilter = await buildCustomerFilter(false, clientId, branchId);
    const [total, alreadyEncrypted] = await Promise.all([
      Customer.countDocuments(scopeFilter),
      Customer.countDocuments({ ...scopeFilter, isDataEncrypted: true }),
    ]);
    if (total > 0 && alreadyEncrypted === total) {
      return res.status(200).json({
        success: true,
        alreadyEncrypted: true,
        message: `All ${total} customer(s) are already encrypted — no action taken`,
        processed: 0,
        failed: 0,
      });
    }
  }

  const filter = await buildCustomerFilter(encrypted, clientId, branchId);
  const customers = await Customer.find(filter).select("_id isDataEncrypted");

  let processed = 0;
  let failed = 0;
  for (const customer of customers) {
    try {
      await setEncryption(Customer, customer._id, encrypted, {
        modelType: "customer",
        performedBy: req.user.id,
      });
      processed++;
    } catch (err) {
      console.error(`[privacy] customer ${customer._id} failed:`, err.message);
      failed++;
    }
  }

  logEvent({
    req,
    service: "privacy",
    action: encrypted ? "pii_bulk_encrypted" : "pii_bulk_decrypted",
    afterValue: { scope: "customers", count: processed },
  });

  res.status(200).json({
    success: true,
    message: encrypted
      ? `Encrypted ${processed} customer(s)`
      : `Decrypted ${processed} customer(s)`,
    processed,
    failed,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined: User + Customer in one call
// ─────────────────────────────────────────────────────────────────────────────

// @desc   Encrypt or decrypt ALL users AND customers in one request
// @route  PUT /api/v1/privacy/all/bulk
// @body   { encrypted: Boolean }
// @access Admin
exports.bulkUpdateAllEncryption = asyncHandler(async (req, res, next) => {
  const { encrypted } = req.body;

  if (typeof encrypted !== "boolean") {
    return next(new ErrorResponse("Body must contain { encrypted: Boolean }", 400));
  }



  const permErr = checkPrivacyPermission(encrypted, req.user.permissions);
  if (permErr) return next(permErr);

  const clientId = req?.user?.client?._id ?? null;
  const branchId = req?.user?.branch?._id ?? null;

  // Pre-check: skip if all users AND all customers in scope are already encrypted
  if (encrypted) {
    const userScope = await buildUserFilter(false, clientId, branchId);
    const customerScope = await buildCustomerFilter(false, clientId, branchId);
    const [totalUsers, encUsers, totalCustomers, encCustomers] = await Promise.all([
      User.countDocuments(userScope),
      User.countDocuments({ ...userScope, isDataEncrypted: true }),
      Customer.countDocuments(customerScope),
      Customer.countDocuments({ ...customerScope, isDataEncrypted: true }),
    ]);
    const usersAllDone = totalUsers > 0 && encUsers === totalUsers;
    const customersAllDone = totalCustomers > 0 && encCustomers === totalCustomers;
    if (usersAllDone && customersAllDone) {
      return res.status(200).json({
        success: true,
        alreadyEncrypted: true,
        message: "All data is already encrypted — no action taken",
        results: {
          users: { processed: 0, failed: 0, alreadyEncrypted: true },
          customers: { processed: 0, failed: 0, alreadyEncrypted: true },
        },
      });
    }
  }

  const [users, customers] = await Promise.all([
    User.find(await buildUserFilter(encrypted, clientId, branchId)).select("_id isDataEncrypted"),
    Customer.find(await buildCustomerFilter(encrypted, clientId, branchId)).select("_id isDataEncrypted"),
  ]);


  const results = { users: { processed: 0, failed: 0 }, customers: { processed: 0, failed: 0 } };

  const opts = { performedBy: req.user.id };

  for (const user of users) {
    try {
      await setEncryption(User, user._id, encrypted, { ...opts, modelType: "user" });
      results.users.processed++;
    } catch (err) {
      console.error(`[privacy] user ${user._id} failed:`, err.message);
      results.users.failed++;
    }
  }

  for (const customer of customers) {
    try {
      await setEncryption(Customer, customer._id, encrypted, { ...opts, modelType: "customer" });
      results.customers.processed++;
    } catch (err) {
      console.error(`[privacy] customer ${customer._id} failed:`, err.message);
      results.customers.failed++;
    }
  }

  logEvent({
    req,
    service: "privacy",
    action: encrypted ? "pii_bulk_encrypted" : "pii_bulk_decrypted",
    afterValue: {
      scope: "all",
      users: results.users.processed,
      customers: results.customers.processed,
    },
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(200).json({
    success: true,
    message: encrypted ? "Bulk encryption complete" : "Bulk decryption complete",
    results,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot endpoints
// ─────────────────────────────────────────────────────────────────────────────

// @desc   List snapshots
// @route  GET /api/v1/privacy/snapshots
// @query  modelType, documentId, operation, version, isRestored=true|false
// @access Admin
exports.getSnapshots = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.modelType) filter.modelType = req.query.modelType;
  if (req.query.operation) filter.operation = req.query.operation;
  if (req.query.version) filter.version = Number(req.query.version);
  if (req.query.documentId && Types.ObjectId.isValid(req.query.documentId)) {
    filter.documentId = new Types.ObjectId(String(req.query.documentId));
  }
  if (req.query.isRestored !== undefined) {
    filter.restoredAt = req.query.isRestored === "true" ? { $ne: null } : null;
  }

  const snapshots = await PrivacySnapshot.find(filter)
    .populate("performedBy", "name email uid")
    .populate("restoredBy", "name email uid")
    .sort({ createdAt: -1 })
    .limit(200);

  // Full snapshot docs include the `fields` PII before-images — this read is auditable
  logEvent({
    req,
    service: "privacy",
    action: "pii_snapshot_viewed",
    details: "list",
    afterValue: { count: snapshots.length },
  });

  res.status(200).json({ success: true, count: snapshots.length, data: snapshots });
});

// @desc   Get a single snapshot
// @route  GET /api/v1/privacy/snapshots/:id
// @access Admin
exports.getSnapshot = asyncHandler(async (req, res, next) => {
  const snapshot = await PrivacySnapshot.findById(req.params.id)
    .populate("performedBy", "name email uid")
    .populate("restoredBy", "name email uid");

  if (!snapshot) return next(new ErrorResponse("Snapshot not found", 404));

  logEvent({
    req,
    service: "privacy",
    action: "pii_snapshot_viewed",
    target: String(snapshot._id),
    details: `${snapshot.modelType}/${snapshot.documentId}`,
  });

  res.status(200).json({ success: true, data: snapshot });
});

// @desc   Restore a document to its pre-operation state from a snapshot
// @route  POST /api/v1/privacy/snapshots/:id/restore
// @access Admin
exports.restoreSnapshot = asyncHandler(async (req, res, next) => {
  const permErr = checkPrivacyPermission(false, req.user.permissions); // restore = decrypt
  if (permErr) return next(permErr);

  const snapshot = await PrivacySnapshot.findById(req.params.id);
  if (!snapshot) return next(new ErrorResponse("Snapshot not found", 404));

  if (snapshot.restoredAt) {
    return next(new ErrorResponse("This snapshot has already been restored", 400));
  }

  const Model = snapshot.modelType === "user" ? User : Customer;
  const oid = new Types.ObjectId(String(snapshot.documentId));

  const exists = await Model.collection.findOne({ _id: oid });
  if (!exists) return next(new ErrorResponse("Original document no longer exists", 404));

  // Write the stored field values back to the DB (raw — bypasses all hooks)
  const $set = { ...snapshot.fields };
  // Flag: pre_encrypt snapshot → was plaintext → restore to plaintext (false)
  //       pre_decrypt snapshot → was encrypted → restore to encrypted (true)
  $set.isDataEncrypted = snapshot.operation === "pre_decrypt";

  await Model.collection.updateOne({ _id: oid }, { $set });

  await PrivacySnapshot.updateOne(
    { _id: snapshot._id },
    { $set: { restoredAt: new Date(), restoredBy: req.user.id } }
  );

  logEvent({
    req,
    service: "privacy",
    action: "pii_snapshot_restored",
    target: String(snapshot._id),
    details: `${snapshot.modelType}/${snapshot.documentId}`,
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(200).json({
    success: true,
    message: `Restored to state before ${snapshot.operation === "pre_encrypt" ? "encryption" : "decryption"}`,
    data: {
      documentId: snapshot.documentId,
      modelType: snapshot.modelType,
      operation: snapshot.operation,
      version: snapshot.version,
      restoredAt: new Date(),
    },
  });
});

// @desc   List all snapshot versions for a specific document
// @route  GET /api/v1/privacy/snapshots/versions?modelType=user&documentId=<id>
// @access Admin
exports.getSnapshotVersions = asyncHandler(async (req, res, next) => {
  const { modelType, documentId } = req.query;

  if (!modelType || !documentId) {
    return next(new ErrorResponse("modelType and documentId query params are required", 400));
  }
  if (!Types.ObjectId.isValid(documentId)) {
    return next(new ErrorResponse("Invalid documentId", 400));
  }

  const snapshots = await PrivacySnapshot.find({
    modelType,
    documentId: new Types.ObjectId(String(documentId)),
  })
    .select("version operation restoredAt restoredBy performedBy createdAt")
    .populate("performedBy", "name email uid")
    .populate("restoredBy", "name email uid")
    .sort({ version: 1 });

  logEvent({
    req,
    service: "privacy",
    action: "pii_snapshot_viewed",
    target: String(documentId),
    details: `versions ${modelType}/${documentId}`,
    afterValue: { count: snapshots.length },
  });

  res.status(200).json({ success: true, count: snapshots.length, data: snapshots });
});

// @desc   Bulk restore — restore all unrestored snapshots matching a filter
// @route  POST /api/v1/privacy/snapshots/bulk-restore
// @body   { modelType, operation?, version? }
//         version  — if provided, only snapshots at exactly that version are restored
//         operation — if provided, only snapshots of that operation type are restored
//         When version is omitted, the LATEST unrestored snapshot per document is used.
// @access Admin
exports.bulkRestoreSnapshots = asyncHandler(async (req, res, next) => {
  const permErr = checkPrivacyPermission(false, req.user.permissions); // restore = decrypt
  if (permErr) return next(permErr);

  const { modelType, operation, version } = req.body;

  if (!modelType || !["user", "customer"].includes(modelType)) {
    return next(new ErrorResponse("modelType must be 'user' or 'customer'", 400));
  }
  if (operation && !["pre_encrypt", "pre_decrypt"].includes(operation)) {
    return next(new ErrorResponse("operation must be 'pre_encrypt' or 'pre_decrypt'", 400));
  }

  const Model = modelType === "user" ? User : Customer;
  let snapshots;

  if (version != null) {
    // Restore all unrestored snapshots at an exact version
    const filter = { modelType, restoredAt: null, version: Number(version) };
    if (operation) filter.operation = operation;
    snapshots = await PrivacySnapshot.find(filter).lean();
  } else {
    // No version supplied — for each document, pick its latest unrestored snapshot
    const pipeline = [
      { $match: { modelType, restoredAt: null, ...(operation ? { operation } : {}) } },
      { $sort: { version: -1 } },
      { $group: { _id: "$documentId", snapshotId: { $first: "$_id" } } },
    ];
    const grouped = await PrivacySnapshot.aggregate(pipeline);
    const ids = grouped.map((g) => g.snapshotId);
    snapshots = await PrivacySnapshot.find({ _id: { $in: ids } }).lean();
  }

  if (snapshots.length === 0) {
    return res.status(200).json({
      success: true,
      message: "No matching snapshots to restore",
      restored: 0,
      failed: 0,
    });
  }

  let restored = 0;
  let failed = 0;
  const errors = [];

  for (const snapshot of snapshots) {
    try {
      const oid = new Types.ObjectId(String(snapshot.documentId));
      const exists = await Model.collection.findOne({ _id: oid });

      if (!exists) {
        errors.push({ snapshotId: snapshot._id, reason: "Document no longer exists" });
        failed++;
        continue;
      }

      const $set = { ...snapshot.fields };
      $set.isDataEncrypted = snapshot.operation === "pre_decrypt";

      await Model.collection.updateOne({ _id: oid }, { $set });
      await PrivacySnapshot.updateOne(
        { _id: snapshot._id },
        { $set: { restoredAt: new Date(), restoredBy: req.user.id } }
      );
      restored++;
    } catch (err) {
      console.error(`[privacy] bulk restore failed for snapshot ${snapshot._id}:`, err.message);
      errors.push({ snapshotId: snapshot._id, reason: err.message });
      failed++;
    }
  }

  logEvent({
    req,
    service: "privacy",
    action: "pii_snapshot_restored",
    details: "bulk",
    afterValue: { count: restored },
  });

  res.status(200).json({
    success: true,
    message: `Restored ${restored} snapshot(s)`,
    restored,
    failed,
    ...(errors.length ? { errors } : {}),
  });
});
