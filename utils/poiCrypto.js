// utils/poiCrypto.js
//
// Field encryption for Case.externalPois — people who are not our customers
// but whose identity details (DOB, ID numbers, accounts) we hold for an
// investigation. Same AES-256-GCM format and role gate as the Customer model
// (roleEncryptionPlugin), applied by hand because that plugin cannot walk an
// array of subdocuments.
//
//   Write: every save encrypts any plaintext secret field (idempotent — a value
//          that is already ciphertext is left alone).
//   Read:  only LEAN results are decrypted (or masked "***" for a caller
//          without the decrypt grant). A lean object is output, never saved
//          back, so masking it cannot destroy data. A hydrated Case keeps the
//          ciphertext, so re-saving it — by anyone — rewrites what was there.

const { encrypt, decrypt } = require('./encryption');
const { canReadDecrypted, looksEncrypted } = require('./roleEncryptionPlugin');

// Scalar paths within one POI. `aliases` (an array) is handled alongside.
const POI_SECRET_PATHS = ['name', 'dateOfBirth', 'idDocument.number', 'address', 'email', 'phone', 'account', 'notes'];

const MASK = '***';

const getPath = (obj, path) => path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);

const encryptValue = (v) => (typeof v === 'string' && v !== '' && !looksEncrypted(v) ? encrypt(v) : v);

const readValue = (v, canRead) => {
  if (!looksEncrypted(v)) return v;
  if (!canRead) return MASK;
  try {
    return decrypt(v);
  } catch {
    return MASK;
  }
};

/** Encrypt the secret fields of a hydrated POI subdocument in place. */
function encryptPoiDoc(poi) {
  for (const path of POI_SECRET_PATHS) {
    const v = poi.get(path);
    const enc = encryptValue(v);
    if (enc !== v) poi.set(path, enc);
  }
  const aliases = poi.get('aliases');
  if (Array.isArray(aliases) && aliases.some((a) => typeof a === 'string' && !looksEncrypted(a))) {
    poi.set('aliases', aliases.map(encryptValue));
  }
}

/** Decrypt (or mask) the secret fields of a plain POI object in place. */
function decryptPoiLean(poi, canRead = canReadDecrypted()) {
  if (!poi) return poi;
  for (const path of POI_SECRET_PATHS) {
    const keys = path.split('.');
    const last = keys.pop();
    const parent = keys.length ? getPath(poi, keys.join('.')) : poi;
    if (parent && parent[last] != null) parent[last] = readValue(parent[last], canRead);
  }
  if (Array.isArray(poi.aliases)) poi.aliases = poi.aliases.map((a) => readValue(a, canRead));
  return poi;
}

/** Decrypt every external POI on a lean Case (or list of them). */
function decryptCasePoisLean(result) {
  const canRead = canReadDecrypted();
  const list = Array.isArray(result) ? result : [result];
  for (const c of list) {
    if (c && Array.isArray(c.externalPois)) c.externalPois.forEach((p) => decryptPoiLean(p, canRead));
  }
  return result;
}

module.exports = { POI_SECRET_PATHS, encryptPoiDoc, decryptPoiLean, decryptCasePoisLean, MASK };
