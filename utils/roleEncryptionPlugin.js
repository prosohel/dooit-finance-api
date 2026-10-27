const { AsyncLocalStorage } = require("async_hooks");
const { encrypt, decrypt } = require("./encryption");

// ── Per-request context ────────────────────────────────────────────────────
// Stores { role, canReadDecrypted } for the lifetime of each async request.
const _roleStorage = new AsyncLocalStorage();

/**
 * Detect AES-256-GCM encrypted format: <32-hex iv>:<32-hex authTag>:<hex data>
 * Used in both autoDecryptDoc (to detect real state) and pre-save (to prevent double-encryption).
 */
function looksEncrypted(val) {
  if (!val || typeof val !== "string") return false;
  const parts = val.split(":");
  return parts.length === 3 && parts[0].length === 32 && parts[1].length === 32;
}

/**
 * Bind role + decrypt permission to the current async context.
 * Called once per request (in the protect middleware).
 *
 * @param {string}  role             - authenticated user's role string
 * @param {boolean} canReadDecrypted - result of RolePermission.isGranted()
 * @param {Function} fn              - next() callback
 */
function runWithRole(role, canReadDecrypted, fn) {
  _roleStorage.run({ role, canReadDecrypted }, fn);
}

function _getStore() {
  return _roleStorage.getStore() ?? { role: null, canReadDecrypted: false };
}

/**
 * Walk the schema tree and collect every path that has
 * fieldMeta.isDataSecret === true.
 */
function collectSecretPaths(schema, prefix = "") {
  const paths = [];
  schema.eachPath((pathname, schematype) => {
    const fullPath = prefix ? `${prefix}.${pathname}` : pathname;

    if (schematype.schema) {
      collectSecretPaths(schematype.schema, fullPath).forEach((p) =>
        paths.push(p)
      );
      return;
    }

    const meta = schematype.options?.fieldMeta;
    if (meta?.isDataSecret === true) {
      paths.push({ path: fullPath });
    }
  });
  return paths;
}

function getNestedValue(obj, path) {
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
}

function setNestedValue(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((acc, key) => {
    if (acc[key] == null) acc[key] = {};
    return acc[key];
  }, obj);
  target[last] = value;
}

/**
 * Mongoose plugin — role-based field encryption.
 *
 * Usage:
 *   1. Mark sensitive fields in the schema:
 *        email: { type: String, fieldMeta: fieldMeta(String, true) }
 *
 *   2. Declare restrictedProperty on the model file (developer config):
 *        const restrictedProperty = ["email", "phone"];
 *        MySchema.statics.restrictedProperty = restrictedProperty;
 *
 *   3. Apply the plugin:
 *        MySchema.plugin(roleEncryptionPlugin);
 *
 *   4. In protect middleware, resolve permission + permissions in parallel, then pass to runWithRole:
 *        const roleDoc = await Role.findOne({ name: u.role }).select('_id').lean();
 *        const [canRead, permissions] = await Promise.all([
 *          RolePermission.isGranted(u._id, roleDoc?._id, { clientId, branchId }),
 *          RolePermission.getPermissions(roleDoc?._id),
 *        ]);
 *        req.user.permissions = permissions;
 *        runWithRole(role, canRead, next);
 */
function roleEncryptionPlugin(schema, options = {}) {
  // Prefer developer-declared restrictedProperty paths (passed as plugin option).
  // Fall back to scanning fieldMeta annotations for backward compatibility.
  const secretPaths = options.paths?.length
    ? options.paths.map((p) => ({ path: p }))
    : collectSecretPaths(schema);

  if (secretPaths.length === 0) return;

  const hasEncryptedFlag = !!schema.path("isDataEncrypted");

  // ── Encrypt before .save() — OPT-IN, OFF BY DEFAULT ───────────────────────
  // Documents (User, Customer, …) are stored as PLAINTEXT when created. Encryption
  // is an explicit, admin-driven operation owned by the Privacy module
  // (privacyController: per-doc / bulk encrypt + decrypt, with PrivacySnapshot
  // rollback) — it must NOT happen automatically just because a record is created.
  //
  // Reads still mask/decrypt correctly: autoDecryptDoc keys off the actual stored
  // value format (looksEncrypted), so plaintext is returned as-is and anything the
  // Privacy module encrypted is still role-gated. NOTE: role-based "***" masking
  // only applies once data is actually encrypted via the Privacy module.
  //
  // Set ENCRYPT_ON_SAVE=true to restore the legacy auto-encrypt-on-save behaviour.
  const encryptOnSave = process.env.ENCRYPT_ON_SAVE === "true";

  schema.pre("save", function (next) {
    try {
      if (!encryptOnSave) return next();                 // plaintext-on-create (default)
      if (hasEncryptedFlag && this.isDataEncrypted) return next();

      let didEncrypt = false;
      secretPaths.forEach(({ path }) => {
        const val = this.get(path);
        // Skip if already encrypted — prevents double-encryption after admin decrypts to DB
        if (val && typeof val === "string" && !looksEncrypted(val)) {
          this.set(path, encrypt(val));
          didEncrypt = true;
        }
      });

      if (hasEncryptedFlag && didEncrypt) this.isDataEncrypted = true;
      next();
    } catch (err) {
      next(err);
    }
  });

  // ── Auto-decrypt on read ──────────────────────────────────────────────────
  // Reads canReadDecrypted from AsyncLocalStorage set by protect middleware.
  // If the user has no active RolePermission grant, fields are masked "***".

  // Stores original ciphertext per document instance before autoDecryptDoc
  // transforms them. decryptForRole() reads from here so it always sees real
  // ciphertext even when canReadDecrypted:false has already masked to "***".
  const _rawEncrypted = new WeakMap();

  function autoDecryptDoc(doc) {
    if (!doc) return;

    const { canReadDecrypted } = _getStore();

    // Snapshot every encrypted field value BEFORE masking or decrypting,
    // so decryptForRole() can bypass "***" and work from real ciphertext.
    const snapshot = {};
    secretPaths.forEach(({ path }) => {
      const val = doc.get ? doc.get(path) : getNestedValue(doc, path);
      if (looksEncrypted(val)) snapshot[path] = val;
    });
    if (Object.keys(snapshot).length > 0) _rawEncrypted.set(doc, snapshot);

    secretPaths.forEach(({ path }) => {
      const val = doc.get ? doc.get(path) : getNestedValue(doc, path);
      // Check actual value format — do NOT trust isDataEncrypted flag (it can be corrupted)
      if (!looksEncrypted(val)) return;

      let result;
      if (canReadDecrypted) {
        try {
          result = decrypt(val);
        } catch {
          result = val; // leave as-is if decrypt fails
        }
      } else {
        result = "***";
      }

      if (doc.set) {
        // Use { strict: false } to bypass field validators (e.g. email regex)
        // that would reject ciphertext or the "***" mask string.
        doc.set(path, result, { strict: false });
      } else {
        setNestedValue(doc, path, result);
      }
    });
  }

  schema.post("init", function () {
    autoDecryptDoc(this);
  });

  schema.post("find", function (docs) {
    docs.forEach(autoDecryptDoc);
  });

  schema.post("findOne", function (doc) {
    if (doc) autoDecryptDoc(doc);
  });

  // ── Instance method: explicit decrypt for a given role ────────────────────
  // Used in admin-only controller operations (e.g. privacyController) where
  // you need to force-decrypt regardless of the request context.
  //
  // Reads ciphertext from _rawEncrypted snapshot (captured by autoDecryptDoc
  // before it masked to "***"), so this works correctly even when the request
  // context has canReadDecrypted:false.
  schema.methods.decryptForRole = function () {
    const obj = this.toObject({ virtuals: true, getters: false });
    const rawSnap = _rawEncrypted.get(this) ?? {};

    secretPaths.forEach(({ path }) => {
      // Prefer snapshot ciphertext over the (possibly masked) in-memory value
      const val = rawSnap[path] ?? getNestedValue(obj, path);
      if (!looksEncrypted(val)) return;
      try {
        setNestedValue(obj, path, decrypt(val));
      } catch {
        // leave as-is if decrypt fails
      }
    });

    return obj;
  };

  // ── Static: decrypt an array of docs or lean objects ─────────────────────
  schema.statics.decryptMany = function (docs) {
    return docs.map((doc) =>
      typeof doc.decryptForRole === "function"
        ? doc.decryptForRole()
        : doc
    );
  };

  // ── Static: returns the list of encrypted field paths ─────────────────────
  schema.statics.getEncryptedPaths = function () {
    return secretPaths.map((p) => p.path);
  };
}

/** Whether the current request may read decrypted values (false outside a request). */
function canReadDecrypted() {
  return !!_getStore().canReadDecrypted;
}

module.exports = { roleEncryptionPlugin, runWithRole, canReadDecrypted, looksEncrypted };
