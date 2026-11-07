// seeds/tmTransactions/context.js
//
// Shared generation context: the clock (Asia/Dhaka days — the window the
// monitoring service scans), counterparty builders and the one function that
// turns a short spec into a complete Transaction document.

const { Types } = require("mongoose");
const { round2 } = require("./random");
const {
  SOURCE,
  MARK,
  HOME,
  FX_TO_AUD,
  DOMESTIC_BANKS,
  MFS_PROVIDERS,
  FOREIGN_BANKS,
  FOREIGN_PERSONS,
  GIVEN_NAMES,
  SURNAMES,
  DOMESTIC_BUSINESSES,
  SHELL_COMPANIES,
  BILLERS,
  MERCHANTS,
  BROKERAGES,
} = require("./reference");

const DAY_MS = 86400e3;
const HOUR_MS = 3600e3;
const MIN_MS = 60e3;

// ── Clock ────────────────────────────────────────────────────────────────────
// The service's run window is one Asia/Dhaka calendar day (18:00Z → 18:00Z),
// so days are cut on Dhaka midnight, not UTC midnight.

const dhakaDate = (ms) => new Date(ms + HOME.utcOffsetMs).toISOString().slice(0, 10);
const dayStartUtc = (dateStr) => Date.parse(`${dateStr}T00:00:00+06:00`);
const dhakaHour = (ms) => new Date(ms + HOME.utcOffsetMs).getUTCHours();
/** 0 = Sunday … 6 = Saturday, in Dhaka. */
const dhakaWeekday = (ms) => new Date(ms + HOME.utcOffsetMs).getUTCDay();

// Relative activity by local hour. Branch counters keep banking hours.
const HOUR_WEIGHTS = {
  general: [1, 0.5, 0.3, 0.2, 0.2, 0.4, 1, 2, 4, 7, 9, 10, 10, 9, 9, 9, 8, 8, 8, 7, 6, 5, 3, 2],
  branch: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 10, 10, 7, 9, 8, 0, 0, 0, 0, 0, 0, 0, 0],
};

function createContext({ rng, stamp, clientId, branchId, authorId, institution, now }) {
  let uidCounter = 0;
  const uid = (prefix) => `${prefix}_${MARK}_${stamp}_${++uidCounter}`;

  let incidentCounter = 0;
  const incident = (typology) => `${typology}-${++incidentCounter}`;

  const profilesById = new Map();

  // ── Names ──────────────────────────────────────────────────────────────────
  const personName = () => `${rng.pick(GIVEN_NAMES)} ${rng.pick(SURNAMES)}`;
  const accountNo = () => rng.digits(13);
  const walletNo = () => `01${rng.pick(["3", "5", "6", "7", "8", "9"])}${rng.digits(8)}`;
  const iban = (country) => `${country.slice(0, 2).toUpperCase()}${rng.digits(20)}`;

  // ── Counterparties ─────────────────────────────────────────────────────────
  const home = { institution, institutionCountry: HOME.country, bic: HOME.bic };

  /** A customer of this institution, as a transaction party. */
  const internal = (profile) => ({ ...profile.party });

  const domesticBank = () => {
    const bank = rng.pick(DOMESTIC_BANKS);
    return { institution: bank.institution, institutionCountry: HOME.country, bic: bank.bic };
  };

  const domesticPerson = (name = personName()) => ({ name, account: accountNo(), ...domesticBank() });

  const domesticBusiness = (name = rng.pick(DOMESTIC_BUSINESSES)) => ({ name, account: accountNo(), ...domesticBank() });

  const wallet = (name = personName()) => ({
    name,
    account: walletNo(),
    institution: rng.pick(MFS_PROVIDERS),
    institutionCountry: HOME.country,
  });

  /**
   * A counterparty abroad. `kind` is "person" (name drawn from the corridor's
   * pool) or "company" (a shell-style trading name) unless `name` is given.
   */
  const foreign = (corridor, { kind = "company", name } = {}) => {
    const bank = rng.pick(FOREIGN_BANKS[corridor]);
    const pool = FOREIGN_PERSONS[corridor] || FOREIGN_PERSONS.west;
    const party = {
      name: name || (kind === "person" ? rng.pick(pool) : rng.pick(SHELL_COMPANIES)),
      account: iban(bank.country),
      institution: bank.institution,
      institutionCountry: bank.country,
    };
    if (bank.bic) party.bic = bank.bic;
    return { party, bank };
  };

  // Shared, stable counterparties for ordinary traffic.
  const fixedParties = (names) =>
    names.map((name, i) => {
      const bank = DOMESTIC_BANKS[i % DOMESTIC_BANKS.length];
      return { name, account: accountNo(), institution: bank.institution, institutionCountry: HOME.country, bic: bank.bic };
    });
  const billers = fixedParties(BILLERS);
  const merchants = fixedParties(MERCHANTS);
  const brokerages = fixedParties(BROKERAGES);
  const employers = fixedParties(DOMESTIC_BUSINESSES);

  // ── The day being generated ────────────────────────────────────────────────
  // `end` is exclusive and never in the future: today's window stops just
  // short of "now", so the seed never writes a transaction that has not
  // happened yet.
  const day = { date: null, start: 0, end: 0, weekday: 0, dayOfMonth: 1, txns: [] };

  const openDay = (date) => {
    day.date = date;
    day.start = dayStartUtc(date);
    day.end = Math.min(day.start + DAY_MS, now - 2 * MIN_MS);
    day.weekday = dhakaWeekday(day.start);
    day.dayOfMonth = Number(date.slice(8, 10));
    day.txns = [];
    return day.end - day.start > 10 * MIN_MS;
  };

  /** Friday and Saturday are the weekend in Bangladesh. */
  const isWeekend = () => day.weekday === 5 || day.weekday === 6;

  /** A time following the daily activity curve. */
  const timeOnCurve = (curve = "general") => {
    const weights = HOUR_WEIGHTS[curve] || HOUR_WEIGHTS.general;
    const hour = rng.weighted(weights.map((w, h) => [h, w]));
    const at = day.start + hour * HOUR_MS + rng.float() * HOUR_MS;
    return at < day.end ? at : day.start + rng.float() * (day.end - day.start);
  };

  /**
   * Start time for a sequence lasting `spanMs`, between two local hours.
   * Returns null when the sequence cannot finish inside today's window.
   */
  const startFor = (spanMs, fromHour = 0, toHour = 24) => {
    const lo = day.start + fromHour * HOUR_MS;
    const hi = Math.min(day.start + toHour * HOUR_MS, day.end) - spanMs;
    if (hi <= lo) {
      // Fall back to anywhere in the window before giving up.
      const latest = day.end - spanMs;
      return latest > day.start ? day.start + rng.float() * (latest - day.start) : null;
    }
    return lo + rng.float() * (hi - lo);
  };

  // ── Transaction builder ────────────────────────────────────────────────────

  const reference = (at) => {
    const d = new Date(at + HOME.utcOffsetMs).toISOString();
    return `PBL${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}${rng.digits(8)}`;
  };

  const touch = (party, at) => {
    const profile = party && party.customer ? profilesById.get(String(party.customer)) : null;
    if (profile && at > (profile.lastTxnAt || 0)) profile.lastTxnAt = at;
  };

  /**
   * Build one Transaction document and add it to the current day.
   *
   * spec: { at, amount, sender, receiver, [type, subtype, currency, channel,
   *         status, beneficiary, intermediary, purpose, purposeCode, narrative,
   *         reference, crypto, forensic, travelRule, signals, riskScore,
   *         riskFlags, typology, incident, subject, device] }
   *
   * - `receiver` and `beneficiary` mirror each other when only one is given:
   *   the app lists `receiver`, the monitoring service reads `beneficiary`.
   * - `reference: null` leaves the reference out (rule R10 looks for that).
   * - `signals` is [[key, value], …].
   */
  const txn = (spec) => {
    const at = Math.floor(spec.at);
    const sender = spec.sender || {};
    const receiver = spec.receiver || spec.beneficiary || {};
    const beneficiary = spec.beneficiary || spec.receiver || {};
    const currency = spec.currency || HOME.currency;
    const amount = round2(spec.amount);
    const device = spec.device || (spec.subject && spec.subject.device) || {};
    const when = new Date(at);

    const doc = {
      _id: new Types.ObjectId(),
      uid: uid("TXN"),
      client: clientId,
      branch: branchId,
      timestamp: when,
      type: spec.type || "transfer",
      subtype: spec.subtype || "",
      amount,
      currency,
      convertedAmountAUD: round2(amount * (FX_TO_AUD[currency] ?? 1)),
      narrative: spec.narrative || "",
      status: spec.status || "completed",
      channel: spec.channel || "Online",
      sender,
      receiver,
      beneficiary,
      intermediary: spec.intermediary || {},
      purpose: spec.purpose || "",
      riskScore: spec.riskScore || 0,
      riskFlags: spec.riskFlags || [],
      signals: (spec.signals || []).map(([key, value]) => ({ key, value, source: "system", observedAt: when })),
      createdBy: authorId,
      metadata: {
        source: SOURCE,
        seedBatch: stamp,
        // Ground truth for measuring detection: which typology (if any) this
        // transaction belongs to, and which incident groups it with others.
        typology: spec.typology || null,
        incident: spec.incident || null,
        ip: device.ip || null,
        deviceId: device.deviceId || null,
      },
      createdAt: when,
    };

    if (spec.reference !== null) doc.reference = spec.reference || reference(at);
    if (spec.purposeCode) doc.remittancePurposeCode = spec.purposeCode;
    if (spec.crypto) doc.crypto = spec.crypto;
    if (spec.forensic) doc.forensic = spec.forensic;
    if (spec.travelRule) doc.travelRule = spec.travelRule;

    touch(sender, at);
    touch(receiver, at);
    day.txns.push(doc);
    return doc;
  };

  return {
    rng,
    stamp,
    now,
    clientId,
    branchId,
    authorId,
    home,
    uid,
    incident,
    profilesById,
    profiles: [],
    // names + parties
    personName,
    accountNo,
    walletNo,
    internal,
    domesticPerson,
    domesticBusiness,
    wallet,
    foreign,
    billers,
    merchants,
    brokerages,
    employers,
    // clock
    day,
    openDay,
    isWeekend,
    timeOnCurve,
    startFor,
    // output
    txn,
  };
}

module.exports = {
  createContext,
  DAY_MS,
  HOUR_MS,
  MIN_MS,
  dhakaDate,
  dayStartUtc,
  dhakaHour,
  dhakaWeekday,
};
