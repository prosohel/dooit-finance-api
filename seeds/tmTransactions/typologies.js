// seeds/tmTransactions/typologies.js
//
// The suspicious activity. Each typology writes one *incident* — a handful
// of transactions that belong together — shaped to give the monitoring
// service something to find:
//
//   rule detector   conditions the Rule Engine corpus checks (rule ids in
//                   CATALOGUE.targets), using the corpus's own constants
//   collective      velocity, structuring, fan-in / fan-out and pass-through,
//                   which only show up across a customer's transactions
//   ml / dl         departures from the customer's own 30-day baseline
//
// Every transaction carries metadata.typology and metadata.incident, so a
// detection run can be scored against what was planted.

const { HOME, CORRESPONDENTS, SHELL_COMPANIES, BETTING_OPERATORS, VASPS, WATCHLIST_NAMES } = require("./reference");
const { MIN_MS, DAY_MS } = require("./context");

const SEC_MS = 1000;
const sum = (list) => list.reduce((a, b) => a + b, 0);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Pick the customer an incident happens to. Part of the time it is someone
 * who has done this before: repeat behaviour is what lets alerts for the same
 * customer and case type group into one case.
 */
function subject(ctx, key, eligible, repeatChance = 0.45) {
  const { rng, day } = ctx;
  const open = (p) => p.openedAt < day.start && eligible(p);
  ctx.offenders = ctx.offenders || {};
  const seen = (ctx.offenders[key] = ctx.offenders[key] || []);
  if (seen.length && rng.chance(repeatChance)) {
    const again = rng.pick(seen);
    if (open(again)) return again;
  }
  const pool = ctx.profiles.filter(open);
  if (!pool.length) return null;
  const p = rng.pick(pool);
  if (!seen.includes(p)) seen.push(p);
  return p;
}

/** n timestamps with random gaps (ms), or null if they do not fit in the day. */
function schedule(ctx, n, [gapMin, gapMax], fromHour = 0, toHour = 24) {
  const gaps = Array.from({ length: Math.max(0, n - 1) }, () => ctx.rng.int(gapMin, gapMax));
  const t0 = ctx.startFor(sum(gaps) + SEC_MS, fromHour, toHour);
  if (t0 === null) return null;
  const times = [t0];
  for (const gap of gaps) times.push(times[times.length - 1] + gap);
  return times;
}

const tagFor = (ctx, typology) => ({ typology, incident: ctx.incident(typology) });

const inSegment = (...segments) => (p) => segments.includes(p.segment);

/** A device the customer has never used — the mark of a takeover. */
const strangeDevice = (ctx) => ({
  deviceId: `dev-${ctx.rng.hex(10)}`,
  ip: `${ctx.rng.pick(["185.220", "45.142", "193.32", "91.219"])}.${ctx.rng.int(1, 250)}.${ctx.rng.int(2, 250)}`,
});

const bearer = (ctx) => ({ name: ctx.personName(), institution: ctx.home.institution, institutionCountry: HOME.country });

const shellBusiness = (ctx) => ctx.domesticBusiness(ctx.rng.pick(SHELL_COMPANIES));

const wire = (ctx) => ({ channel: "WIRE", intermediary: { ...ctx.rng.pick(CORRESPONDENTS) } });

// ── Typologies ───────────────────────────────────────────────────────────────

const RUNNERS = {
  /** Cash deposits kept just under the BDT 10 lakh reporting threshold. */
  structuring_cash(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "structuring_cash", inSegment("sme", "retail", "hnw"));
    const times = schedule(ctx, rng.int(4, 9), [18 * MIN_MS, 55 * MIN_MS], 10, 17);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "structuring_cash");
    for (const at of times) {
      ctx.txn({
        ...tag, at, subject: p, type: "deposit", subtype: "cash", channel: "CASH",
        amount: rng.chance(0.4) ? rng.int(181, 199) * 5000 : rng.money(905000, 998500),
        sender: rng.chance(0.6) ? ctx.internal(p) : bearer(ctx), receiver: ctx.internal(p),
        purpose: "business", narrative: rng.pick(["Cash deposit", "Cash deposit - business proceeds", "Cash deposit by bearer"]),
      });
    }
    return times.length;
  },

  /** Repeated transfers in the 9,000–9,999 band (rules R21/R22). */
  structuring_transfers(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "structuring_transfers", inSegment("retail", "sme", "student"));
    const times = schedule(ctx, rng.int(6, 14), [3 * MIN_MS, 25 * MIN_MS], 8, 23);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "structuring_transfers");
    const payees = Array.from({ length: rng.int(2, 4) }, () => (rng.chance(0.6) ? ctx.wallet() : ctx.domesticPerson()));
    for (const at of times) {
      ctx.txn({
        ...tag, at, subject: p, subtype: "p2p", channel: "Mobile",
        amount: rng.money(9050, 9995),
        sender: ctx.internal(p), receiver: rng.pick(payees),
        purpose: "personal", narrative: "Fund transfer",
      });
    }
    return times.length;
  },

  /** Account takeover drain: many transfers seconds apart from a new device. */
  rapid_fire(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "rapid_fire", inSegment("retail", "sme", "hnw"), 0.2);
    const night = rng.chance(0.6);
    const times = schedule(ctx, rng.int(8, 20), [6 * SEC_MS, 55 * SEC_MS], night ? 0 : 6, night ? 5 : 24);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "rapid_fire");
    const device = strangeDevice(ctx);
    const payees = Array.from({ length: rng.int(3, 6) }, () => (rng.chance(0.5) ? ctx.wallet() : ctx.domesticPerson()));
    const channel = rng.pick(["Online", "Mobile"]);
    for (const at of times) {
      ctx.txn({
        ...tag, at, subject: p, device, subtype: "p2p", channel,
        amount: rng.money(12000, 95000),
        sender: ctx.internal(p), receiver: rng.pick(payees),
        purpose: "personal", narrative: "Fund transfer",
      });
    }
    return times.length;
  },

  /** A small-ticket customer suddenly moves 20–80× their usual amount, at night. */
  amount_spike(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "amount_spike", inSegment("retail", "student"), 0.15);
    const night = rng.chance(0.7);
    const times = schedule(ctx, rng.int(1, 3), [2 * MIN_MS, 15 * MIN_MS], night ? 1 : 6, night ? 4 : 24);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "amount_spike");
    const device = strangeDevice(ctx);
    const payee = ctx.domesticPerson();
    for (const at of times) {
      ctx.txn({
        ...tag, at, subject: p, device, subtype: "p2p", channel: "ONLINE",
        amount: rng.money(350000, 2400000),
        sender: ctx.internal(p), receiver: payee,
        purpose: "personal", narrative: rng.pick(["Urgent transfer", "Personal transfer", "Emergency payment"]),
      });
    }
    return times.length;
  },

  /** Five or more large transfers in a day: the last five sum past 1,000,000 (R84). */
  burst_large(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "burst_large", inSegment("sme", "hnw"));
    const times = schedule(ctx, rng.int(5, 8), [8 * MIN_MS, 50 * MIN_MS], 9, 19);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "burst_large");
    const payees = Array.from({ length: rng.int(2, 4) }, () => ctx.domesticBusiness());
    for (const at of times) {
      ctx.txn({
        ...tag, at, subject: p, subtype: "supplier_payment", channel: "Online",
        amount: rng.money(215000, 495000),
        sender: ctx.internal(p), receiver: rng.pick(payees),
        purpose: "trade", narrative: `Trade settlement PO-${rng.digits(5)}`,
      });
    }
    return times.length;
  },

  /** One account pays a dozen or more distinct beneficiaries within hours. */
  fan_out(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "fan_out", inSegment("retail", "sme", "newAccount", "student"));
    const times = schedule(ctx, rng.int(12, 35), [1 * MIN_MS, 6 * MIN_MS], 7, 23);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "fan_out");
    const base = rng.money(8000, 42000);
    const amounts = times.map(() => base * (0.9 + rng.float() * 0.2));
    let made = times.length;

    // Half the time the money arrives first, in one piece.
    const fundedAt = times[0] - rng.int(20, 60) * MIN_MS;
    if (rng.chance(0.5) && fundedAt > ctx.day.start) {
      ctx.txn({
        ...tag, at: fundedAt, subject: p, subtype: "receipt", channel: "Online",
        amount: sum(amounts) * 1.02,
        sender: shellBusiness(ctx), receiver: ctx.internal(p),
        purpose: "trade", narrative: "Commission payout",
      });
      made++;
    }
    times.forEach((at, i) => {
      ctx.txn({
        ...tag, at, subject: p, subtype: "p2p", channel: "Mobile",
        amount: amounts[i],
        sender: ctx.internal(p), receiver: rng.chance(0.6) ? ctx.wallet() : ctx.domesticPerson(),
        purpose: "personal", narrative: rng.pick(["Payment", "Commission", "Payout"]),
      });
    });
    return made;
  },

  /** A dozen or more distinct senders pay one account, which is then emptied. */
  fan_in(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "fan_in", inSegment("retail", "sme", "newAccount", "student"));
    const times = schedule(ctx, rng.int(12, 35), [4 * MIN_MS, 22 * MIN_MS], 8, 21);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "fan_in");
    const others = ctx.profiles.filter((o) => o !== p && o.openedAt < ctx.day.start && o.segment !== "dormant" && !o.traits.has("minor"));
    let total = 0;
    for (const at of times) {
      const amount = rng.money(4000, 45000);
      total += amount;
      const fromCustomer = others.length && rng.chance(0.3);
      const payer = fromCustomer ? rng.pick(others) : null;
      ctx.txn({
        ...tag, at, subject: payer || p, subtype: "p2p", channel: "Mobile", amount,
        sender: payer ? ctx.internal(payer) : rng.chance(0.5) ? ctx.wallet() : ctx.domesticPerson(), receiver: ctx.internal(p),
        purpose: "personal", narrative: rng.pick(["Payment", "Contribution", "Order advance", "Membership fee"]),
      });
    }
    let made = times.length;
    const outAt = times[times.length - 1] + rng.int(20, 90) * MIN_MS;
    if (rng.chance(0.6) && outAt < ctx.day.end) {
      const amount = total * (0.92 + rng.float() * 0.06);
      if (amount > 500000) {
        ctx.txn({
          ...tag, ...wire(ctx), at: outAt, subject: p, subtype: "remittance", amount,
          sender: ctx.internal(p), receiver: ctx.foreign(rng.pick(["gulf", "offshore"])).party,
          purpose: "trade", narrative: "Consolidated settlement",
        });
      } else {
        ctx.txn({
          ...tag, at: outAt, subject: p, type: "withdrawal", subtype: "cash", channel: "AGENT", amount,
          sender: ctx.internal(p), receiver: ctx.internal(p),
          purpose: "personal", narrative: "Agent cash out",
        });
      }
      made++;
    }
    return made;
  },

  /** Mule account: money in, 91–99% of it out again within the hour. */
  pass_through(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "pass_through", inSegment("retail", "student", "newAccount"));
    const splits = rng.int(1, 3);
    const times = schedule(ctx, splits + 1, [8 * MIN_MS, 40 * MIN_MS], 7, 23);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "pass_through");
    const received = rng.money(160000, 950000);
    ctx.txn({
      ...tag, at: times[0], subject: p, subtype: "receipt", channel: "Online", amount: received,
      sender: rng.chance(0.3) ? ctx.foreign(rng.pick(["gulf", "tradeHub"])).party : shellBusiness(ctx), receiver: ctx.internal(p),
      purpose: "personal", narrative: rng.pick(["Payment received", "Refund", "Commission"]),
    });
    const onward = received * (0.91 + rng.float() * 0.08);
    for (let i = 1; i <= splits; i++) {
      ctx.txn({
        ...tag, at: times[i], subject: p, subtype: "p2p", channel: "Online", amount: onward / splits,
        sender: ctx.internal(p), receiver: rng.chance(0.5) ? ctx.domesticPerson() : ctx.wallet(),
        purpose: "personal", narrative: "Fund transfer",
      });
    }
    return splits + 1;
  },

  /** Funds hop through 4–6 accounts in one afternoon and leave the country (or loop back). */
  layering_chain(ctx) {
    const { rng } = ctx;
    const open = ctx.profiles.filter((p) => p.openedAt < ctx.day.start && p.segment !== "dormant" && !p.traits.has("minor"));
    const nodes = rng.sample(open, rng.int(4, 6));
    const times = schedule(ctx, nodes.length + 1, [15 * MIN_MS, 60 * MIN_MS], 9, 20);
    if (nodes.length < 4 || !times) return 0;
    const tag = tagFor(ctx, "layering_chain");
    const circular = rng.chance(0.2);
    const signals = [["transaction_sequence", circular ? "CIRCULAR" : "LAYERED"]];
    const narrative = () => rng.pick(["Consulting services fee", "Loan repayment", "Investment proceeds", "Trade invoice settlement"]);
    let amount = rng.money(650000, 3200000);

    ctx.txn({
      ...tag, at: times[0], subject: nodes[0], subtype: "receipt", channel: "Online", amount, signals,
      sender: rng.chance(0.5) ? ctx.foreign("tradeHub").party : shellBusiness(ctx), receiver: ctx.internal(nodes[0]),
      purpose: "trade", narrative: narrative(),
    });
    for (let i = 0; i < nodes.length; i++) {
      amount *= 0.985 + rng.float() * 0.012;
      const last = i === nodes.length - 1;
      const exit = last && !circular;
      ctx.txn({
        ...tag, ...(exit ? wire(ctx) : { channel: "Online" }), at: times[i + 1], subject: nodes[i], amount, signals,
        subtype: exit ? "remittance" : "p2p",
        sender: ctx.internal(nodes[i]),
        receiver: exit ? ctx.foreign("offshore").party : ctx.internal(last ? nodes[0] : nodes[i + 1]),
        purpose: "trade", narrative: narrative(),
      });
    }
    return nodes.length + 1;
  },

  /** Large wires to and from high-risk, offshore and trade-hub jurisdictions. */
  cross_border_high_risk(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "cross_border_high_risk", inSegment("sme", "hnw"));
    const times = schedule(ctx, rng.int(1, 3), [20 * MIN_MS, 120 * MIN_MS], 9, 18);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "cross_border_high_risk");
    const corridor = rng.weighted([["highRisk", 40], ["offshore", 35], ["tradeHub", 25]]);
    const signals = { highRisk: [["beneficiary_institution_risk_level", "HIGH"]], offshore: [["tx_jurisdiction", "high secrecy"]], tradeHub: [] }[corridor];
    for (const at of times) {
      const currency = rng.weighted([["USD", 55], ["EUR", 15], ["BDT", 30]]);
      let amount = currency === "BDT" ? rng.money(260000, 4800000) : currency === "EUR" ? rng.money(210000, 900000) : rng.money(205000, 1250000);
      if (rng.chance(0.35)) amount = Math.round(amount / 1000) * 1000;
      const abroad = ctx.foreign(corridor).party;
      const outbound = rng.chance(0.75);
      ctx.txn({
        ...tag, ...wire(ctx), at, subject: p, subtype: "remittance", currency, amount, signals,
        sender: outbound ? ctx.internal(p) : abroad, receiver: outbound ? abroad : ctx.internal(p),
        purpose: "trade", purposeCode: "GDS",
        narrative: rng.pick([
          `Invoice ${rng.digits(4)} - consulting services`,
          `Payment for machinery parts invoice ${rng.digits(5)}`,
          "Advance for commodities shipment",
          `Proforma invoice ${rng.digits(4)} settlement`,
          "Management services fee",
        ]),
      });
    }
    return times.length;
  },

  /** Exposure to mixers, darknet clusters and weak or shell VASPs. */
  crypto_exposure(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "crypto_exposure", (c) => c.industry === "CRYPTO" || ["retail", "hnw", "sme"].includes(c.segment));
    const times = schedule(ctx, rng.int(1, 3), [10 * MIN_MS, 90 * MIN_MS]);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "crypto_exposure");
    for (const at of times) {
      const network = rng.weighted([["MIXER", 14], ["TOR", 6], ["DARKNET", 8], ["DEFI", 12], ["DEX", 12], ["BRIDGE", 10], ["LAYER2", 8], ["Bitcoin", 12], ["Ethereum", 10], ["Tron", 8]]);
      const vasp = rng.pick(VASPS);
      const cluster = rng.pick(["highrisk-exchange-cluster", "fraud-shop-cluster", "hack-proceeds-2025", "darkmarket-vendor", "gambling-pool", "ponzi-forsage", "exchange-hosted"]);
      const currency = rng.chance(0.3) ? "USD" : "BDT";
      const exchange = { name: vasp.name, account: `0x${rng.hex(40)}`, institution: vasp.name, institutionCountry: vasp.country };
      const desk = { id: "VASP-BD-0001", name: `${ctx.home.institution} Digital Desk` };
      // A sale pays in from the exchange, so the foreign VASP is the originator.
      const sale = rng.chance(0.3);
      ctx.txn({
        ...tag, at, subject: p, type: rng.chance(0.4) ? "exchange" : "transfer", subtype: "crypto", channel: "CRYPTO", currency,
        amount: rng.money(160000, 950000),
        sender: sale ? exchange : ctx.internal(p),
        receiver: sale ? ctx.internal(p) : exchange,
        purpose: "investment", narrative: sale ? "Crypto sale proceeds" : rng.pick(["Crypto purchase", "Exchange top-up", "USDT settlement - crypto desk"]),
        crypto: {
          walletAddress: rng.chance(0.5) ? `bc1q${rng.hex(38)}` : `0x${rng.hex(40)}`,
          txHash: `0x${rng.hex(64)}`,
          network,
          hops: rng.chance(0.4) ? rng.int(11, 24) : rng.int(1, 6),
          cluster,
        },
        forensic: {
          walletCluster: `cluster-${rng.digits(4)}`,
          chainalysisScore: rng.int(60, 98),
          notes: rng.pick([
            "Funds traced through a mixer service within three hops.",
            "Exposure to illicit darknet marketplace proceeds.",
            "Address linked to a ransom payment campaign.",
            "Indirect exposure to a sanctioned exchange.",
          ]),
        },
        travelRule: {
          originatorVaspId: sale ? vasp.id : desk.id,
          originatorVaspName: sale ? vasp.name : desk.name,
          originatorVaspLicense: sale ? `${vasp.country.slice(0, 2).toUpperCase()}-VASP-${rng.digits(5)}` : "BB-PSD-000184",
          beneficiaryVaspId: sale ? desk.id : vasp.id,
          beneficiaryVaspName: sale ? desk.name : vasp.name,
          travelMessageId: `TR-${rng.digits(12)}`,
          protocol: rng.weighted([["IVMS101", 55], ["LEGACY", 25], ["OLD", 10], ["TRP", 10]]),
        },
      });
    }
    return times.length;
  },

  /** Activity that does not fit who the customer says they are. */
  profile_mismatch(ctx) {
    const { rng } = ctx;
    const has = (trait) => (c) => c.traits.has(trait);
    const variants = [
      { who: has("unemployed"), amount: () => rng.money(55000, 420000), narrative: "Fund transfer" },
      { who: has("riskIndustry"), amount: () => rng.money(210000, 900000), narrative: "Business payment" },
      { who: has("minor"), amount: () => rng.money(5500, 60000), narrative: "Fund transfer" },
      { who: has("elderly"), amount: () => rng.money(55000, 480000), narrative: rng.pick(["Urgent payment - tax authority penalty", "Court settlement fee - urgent"]) },
      { who: has("selfEmployed"), amount: () => rng.money(520000, 1800000), narrative: "Business payment" },
      { who: inSegment("sme", "hnw"), amount: () => rng.money(510000, 2200000), purpose: "CHARITY", narrative: "Donation" },
      { who: inSegment("retail", "hnw"), amount: () => rng.money(1050000, 4800000), purpose: "INHERITANCE", narrative: "Estate distribution" },
    ];
    const v = rng.pick(variants);
    const p = subject(ctx, "profile_mismatch", v.who);
    const times = schedule(ctx, rng.int(1, 2), [15 * MIN_MS, 120 * MIN_MS], 8, 22);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "profile_mismatch");
    for (const at of times) {
      ctx.txn({
        ...tag, at, subject: p, subtype: "p2p", channel: rng.pick(["Online", "Mobile"]),
        amount: v.amount(),
        sender: ctx.internal(p), receiver: rng.chance(0.5) ? ctx.domesticPerson() : ctx.domesticBusiness(),
        purpose: v.purpose || "personal", narrative: v.narrative,
      });
    }
    return times.length;
  },

  /** An account under 30 days old takes a large credit and cashes it out. */
  new_account_abuse(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "new_account_abuse", inSegment("newAccount"), 0.3);
    const outs = rng.int(1, 4);
    const times = schedule(ctx, outs + 1, [15 * MIN_MS, 70 * MIN_MS], 8, 22);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "new_account_abuse");
    const received = rng.money(180000, 900000);
    const cashIn = rng.chance(0.4);
    ctx.txn({
      ...tag, at: times[0], subject: p, amount: received,
      type: cashIn ? "deposit" : "transfer", subtype: cashIn ? "cash" : "receipt", channel: cashIn ? "CASH" : "Online",
      sender: cashIn ? bearer(ctx) : shellBusiness(ctx), receiver: ctx.internal(p),
      purpose: "personal", narrative: cashIn ? "Cash deposit by bearer" : "Payment received",
    });
    const onward = received * (0.9 + rng.float() * 0.09);
    if (onward > 520000 && rng.chance(0.5)) {
      ctx.txn({
        ...tag, at: times[1], subject: p, type: "withdrawal", subtype: "cash", channel: "AGENT", amount: onward,
        sender: ctx.internal(p), receiver: ctx.internal(p),
        purpose: "personal", narrative: "Agent cash out",
      });
      return 2;
    }
    for (let i = 1; i <= outs; i++) {
      ctx.txn({
        ...tag, at: times[i], subject: p, subtype: "p2p", channel: "Mobile", amount: onward / outs,
        sender: ctx.internal(p), receiver: rng.chance(0.6) ? ctx.wallet() : ctx.domesticPerson(),
        purpose: "personal", narrative: "Fund transfer",
      });
    }
    return outs + 1;
  },

  /** No activity for five weeks or more, then a large credit and a flurry of payments. */
  dormant_reactivation(ctx) {
    const { rng } = ctx;
    const quiet = (p) => p.segment === "dormant" && ctx.day.start - (p.lastTxnAt || 0) >= 35 * DAY_MS;
    const p = subject(ctx, "dormant_reactivation", quiet, 0);
    const outs = rng.int(2, 8);
    const times = schedule(ctx, outs + 1, [10 * MIN_MS, 45 * MIN_MS], 8, 22);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "dormant_reactivation");
    const received = rng.money(250000, 1500000);
    ctx.txn({
      ...tag, at: times[0], subject: p, subtype: "receipt", channel: "Online", amount: received,
      sender: shellBusiness(ctx), receiver: ctx.internal(p),
      purpose: "personal", narrative: "Payment received",
    });
    const onward = received * (0.9 + rng.float() * 0.08);
    for (let i = 1; i <= outs; i++) {
      ctx.txn({
        ...tag, at: times[i], subject: p, device: strangeDevice(ctx), subtype: "p2p", channel: "Online", amount: onward / outs,
        sender: ctx.internal(p), receiver: rng.chance(0.5) ? ctx.domesticPerson() : ctx.wallet(),
        purpose: "personal", narrative: "Fund transfer",
      });
    }
    return outs + 1;
  },

  /** Large remittances from unrelated senders abroad to a student or unemployed customer. */
  remittance_mismatch(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "remittance_mismatch", (c) => (c.segment === "student" && !c.traits.has("minor")) || c.traits.has("unemployed"));
    const times = schedule(ctx, rng.int(3, 7), [30 * MIN_MS, 150 * MIN_MS], 9, 21);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "remittance_mismatch");
    let total = 0;
    for (const at of times) {
      const amount = rng.money(255000, 1150000);
      total += amount;
      ctx.txn({
        ...tag, at, subject: p, subtype: "remittance", channel: "REMIT", amount,
        sender: ctx.foreign(rng.pick(["gulf", "gulf", "asia", "west"]), { kind: "person" }).party, receiver: ctx.internal(p),
        purpose: "family_support", purposeCode: "FAM", narrative: rng.pick(["Family maintenance", "Gift from relative", "Support"]),
      });
    }
    const outAt = times[times.length - 1] + rng.int(30, 120) * MIN_MS;
    if (rng.chance(0.5) && outAt < ctx.day.end) {
      ctx.txn({
        ...tag, at: outAt, subject: p, type: "withdrawal", subtype: "cash", channel: "CASH", amount: total * (0.7 + rng.float() * 0.2),
        sender: ctx.internal(p), receiver: ctx.internal(p),
        purpose: "personal", narrative: "Cash withdrawal",
      });
      return times.length + 1;
    }
    return times.length;
  },

  /** Large stakes with offshore betting operators, and the occasional payout. */
  gambling(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "gambling", inSegment("retail", "hnw", "sme"));
    const times = schedule(ctx, rng.int(1, 4), [10 * MIN_MS, 90 * MIN_MS], 17, 24);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "gambling");
    const op = rng.pick(BETTING_OPERATORS);
    const operator = { name: op.name, account: `GM${rng.digits(12)}`, institution: op.institution, institutionCountry: op.country };
    for (const at of times) {
      const payout = rng.chance(0.3);
      ctx.txn({
        ...tag, at, subject: p, subtype: "GAMBLING", channel: "Online",
        amount: rng.money(105000, 620000),
        sender: payout ? operator : ctx.internal(p), receiver: payout ? ctx.internal(p) : operator,
        purpose: "entertainment", narrative: payout ? "Gaming payout" : "Gaming wallet top-up",
        signals: [["gambling_outcome", payout ? "WIN" : "LOSS"]],
      });
    }
    return times.length;
  },

  /** Single large transactions through the channels and states rules single out. */
  high_value_channel(ctx) {
    const { rng, day } = ctx;
    const self = (p) => ({ sender: ctx.internal(p), receiver: ctx.internal(p) });
    const pay = (p) => ({ sender: ctx.internal(p), receiver: ctx.domesticBusiness() });
    const variants = [
      (p) => ({ type: "deposit", subtype: "cash", channel: "CASH", amount: rng.money(760000, 3500000), narrative: "Cash deposit", ...self(p) }),
      (p) => ({ type: "withdrawal", subtype: "cash", channel: "CASH", amount: rng.money(760000, 2800000), narrative: "Cash withdrawal", ...self(p) }),
      (p) => ({ type: "withdrawal", subtype: "atm", channel: "ATM", amount: rng.int(41, 96) * 5000, narrative: "ATM withdrawal", ...self(p) }),
      (p) => ({ type: "withdrawal", subtype: "cash", channel: "AGENT", amount: rng.money(510000, 1400000), narrative: "Agent cash out", ...self(p) }),
      (p) => ({ status: "pending", channel: "Online", amount: rng.money(520000, 2600000), narrative: "Property booking money", ...pay(p) }),
      (p) => ({ status: "cancelled", channel: "Online", amount: rng.money(55000, 900000), narrative: "Fund transfer", ...pay(p) }),
      (p) => ({ subtype: "MANUAL", channel: "Branch", amount: rng.money(105000, 800000), narrative: "Manual voucher posting", ...pay(p) }),
      (p) => ({ reference: null, channel: "Online", amount: rng.money(105000, 600000), narrative: "Fund transfer", ...pay(p) }),
      (p) => ({ channel: "Online", amount: rng.int(51, 950) * 1000, narrative: "Fund transfer", ...pay(p) }),
      (p) => ({ channel: "ONLINE", amount: rng.money(810000, 2400000), narrative: "Fund transfer", ...pay(p) }),
    ];
    // "Weekend" in the rule corpus is Saturday/Sunday (R26).
    if (day.weekday === 6 || day.weekday === 0) {
      variants.push((p) => ({ channel: "Online", amount: rng.money(310000, 1900000), narrative: "Fund transfer", ...pay(p) }));
    }
    const p = subject(ctx, "high_value_channel", inSegment("sme", "hnw", "retail"));
    const times = schedule(ctx, 1, [0, 0], 7, 23);
    if (!p || !times) return 0;
    ctx.txn({ ...tagFor(ctx, "high_value_channel"), at: times[0], subject: p, purpose: "business", ...rng.pick(variants)(p) });
    return 1;
  },

  /** Payment data that should not have got through: placeholder parties, zero accounts. */
  integrity_anomaly(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "integrity_anomaly", inSegment("sme", "retail", "hnw"));
    const times = schedule(ctx, 1, [0, 0], 7, 23);
    if (!p || !times) return 0;
    const ordinary = ctx.domesticPerson();
    const variants = [
      { receiver: { ...ordinary, account: "0" }, narrative: "Fund transfer" },
      { receiver: { ...ordinary, institution: "UNKNOWN", bic: undefined }, narrative: "Fund transfer" },
      { receiver: { ...ordinary, institutionCountry: "UNKNOWN" }, narrative: "Fund transfer" },
      { receiver: { ...ordinary, name: "TEST" }, narrative: "Fund transfer", reference: `TEST-${rng.digits(6)}` },
      { receiver: { ...ordinary, name: "MR" }, narrative: "Fund transfer" },
      { receiver: { ...ordinary, account: "112" }, narrative: "Fund transfer" },
      { receiver: { ...ordinary, name: p.name }, narrative: "Own account transfer" },
      { receiver: ordinary, narrative: "??? unknown purpose" },
    ];
    ctx.txn({
      ...tagFor(ctx, "integrity_anomaly"), at: times[0], subject: p, subtype: "p2p", channel: rng.pick(["Online", "Mobile"]),
      amount: rng.money(305000, 650000),
      sender: ctx.internal(p), purpose: "personal", ...rng.pick(variants),
    });
    return 1;
  },

  /** Sanctions and watchlist exposure, on either side of the payment. */
  watchlist_sanctions(ctx) {
    const { rng } = ctx;
    const variant = rng.weighted([["customer", 30], ["beneficiary", 25], ["corridor", 25], ["fraudScore", 20]]);
    const p = subject(ctx, "watchlist_sanctions", variant === "customer" ? (c) => c.traits.has("sanctioned") : inSegment("sme", "hnw", "retail"));
    const times = schedule(ctx, rng.int(1, 2), [20 * MIN_MS, 90 * MIN_MS], 8, 22);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "watchlist_sanctions");
    for (const at of times) {
      const base = { ...tag, at, subject: p, subtype: "p2p", channel: "Online", sender: ctx.internal(p), purpose: "personal", narrative: "Fund transfer" };
      if (variant === "customer") {
        ctx.txn({ ...base, amount: rng.money(20000, 600000), receiver: ctx.domesticPerson(), signals: [["sender_on_watchlist", true]] });
      } else if (variant === "beneficiary") {
        ctx.txn({ ...base, amount: rng.money(60000, 900000), receiver: ctx.domesticPerson(rng.pick(WATCHLIST_NAMES)), signals: [["beneficiary_on_watchlist", true]] });
      } else if (variant === "corridor") {
        const abroad = ctx.foreign("sanctioned", { kind: rng.chance(0.5) ? "person" : "company" });
        ctx.txn({
          ...base, ...wire(ctx), subtype: "remittance", currency: abroad.bank.currency, amount: rng.money(55000, 700000), receiver: abroad.party,
          purpose: "trade", narrative: "Payment for goods",
          signals: [["beneficiary_country_in_sanctioned_region", true], ["beneficiary_ofac_score", "HIGH"]],
        });
      } else {
        // The payment gateway already scored it as fraud before it was booked.
        ctx.txn({
          ...base, device: strangeDevice(ctx), amount: rng.money(510000, 1500000), receiver: ctx.domesticPerson(),
          riskScore: rng.int(91, 99), riskFlags: ["gateway-fraud-score"],
          signals: [["transaction_ip_flagged_as_high_risk", true]],
        });
      }
    }
    return times.length;
  },

  /** Dozens of tiny payments in an hour: card testing and wallet cycling. */
  micro_velocity(ctx) {
    const { rng } = ctx;
    const p = subject(ctx, "micro_velocity", inSegment("retail", "student", "newAccount"), 0.3);
    const times = schedule(ctx, rng.int(25, 60), [20 * SEC_MS, 110 * SEC_MS]);
    if (!p || !times) return 0;
    const tag = tagFor(ctx, "micro_velocity");
    const payees = Array.from({ length: rng.int(2, 5) }, () => ctx.wallet());
    for (const at of times) {
      ctx.txn({
        ...tag, at, subject: p, subtype: "p2p", channel: "Mobile",
        amount: rng.chance(0.12) ? rng.money(0.1, 0.95) : rng.money(20, 950),
        sender: ctx.internal(p), receiver: rng.pick(payees),
        purpose: "personal", narrative: "Payment",
        signals: [["high_volume_low_value_pattern", true]],
      });
    }
    return times.length;
  },
};

// weight: how often an incident of this kind starts, relative to the others.
// targets: the rules / collective signals the incident is built to trip.
const CATALOGUE = [
  { key: "structuring_cash", weight: 6, caseType: "AML", label: "Cash structuring under BDT 10 lakh", targets: "R4, R37, R84, structuring count" },
  { key: "structuring_transfers", weight: 5, caseType: "AML", label: "Transfers in the 9,000–9,999 band", targets: "R21, R22, structuring count" },
  { key: "rapid_fire", weight: 6, caseType: "Fraud", label: "Account-takeover drain, seconds apart", targets: "R81, R223, new device" },
  { key: "amount_spike", weight: 9, caseType: "Fraud", label: "Amount far above the customer's baseline", targets: "R82, R25, R11, R1, z-score" },
  { key: "burst_large", weight: 6, caseType: "Fraud", label: "Five or more large transfers in a day", targets: "R84, R8" },
  { key: "fan_out", weight: 4, caseType: "AML", label: "One sender to 12+ beneficiaries", targets: "fan-out, R223" },
  { key: "fan_in", weight: 4, caseType: "AML", label: "12+ senders to one account, then emptied", targets: "fan-in, pass-through, R18" },
  { key: "pass_through", weight: 8, caseType: "AML", label: "Mule account: in and straight out", targets: "pass-through ratio, R8" },
  { key: "layering_chain", weight: 4, caseType: "AML", label: "Multi-hop layering, offshore exit or loop", targets: "pass-through, R215, R216, R70, R1" },
  { key: "cross_border_high_risk", weight: 8, caseType: "AML", label: "Wires to high-risk, offshore and trade-hub jurisdictions", targets: "R5, R3, R79, R38–R40, R69, R70, R23" },
  { key: "crypto_exposure", weight: 6, caseType: "AML", label: "Mixer / darknet / shell-VASP exposure", targets: "R6, R28, R29, R43–R60, R101, R107–R118" },
  { key: "profile_mismatch", weight: 9, caseType: "Fraud", label: "Activity that contradicts the KYC profile", targets: "R124, R129–R138, R227, R228, R237, R229, R230" },
  { key: "new_account_abuse", weight: 5, caseType: "Fraud", label: "New account funded and cashed out", targets: "R221, R18, pass-through" },
  { key: "dormant_reactivation", weight: 4, caseType: "Fraud", label: "Dormant account suddenly active", targets: "R225, R223, R82" },
  { key: "remittance_mismatch", weight: 5, caseType: "AML", label: "Large remittances to a student / unemployed profile", targets: "R78, R5, R19, fan-in" },
  { key: "gambling", weight: 4, caseType: "Fraud", label: "Stakes with offshore betting operators", targets: "R7, R30, R31, R32, R5" },
  { key: "high_value_channel", weight: 9, caseType: "Fraud", label: "Single large cash / ATM / agent / pending / round-amount transactions", targets: "R1, R4, R9, R10, R11, R18, R23, R26, R27, R186, R187" },
  { key: "integrity_anomaly", weight: 5, caseType: "Fraud", label: "Placeholder parties and malformed accounts", targets: "R12, R14, R72, R185, R189, R191, R198, R244" },
  { key: "watchlist_sanctions", weight: 5, caseType: "TF", label: "Sanctions and watchlist exposure", targets: "R201, R206, R207, R208, R211, R255, R271" },
  { key: "micro_velocity", weight: 2, caseType: "Fraud", label: "Dozens of tiny payments in an hour", targets: "R2, R81, R239, R269, R270" },
];

/**
 * Start incidents on the open day until about `budget` transactions have been
 * written. Returns the number actually written (the last incident may overshoot).
 */
function generateTypologies(ctx, budget) {
  const pairs = CATALOGUE.map((t) => [t.key, t.weight]);
  let made = 0;
  let misses = 0;
  while (made < budget && misses < 40) {
    const produced = RUNNERS[ctx.rng.weighted(pairs)](ctx);
    if (produced) made += produced;
    else misses++;
  }
  return made;
}

module.exports = { generateTypologies, CATALOGUE, RUNNERS };
