// seeds/tmTransactions/customers.js
//
// The customer cohort the transactions are generated for. Each customer gets
// a Customer document, one CustomerAccount, and an in-memory "profile" the
// generators work from (segment, typical amount, activity rate, payees).
//
// Segments set ordinary behaviour; traits are the KYC facts that rules and
// models read (unknown source of funds, risky industry, PEP, age …). Trait
// values use the rule corpus's own constants — see reference.js.

const { Types } = require("mongoose");
const { SOURCE, RELATION_SOURCE, HOME, LOCATIONS, OCCUPATIONS, RISK_INDUSTRIES, SOURCES_OF_FUNDS } = require("./reference");
const { DAY_MS } = require("./context");

// share: fraction of the cohort · rate: transactions per day · median: typical amount (BDT)
const SEGMENTS = {
  retail: { share: 0.52, rate: [0.6, 1.6], median: [1800, 6500], balance: [20000, 600000] },
  sme: { share: 0.2, rate: [2.5, 7], median: [14000, 38000], balance: [300000, 6000000] },
  hnw: { share: 0.06, rate: [1, 2.5], median: [30000, 60000], balance: [2000000, 40000000] },
  student: { share: 0.08, rate: [0.3, 0.7], median: [900, 2500], balance: [2000, 60000] },
  // Accounts with old history and nothing recent — the dormant-reactivation pool.
  dormant: { share: 0.07, rate: [0.25, 0.5], median: [2000, 6000], balance: [500, 40000] },
  // Opened in the last few weeks — the new-account pool (rule R221).
  newAccount: { share: 0.07, rate: [0.6, 1.2], median: [1500, 5000], balance: [1000, 80000] },
};

// Traits a typology needs at least one holder of. Small cohorts (tests, quick
// runs) would otherwise miss some by chance and silently lose that typology.
const REQUIRED_TRAITS = [
  ["unknownSof", () => true],
  ["unclearPurpose", () => true],
  ["unemployed", (p) => ["retail", "dormant", "newAccount"].includes(p.segment)],
  ["riskIndustry", (p) => ["sme", "hnw"].includes(p.segment)],
  ["selfEmployed", (p) => p.segment === "sme" && !p.traits.has("riskIndustry")],
  ["sanctioned", () => true],
  ["minor", (p) => p.segment === "student"],
  ["elderly", (p) => p.segment === "retail"],
];

const between = (rng, [lo, hi]) => lo + rng.float() * (hi - lo);

function assignSegments(rng, count) {
  const out = [];
  for (const [segment, cfg] of Object.entries(SEGMENTS)) {
    const n = Math.round(cfg.share * count);
    for (let i = 0; i < n; i++) out.push(segment);
  }
  while (out.length < count) out.push("retail");
  return rng.shuffle(out.slice(0, count));
}

function assignTraits(rng, p) {
  const { segment, traits } = p;
  if (rng.chance(0.04)) traits.add("unknownSof");
  if (rng.chance(0.025)) traits.add("unclearPurpose");
  if (["retail", "dormant", "newAccount"].includes(segment) && rng.chance(0.05)) traits.add("unemployed");
  if (["sme", "hnw"].includes(segment) && rng.chance(0.25)) traits.add("riskIndustry");
  if (segment === "sme" && !traits.has("riskIndustry") && rng.chance(0.12)) traits.add("selfEmployed");
  if (rng.chance(0.02)) traits.add("pep");
  if (rng.chance(0.012)) traits.add("sanctioned");
  if (!traits.has("sanctioned") && rng.chance(0.04)) traits.add("adverseMedia");
  if (segment === "student" && rng.chance(0.12)) traits.add("minor");
  if (segment === "retail" && rng.chance(0.03)) traits.add("elderly");
}

function ensureTraits(profiles) {
  for (const [trait, eligible] of REQUIRED_TRAITS) {
    if (profiles.some((p) => p.traits.has(trait))) continue;
    const candidate = profiles.find((p) => eligible(p) && p.traits.size === 0) || profiles.find(eligible);
    if (candidate) candidate.traits.add(trait);
  }
}

/** Occupation, industry and declared funds — as a KYC form would hold them. */
function kycFacts(rng, p, turn) {
  const pool = OCCUPATIONS[p.segment] || OCCUPATIONS.retail;
  let [occupation, industry] = rng.pick(pool);
  if (p.segment === "student") [occupation, industry] = ["Student", "Education"];
  if (p.traits.has("unemployed")) [occupation, industry] = ["UNEMPLOYED", "None"];
  if (p.traits.has("selfEmployed")) occupation = "SELF_EMPLOYED";
  // Dealt in turn rather than drawn, so every risk industry has a holder.
  if (p.traits.has("riskIndustry")) industry = RISK_INDUSTRIES[turn.riskIndustry++ % RISK_INDUSTRIES.length];

  const funds = SOURCES_OF_FUNDS[p.segment] || SOURCES_OF_FUNDS.retail;
  return {
    occupation,
    industry,
    sourceOfFunds: p.traits.has("unknownSof") ? "UNKNOWN" : rng.pick(funds),
    sourceOfWealth: p.traits.has("unknownSof") ? "UNKNOWN" : rng.pick(["Employment Income", "Business Profits", "Family Assets", "Savings"]),
    accountPurpose: p.traits.has("unclearPurpose")
      ? "UNCLEAR"
      : { sme: "Business Operations", hnw: "Investment and Savings", student: "Education Expenses" }[p.segment] || "Personal Savings",
    volume: { sme: "BDT 10,00,000 – 50,00,000 per month", hnw: "BDT 50,00,000+ per month" }[p.segment] || "Under BDT 2,00,000 per month",
  };
}

function screening(p) {
  if (p.traits.has("sanctioned")) return { amlStatus: "flagged", labels: ["sanctions"], kycStatus: "in_review" };
  if (p.traits.has("pep")) return { amlStatus: "yellow", labels: ["pep"], kycStatus: "verified" };
  if (p.traits.has("adverseMedia")) return { amlStatus: "yellow", labels: ["adverseMedia"], kycStatus: "verified" };
  return { amlStatus: "clear", labels: [], kycStatus: null };
}

function buildCustomerDoc(ctx, p, facts) {
  const { rng } = ctx;
  const screen = screening(p);
  const kycStatus = screen.kycStatus || rng.weighted([["verified", 86], ["in_review", 7], ["pending", 7]]);
  const registeredAt = new Date(p.openedAt);
  const verifiedAt = new Date(p.openedAt + 2 * DAY_MS);
  const address = {
    address: `House ${rng.int(1, 240)}, Road ${rng.int(1, 40)}, ${p.location.area}`,
    suburb: p.location.area,
    state: p.location.district,
    postcode: p.location.postcode,
    country: HOME.country,
  };

  // Facts with no column of their own travel as typed signals, which the
  // rule evaluator resolves by label ("Sender risk tier" → sender_risk_tier).
  const signals = [];
  if (p.traits.has("pep") || p.traits.has("adverseMedia")) {
    signals.push({ key: "sender_risk_tier", value: "MEDIUM_HIGH", source: "system", observedAt: verifiedAt });
  }

  return {
    _id: p._id,
    uid: p.uid,
    user: null,
    relations: [
      {
        client: ctx.clientId,
        branch: ctx.branchId,
        type: "individual",
        onboardingChannel: rng.pick(["In-Branch", "Mobile App", "Website", "Agent"]),
        registeredAt,
        source: RELATION_SOURCE,
        notes: "Synthetic customer for transaction-monitoring demo data.",
        active: true,
        relationModel: "Customer",
        relationId: p._id,
        invitedBy: ctx.authorId,
        inviteCreatedAt: registeredAt,
      },
    ],
    personalKyc: {
      personal_form: {
        customer_details: {
          given_name: p.given,
          middle_name: "",
          surname: p.surname,
          date_of_birth: new Date(ctx.now - p.ageYears * 365.25 * DAY_MS),
          other_names: "",
          referral: "Walk-in",
        },
        contact_details: { email: p.email, phone: p.phone },
        employment_details: {
          occupation: facts.occupation,
          industry: facts.industry,
          employer_name: p.employer ? p.employer.name : "",
        },
        residential_address: address,
        mailing_address: address,
        identificationNo: rng.digits(13),
      },
      funds_wealth: {
        source_of_funds: facts.sourceOfFunds,
        source_of_wealth: facts.sourceOfWealth,
        account_purpose: facts.accountPurpose,
        estimated_trading_volume: facts.volume,
      },
      sole_trader: { is_sole_trader: p.segment === "sme" },
    },
    documents: [
      { name: "nid.pdf", url: "https://example.com/nid.pdf", mimeType: "application/pdf", type: "identity", docType: "national_id", uploadedAt: registeredAt },
    ],
    country: HOME.country,
    kycStatus,
    kycNotes: kycStatus === "verified" ? "Documents received and checked." : "Verification in progress.",
    kycHistory: [
      { status: "pending", note: "Onboarding started.", changedBy: ctx.authorId, changedAt: registeredAt },
      { status: kycStatus, note: "Verification step completed.", changedBy: ctx.authorId, changedAt: verifiedAt },
    ],
    isPep: p.traits.has("pep"),
    sanction: p.traits.has("sanctioned"),
    kycVerifiedAt: kycStatus === "verified" ? verifiedAt : null,
    amlStatus: screen.amlStatus,
    amlRiskLabels: screen.labels,
    amlCheckedAt: verifiedAt,
    amlVendor: "Powered by ComplyAdvantage CSOM",
    consentToScreen: true,
    isActive: true,
    status: "Active",
    signals,
    metadata: { source: SOURCE, seedBatch: ctx.stamp, segment: p.segment, traits: [...p.traits] },
    declaration: { declarations_accepted: true, signatory_name: p.name, signature: `/s/ ${p.name}`, date: registeredAt },
    isDataEncrypted: false,
    osintStatus: false,
    createdAt: registeredAt,
  };
}

function buildAccountDoc(ctx, p) {
  const { rng } = ctx;
  const cfg = SEGMENTS[p.segment];
  const balance = Math.round(between(rng, cfg.balance));
  const type = p.segment === "sme" || p.segment === "hnw" ? "current" : "savings";
  return {
    _id: new Types.ObjectId(),
    uid: ctx.uid("ACC"),
    client: ctx.clientId,
    branch: ctx.branchId,
    customer: p._id,
    accountType: type,
    accountName: `${p.name} — ${type === "current" ? "Current" : "Savings"}`,
    accountNumber: p.account,
    productCode: type === "current" ? "CUR-STD" : "SAV-STD",
    currency: HOME.currency,
    swift: HOME.bic,
    branchCode: "HO-001",
    balance,
    availableBalance: Math.round(balance * 0.97),
    overdraftLimit: type === "current" ? 100000 : 0,
    dailyLimit: type === "current" ? 2000000 : 200000,
    monthlyLimit: type === "current" ? 20000000 : 2000000,
    accountHolderName: p.name,
    accountHolderType: "individual",
    accountHolderContact: { phone: p.phone, email: p.email, address: `${p.location.area}, ${p.location.district}` },
    accountStatus: "active",
    isActive: true,
    tags: ["tm-seed", p.segment],
    flags: [p.traits.has("pep") ? "pep" : null, p.traits.has("sanctioned") ? "watchlist" : null].filter(Boolean),
    openedAt: new Date(p.openedAt),
    lastActivityAt: new Date(p.openedAt),
    metadata: { source: SOURCE, seedBatch: ctx.stamp },
    createdBy: ctx.authorId,
    createdAt: new Date(p.openedAt),
  };
}

/**
 * Build `count` customers. `historyStart` / `lastDayStart` bound the period
 * transactions will be generated for, so opening dates line up with it:
 * established customers pre-date the history, new accounts open inside it.
 */
function buildCohort(ctx, { count, historyStart, lastDayStart }) {
  const { rng } = ctx;
  const segments = assignSegments(rng, count);
  const usedNames = new Set();
  const span = lastDayStart - historyStart;

  const profiles = segments.map((segment, index) => {
    const cfg = SEGMENTS[segment];
    let name;
    for (let attempt = 0; attempt < 8; attempt++) {
      name = ctx.personName();
      if (!usedNames.has(name)) break;
    }
    usedNames.add(name);
    const [given, ...rest] = name.split(" ");
    const location = rng.pick(LOCATIONS);

    const p = {
      index,
      _id: new Types.ObjectId(),
      uid: ctx.uid("CR"),
      name,
      given,
      surname: rest.join(" "),
      segment,
      traits: new Set(),
      rate: between(rng, cfg.rate),
      median: Math.round(between(rng, cfg.median)),
      location: { district: location.district, area: rng.pick(location.areas), postcode: location.postcode },
      phone: `+880${ctx.walletNo().slice(1)}`,
      email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}.${index + 1}@example.com`,
      account: `2151${String(index + 1).padStart(5, "0")}${rng.digits(4)}`,
      device: { deviceId: `dev-${rng.hex(10)}`, ip: `103.${rng.int(4, 250)}.${rng.int(1, 250)}.${rng.int(2, 250)}` },
      lastTxnAt: 0,
    };

    p.openedAt =
      segment === "newAccount"
        ? lastDayStart - rng.int(1, 24) * DAY_MS + rng.int(9, 16) * 3600e3
        : historyStart - rng.int(30, 2000) * DAY_MS;
    // Dormant accounts: most have no activity in the generated period at all
    // (their history pre-dates it); the rest go quiet early in it, on a day
    // boundary so "active" means the same thing to every generator.
    const quietAfterDays = Math.round((span / DAY_MS) * (0.05 + rng.float() * 0.15));
    p.activeUntil = segment !== "dormant" ? Infinity : rng.chance(0.65) ? -Infinity : historyStart + quietAfterDays * DAY_MS;

    assignTraits(rng, p);
    return p;
  });

  ensureTraits(profiles);

  const customers = [];
  const accounts = [];
  const turn = { riskIndustry: 0 };
  for (const p of profiles) {
    p.ageYears = p.traits.has("minor") ? rng.int(15, 17) : p.traits.has("elderly") ? rng.int(81, 90) : p.segment === "student" ? rng.int(18, 24) : rng.int(24, 62);
    if (p.segment === "retail" && !p.traits.has("unemployed")) {
      p.employer = rng.pick(ctx.employers);
      p.salary = Math.round(p.median * rng.int(9, 16));
      p.salaryDay = rng.int(1, 5);
    }
    p.party = {
      customer: p._id,
      name: p.name,
      account: p.account,
      institution: ctx.home.institution,
      institutionCountry: ctx.home.institutionCountry,
      bic: ctx.home.bic,
      address: `${p.location.area}, ${p.location.district}`,
    };

    const facts = kycFacts(rng, p, turn);
    p.industry = facts.industry;
    p.doc = buildCustomerDoc(ctx, p, facts);
    customers.push(p.doc);
    accounts.push(buildAccountDoc(ctx, p));
    ctx.profilesById.set(String(p._id), p);
  }

  // Stable payees, so "a beneficiary this customer has never paid" means something.
  for (const p of profiles) {
    const n = p.segment === "sme" ? rng.int(5, 10) : rng.int(3, 7);
    p.payees = Array.from({ length: n }, () => {
      const roll = rng.float();
      if (roll < 0.3) {
        const other = rng.pick(profiles);
        if (other !== p) return ctx.internal(other);
      }
      if (p.segment === "sme" || p.segment === "hnw") return ctx.domesticBusiness();
      return roll < 0.75 ? ctx.domesticPerson() : ctx.wallet();
    });
    // Parent abroad who supports a student; payers who settle an SME's sales.
    if (p.segment === "student") p.sponsor = ctx.foreign(rng.pick(["gulf", "asia", "west"]), { kind: "person" }).party;
    if (p.segment === "sme") p.payers = Array.from({ length: rng.int(5, 12) }, () => (rng.chance(0.6) ? ctx.domesticBusiness() : ctx.domesticPerson()));
  }

  ctx.profiles = profiles;
  return { profiles, customers, accounts };
}

module.exports = { buildCohort, SEGMENTS };
