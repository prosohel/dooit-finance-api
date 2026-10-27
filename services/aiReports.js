// services/aiReports.js
//
// The ONLY place in the codebase that talks to the AI reports service
// (https://ai-report-summary.dooit.ai) and the only place its response shape is
// known. docs/74 §6.3 (phase C3).
//
// The rule this module enforces: **facts come from our API, prose comes from
// the AI**. Everything the service returns except the narrative fields listed
// in NARRATIVE_FIELDS is discarded here — its totals, its counterparties, its
// risk scores, its `ecdd_create_payload`, its identities. Two reasons:
//
//   1. Its numbers are not tenant-scoped. A customer onboarded under several
//      clients has all of their transactions counted into one client's report
//      (docs/74 C15, verified against the sandbox).
//   2. Its numbers disagree with themselves — risk_classification "High" beside
//      risk_label "Medium", a 100M USD transfer with amount_aud 0.
//
// Never call this from the browser: the service has no auth and reads our
// database directly.

const axios = require('axios');

const BASE_URL = (process.env.AI_REPORTS_URL || 'https://ai-report-summary.dooit.ai').replace(/\/+$/, '');
// Which database the service should read: 1 = production, 2 = stage. It MUST
// match the database this API is connected to, or it will summarise a
// different environment's data.
const DB_SOURCE = Number(process.env.AI_REPORTS_DB_SOURCE || 2);
// Generation runs 3–20s in practice; allow headroom but never hang a request.
const TIMEOUT_MS = Number(process.env.AI_REPORTS_TIMEOUT_MS || 60000);

const ENDPOINTS = {
  ecdd: '/v2/ecdd_report',
  smr: '/v2/smr_report',
  gfs: '/v2/gfs_report',
  rfi: '/v2/rfi_report',
  dismissal: '/v2/dismissal_report',
};

/**
 * The whitelist: AI response key → our draft field. Anything not here is
 * dropped. Adding a row is a deliberate decision that the field is *prose*.
 */
const NARRATIVE_FIELDS = {
  ecdd: {
    profile_summary: 'profileSummary',
    transaction_analysis: 'transactionAnalysis',
    behavioral_analysis: 'behavioralAnalysis',
    recommendation: 'recommendation',
    recommendation_type: 'recommendationType',
    decision_rationale: 'decisionRationale',
    immediate_actions: 'immediateActions',
    key_indicators: 'keyIndicators',
    typologies_identified: 'typologies',
  },
  smr: {
    narrative: 'groundsForSuspicion',
    grounds_for_suspicion: 'groundsList',
    investigation_notes: 'investigationNotes',
  },
  gfs: {
    suspicionSummary: 'suspicionSummary',
    behavioralChangeDescription: 'behavioralChangeDescription',
  },
  rfi: {
    requested_items: 'requestedItems',
    items_rationale: 'itemsRationale',
    Subject: 'draftSubject',
    body: 'draftBody',
  },
  // `full_report` is deliberately not taken: it is the five sections below
  // concatenated, and we re-render them ourselves so an analyst's edit to one
  // section cannot be contradicted by a stale copy of the whole.
  dismissal: {
    title: 'title',
    category: 'category',
    intro: 'intro',
    profile: 'profile',
    transaction_analysis: 'transactionAnalysis',
    additional_info: 'additionalInfo',
    conclusion: 'conclusion',
  },
};

const REPORT_TYPES = Object.keys(ENDPOINTS);

// Fields that must arrive as a list of strings; everything else is prose.
const LIST_FIELDS = new Set([
  'immediateActions', 'keyIndicators', 'typologies', 'groundsList', 'requestedItems',
]);

// The service pseudonymises PII before prompting and re-hydrates afterwards.
// If re-hydration fails a placeholder survives into the text — a filing must
// never carry one, so any field containing this shape is dropped.
const PII_TOKEN = /(⟨|<|\[\[|\{\{)\s*PII[_\-: ]/i;

// When its model fails, the service still answers 200: the failed section
// arrives as a bracketed apology ("[Profile summary could not be generated
// automatically.]") and the cause sits in `_meta.llm_section_errors`. A
// placeholder must never be saved as narrative (observed live 27 Oct 2026).
const FAILURE_PLACEHOLDER = /^\[[^\]]*could not be generated[^\]]*\]$/i;

/** "SMR" / "ongoing monitoring" / "no further action" → our enum (or null). */
function normalizeRecommendationType(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('smr') || s.includes('sar') || s.includes('suspicious matter')) return 'SMR';
  if (s.includes('rfi') || s.includes('request for information')) return 'RFI';
  if (s.includes('ecdd') || s.includes('enhanced due diligence')) return 'ECDD';
  if (s.includes('offboard') || s.includes('exit') || s.includes('terminate')) return 'offboard';
  if (s.includes('monitor')) return 'monitor';
  if (s.includes('no action') || s.includes('no further action') || s.includes('dismiss')) return 'no_action';
  return null;
}

/** Coerce one whitelisted value into the shape our schema expects, or null. */
function coerce(field, value) {
  if (value === null || value === undefined) return null;

  if (LIST_FIELDS.has(field)) {
    const list = (Array.isArray(value) ? value : [value])
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .filter((v) => !PII_TOKEN.test(v) && !FAILURE_PLACEHOLDER.test(v));
    return list.length ? list : null;
  }

  if (field === 'recommendationType') return normalizeRecommendationType(value);

  const text = String(value).trim();
  if (!text || PII_TOKEN.test(text) || FAILURE_PLACEHOLDER.test(text)) return null;
  return text;
}

/**
 * Did the service look at the same data we did?
 *
 * It reads our database directly with no client scope, so for a customer
 * onboarded under several clients it counts all of their activity into one
 * client's report (docs/74 C15). We never store its numbers — but it writes its
 * prose from them, so a narrative can quote another tenant's totals. Comparing
 * counts is the cheapest reliable signal that this happened.
 */
function buildScope(data, { client, branch, expected }) {
  const meta = data._meta || {};
  const theirTransactionCount = meta.transaction_count ?? null;
  const theirAlertCount = meta.alert_count ?? null;
  const ourTransactionCount = expected?.transactions ?? null;
  const ourAlertCount = expected?.alerts ?? null;
  const sharedCustomers = expected?.sharedCustomers ?? 0;

  // Only a count we can actually compare counts as evidence.
  const comparable = (ours, theirs) => ours !== null && theirs !== null;
  const mismatch =
    (comparable(ourTransactionCount, theirTransactionCount) && ourTransactionCount !== theirTransactionCount) ||
    (comparable(ourAlertCount, theirAlertCount) && ourAlertCount !== theirAlertCount);

  return {
    scope: {
      ourTransactionCount,
      theirTransactionCount,
      ourAlertCount,
      theirAlertCount,
      sharedCustomers,
      mismatch,
    },
    client: client || null,
    branch: branch || null,
    warning: mismatch
      ? `The summary service read ${theirTransactionCount ?? "?"} transaction(s) and ` +
        `${theirAlertCount ?? "?"} alert(s); this tenant's case has ${ourTransactionCount ?? "?"} and ` +
        `${ourAlertCount ?? "?"}.` +
        // Naming the cause turns a puzzling number into something actionable.
        (sharedCustomers > 0
          ? ` ${sharedCustomers} person(s) of interest on this case are also onboarded under another client, which is how the wider read happens.`
          : "") +
        " Its narrative may describe activity outside this tenant — review before filing."
      : null,
  };
}

/** Provenance block for the draft, from the service's own `_meta`. */
function buildMeta(data, { sectionsUsed, sectionsRejected, client, branch, expected, requestedBy }) {
  const meta = data._meta || {};
  const quality = data.data_quality || {};
  const { scope, warning } = buildScope(data, { client, branch, expected });
  return {
    client: client || null,
    branch: branch || null,
    requestedBy: requestedBy || null,
    scope,
    provider: 'ai-report-summary',
    apiVersion: meta.api_version || null,
    model: meta.llm_model || null,
    generatedAt: meta.generated_at ? new Date(meta.generated_at) : new Date(),
    generationMs: meta.generation_ms ?? null,
    piiMode: meta.pii_mode || null,
    alertScope: meta.alert_scope || null,
    alertIds: Array.isArray(meta.alert_ids) ? meta.alert_ids : [],
    sectionsUsed,
    sectionsRejected,
    dataQuality: {
      missingFields: quality.missing_fields || [],
      // A scope mismatch is the most important thing an analyst can be told
      // about a draft, so it leads the warnings rather than trailing them.
      warnings: [...(warning ? [warning] : []), ...(quality.warnings || [])],
      complete: typeof quality.complete === 'boolean' ? quality.complete : null,
    },
    error: { code: null, message: null, at: null },
  };
}

/** A failure is never fatal: the facts still make a valid draft. */
function errorMeta(code, message, { client, branch, requestedBy } = {}) {
  return {
    provider: 'ai-report-summary',
    generatedAt: new Date(),
    // Recorded even on failure: which tenant this draft was attempted for is
    // part of its provenance whether or not any prose came back.
    client: client || null,
    branch: branch || null,
    requestedBy: requestedBy || null,
    sectionsUsed: [],
    sectionsRejected: [],
    dataQuality: { missingFields: [], warnings: [], complete: null },
    error: { code, message: String(message || '').slice(0, 500), at: new Date() },
  };
}

/**
 * Ask the service for one report's prose.
 *
 * Never throws: on any failure it returns empty narrative plus an `aiMeta`
 * carrying the error, so the caller can still persist a facts-only draft.
 *
 * @param {'ecdd'|'smr'|'gfs'|'rfi'|'dismissal'} type
 * @param {Object} opts
 * @param {string} opts.caseId   Case _id (the service resolves it in our DB)
 * @param {string} [opts.alertId] narrow to a single alert; omit to consolidate
 * @param {string} [opts.dismissalType] industry template code (dismissal only)
 * @param {string} [opts.client]   the logged-in tenant this draft is for (C15)
 * @param {Object} [opts.expected] our own counts, to detect an unscoped read:
 *                                 { transactions, alerts }
 * @param {string} [opts.requestedBy] the user asking, for provenance
 * @returns {Promise<{narrative: Object, meta: Object}>}
 */
async function draftNarrative(
  type,
  { caseId, alertId, dismissalType, client, branch, expected, requestedBy, personsOfInterest } = {}
) {
  const endpoint = ENDPOINTS[type];
  if (!endpoint) {
    return {
      narrative: {},
      meta: errorMeta('unsupported_type', `No AI endpoint for "${type}"`, { client, branch, requestedBy }),
    };
  }

  const body = { case_id: String(caseId), db_source: DB_SOURCE };
  if (alertId) body.alert_id = String(alertId);
  // Tell the service whose tenant this is. Today's v2 contract ignores unknown
  // fields, so this changes nothing until the service scopes its own reads —
  // at which point every caller here is already sending what it needs (C15).
  if (client) body.client_id = String(client);
  // Who the case is about (name / role / relationship — no identity numbers).
  // The service reads customers from our database itself, but not the case's
  // non-customer POIs (Case.externalPois, encrypted at rest), so they travel
  // with the request. Ignored by the v2 contract until the service uses it.
  if (Array.isArray(personsOfInterest) && personsOfInterest.length) {
    body.persons_of_interest = personsOfInterest;
  }
  if (branch) body.branch_id = String(branch);
  // Omitted entirely for 'generic' — the service defaults to it, and sending
  // the word back would be rejected as an unknown template code.
  if (type === 'dismissal' && dismissalType && dismissalType !== 'generic') {
    body.dismissal_type = String(dismissalType);
  }

  let data;
  try {
    const response = await axios.post(`${BASE_URL}${endpoint}`, body, {
      timeout: TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
    });
    data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data || {};
  } catch (err) {
    // 404 case not found · 409 alert not linked to case · 422 insufficient data
    // · 502/503/504 model or database unavailable. All are "no prose this time".
    const status = err.response?.status;
    const detail = err.response?.data?.error || err.response?.data?.detail || err.message;
    return {
      narrative: {},
      meta: errorMeta(status ? `http_${status}` : err.code || 'request_failed', detail, { client, branch, requestedBy }),
    };
  }

  const map = NARRATIVE_FIELDS[type];
  const narrative = {};
  const sectionsUsed = [];
  const sectionsRejected = [];

  // Sections the service says its model failed on arrive as placeholder text
  // under a 200 — never usable, whatever the value looks like. Its error keys
  // do not always match its response keys (GFS answers `suspicionSummary` but
  // reports `suspicion_summary`), so the comparison ignores case and casing.
  const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
  const failedKeys = new Set(Object.keys((data._meta || {}).llm_section_errors || {}).map(norm));
  const failedFields = [];

  for (const [aiKey, field] of Object.entries(map)) {
    const failed = failedKeys.has(norm(aiKey));
    if (failed) failedFields.push(field);
    const value = failed ? null : coerce(field, data[aiKey]);
    if (value === null) {
      // Only report a rejection when the service actually sent something.
      if (data[aiKey] !== undefined && data[aiKey] !== null) sectionsRejected.push(field);
      continue;
    }
    narrative[field] = value;
    sectionsUsed.push(field);
  }

  const meta = buildMeta(data, { sectionsUsed, sectionsRejected, client, branch, expected, requestedBy });
  if (failedFields.length) {
    meta.dataQuality.warnings.unshift(
      `The AI model failed for ${failedFields.join(', ')} — write those sections yourself or redraft later.`
    );
    // No prose at all (an enum like recommendationType is not prose): tell the
    // analyst the way an unreachable service would, so the hub shows its banner.
    if (!sectionsUsed.some((f) => f !== 'recommendationType')) {
      meta.error = { code: 'llm_failed', message: 'The AI model failed for every section', at: new Date() };
    }
  }

  return { narrative, meta };
}

module.exports = {
  draftNarrative,
  normalizeRecommendationType,
  NARRATIVE_FIELDS,
  REPORT_TYPES,
  BASE_URL,
  DB_SOURCE,
};
