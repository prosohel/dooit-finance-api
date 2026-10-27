const mongoose = require('mongoose');
const uniqueValidator  = require('mongoose-unique-validator');
const mongoosePaginate = require('mongoose-paginate-v2');

const { Schema } = mongoose;
const { riskFields, slaFields, addOverdueVirtual } = require('./schemas/riskShared');
const { encryptPoiDoc, decryptCasePoisLean } = require('../utils/poiCrypto');

// ─────────────────────────────────────────────────────────────────────────────
// Case document
//
// Evidence attached to a case — a trade invoice, a bank statement, a registry
// extract. The bytes live in FileVault (POST /file-vault/upload); this records
// only the reference, the same { name, url, mimeType, type } shape Client and
// Branch use for their documents.
//
// `tbml` is the link back to a TBML screening run at osint.dooit.ai. It is on
// the document rather than the case because a case can hold several trade
// documents and each is screened on its own — and because the OSINT Engine
// keeps the report, not us: all we hold is the id needed to fetch it again.
// ─────────────────────────────────────────────────────────────────────────────
const CaseDocumentSchema = new Schema(
    {
        name:       { type: String, trim: true },
        url:        { type: String, trim: true },
        mimeType:   { type: String, trim: true },
        // e.g. 'trade_document', 'bank_statement', 'company_registry'
        type:       { type: String, trim: true, default: 'other' },
        sizeBytes:  { type: Number, default: null },
        uploadedAt: { type: Date, default: Date.now },
        uploadedBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },

        tbml: {
            reportId:     { type: String, default: null },
            submissionId: { type: String, default: null },
            // Mirrors the engine's OSINTStatus so the case list can say a
            // screening is still running without calling out to it.
            status:       { type: String, default: null },
            dbSource:     { type: Number, default: null },
            submittedAt:  { type: Date, default: null },
        },
    },
    { timestamps: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// External person of interest
//
// A POI who is NOT one of our customers — a counterparty on a flagged
// transaction, a director or beneficial owner named in an RFI response, a third
// party an analyst found in open sources. Customers who are POIs stay in
// `customer` / `linkedCustomers` (the Customer record is the source of truth);
// this array holds everyone else, with enough identifying detail to go into
// an SMR (AUSTRAC Part C "other parties") without re-keying.
//
// `source` records how the analyst found them: picked off a party slot on a
// linked alert's transaction ('alert'), or typed in ('manual'). For 'alert'
// POIs the alert / transaction / party slot are kept so the same party cannot
// be added twice and the SMR can cite where the name came from.
//
// Identity fields are ENCRYPTED at rest (utils/poiCrypto — name, aliases, DOB,
// ID number, address, email, phone, account, notes). Their length limits live
// in the request validator: ciphertext is longer than the value it holds.
// ─────────────────────────────────────────────────────────────────────────────
const POI_ROLES = [
    'subject',          // a subject of the suspicion in their own right
    'associated_party', // connected to the subject, suspicion not yet established
    'counterparty',     // the other side of a flagged transaction
    'beneficiary',
    'beneficial_owner',
    'director',
    'third_party',
    'other',
];
const POI_PARTY_SLOTS = ['sender', 'receiver', 'beneficiary', 'intermediary'];

const ExternalPoiSchema = new Schema(
    {
        kind:         { type: String, enum: ['individual', 'entity'], default: 'individual' },
        name:         { type: String, trim: true, required: [true, 'POI name is required'] }, // encrypted
        aliases:      [{ type: String, trim: true }],                                         // encrypted
        role:         { type: String, enum: POI_ROLES, default: 'associated_party' },
        // Free text: "Brother of the subject", "Receiving account holder".
        relationship: { type: String, trim: true, maxlength: 300, default: null },

        // ── Identity (individual) ──────────────────────────────────────────
        // 'yyyy-mm-dd' — a string so it can hold ciphertext.
        dateOfBirth:  { type: String, default: null },                                        // encrypted
        nationality:  { type: String, trim: true, maxlength: 100, default: null },
        occupation:   { type: String, trim: true, maxlength: 200, default: null },
        idDocument: {
            type:    { type: String, trim: true, maxlength: 60, default: null }, // passport, driver_licence …
            number:  { type: String, trim: true, default: null },                       // encrypted
            country: { type: String, trim: true, maxlength: 100, default: null },
        },

        // ── Identity (entity) ──────────────────────────────────────────────
        registrationNumber: { type: String, trim: true, maxlength: 100, default: null }, // ABN / ACN / foreign reg.

        // ── Contact / location ─────────────────────────────────────────────
        country: { type: String, trim: true, maxlength: 100, default: null },
        address: { type: String, trim: true, default: null }, // encrypted
        email:   { type: String, trim: true, default: null }, // encrypted (lower-cased before)
        phone:   { type: String, trim: true, default: null }, // encrypted

        // ── Financial identifiers (mirrors Transaction PartySchema) ────────
        account:            { type: String, trim: true, default: null }, // encrypted
        institution:        { type: String, trim: true, maxlength: 200, default: null },
        institutionCountry: { type: String, trim: true, maxlength: 100, default: null },
        bic:                { type: String, trim: true, maxlength: 20, default: null },

        notes: { type: String, trim: true, default: null }, // encrypted

        // ── Provenance ─────────────────────────────────────────────────────
        source:            { type: String, enum: ['manual', 'alert'], default: 'manual' },
        sourceAlert:       { type: Schema.Types.ObjectId, ref: 'Alert', default: null },
        sourceAlertUid:    { type: String, default: null }, // snapshot for display
        sourceTransaction: { type: Schema.Types.ObjectId, ref: 'Transaction', default: null },
        sourcePartySlot:   { type: String, enum: [...POI_PARTY_SLOTS, null], default: null },

        addedBy:   { type: Schema.Types.ObjectId, ref: 'Users', default: null },
        addedAt:   { type: Date, default: Date.now },
        updatedBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
    },
    { timestamps: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Case schema
//
// Notes and audit trail are stored in separate collections:
//   CaseNote  — analyst notes / attachments  (collection: casenotes)
//   AuditLog  — system event log             (collection: auditlogs)
//   Report    — regulatory filings (SAR, STR, ECDD, TTR …) (collection: reports)
//
// Access model:
//   - client === null  →  system-level case  (dooit internal)
//   - client !== null  →  tenant case
// ─────────────────────────────────────────────────────────────────────────────

const CaseSchema = new Schema(
    {
        // ── Identity ─────────────────────────────────────────────────────────
        // No `sequence`: the uid no longer counts, so nothing needs one (see the
        // pre('save') hook below). Cases written before this keep whatever
        // sequence they were given — Mongoose simply ignores the stored field.
        uid: { type: String, unique: true, sparse: true, index: true },

        // ── Multi-tenant ─────────────────────────────────────────────────────
        client: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
        branch: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

        // ── Core ─────────────────────────────────────────────────────────────
        title: {
            type:      String,
            required:  [true, 'Case title is required'],
            trim:      true,
            maxlength: [200, 'Title cannot exceed 200 characters'],
        },
        description: {
            type:      String,
            trim:      true,
            maxlength: [5000, 'Description cannot exceed 5000 characters'],
            default:   null,
        },

        // ── Classification ───────────────────────────────────────────────────
        // type    — investigation workflow category (SAR filing, PEP review, etc.)
        // caseType — AML domain, consistent with RuleEngine.caseType and Alert.caseType
        type: {
            type:    String,
            enum:    ['SAR', 'PEP', 'transaction_monitoring', 'other'],
            default: 'other',
            index:   true,
        },
        caseType: {
            type:    String,
            enum:    ['Fraud', 'AML', 'Compliance', 'TF'],
            default: null,
            index:   true,
        },

        // ── Risk ─────────────────────────────────────────────────────────────
        // Derived from linked alerts; updated when alerts are added/removed.
        ...riskFields({ nullable: true }),

        // ── Priority ─────────────────────────────────────────────────────────
        priority: {
            type:    String,
            enum:    ['low', 'medium', 'high', 'critical'],
            default: 'medium',
            index:   true,
        },

        // ── Workflow status ──────────────────────────────────────────────────
        // open                → newly created, awaiting assignment
        // under_investigation → analyst actively investigating
        // pending_review      → awaiting compliance sign-off
        // closed              → resolved
        // escalated           → elevated to regulator / senior team
        status: {
            type:    String,
            enum:    ['open', 'under_investigation', 'pending_review', 'closed', 'escalated'],
            default: 'open',
            index:   true,
        },
        closureReason: {
            type:      String,
            trim:      true,
            maxlength: [1000, 'Closure reason cannot exceed 1000 characters'],
            default:   null,
        },
        closedAt: { type: Date, default: null },

        // ── Linked records ───────────────────────────────────────────────────
        customer:           { type: Schema.Types.ObjectId, ref: 'Customer', default: null }, // Primary customer (POI)
        linkedCustomers:    [{ type: Schema.Types.ObjectId, ref: 'Customer' }], // POI
        // POIs who are not customers — see ExternalPoiSchema above.
        externalPois:       { type: [ExternalPoiSchema], default: [] },
        linkedAlerts:       [{ type: Schema.Types.ObjectId, ref: 'Alert' }], // Should be same customer but income
        linkedTransactions: [{ type: Schema.Types.ObjectId, ref: 'Transaction' }],

        // ── People ───────────────────────────────────────────────────────────
        // assignedTo: primary responsible analyst (single field for dashboard queries)
        // watchers: additional team members receiving updates
        assignedTo: { type: Schema.Types.ObjectId, ref: 'Users', default: null, index: true },
        // reviewer: the checker in the maker→checker (four-eyes) review flow.
        reviewer:   { type: Schema.Types.ObjectId, ref: 'Users', default: null, index: true },
        watchers:   [{ type: Schema.Types.ObjectId, ref: 'Users' }],
        createdBy: {
            type:     Schema.Types.ObjectId,
            ref:      'Users',
            required: [true, 'createdBy is required'],
            index:    true,
        },

        // ── Decision ─────────────────────────────────────────────────────────
        // Recorded when a case is closed. Separate from status so the outcome
        // is queryable even if the case is later re-opened.
        // The actual regulatory report (SAR, STR, etc.) lives in the Report collection.
        decision: {
            type:  String,
            enum:  ['true_positive', 'false_positive', 'sar_filed', 'no_action', null],
            default: null,
            index: true,
        },
        decisionNotes: { type: String, trim: true, maxlength: 5000, default: null },
        decidedAt:     { type: Date, default: null },
        decidedBy:     { type: Schema.Types.ObjectId, ref: 'Users', default: null },

        // ── Review window (docs/74 §6.2) ──────────────────────────────────────
        // The period the case's transaction analysis covers. Left empty until an
        // analyst pins one down; the analysis service then falls back to
        // "30 days before the earliest alert / transaction → now".
        reviewWindow: {
            start:  { type: Date, default: null },
            end:    { type: Date, default: null },
            source: { type: String, enum: ['default', 'analyst'], default: 'default' },
        },

        // Cached result of GET /cases/:id/analysis — the numbers every ECDD /
        // SMR / GFS / RFI draft is built from. Written with `timestamps: false`
        // so caching does not itself invalidate the cache.
        analysis: {
            computedAt: { type: Date, default: null },
            snapshot:   { type: Schema.Types.Mixed, default: null },
        },

        // ── SLA ──────────────────────────────────────────────────────────────
        ...slaFields(),

        // ── Evidence ─────────────────────────────────────────────────────────
        // Files attached to the case; the bytes live in FileVault.
        documents: { type: [CaseDocumentSchema], default: [] },

        // ── Metadata ─────────────────────────────────────────────────────────
        tags:     [{ type: String, trim: true }],
        metadata: { type: Schema.Types.Mixed, default: {} },

        // ── Soft delete ──────────────────────────────────────────────────────
        isDeleted: { type: Boolean, default: false, index: true },
        deletedAt: { type: Date, default: null },
    },
    {
        timestamps: true,
        toJSON:     { virtuals: true },
        toObject:   { virtuals: true },
        collection: 'cases',
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// Indexes
// ─────────────────────────────────────────────────────────────────────────────

CaseSchema.index({ client: 1, status: 1, createdAt: -1 });
CaseSchema.index({ client: 1, isDeleted: 1, status: 1 });
CaseSchema.index({ status: 1, priority: 1, createdAt: -1 });
CaseSchema.index({ linkedAlerts: 1 });
CaseSchema.index({ linkedCustomers: 1 });
CaseSchema.index({ title: 'text', description: 'text' });

// ─────────────────────────────────────────────────────────────────────────────
// Virtuals
// ─────────────────────────────────────────────────────────────────────────────

addOverdueVirtual(CaseSchema, ['closed']);

// Convenience: total linked alert count (populated separately via CaseNote / AuditLog)
CaseSchema.virtual('alertCount').get(function () {
    return Array.isArray(this.linkedAlerts) ? this.linkedAlerts.length : 0;
});

// ── Reverse report linkage (Phase 4) ─────────────────────────────────────────
// Virtual populate keeps reports normalized — a case never re-saves when a
// report is added. NOTE the foreignField differs by model: ECDD/SMR use `caseId`;
// TTR/IFTI/GFS/RFI use `case`.
CaseSchema.virtual('ecddReports', { ref: 'EcddReport', localField: '_id', foreignField: 'caseId' });
CaseSchema.virtual('smrReports',  { ref: 'SMR',        localField: '_id', foreignField: 'caseId' });
CaseSchema.virtual('ttrReports',  { ref: 'TTR',        localField: '_id', foreignField: 'case' });
CaseSchema.virtual('iftiReports', { ref: 'IFTI',       localField: '_id', foreignField: 'case' });
CaseSchema.virtual('gfsReports',  { ref: 'GFS',        localField: '_id', foreignField: 'case' });
CaseSchema.virtual('rfis',        { ref: 'RFI',        localField: '_id', foreignField: 'case' });

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

// The uid is minted here, in the same write as the case, and deliberately does
// NOT come from an auto-increment sequence.
//
// It used to be `CA-<padded sequence>` derived from mongoose-sequence's counter.
// That plugin assigns `sequence` in a hook that runs AFTER the schema's own
// pre('save') hooks, so the derivation always read `undefined` and every case
// created through the API was saved with no uid at all — invisible only because
// the seeder sets its own. A timestamp plus a short random suffix needs no
// counter, no plugin-ordering assumption and no second write, and matches how
// every other record here mints a uid (TXN_, ECDD_, SMR_, GFS_, RFI_, DISM_,
// NOTIFY_). The suffix is what makes two cases created in the same millisecond
// safe against the unique index: its first three digits rotate through a
// process-local counter (so a batch minted in one process can never collide
// with itself, docs/74 C27), the last three are random (so two processes
// minting in the same millisecond almost never collide either — and the unique
// index rejects the residual case).
let uidSeq = Math.floor(Math.random() * 1000);
CaseSchema.pre('save', function (next) {
    if (this.isNew && !this.uid) {
        uidSeq = (uidSeq + 1) % 1000;
        const seq = String(uidSeq).padStart(3, '0');
        const rand = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
        this.uid = `CA-${Date.now()}-${seq}${rand}`;
    }
    next();
});

// Auto-set closedAt when status transitions to closed
CaseSchema.pre('save', function (next) {
    if (this.isModified('status') && this.status === 'closed' && !this.closedAt) {
        this.closedAt = new Date();
    }
    next();
});

CaseSchema.plugin(uniqueValidator,  { message: '{PATH} must be unique.' });
CaseSchema.plugin(mongoosePaginate);

// External POI encryption (utils/poiCrypto): encrypt on every save; decrypt
// only lean reads, which are output and never saved back.
CaseSchema.pre('save', function (next) {
    try {
        (this.externalPois || []).forEach(encryptPoiDoc);
        next();
    } catch (err) {
        next(err);
    }
});

function decryptLeanPois(result) {
    if (result && this.mongooseOptions().lean) decryptCasePoisLean(result);
}
CaseSchema.post('find', decryptLeanPois);
CaseSchema.post('findOne', decryptLeanPois);
CaseSchema.post('findOneAndUpdate', decryptLeanPois);

// ─────────────────────────────────────────────────────────────────────────────

module.exports = mongoose.model('Case', CaseSchema);
module.exports.POI_ROLES = POI_ROLES;
module.exports.POI_PARTY_SLOTS = POI_PARTY_SLOTS;
