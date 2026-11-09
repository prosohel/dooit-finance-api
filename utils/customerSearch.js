// utils/customerSearch.js
//
// Name / email / uid search over customers. Customer name and email fields are
// AES-256-GCM encrypted at rest (roleEncryptionPlugin), so they CANNOT be
// regex-searched in Mongo — a plain query only ever matches `uid`. We read raw
// ciphertext via the native collection (bypasses the masking hook, so the
// result does not depend on the caller's decrypt permission), decrypt the
// searchable fields, and filter in app.
//
// Shared by the CRA customer dropdown and the case POI picker.

const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const { decrypt } = require('./encryption');

const looksEncrypted = (v) => {
  if (!v || typeof v !== 'string') return false;
  const p = v.split(':');
  return p.length === 3 && p[0].length === 32 && p[1].length === 32;
};

const dec = (v) => {
  if (!looksEncrypted(v)) return v || '';
  try {
    return decrypt(v);
  } catch {
    return '';
  }
};

/**
 * @param {Object}  opts
 * @param {string}  [opts.q]        free text; every whitespace token must match
 * @param {number}  [opts.limit]    max results (capped at 50)
 * @param {*}       [opts.clientId] tenant to scope to — omit only for admins
 * @param {*}       [opts.branchId] narrower tenant scope
 * @returns {Promise<Array<{id,uid,name,type,kycStatus,country,email,isPep,sanction,createdAt}>>}
 */
async function searchCustomers({ q = '', limit = 50, clientId = null, branchId = null } = {}) {
  const lim = Math.min(Number(limit) || 50, 50);
  const tokens = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);

  const filter = { isActive: true };
  if (clientId && mongoose.isValidObjectId(clientId)) {
    filter['relations.client'] = new mongoose.Types.ObjectId(String(clientId));
  }
  if (branchId && mongoose.isValidObjectId(branchId)) {
    filter['relations.branch'] = new mongoose.Types.ObjectId(String(branchId));
  }

  // Bounded candidate pool, newest first; only scan more when searching.
  const POOL = tokens.length ? 1000 : lim;
  const docs = await Customer.collection.find(filter).sort({ createdAt: -1 }).limit(POOL).toArray();

  const data = [];
  for (const c of docs) {
    const det = c.personalKyc?.personal_form?.customer_details || {};
    const contact = c.personalKyc?.personal_form?.contact_details || {};
    const name = [dec(det.given_name), dec(det.middle_name), dec(det.surname)]
      .filter(Boolean)
      .join(' ')
      .trim();
    const email = dec(contact.email);

    if (tokens.length) {
      const haystack = `${c.uid || ''} ${name} ${email}`.toLowerCase();
      if (!tokens.every((t) => haystack.includes(t))) continue;
    }

    const rel = c.relations?.[0];
    data.push({
      id: c._id,
      uid: c.uid,
      name: name || c.uid || 'Unnamed',
      type: rel?.type || 'individual',
      kycStatus: c.kycStatus,
      country: c.country,
      email: email || undefined,
      isPep: !!c.isPep,
      sanction: !!c.sanction,
      createdAt: c.createdAt,
    });
    if (data.length >= lim) break;
  }
  return data;
}

const KYC_SEARCH_PATHS = [
  'personalKyc.personal_form.customer_details.given_name',
  'personalKyc.personal_form.customer_details.middle_name',
  'personalKyc.personal_form.customer_details.surname',
  'personalKyc.personal_form.contact_details.email',
].join(' ');

/**
 * _ids of the customers matching `filter` whose KYC full name and/or email
 * contains `text` (case-insensitive), compared on decrypted values.
 *
 * For the queue list + Excel export: they regex the KYC columns in Mongo, which
 * only ever matches plaintext rows. The caller ORs these ids into that regex
 * group. The caller must gate this on the viewer's decrypt permission
 * (canReadDecrypted) — a viewer who sees "***" must not be able to find a
 * customer by a name they cannot read.
 *
 * @param {object}  filter              Mongoose filter (tenant scope + other filters)
 * @param {string}  text                search text
 * @param {object}  [opts]
 * @param {boolean} [opts.name=true]    match the full name
 * @param {boolean} [opts.email=true]   match the KYC email
 * @returns {Promise<ObjectId[]>}
 */
async function findIdsByDecryptedKyc(filter, text, { name = true, email = true } = {}) {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return [];

  // Mongoose (not the raw collection) so string ids in `filter` are cast.
  // dec() handles both shapes: ciphertext, or values the read hook has
  // already decrypted.
  const docs = await Customer.find(filter).select(KYC_SEARCH_PATHS).lean();

  const ids = [];
  for (const c of docs) {
    const det = c.personalKyc?.personal_form?.customer_details || {};
    const contact = c.personalKyc?.personal_form?.contact_details || {};
    const hay = [];
    if (name) {
      hay.push([dec(det.given_name), dec(det.middle_name), dec(det.surname)].filter(Boolean).join(' '));
    }
    if (email) hay.push(dec(contact.email));
    if (hay.some((h) => h.toLowerCase().includes(needle))) ids.push(c._id);
  }
  return ids;
}

module.exports = { searchCustomers, findIdsByDecryptedKyc };
