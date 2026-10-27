// services/reportDrafts.js
//
// Builds a draft ECDD / SMR / GFS / RFI for a case: **facts from our own
// models, prose from the AI service** (docs/74 §4 and §6.3, phase C3).
//
// Every field written here comes from one of three places, and the builders
// below are deliberately explicit about which:
//   • the Case and its Alerts            — identity, linkage, risk, rules
//   • services/caseAnalysis              — totals, counterparties, evidence, POIs
//   • services/aiReports narrative       — prose only, from a fixed whitelist
//
// A draft is saved even when the AI call fails; the numbers are the part a
// filing cannot do without, and `aiMeta.error` records why the prose is absent.

const Case = require('../models/Case');
const Alert = require('../models/Alert');
const Client = require('../models/Client');
const EcddReport = require('../models/EcddReport');
const SMR = require('../models/SmrReport');
const GFS = require('../models/gfsReport');
const RFI = require('../models/Rfi');
const AlertDismissal = require('../models/AlertDismissal');
const { dismissalTypeByCode, GENERIC } = require('../utils/dismissalTypes');
const { analyseCase } = require('./caseAnalysis');
// Required as a module (not destructured) so the AI call can be stubbed in
// tests without reaching the network.
const aiReports = require('./aiReports');
const { idStr } = require('./caseLinking');
const { suspicionReasonsForFlags } = require('../utils/smrFormOptions');
const { MASK } = require('../utils/poiCrypto');
const ErrorResponse = require('../utils/errorResponse');

// A filing lists its transactions; it does not carry a ledger. Beyond this the
// analyst works from the case's Transactions tab.
const MAX_REPORT_TRANSACTIONS = 100;
// RFI response window used for the draft; sending re-stamps the deadlines.
const RFI_RESPONSE_DAYS = 14;

const DAY = 86400e3;

/* ── shared helpers ─────────────────────────────────────────────────────── */

const subjectOf = (analysis) =>
  analysis.pois.find((p) => p.role === 'subject') || analysis.pois[0] || {};

const yesNo = (value) => (value ? 'Yes' : 'No');

/* ── Persons of interest (Case.externalPois) ────────────────────────────── */

const POI_ROLE_LABELS = {
  subject: 'Subject',
  associated_party: 'Associated party',
  counterparty: 'Counterparty',
  beneficiary: 'Beneficiary',
  beneficial_owner: 'Beneficial owner',
  director: 'Director',
  third_party: 'Third party',
  other: 'Other',
};

// The case arrives lean, so its POIs are already decrypted — or masked "***"
// when the drafting user has no decrypt grant. A mask must never be frozen
// into a filing as if it were the person's name; it becomes blank instead.
const clean = (v) => (v == null || v === MASK ? '' : String(v));

/** The case's non-customer POIs, normalised for the report builders. */
function externalPoisOf(caseDoc) {
  return (caseDoc.externalPois || [])
    .map((p) => ({
      poiId: idStr(p._id),
      kind: p.kind || 'individual',
      name: clean(p.name),
      aliases: (p.aliases || []).map(clean).filter(Boolean),
      role: p.role || 'associated_party',
      roleLabel: POI_ROLE_LABELS[p.role] || 'Associated party',
      relationship: clean(p.relationship),
      dateOfBirth: /^\d{4}-\d{2}-\d{2}$/.test(clean(p.dateOfBirth)) ? new Date(p.dateOfBirth) : null,
      nationality: clean(p.nationality),
      occupation: clean(p.occupation),
      idDocument: {
        type: clean(p.idDocument?.type),
        number: clean(p.idDocument?.number),
        country: clean(p.idDocument?.country),
      },
      registrationNumber: clean(p.registrationNumber),
      country: clean(p.country),
      address: clean(p.address),
      email: clean(p.email),
      phone: clean(p.phone),
      account: clean(p.account),
      institution: clean(p.institution),
      institutionCountry: clean(p.institutionCountry),
      bic: clean(p.bic),
      source: p.source || 'manual',
      sourceAlertUid: p.sourceAlertUid || null,
    }))
    .filter((p) => p.name);
}

/**
 * Who the case is about, for the AI prompt: name, role and relationship only.
 * No DOB, ID numbers or accounts — prose does not need them, and the service
 * pseudonymises names before prompting.
 */
function poiContextForAi(caseDoc, analysis) {
  return [
    ...(analysis.pois || []).map((p) => ({
      name: p.name || p.uid || '',
      role: p.role === 'subject' ? 'Subject' : 'Linked customer',
      relationship: '',
      is_customer: true,
    })),
    ...externalPoisOf(caseDoc).map((p) => ({
      name: p.name,
      role: p.roleLabel,
      relationship: p.relationship,
      is_customer: false,
    })),
  ].filter((p) => p.name);
}

/** "Jane Doe (AU)" style one-liners for the ECDD free-text fields. */
const poiOneLiner = (p) => {
  const extra = [p.nationality || p.country, p.registrationNumber].filter(Boolean).join(', ');
  return extra ? `${p.name} (${extra})` : p.name;
};

/** Alert evidence frozen as it stood when the draft was written. */
const alertSnapshots = (alerts) =>
  alerts.map((a) => ({
    alert: a._id,
    uid: a.uid,
    ruleId: a.ruleId,
    ruleName: a.ruleName,
    ruleVersion: a.ruleVersion ?? null,
    caseType: a.caseType,
    riskScore: a.riskScore ?? null,
    riskLabel: a.riskLabel,
    alertOrigin: a.alertOrigin,
    explanation: a.explanation,
    status: a.status,
    triggeredAt: a.createdAt || null,
  }));

/** Withdrawal total for one crypto currency, exact (never AUD-converted). */
const withdrawalsIn = (analysis, code) => analysis.byCurrency.withdrawals?.[code] ?? 0;

/** Client address → the {street, city, state, postcode, country} reports use. */
const reportAddress = (address = {}) => ({
  street: address.street || '',
  city: address.city || '',
  state: address.state || '',
  postcode: address.zipcode || address.postcode || '',
  country: address.country || '',
});

/* ── ECDD (docs/74 §4.1) ────────────────────────────────────────────────── */

function buildEcddFacts({ caseDoc, analysis, user }) {
  const subject = subjectOf(analysis);
  const { totals, window } = analysis;
  const external = externalPoisOf(caseDoc);
  const withRole = (role) => external.filter((p) => p.role === role).map(poiOneLiner).join('; ');
  const others = external.filter((p) => !['beneficial_owner', 'director'].includes(p.role));

  return {
    // who prepared it
    analystName: user?.name || '',
    date: new Date(),

    // subject identity
    userId: subject.uid || '',
    fullName: subject.name || '',
    customerName: subject.name || '',
    onboardingDate: subject.onboardedAt || null,
    accountCreationDate: subject.onboardedAt || null,
    accountPurpose: subject.accountPurpose || '',
    // A declared range ("$1,000 – $5,000 per month") stays text; forcing it to
    // a number would invent precision the customer never gave.
    expectedVolumeText: subject.expectedVolumeText || '',
    registeredAddress: subject.residentialAddress || '',

    // screening flags
    isPEP: yesNo(subject.isPep),
    isSanctioned: yesNo(subject.sanction),
    relatedParty: [
      `${totals.relatedPartyTxnCount} related-party transaction(s) identified`,
      others.length
        ? `other persons of interest: ${others.map((p) => `${p.name} (${[p.roleLabel, p.relationship].filter(Boolean).join(', ')})`).join('; ')}`
        : null,
    ]
      .filter(Boolean)
      .join('; '),

    // Beneficial owners / directors the analyst recorded as POIs.
    beneficialOwner: withRole('beneficial_owner'),
    directors: withRole('director'),

    // Everyone the case is about, as the ECDD's subject list. Identity detail
    // (DOB, ID numbers, accounts) stays on the case, encrypted — the report
    // carries who and why, and the SMR carries the rest when one is filed.
    personsOfInterest: [
      ...analysis.pois.map((p) => ({
        customer: p.customer || null,
        kind: null,
        name: p.name || p.uid || '',
        role: p.role === 'subject' ? 'Subject' : 'Linked customer',
        relationship: '',
        nationality: '',
        country: p.country || '',
        source: 'customer',
      })),
      ...external.map((p) => ({
        poi: p.poiId,
        kind: p.kind,
        name: p.name,
        role: p.roleLabel,
        relationship: p.relationship,
        nationality: p.nationality,
        country: p.country,
        source: p.source,
      })),
    ],

    // review window + totals
    analysisStartDate: window.start,
    analysisEndDate: window.end,
    totalDepositsAUD: totals.depositsAUD,
    totalWithdrawalsAUD: totals.withdrawalsAUD,
    totalWithdrawalsUSDT: withdrawalsIn(analysis, 'USDT'),
    totalWithdrawalsETH: withdrawalsIn(analysis, 'ETH'),
    totalWithdrawalsBTC: withdrawalsIn(analysis, 'BTC'),

    // deterministic restatements of the numbers above
    depositDetails: analysis.narrativeFacts.depositDetails,
    withdrawalDetails: analysis.narrativeFacts.withdrawalDetails,
    additionalInfo: analysis.narrativeFacts.additionalInfo,

    // behavioural evidence
    ipLocations: analysis.ipAddresses.length,
    ipAddresses: analysis.ipAddresses.map((ip) => ({
      ip: ip.ip,
      location: ip.country || null,
      count: (ip.transactionCount || 0) + (ip.deviceCount || 0),
    })),

    // risk as the CASE derived it from its alerts — not the AI's own score
    riskScore: caseDoc.riskScore ?? null,
    riskLabel: caseDoc.riskLabel ?? null,

    analysisSnapshot: analysis,
  };
}

/* ── SMR (docs/74 §4.2) ─────────────────────────────────────────────────── */

const MAX_SMR_OTHER_PARTIES = 20;

/** AUSTRAC SMR Part D rows for everyone on the case but the Part C subject. */
function smrOtherParties(analysis, external, subject) {
  const linkedCustomers = analysis.pois
    .filter((p) => String(p.customer) !== String(subject.customer))
    .map((p) => ({
      name: p.name || p.uid || '',
      personDetails: { dateOfBirth: p.dateOfBirth || null, nationality: p.country || '' },
      businessAddress: reportAddress(p.residentialAddressParts),
      phoneNumbers: [p.phone].filter(Boolean),
      emails: [p.email].filter(Boolean),
      occupation: p.occupation || '',
      identityVerification: {
        documents: p.identificationNumber ? [{ number: p.identificationNumber, country: p.country || '' }] : [],
      },
      isCustomer: true,
    }));

  const recorded = external.map((p) => ({
    name: p.name,
    otherNames: p.aliases,
    personDetails:
      p.kind === 'individual' ? { dateOfBirth: p.dateOfBirth, nationality: p.nationality } : undefined,
    businessAddress: { street: p.address, country: p.country || p.institutionCountry },
    phoneNumbers: [p.phone].filter(Boolean),
    emails: [p.email].filter(Boolean),
    accounts: p.account
      ? [{ number: p.account, institution: p.institution, country: p.institutionCountry, bic: p.bic }]
      : [],
    occupation: p.occupation,
    identityVerification: {
      documents: p.idDocument.number
        ? [{ type: p.idDocument.type, number: p.idDocument.number, country: p.idDocument.country }]
        : [],
    },
    documentation: [
      p.roleLabel,
      p.relationship,
      p.registrationNumber && `Registration ${p.registrationNumber}`,
      p.source === 'alert' && p.sourceAlertUid && `identified from alert ${p.sourceAlertUid}`,
    ]
      .filter(Boolean)
      .join('; '),
    isCustomer: false,
  }));

  // A counterparty the analyst already recorded as a POI is that POI.
  const recordedAccounts = new Set(external.map((p) => p.account).filter(Boolean));
  const counterparties = analysis.counterparties
    .filter((c) => !c.customer && !(c.account && recordedAccounts.has(c.account)))
    .map((c) => ({
      name: c.name || c.account || '',
      businessAddress: { country: c.institutionCountry || '' },
      accounts: c.account ? [{ number: c.account, institution: c.institution || '' }] : [],
      isCustomer: false,
    }));

  // Named people first: they are why the matter is suspicious. Plain
  // counterparties fill whatever room is left.
  const otherParties = [...linkedCustomers, ...recorded, ...counterparties].slice(0, MAX_SMR_OTHER_PARTIES);
  return { hasOtherParties: otherParties.length > 0, otherParties };
}

function buildSmrFacts({ caseDoc, analysis, alerts, client, user, previousReports }) {
  const subject = subjectOf(analysis);
  const flags = Object.keys(analysis.riskFlags || {});

  return {
    partA: {
      // Which designated services apply is a reporting-entity decision.
      designatedServices: [],
      serviceStatus: 'provided',
      suspicionReasons: suspicionReasonsForFlags(flags),
      otherReasons: [],
      suspiciousIndicators: {
        pep: !!subject.isPep,
        sanctions: !!subject.sanction,
        adverseMedia: (subject.amlRiskLabels || []).includes('adverseMedia'),
        structuringCandidates: analysis.structuring.candidates,
        relatedPartyTransactions: analysis.totals.relatedPartyTxnCount,
        highRiskJurisdictions: analysis.jurisdictions.filter((j) => j.highRisk).map((j) => j.code),
        rulesTriggered: analysis.rulesTriggered.map((r) => r.ruleName).filter(Boolean),
      },
    },

    partC: {
      personOrganisation: {
        name: subject.name || '',
        personDetails: {
          dateOfBirth: subject.dateOfBirth || null,
          nationality: subject.country || '',
        },
        businessAddress: reportAddress(subject.residentialAddressParts),
        phoneNumbers: [subject.phone].filter(Boolean),
        emails: [subject.email].filter(Boolean),
        occupation: subject.occupation || '',
        identityVerification: {
          documents: subject.identificationNumber
            ? [{ number: subject.identificationNumber, country: subject.country || '' }]
            : [],
        },
        isCustomer: true,
      },
    },

    // Everyone else: the case's other customers, the POIs the analyst recorded
    // (with their full identity detail) and the remaining counterparties.
    partD: smrOtherParties(analysis, externalPoisOf(caseDoc), subject),

    partF: {
      transactions: analysis.transactions.slice(0, MAX_REPORT_TRANSACTIONS).map((t) => {
        const counterpartyName = t.counterparty?.name || '';
        const outbound = t.direction === 'out';
        return {
          date: t.date,
          type: t.type,
          completed: t.status === 'completed',
          referenceNumber: t.uid || t.reference || '',
          totalAmount: { currencyCode: t.currency, amount: t.amount },
          // Only a cash leg carries a cash amount.
          cashAmount:
            t.subtype === 'cash' ? { currencyCode: t.currency, amount: t.amount } : undefined,
          sender: { name: outbound ? subject.name || '' : counterpartyName },
          payee: { name: outbound ? counterpartyName : subject.name || '' },
          beneficiary: { name: outbound ? counterpartyName : subject.name || '' },
        };
      }),
    },

    partG: {
      // The offence is the analyst's legal characterisation, not ours.
      likelyOffence: [],
      previousReports,
      otherGovernmentBodies: [],
      attachments: [],
    },

    partH: {
      reportingEntity: {
        name: client?.name || '',
        address: reportAddress(client?.address),
        internalReference: caseDoc.uid || String(caseDoc._id),
        completedBy: { name: user?.name || '', email: user?.email || '' },
      },
    },

    alerts: alertSnapshots(alerts),
  };
}

/* ── GFS (docs/74 §4.3) ─────────────────────────────────────────────────── */

function gfsPois(caseDoc, analysis) {
  const external = externalPoisOf(caseDoc);
  const byAccount = new Map(external.filter((p) => p.account).map((p) => [p.account, p]));
  const matched = new Set();

  const counterparties = analysis.counterparties.map((c) => {
    const ext = c.account ? byAccount.get(c.account) : null;
    if (ext) matched.add(ext.poiId);
    return {
      name: (ext && ext.name) || c.name || '',
      relationship: ext ? ext.roleLabel : 'Counterparty',
      country: c.institutionCountry || '',
      institution: c.institution || '',
      account: c.account || '',
      transactionCount: c.transactionCount,
      totalAmountAUD: c.totalAmountAUD,
    };
  });

  return [
    ...analysis.pois.map((p) => ({
      customer: p.customer,
      name: p.name || p.uid || '',
      relationship: p.role === 'subject' ? 'Subject' : 'Linked customer',
      country: p.country || '',
    })),
    ...counterparties,
    ...external
      .filter((p) => !matched.has(p.poiId))
      .map((p) => ({
        id: p.poiId,
        name: p.name,
        relationship: p.roleLabel,
        country: p.country || p.nationality || p.institutionCountry || '',
        institution: p.institution || '',
        account: p.account || '',
      })),
  ];
}

function buildGfsFacts({ caseDoc, analysis, linkedToSMR }) {
  const subject = subjectOf(analysis);
  const { totals, window } = analysis;

  return {
    customerName: subject.name || '',
    customerUID: subject.uid || '',
    customerCountry: subject.country || '',
    customerType: subject.customerType || '',
    occupation: subject.occupation || '',
    kycStatus: subject.kycStatus || '',
    amlRiskLabels: subject.amlRiskLabels || [],
    pepFlag: !!subject.isPep,
    sanctionsFlag: !!subject.sanction,
    adverseMediaFlag: (subject.amlRiskLabels || []).includes('adverseMedia'),
    expectedTradingVolume: subject.expectedVolumeText || '',
    residentialAddress: subject.residentialAddress || '',
    accountOpeningDate: subject.onboardedAt || null,
    sourceOfFunds: subject.sourceOfFunds || '',
    sourceOfWealth: subject.sourceOfWealth || '',
    accountOpeningPurpose: subject.accountPurpose || '',

    reviewStartDate: window.start,
    reviewEndDate: window.end,
    totalDeposited: totals.depositsAUD,
    totalWithdrawn: totals.withdrawalsAUD,
    // What the case is actually about: the value that moved, in AUD terms.
    totalSuspicionAmount: totals.volumeAUD,
    netFlowAUD: totals.netFlowAUD,
    passThroughRatio: analysis.ratios.passThrough,
    peakDailyVolumeAUD: totals.peakDailyVolumeAUD,
    activeDays: totals.activeDays,
    transactionCount: totals.transactionCount,
    structuringCandidates: analysis.structuring.candidates,
    unconvertedCount: totals.unconvertedCount,
    jurisdictionsInvolved: analysis.jurisdictions.map((j) => j.code),
    riskFlags: Object.keys(analysis.riskFlags || {}),

    transactions: analysis.transactions.slice(0, MAX_REPORT_TRANSACTIONS).map((t) => ({
      transaction: t.transactionId,
      uid: t.uid,
      date: t.date,
      type: t.type,
      subtype: t.subtype,
      amount: t.amount,
      currency: t.currency,
      amountAUD: t.amountAUD,
      status: t.status,
      channel: t.channel,
      direction: t.direction,
      counterparty: t.counterparty?.name || '',
      counterpartyCountry: t.counterparty?.country || '',
      purpose: t.purpose || '',
      riskFlags: t.riskFlags || [],
      relatedParty: t.relatedParty,
      reference: t.reference || '',
      cryptoAddress: t.cryptoAddress || '',
    })),

    ofis: analysis.institutions.map((i) => ({
      name: i.name,
      country: i.country,
      bic: i.bic,
      transactionCount: i.transactionCount,
    })),

    // POIs = the case's own customers, the counterparties they dealt with, and
    // the non-customer POIs an analyst recorded (Case.externalPois). An
    // external POI with a counterparty's account IS that counterparty — it
    // lends its name and role to the row rather than appearing twice.
    pois: gfsPois(caseDoc, analysis),

    cryptoAddresses: [...new Set(analysis.cryptoAddresses.map((c) => c.address).filter(Boolean))],
    cryptoLegs: analysis.cryptoAddresses,

    ipAddresses: analysis.ipAddresses.map((ip) => ({
      address: ip.ip,
      country: ip.country || '',
      count: (ip.transactionCount || 0) + (ip.deviceCount || 0),
    })),

    linkedToSMR,
    riskScore: caseDoc.riskScore ?? null,
    riskLabel: caseDoc.riskLabel ?? null,
  };
}

/* ── RFI (docs/74 §4.4) ─────────────────────────────────────────────────── */

function buildRfiFacts({ analysis, client, tippingOff }) {
  const subject = subjectOf(analysis);
  const now = Date.now();

  return {
    // First name only — the letter opens "Dear <name>".
    primaryContactName: (subject.name || '').split(' ')[0] || subject.name || '',
    replyToEmail: client?.email || process.env.FROM_EMAIL || '',
    responseDeadline: new Date(now + RFI_RESPONSE_DAYS * DAY),
    followupDeadline: new Date(now + RFI_RESPONSE_DAYS * 2 * DAY),
    finalDeadline: new Date(now + RFI_RESPONSE_DAYS * 3 * DAY),
    // Our own tipping-off control, not the AI's hint.
    tippingOffWarning: tippingOff.warning,
    deliveryBlocked: tippingOff.blocked,
    deliveryBlockReason: tippingOff.reason,
    status: 'Draft',
  };
}

/* ── Dismissal (docs/74 §4.5) ───────────────────────────────────────────── */

/**
 * The evidence considered, and OUR view of whether dismissing is safe.
 *
 * `requiresEscalation` is decided here, not by the AI: a dismissal is a
 * decision to stop looking, so the conditions that should stop it are ours to
 * state. The AI's own opinion informs the prose only.
 */
function buildDismissalFacts({ caseDoc, analysis, alerts, alert, dismissalType, liveSmr, user }) {
  const subject = subjectOf(analysis);
  const template = dismissalTypeByCode(dismissalType);

  const blockingConditions = [];
  if (subject.kycStatus && subject.kycStatus !== 'verified') {
    blockingConditions.push(`KYC status is '${subject.kycStatus}', not verified.`);
  }
  if (subject.sanction) blockingConditions.push('Customer is a sanctions match.');
  if (liveSmr) {
    blockingConditions.push(`SMR ${liveSmr.uid} is ${liveSmr.status} on this case.`);
  }
  if (analysis.jurisdictions.some((j) => j.highRisk)) {
    blockingConditions.push(
      `Activity touches a high-risk jurisdiction (${analysis.jurisdictions
        .filter((j) => j.highRisk)
        .map((j) => j.code)
        .join(', ')}).`
    );
  }

  return {
    alert: alert._id,
    dismissalType: dismissalType || GENERIC,
    templateKey: template?.templateKey || null,
    // The AI supplies its own title/category; the template's are the fallback.
    title: template?.title || '',
    category: template?.group || '',

    evidenceReviewed: {
      alertsReviewed: alerts.length,
      transactionsReviewed: analysis.totals.transactionCount,
      totalInflowAUD: analysis.totals.depositsAUD,
      totalOutflowAUD: analysis.totals.withdrawalsAUD,
      unconvertedCount: analysis.totals.unconvertedCount,
      jurisdictions: analysis.jurisdictions.map((j) => j.code),
      counterpartiesReviewed: analysis.counterparties.length,
      riskFlags: Object.keys(analysis.riskFlags || {}),
      rulesTriggered: analysis.rulesTriggered.map((r) => r.ruleName).filter(Boolean),
      reviewPeriod: { start: analysis.window.start, end: analysis.window.end },
      analystNotes: [],
    },

    requiresEscalation: blockingConditions.length > 0,
    blockingConditions,
    closedBy: user?._id || null,
    status: 'draft',
  };
}

/** Write `value` at a dotted `path` inside a plain payload object. */
function setPath(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  let node = obj;
  for (const p of parts) {
    if (!node[p] || typeof node[p] !== 'object') node[p] = {};
    node = node[p];
  }
  node[last] = value;
}

/* ── narrative application ──────────────────────────────────────────────── */

/**
 * Merge the AI prose into a payload, respecting analyst edits.
 * Returns the keys actually applied so `aiMeta.sectionsUsed` stays honest.
 */
function applyNarrative(type, payload, narrative, editedFields = []) {
  const applied = [];
  // `path` is the key as `editedFields` records it — the storage path for a
  // nested field (SMR 'partB.groundsForSuspicion'), the key itself otherwise.
  const take = (key, path = key) => {
    if (narrative[key] === undefined) return undefined;
    if (editedFields.includes(path)) return undefined; // analyst owns it now
    applied.push(path);
    return narrative[key];
  };

  if (type === 'ecdd') {
    for (const key of [
      'profileSummary', 'transactionAnalysis', 'behavioralAnalysis', 'recommendation',
      'recommendationType', 'decisionRationale', 'immediateActions', 'keyIndicators', 'typologies',
    ]) {
      const value = take(key);
      if (value !== undefined) payload[key] = value;
    }
  }

  if (type === 'smr') {
    payload.partB = payload.partB || {};
    const grounds = take('groundsForSuspicion', 'partB.groundsForSuspicion');
    if (grounds !== undefined) payload.partB.groundsForSuspicion = grounds;
    const list = take('groundsList', 'partB.groundsList');
    if (list !== undefined) payload.partB.groundsList = list;
    const notes = take('investigationNotes', 'partB.investigationNotes');
    if (notes !== undefined) payload.partB.investigationNotes = notes;
  }

  if (type === 'gfs') {
    const summary = take('suspicionSummary');
    if (summary !== undefined) {
      payload.suspicionSummary = summary;
      // The legacy single-line field the existing form and PDF read.
      if (!payload.suspicionReason) payload.suspicionReason = summary;
    }
    const change = take('behavioralChangeDescription');
    if (change !== undefined) payload.behavioralChangeDescription = change;
  }

  if (type === 'rfi') {
    const items = take('requestedItems');
    if (items !== undefined) payload.requestedItems = items.map((text) => ({ text }));
    for (const key of ['itemsRationale', 'draftSubject', 'draftBody']) {
      const value = take(key);
      if (value !== undefined) payload[key] = value;
    }
  }

  if (type === 'dismissal') {
    for (const key of ['title', 'category', 'intro', 'profile', 'transactionAnalysis', 'additionalInfo', 'conclusion']) {
      const value = take(key);
      // Title and category have a template fallback already in the payload —
      // only let the AI's version win when it actually sent one.
      if (value !== undefined) payload[key] = value;
    }
  }

  return applied;
}

/* ── model registry ─────────────────────────────────────────────────────── */

// `perAlert` types are scoped to one alert rather than to the case, so a case
// with several alerts can hold several of them — one per alert.
const REGISTRY = {
  ecdd: { Model: EcddReport, hubField: 'caseId', label: 'ECDD' },
  smr: { Model: SMR, hubField: 'caseId', label: 'SMR' },
  gfs: { Model: GFS, hubField: 'case', label: 'GFS' },
  rfi: { Model: RFI, hubField: 'case', label: 'RFI' },
  dismissal: { Model: AlertDismissal, hubField: 'case', label: 'Dismissal', perAlert: true },
};

const SUPPORTED_TYPES = Object.keys(REGISTRY);

/* ── entry point ────────────────────────────────────────────────────────── */

/**
 * Draft (or re-draft) one report for a case.
 *
 * @param {Object}  opts
 * @param {Object}  opts.caseDoc     lean Case
 * @param {string}  opts.type        ecdd | smr | gfs | rfi
 * @param {string}  [opts.alertId]   narrow the AI narrative to one alert
 * @param {boolean} [opts.regenerate] refresh an existing draft in place
 * @param {Object}  opts.user        req.user
 * @returns {Promise<{report: Object, created: boolean, regenerated: boolean, analysis: Object}>}
 */
async function draftReport({ caseDoc, type, alertId, dismissalType, regenerate = false, user }) {
  const entry = REGISTRY[type];
  const { Model, hubField, perAlert } = entry;

  // Case-scoped types have one draft per case; alert-scoped types have one per
  // alert, so the same case can hold a dismissal for each of its alerts.
  const scope = perAlert ? { alert: alertId } : { [hubField]: caseDoc._id };

  // An existing draft is returned untouched unless the caller asks for a rebuild
  // — regenerating silently would discard whatever the analyst had written.
  const existing = await Model.findOne(scope).sort({ createdAt: -1 });
  if (existing && !regenerate) {
    return { report: existing.toObject(), created: false, regenerated: false, analysis: null };
  }

  // 1. Facts. Reuse the cached snapshot when the case has one that is current.
  const cached = caseDoc.analysis || {};
  const analysis =
    cached.snapshot && cached.computedAt && new Date(cached.computedAt) >= new Date(caseDoc.updatedAt)
      ? cached.snapshot
      : await analyseCase(caseDoc);

  const [alerts, client] = await Promise.all([
    Alert.find({ _id: { $in: caseDoc.linkedAlerts || [] }, isDeleted: { $ne: true } })
      .select('uid ruleId ruleName ruleVersion caseType riskScore riskLabel status alertOrigin explanation createdAt customer')
      .lean(),
    caseDoc.client ? Client.findById(caseDoc.client).select('name email address registrationNumber clientType').lean() : null,
  ]);

  // 2. Prose. Never throws — a failure leaves the narrative empty.
  //
  // The tenant goes with the request and our own counts go with it: the service
  // does not scope its reads by client, so comparing what it saw against what
  // this client's case actually holds is how a cross-tenant narrative is caught
  // (docs/74 C15).
  const { narrative, meta } = await aiReports.draftNarrative(type, {
    caseId: caseDoc._id,
    alertId,
    dismissalType,
    client: caseDoc.client || null,
    branch: caseDoc.branch || null,
    requestedBy: user?._id || null,
    personsOfInterest: poiContextForAi(caseDoc, analysis),
    expected: {
      transactions: analysis.totals.transactionCount,
      alerts: alerts.length,
      // How many of this case's POIs another reporting entity also holds. Above
      // zero explains a wider read rather than leaving it a mystery.
      sharedCustomers: analysis.tenancy?.poisSharedWithOtherClients ?? 0,
    },
  });

  // 3. Type-specific facts.
  let payload;
  if (type === 'ecdd') {
    payload = buildEcddFacts({ caseDoc, analysis, user });
  } else if (type === 'smr') {
    const previousReports = await SMR.find({
      customer: caseDoc.customer,
      status: 'approved',
      caseId: { $ne: caseDoc._id },
    })
      .select('uid createdAt metadata.austracReference')
      .lean();
    payload = buildSmrFacts({
      caseDoc, analysis, alerts, client, user,
      previousReports: previousReports.map((r) => ({
        date: r.createdAt,
        referenceNumber: r.metadata?.austracReference || r.uid,
      })),
    });
  } else if (type === 'gfs') {
    const linkedToSMR = !!(await SMR.exists({ caseId: caseDoc._id }));
    payload = buildGfsFacts({ caseDoc, analysis, linkedToSMR });
  } else if (type === 'dismissal') {
    const alert = alerts.find((a) => String(a._id) === String(alertId));
    // A live SMR is a blocking condition for closing an alert as unremarkable.
    const liveSmr = await SMR.findOne({
      caseId: caseDoc._id,
      status: { $in: ['review', 'approved'] },
    })
      .select('uid status')
      .lean();
    payload = buildDismissalFacts({ caseDoc, analysis, alerts, alert, dismissalType, liveSmr, user });
  } else {
    // An RFI can tip off a customer who is the subject of a suspicious matter
    // report (AML/CTF Act s123), so a live SMR blocks delivery.
    const liveSmr = await SMR.findOne({
      caseId: caseDoc._id,
      status: { $in: ['review', 'approved'] },
    })
      .select('uid status')
      .lean();
    payload = buildRfiFacts({
      analysis,
      client,
      tippingOff: liveSmr
        ? {
            warning: true,
            blocked: true,
            reason: `SMR ${liveSmr.uid} is ${liveSmr.status} on this case — sending may tip off the subject.`,
          }
        : { warning: false, blocked: false, reason: '' },
    });
  }

  // 4. Linkage, evidence and provenance are the same for every type.
  const subject = subjectOf(analysis);
  Object.assign(payload, {
    [hubField]: caseDoc._id,
    caseNumber: caseDoc.uid || null,
    client: caseDoc.client || null,
    branch: caseDoc.branch || null,
    customer: caseDoc.customer || subject.customer || null,
    alert: alertId || alerts[0]?._id || null,
    analysisComputedAt: analysis.computedAt || null,
  });
  // A dismissal freezes only the alert it closes; the others freeze the set.
  payload.alerts = alertSnapshots(
    type === 'dismissal' ? alerts.filter((a) => String(a._id) === String(alertId)) : alerts
  );

  // 5. Prose, honouring anything the analyst has rewritten.
  const editedFields = existing?.editedFields || [];
  const applied = applyNarrative(type, payload, narrative, editedFields);
  payload.aiMeta = { ...meta, sectionsUsed: applied, sectionsRejected: meta.sectionsRejected || [] };

  // 6. Persist.
  if (existing) {
    // Anything the analyst edited is theirs — facts included, not only prose
    // (applyNarrative already skipped edited prose). A dotted path cannot be
    // deleted from the payload — `set()` may replace its whole subdocument
    // (partH.reportingEntity) — so the analyst's stored value is carried into
    // the payload instead.
    for (const key of editedFields) {
      if (key.includes('.')) setPath(payload, key, existing.get(key));
      else delete payload[key];
    }
    existing.set(payload);
    await existing.save();
    return { report: existing.toObject(), created: false, regenerated: true, analysis };
  }

  if (type === 'ecdd') payload.generatedBy = user?._id || null;
  if (type === 'rfi') payload.sentBy = null;
  const report = await Model.create(payload);
  return { report: report.toObject(), created: true, regenerated: false, analysis };
}

/* ── analyst editing (Investigation Hub narrative step) ─────────────────── */

// What an analyst may change on a draft from the case, per type. Linkage,
// evidence snapshots and provenance are never writable this way.
const EDITABLE_FIELDS = {
  ecdd: [
    // 1. Analysis & review
    'analystName', 'position', 'date',
    // 2. Customer profile
    'userId', 'fullName', 'customerName', 'abn', 'onboardingDate', 'accountPurpose',
    'expectedVolumeText', 'annualIncome', 'beneficialOwner', 'directors', 'profileSummary',
    // 3. Risk flags
    'isPEP', 'isSanctioned', 'relatedParty',
    // 4. Transaction analysis
    'accountCreationDate', 'analysisStartDate', 'analysisEndDate', 'totalDepositsAUD',
    'totalWithdrawalsAUD', 'totalWithdrawalsUSDT', 'totalWithdrawalsETH', 'totalWithdrawalsBTC',
    'depositDetails', 'withdrawalDetails', 'transactionAnalysis', 'additionalInfo',
    // 5. Behavioural analysis
    'ipLocations', 'registeredAddress', 'behavioralAnalysis',
    // 6. Recommendation
    'recommendation', 'recommendationType', 'decisionRationale',
    'immediateActions', 'keyIndicators', 'typologies',
  ],
  gfs: [
    // 1. Suspicion
    'suspicionType', 'suspicionReason', 'suspicionDates', 'suspicionIntensity',
    'suspicionBehaviour', 'suspicionSummary',
    // 2. Customer profile
    'customerName', 'customerUID', 'companyName', 'customerAge', 'accountOpeningDate',
    'occupation', 'customerCountry', 'residentialAddress', 'expectedTradingVolume',
    'sourceOfFunds', 'sourceOfWealth', 'accountOpeningPurpose',
    // 3. Review period & totals
    'reviewStartDate', 'reviewEndDate', 'totalDeposited', 'totalWithdrawn',
    'totalSuspicionAmount',
    // 4. Behaviour & notes — `behavioralChange` (the boolean) stays derived (§4.3)
    'behavioralChangeDescription', 'additionalNotes',
  ],
  // Dotted paths: the hub edits leaves of the AUSTRAC parts. The evidence
  // parts (C subject, D other parties, F transactions, `suspiciousIndicators`)
  // and `previousReports` are computed by us and stay API-owned (§4.2).
  smr: [
    // Part A — the reporting entity's own characterisation of the matter
    'partA.designatedServices', 'partA.serviceStatus',
    'partA.suspicionReasons', 'partA.otherReasons',
    // Part B — the narrative
    'partB.groundsForSuspicion', 'partB.groundsList', 'partB.investigationNotes',
    // Parts D/E — the yes/no gates are the analyst's answer
    'partD.hasOtherParties', 'partE.hasUnidentifiedPersons',
    // Part G — the analyst's legal characterisation
    'partG.likelyOffence',
    // Part H — who completed the report
    'partH.reportingEntity.internalReference',
    'partH.reportingEntity.completedBy.name', 'partH.reportingEntity.completedBy.jobTitle',
    'partH.reportingEntity.completedBy.phone', 'partH.reportingEntity.completedBy.email',
  ],
};

const sameValue = (a, b) => {
  const norm = (v) => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

/**
 * Fields in `patch` that actually change `doc` — a form that re-sends every
 * value must not mark every field as analyst-owned.
 */
function changedKeys(doc, patch, allowed) {
  return Object.keys(patch).filter((k) => {
    if (!allowed.includes(k)) return false;
    const current = doc.get ? doc.get(k) : doc[k];
    const next = patch[k];
    // Compare dates by their calendar day: the form speaks yyyy-mm-dd.
    if (current instanceof Date && typeof next === 'string') {
      return current.toISOString().slice(0, 10) !== next.slice(0, 10);
    }
    return !sameValue(current, next);
  });
}

/**
 * Save an analyst's edits to the case's draft. Only whitelisted fields are
 * written, and each changed one joins `editedFields` so a later re-draft
 * leaves it alone.
 * @returns {Promise<{report:Object, changed:string[]}>}
 */
async function saveReportEdits({ caseDoc, type, patch = {} }) {
  const allowed = EDITABLE_FIELDS[type];
  if (!allowed) throw new ErrorResponse(`${type} drafts cannot be edited here`, 400);
  const { Model, hubField } = REGISTRY[type];

  const doc = await Model.findOne({ [hubField]: caseDoc._id }).sort({ createdAt: -1 });
  if (!doc) throw new ErrorResponse(`This case has no ${REGISTRY[type].label} draft yet`, 404);

  const unknown = Object.keys(patch).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new ErrorResponse(`Not editable here: ${unknown.join(', ')}`, 400);

  const changed = changedKeys(doc, patch, allowed);
  if (changed.length) {
    for (const k of changed) doc.set(k, patch[k] === '' && doc.schema.path(k)?.instance === 'Date' ? null : patch[k]);
    doc.editedFields = [...new Set([...(doc.editedFields || []), ...changed])];
    await doc.save();
  }
  return { report: doc.toObject(), changed };
}

/**
 * Fresh AI prose for the case — returned, NOT saved. The analyst picks what
 * to keep, so a suggestion can never overwrite their words.
 */
async function suggestNarrative({ caseDoc, type, user }) {
  const cached = caseDoc.analysis || {};
  const analysis =
    cached.snapshot && cached.computedAt && new Date(cached.computedAt) >= new Date(caseDoc.updatedAt)
      ? cached.snapshot
      : await analyseCase(caseDoc);
  const { narrative, meta } = await aiReports.draftNarrative(type, {
    caseId: caseDoc._id,
    client: caseDoc.client || null,
    branch: caseDoc.branch || null,
    requestedBy: user?._id || null,
    personsOfInterest: poiContextForAi(caseDoc, analysis),
    expected: {
      transactions: analysis.totals.transactionCount,
      alerts: (caseDoc.linkedAlerts || []).length,
      sharedCustomers: analysis.tenancy?.poisSharedWithOtherClients ?? 0,
    },
  });
  return { narrative, meta };
}

module.exports = {
  draftReport,
  saveReportEdits,
  suggestNarrative,
  EDITABLE_FIELDS,
  changedKeys,
  SUPPORTED_TYPES,
  REGISTRY,
  // exported for tests
  buildEcddFacts,
  buildSmrFacts,
  buildGfsFacts,
  buildRfiFacts,
  applyNarrative,
};
