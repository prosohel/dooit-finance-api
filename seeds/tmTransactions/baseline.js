// seeds/tmTransactions/baseline.js
//
// Ordinary traffic: salaries, bills, shopping, ATM withdrawals, SME trade,
// family remittances. It gives every customer a 30-day history (the models'
// training window and the z-score / frequency baselines) and it is the
// background the typologies have to stand out from.
//
// Baseline amounts are kept under the thresholds the rule corpus treats as
// High on their own: 100,000 in general (the lowest plain-amount High rule in
// use), lower for minors, the unemployed, the elderly, new accounts and night
// hours. A baseline transaction can still draw Medium noise — a 50% swing
// against the previous amount is normal behaviour and fires R82/R83 — which
// is what real traffic looks like to the monitoring service as well.

const { BASELINE_NARRATIVES: N } = require("./reference");
const { dhakaHour } = require("./context");

const GENERAL_CAP = 95000;

// Which kinds of transaction each segment makes, by relative weight.
const KINDS = {
  retail: [["p2p", 24], ["bill", 14], ["merchant", 22], ["atm", 14], ["deposit", 6], ["inbound", 12], ["wallet", 6], ["remitIn", 2]],
  sme: [["supplier", 28], ["receipt", 34], ["takings", 14], ["payroll", 3], ["bill", 6], ["withdrawal", 8], ["wallet", 5], ["remitOut", 2]],
  hnw: [["invest", 25], ["p2p", 20], ["receipt", 22], ["merchant", 15], ["bill", 10], ["fx", 4], ["remitOut", 4]],
  student: [["p2p", 30], ["merchant", 35], ["atm", 20], ["bill", 15]],
  dormant: [["p2p", 40], ["atm", 30], ["bill", 30]],
  newAccount: [["inbound", 25], ["p2p", 25], ["merchant", 20], ["atm", 15], ["deposit", 15]],
};

/** The most this customer may move in a baseline transaction at this time. */
const capFor = (p, at) => {
  let cap = GENERAL_CAP;
  if (p.traits.has("minor")) cap = Math.min(cap, 4500);
  if (p.traits.has("unemployed") || p.traits.has("elderly") || p.segment === "newAccount") cap = Math.min(cap, 45000);
  if (dhakaHour(at) < 4) cap = Math.min(cap, 45000);
  return cap;
};

/** Large round figures are a rule trigger of their own (R23/R24); ordinary traffic avoids them. */
const offRound = (whole) => (whole >= 50000 && whole % 500 === 0 ? whole - 137 : whole);

/** Log-normal amount around `median`, below `cap`, never a round figure. */
const amountAround = (ctx, median, cap, { sigma = 0.55, min = 50 } = {}) => {
  // One short of the cap, so the paisa added below cannot carry it over.
  const raw = Math.min(cap - 1, Math.max(min, ctx.rng.logNormal(median, sigma)));
  return offRound(Math.floor(raw)) + ctx.rng.int(1, 99) / 100;
};

/**
 * One of the customer's usual payees, with the most that payee may be party
 * to. A payee who is also a customer brings their own limits (a minor's cap
 * applies whichever side of the payment they are on), and an account that is
 * not open yet — or has gone dormant — is swapped for an outside party.
 */
const payeeOf = (ctx, p, at) => {
  const party = ctx.rng.pick(p.payees);
  const other = party.customer ? ctx.profilesById.get(String(party.customer)) : null;
  if (!other) return { party, cap: Infinity };
  if (other.openedAt >= at || other.activeUntil < at) return { party: ctx.domesticPerson(), cap: Infinity };
  return { party, cap: capFor(other, at) };
};

const status = (ctx) => ctx.rng.weighted([["completed", 955], ["pending", 20], ["failed", 17], ["cancelled", 8]]);

const digitalChannel = (ctx) => ctx.rng.weighted([["Mobile", 55], ["Online", 45]]);

const BUILDERS = {
  p2p(ctx, p) {
    const branch = !ctx.isWeekend() && ctx.rng.chance(0.15);
    const at = ctx.timeOnCurve(branch ? "branch" : "general");
    const payee = payeeOf(ctx, p, at);
    return ctx.txn({
      at, subject: p, subtype: "p2p", channel: branch ? "Branch" : digitalChannel(ctx), status: status(ctx),
      amount: amountAround(ctx, p.median, Math.min(capFor(p, at), payee.cap)),
      sender: ctx.internal(p), receiver: payee.party,
      purpose: "personal", narrative: ctx.rng.pick(N.p2p),
    });
  },

  bill(ctx, p) {
    const at = ctx.timeOnCurve();
    return ctx.txn({
      at, subject: p, subtype: "bill_payment", channel: digitalChannel(ctx), status: status(ctx),
      amount: amountAround(ctx, p.segment === "sme" ? 6500 : 1400, capFor(p, at), { sigma: 0.6 }),
      sender: ctx.internal(p), receiver: ctx.rng.pick(ctx.billers),
      purpose: "utility", narrative: ctx.rng.pick(N.bill),
    });
  },

  merchant(ctx, p) {
    const at = ctx.timeOnCurve();
    return ctx.txn({
      at, subject: p, subtype: "merchant_payment", channel: ctx.rng.weighted([["POS", 50], ["Online", 30], ["Mobile", 20]]), status: status(ctx),
      amount: amountAround(ctx, p.segment === "hnw" ? 9000 : 1100, capFor(p, at), { sigma: 0.8 }),
      sender: ctx.internal(p), receiver: ctx.rng.pick(ctx.merchants),
      purpose: "purchase", narrative: ctx.rng.pick(N.merchant),
    });
  },

  atm(ctx, p) {
    const at = ctx.timeOnCurve();
    const notes = Math.min(ctx.rng.int(2, 40) * 500, Math.floor(Math.min(20000, capFor(p, at)) / 500) * 500);
    return ctx.txn({
      at, subject: p, type: "withdrawal", subtype: "atm", channel: "ATM", status: status(ctx),
      amount: Math.max(500, notes),
      sender: ctx.internal(p), receiver: ctx.internal(p),
      purpose: "personal", narrative: N.atm[0],
    });
  },

  deposit(ctx, p) {
    const weekend = ctx.isWeekend();
    const at = ctx.timeOnCurve(weekend ? "general" : "branch");
    return ctx.txn({
      at, subject: p, type: "deposit", subtype: "cash", channel: weekend ? "CDM" : "Branch",
      amount: amountAround(ctx, p.median * 3, capFor(p, at)),
      sender: ctx.internal(p), receiver: ctx.internal(p),
      purpose: "savings", narrative: ctx.rng.pick(N.deposit),
    });
  },

  inbound(ctx, p) {
    const at = ctx.timeOnCurve();
    const payer = ctx.rng.chance(0.7) ? payeeOf(ctx, p, at) : { party: ctx.domesticPerson(), cap: Infinity };
    return ctx.txn({
      at, subject: p, subtype: "p2p", channel: digitalChannel(ctx), status: status(ctx),
      amount: amountAround(ctx, p.median * 1.5, Math.min(capFor(p, at), payer.cap)),
      sender: payer.party, receiver: ctx.internal(p),
      purpose: "personal", narrative: ctx.rng.pick(N.p2p),
    });
  },

  wallet(ctx, p) {
    const at = ctx.timeOnCurve();
    p.wallet = p.wallet || ctx.wallet(`${p.name} Wallet`);
    return ctx.txn({
      at, subject: p, subtype: "wallet_topup", channel: "Mobile", status: status(ctx),
      amount: amountAround(ctx, 2500, Math.min(25000, capFor(p, at)), { sigma: 0.7 }),
      sender: ctx.internal(p), receiver: p.wallet,
      purpose: "personal", narrative: "Wallet top-up",
    });
  },

  // Family remittance from abroad, well under the remittance thresholds.
  remitIn(ctx, p) {
    const at = ctx.timeOnCurve();
    p.relativeAbroad = p.relativeAbroad || ctx.foreign(ctx.rng.pick(["gulf", "asia", "west"]), { kind: "person" }).party;
    return ctx.txn({
      at, subject: p, subtype: "remittance", channel: "REMIT",
      amount: amountAround(ctx, 38000, Math.min(95000, capFor(p, at)), { sigma: 0.4 }),
      sender: p.relativeAbroad, receiver: ctx.internal(p),
      purpose: "family_support", purposeCode: "FAM", narrative: ctx.rng.pick(N.remitIn),
    });
  },

  remitOut(ctx, p) {
    const at = ctx.timeOnCurve(ctx.isWeekend() ? "general" : "branch");
    return ctx.txn({
      at, subject: p, subtype: "remittance", channel: "WIRE",
      amount: amountAround(ctx, 55000, capFor(p, at), { sigma: 0.35 }),
      sender: ctx.internal(p), receiver: ctx.foreign(ctx.rng.pick(["asia", "west"]), { kind: "person" }).party,
      purpose: "education", purposeCode: "EDU", narrative: ctx.rng.pick(N.remitOut),
    });
  },

  supplier(ctx, p) {
    const at = ctx.timeOnCurve();
    const payee = payeeOf(ctx, p, at);
    return ctx.txn({
      at, subject: p, subtype: "supplier_payment", channel: ctx.rng.weighted([["Online", 70], ["Mobile", 30]]), status: status(ctx),
      amount: amountAround(ctx, p.median, Math.min(capFor(p, at), payee.cap)),
      sender: ctx.internal(p), receiver: payee.party,
      purpose: "trade", narrative: `${ctx.rng.pick(N.supplier)} PO-${ctx.rng.digits(5)}`,
    });
  },

  receipt(ctx, p) {
    const at = ctx.timeOnCurve();
    const payer = p.payers ? ctx.rng.pick(p.payers) : ctx.domesticBusiness();
    return ctx.txn({
      at, subject: p, subtype: "receipt", channel: digitalChannel(ctx), status: status(ctx),
      amount: amountAround(ctx, p.median * 0.8, capFor(p, at), { sigma: 0.7 }),
      sender: payer, receiver: ctx.internal(p),
      purpose: "trade", narrative: `${ctx.rng.pick(N.receipt)} SO-${ctx.rng.digits(5)}`,
    });
  },

  takings(ctx, p) {
    const weekend = ctx.isWeekend();
    const at = ctx.timeOnCurve(weekend ? "general" : "branch");
    return ctx.txn({
      at, subject: p, type: "deposit", subtype: "cash", channel: weekend ? "CDM" : "Branch",
      amount: amountAround(ctx, p.median * 1.2, capFor(p, at), { sigma: 0.4 }),
      sender: ctx.internal(p), receiver: ctx.internal(p),
      purpose: "business", narrative: ctx.rng.pick(N.takings),
    });
  },

  withdrawal(ctx, p) {
    const weekend = ctx.isWeekend();
    const at = ctx.timeOnCurve(weekend ? "general" : "branch");
    return ctx.txn({
      at, subject: p, type: "withdrawal", subtype: weekend ? "atm" : "counter", channel: weekend ? "ATM" : "Branch",
      amount: weekend ? ctx.rng.int(4, 40) * 500 : amountAround(ctx, p.median * 0.6, capFor(p, at), { sigma: 0.4 }),
      sender: ctx.internal(p), receiver: ctx.internal(p),
      purpose: "business", narrative: "Petty expenses",
    });
  },

  // A small payroll run — several staff paid within a few minutes.
  payroll(ctx, p) {
    const start = ctx.timeOnCurve();
    p.staff = p.staff || Array.from({ length: ctx.rng.int(3, 6) }, () => ctx.domesticPerson());
    return p.staff.map((member, i) =>
      ctx.txn({
        at: Math.min(start + i * ctx.rng.int(75, 240) * 1000, ctx.day.end - 1000), subject: p, subtype: "payroll", channel: "Online",
        amount: amountAround(ctx, 19000, 45000, { sigma: 0.2 }),
        sender: ctx.internal(p), receiver: member,
        purpose: "salary", narrative: ctx.rng.pick(N.payroll),
      })
    );
  },

  invest(ctx, p) {
    const at = ctx.timeOnCurve(ctx.isWeekend() ? "general" : "branch");
    return ctx.txn({
      at, subject: p, subtype: "investment", channel: "Online",
      amount: amountAround(ctx, p.median, capFor(p, at)),
      sender: ctx.internal(p), receiver: ctx.rng.pick(ctx.brokerages),
      purpose: "investment", narrative: ctx.rng.pick(N.invest),
    });
  },

  fx(ctx, p) {
    const at = ctx.timeOnCurve(ctx.isWeekend() ? "general" : "branch");
    return ctx.txn({
      at, subject: p, type: "exchange", subtype: "fx", channel: "FOREX", currency: "USD",
      amount: ctx.rng.money(300, 3000),
      sender: ctx.internal(p), receiver: ctx.internal(p),
      purpose: "travel", narrative: N.fx[0],
    });
  },
};

/** Salaries and family support land once a month, on a fixed day per customer. */
function monthlyCredits(ctx, eligible) {
  let made = 0;
  for (const p of eligible) {
    if (p.salary && p.salaryDay === ctx.day.dayOfMonth) {
      const at = ctx.startFor(0, 9, 13);
      if (at === null) continue;
      ctx.txn({
        at, subject: p, subtype: "salary", channel: "Online",
        amount: offRound(Math.min(capFor(p, at) - 1, Math.round(p.salary * (0.99 + ctx.rng.float() * 0.02)))) + 0.5,
        sender: p.employer, receiver: ctx.internal(p),
        purpose: "salary", narrative: ctx.rng.pick(N.salary),
      });
      made++;
    }
    if (p.sponsor && ctx.day.dayOfMonth === 3 + (p.index % 5)) {
      const at = ctx.startFor(0, 10, 18);
      if (at === null) continue;
      ctx.txn({
        at, subject: p, subtype: "remittance", channel: "REMIT",
        amount: amountAround(ctx, p.traits.has("minor") ? 3500 : 32000, capFor(p, at), { sigma: 0.15 }),
        sender: p.sponsor, receiver: ctx.internal(p),
        purpose: "family_support", purposeCode: "FAM", narrative: ctx.rng.pick(N.remitIn),
      });
      made++;
    }
  }
  return made;
}

/**
 * Generate about `count` ordinary transactions for the open day, spread
 * across customers in proportion to how active each one is.
 */
function generateBaseline(ctx, count) {
  const { rng, day } = ctx;
  const eligible = ctx.profiles.filter((p) => p.openedAt < day.start && p.activeUntil > day.start);
  if (!eligible.length) return 0;

  let made = monthlyCredits(ctx, eligible);

  const weekend = ctx.isWeekend();
  const weights = eligible.map((p) => p.rate * (weekend && (p.segment === "sme" || p.segment === "hnw") ? 0.45 : 1));
  const cumulative = [];
  weights.reduce((sum, w, i) => (cumulative[i] = sum + w), 0);
  const total = cumulative[cumulative.length - 1];

  const pickProfile = () => {
    const roll = rng.float() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < roll) lo = mid + 1;
      else hi = mid;
    }
    return eligible[lo];
  };

  while (made < count) {
    const p = pickProfile();
    const kind = rng.weighted(KINDS[p.segment] || KINDS.retail);
    const result = BUILDERS[kind](ctx, p);
    // Anything a baseline transaction of a trait-carrying customer triggers is
    // triggered by who they are, not by what they did — tag it so the audit
    // counts it as expected rather than as noise.
    const docs = Array.isArray(result) ? result : [result];
    if (p.traits.has("unknownSof") || p.traits.has("unclearPurpose")) {
      for (const doc of docs) doc.metadata.typology = "kyc_profile_gap";
    }
    made += docs.length;
  }
  return made;
}

module.exports = { generateBaseline, capFor, GENERAL_CAP };
