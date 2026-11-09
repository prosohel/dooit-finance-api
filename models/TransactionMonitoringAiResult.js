const mongoose = require('mongoose');

const { Schema } = mongoose;
const { ObjectId, Mixed } = Schema.Types;

// ─────────────────────────────────────────────────────────────────────────────
// transaction-monitoring-ai-results
//
// One document per evaluated transaction, written by the AFC transaction-
// monitoring service (runId "MON-API-…"). That service also raises the alert
// and/or case and stamps the alert with metadata.source
// 'afc-transaction-monitoring' and metadata.resultId = this _id.
//
// This API only READS the collection. The writer owns the shape and the
// indexes, so autoIndex/autoCreate are off: the API never creates or changes
// an index here, and no schema.index() is declared, so a syncIndexes() call
// on this model can't drop the writer's indexes either. Indexes in place on
// 2026-11-09:
//   uniq_transaction { transactionId: 1 } unique
//   by_run_date      { runDate: -1, 'overall.riskScore': -1 }
//   by_txn_date      { transactionDate: -1 }
//   by_detected_at   { detectedAt: -1 }
//   by_client_day    { client: 1, runDate: -1 }
//   by_customer      { customer: 1, detectedAt: -1 }
//   by_detector      { 'overall.detectedBy': 1, runDate: -1 }
//   by_label         { 'overall.riskLabel': 1, runDate: -1 }
//   by_case_type     { 'categories.caseTypes': 1 }
//   by_rule          { 'ruleHits.ruleId': 1 }
//   by_txn_uid       { transactionUid: 1 }
// Nothing covers 'alert.alertId'. To reach a result from an alert, use the
// Alert.monitoringResult virtual. It joins on transactionId and then checks
// alert.alertId.
//
// No enums: a new label or detector from the writer must not make these
// documents fail validation here.
// ─────────────────────────────────────────────────────────────────────────────

// ── Links to the alert / case the run raised or updated ─────────────────────
const AlertLinkSchema = new Schema(
  {
    alertId: { type: ObjectId, ref: 'Alert', default: null },
    uid: { type: String, default: null },       // AL-0000012
    status: { type: String, default: null },    // alert status at write time
    action: { type: String, default: null },    // created | updated
  },
  { _id: false }
);

const CaseLinkSchema = new Schema(
  {
    caseId: { type: ObjectId, ref: 'Case', default: null },
    uid: { type: String, default: null },       // CA-…
    action: { type: String, default: null },    // created | updated
  },
  { _id: false }
);

const CategoriesSchema = new Schema(
  {
    caseTypes: { type: [String], default: [] },   // Fraud, AML, …
    domains: { type: [String], default: [] },
    mainDomains: { type: [String], default: [] },
  },
  { _id: false }
);

// Behavioural aggregates over the sender/beneficiary at evaluation time.
// Ratios and deltas are null when there is no previous transaction to compare.
const CollectiveContextSchema = new Schema(
  {
    senderTxCount24h: Number,
    senderSum24h: Number,
    senderSumLast5: Number,
    senderUniqueBeneficiariesDay: Number,
    beneficiaryTxCount24h: Number,
    beneficiaryUniqueSendersDay: Number,
    secsSincePrevSenderTx: Number,
    amountPctChangePrev: Number,
    senderAmountZscore30d: Number,
    senderTxCount30d: Number,
    txFreqChangePct: Number,
    structuringCount24h: Number,
    passThroughRatio: Number,
  },
  { _id: false }
);

// ── ML / DL model output ─────────────────────────────────────────────────────
const ModelFactorSchema = new Schema(
  {
    rank: Number,
    feature: String,            // agg_24h_txn_value
    group: String,              // collective | crypto | …
    value: Mixed,               // number or string (e.g. 'DEFI')
    contribution: Number,       // signed attribution
    direction: String,          // increases_risk | decreases_risk
    fields: { type: [String], default: undefined },  // derived.agg_24h_txn_value
  },
  { _id: false }
);

const ModelDetectionSchema = new Schema(
  {
    detector: String,           // ml | dl
    algorithm: String,          // embedding-mlp
    explainer: String,          // IntegratedGradients
    modelSource: String,        // csv
    modelVersion: String,
    predictedClass: String,     // High | Medium | Low
    probabilities: { type: Map, of: Number, default: undefined },
    threshold: Number,
    riskScore: Number,
    riskLabel: String,
    inferredCaseType: String,
    inferredDomain: String,
    inferenceBasis: String,
    topFactors: { type: [ModelFactorSchema], default: undefined },
    mitigatingFactors: { type: [ModelFactorSchema], default: undefined },
  },
  { _id: false }
);

const ModelDetectionsSchema = new Schema(
  {
    ml: { type: ModelDetectionSchema, default: null },
    dl: { type: ModelDetectionSchema, default: null },
  },
  { _id: false }
);

// ── Combined verdict across rule / ml / dl ───────────────────────────────────
const OverallSchema = new Schema(
  {
    isRisky: Boolean,
    riskScore: Number,
    riskLabel: String,          // Low | Medium | High | Critical
    priority: String,           // low | medium | high | critical
    detectedBy: { type: [String], default: [] },   // rule | ml | dl
    detectorCount: Number,
    agreement: String,          // '1/3'
    primaryCaseType: String,
    primaryReason: String,
  },
  { _id: false }
);

const PipelineSchema = new Schema(
  {
    modelVersions: {
      ml: { type: String, default: null },
      dl: { type: String, default: null },
    },
    appVersion: String,
    rulesEvaluated: Number,
  },
  { _id: false }
);

const ReasonSchema = new Schema(
  {
    detector: String,           // rule | ml | dl
    ref: String,                // R223
    text: String,
  },
  { _id: false }
);

// ── Rule hits ────────────────────────────────────────────────────────────────
const MatchedConditionSchema = new Schema(
  {
    field: String,              // human label: 'Transaction frequency change'
    resolvedField: String,      // derived.tx_freq_change_pct
    operator: String,           // gt | eq | between | …
    expected: Mixed,            // '300%' | 9000 | true | { min, max } | null
    actual: Mixed,              // number | string | boolean
  },
  { _id: false }
);

const RuleHitSchema = new Schema(
  {
    ruleRef: { type: ObjectId, ref: 'RuleEngine', default: null },  // null for corpus-only rules
    ruleId: String,
    ruleName: String,
    ruleVersion: Number,
    caseType: String,
    riskScore: Number,
    riskLabel: String,
    domain: String,
    mainDomain: String,
    category: String,           // dsl-natural
    engine: String,             // predicate
    appliesTo: String,          // transaction
    alertable: Boolean,
    slaHours: { type: Number, default: null },
    conditionSummary: String,
    explanation: String,
    logicSource: String,        // corpus
    source: String,             // mongo
    detector: String,           // rule
    matchedConditions: { type: [MatchedConditionSchema], default: [] },
  },
  { _id: false }
);

// One entry per monitoring run that re-evaluated this transaction.
const RunHistorySchema = new Schema(
  {
    runId: String,
    detectedAt: Date,
    riskScore: Number,
    detectedBy: { type: [String], default: [] },
  },
  { _id: false }
);

// Field-level view across detectors, used for "what triggered" displays.
const TriggeredFieldSourceSchema = new Schema(
  {
    detector: String,
    ref: String,                // rule id or model name
    how: String,                // matched_condition | …
    weight: Number,
  },
  { _id: false }
);

const TriggeredFieldSchema = new Schema(
  {
    field: String,              // derived.tx_freq_change_pct
    value: Mixed,
    weight: Number,
    detectorCount: Number,
    detectors: { type: [String], default: [] },
    sources: { type: [TriggeredFieldSourceSchema], default: [] },
  },
  { _id: false }
);

// ── Transaction snapshot (party names and accounts arrive already masked) ────
const PartySnapshotSchema = new Schema(
  {
    customer: { type: ObjectId, ref: 'Customer', default: null },
    name: String,               // 'A*** H***'
    account: { type: String, default: null },  // '****1261'
    bic: { type: String, default: null },
    institution: String,
    country: String,
  },
  { _id: false }
);

const TransactionSnapshotSchema = new Schema(
  {
    amount: Number,
    currency: String,
    convertedAmountAUD: Number,
    type: String,
    subtype: String,
    channel: String,
    status: String,
    purpose: String,
    isCrossBorder: Number,      // 0 | 1 as written by the service
    beneficiaryFromReceiver: Boolean,
    sender: { type: PartySnapshotSchema, default: null },
    beneficiary: { type: PartySnapshotSchema, default: null },
    crypto: {
      hasWallet: Boolean,
      network: { type: String, default: null },
      cluster: { type: String, default: null },
      hops: Number,
    },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Result schema
// ─────────────────────────────────────────────────────────────────────────────

const TransactionMonitoringAiResultSchema = new Schema(
  {
    // ── Subject ──────────────────────────────────────────────────────────
    transactionId: { type: ObjectId, ref: 'Transaction', required: true },
    transactionUid: String,
    transactionDate: String,                // 'YYYY-MM-DD'
    transactionTimestamp: Date,
    transaction: { type: TransactionSnapshotSchema, default: null },

    customer: { type: ObjectId, ref: 'Customer', default: null },
    customerUid: String,
    counterpartyCustomer: { type: ObjectId, ref: 'Customer', default: null },
    subjectKey: String,                     // 'cust:<customerId>'

    // ── Multi-tenant ─────────────────────────────────────────────────────
    client: { type: ObjectId, ref: 'Client', default: null },
    branch: { type: ObjectId, ref: 'Branch', default: null },

    // ── Outcome links ────────────────────────────────────────────────────
    alert: { type: AlertLinkSchema, default: null },
    case: { type: CaseLinkSchema, default: null },

    // ── Verdict and explanation ──────────────────────────────────────────
    overall: { type: OverallSchema, default: null },
    categories: { type: CategoriesSchema, default: null },
    reasons: { type: [ReasonSchema], default: [] },
    ruleHitCount: Number,
    ruleHits: { type: [RuleHitSchema], default: [] },
    modelDetections: { type: ModelDetectionsSchema, default: null },
    triggeredFields: { type: [TriggeredFieldSchema], default: [] },
    topTriggeredFields: { type: [String], default: [] },
    collectiveContext: { type: CollectiveContextSchema, default: null },

    // ── Run ──────────────────────────────────────────────────────────────
    runId: String,
    runDate: String,                        // 'YYYY-MM-DD'
    runHistory: { type: [RunHistorySchema], default: [] },
    detectedAt: Date,
    window: {
      start: Date,
      end: Date,
    },
    pipeline: { type: PipelineSchema, default: null },

    // Set by the writer itself, so no `timestamps` option here.
    createdAt: Date,
    updatedAt: Date,
  },
  {
    collection: 'transaction-monitoring-ai-results',
    autoIndex: false,
    autoCreate: false,
    versionKey: false,
  }
);

module.exports = mongoose.model('TransactionMonitoringAiResult', TransactionMonitoringAiResultSchema);
