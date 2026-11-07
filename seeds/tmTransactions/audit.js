// seeds/tmTransactions/audit.js
//
// Checks that the generated data really is flaggable, before anything is
// written. Two independent readings of every transaction:
//
//   1. Rule hits — the application's own evaluator (services/ruleEvaluation)
//      run against the Rule Engine corpus. Amounts are compared in their
//      native currency, as the monitoring service does (its sample evidence
//      quotes BDT sums), so `convertedAmountAUD` is left out of the view.
//
//   2. Collective context — the per-customer figures the monitoring API
//      returns in `collectiveContext` (24-hour counts and sums, last-5 sum,
//      unique counterparties, change against the previous amount, 30-day
//      z-score, frequency change, structuring count, pass-through ratio),
//      recomputed here from the generated transactions.
//
// This is a prediction, not the service's verdict: its ML and DL detectors
// and its typology thresholds are its own. The thresholds below are stated
// so the numbers can be read for what they are.

const { DAY_MS, dhakaHour } = require("./context");

const LABEL_RANK = { Info: 0, Low: 1, Medium: 2, High: 3, Critical: 4 };

// Collective rules the corpus states in words the evaluator cannot parse
// ("Sum of last 5 transactions > 1,000,000"); checked here from the context.
const COLLECTIVE_RULES = [
  { id: "R81", name: "rapid_tx", label: "High", test: (c) => c.secsSincePrev !== null && c.secsSincePrev < 60 },
  { id: "R82", name: "sudden_amt_increase", label: "Medium", test: (c) => c.pctChange !== null && c.pctChange > 50 },
  { id: "R83", name: "sudden_amt_drop", label: "Medium", test: (c) => c.pctChange !== null && c.pctChange < -50 },
  { id: "R84", name: "burst_large", label: "High", test: (c) => c.sumLast5 > 1000000 },
  { id: "R223", name: "sudden_freq_increase", label: "High", test: (c) => c.freqChangePct !== null && c.freqChangePct > 300 },
];

// Typology signals with no rule id of their own. Thresholds are this audit's.
const COLLECTIVE_SIGNALS = [
  { id: "fan_out", text: "sender paid 10+ distinct beneficiaries today", test: (c) => c.uniqueBeneficiaries >= 10 },
  { id: "fan_in", text: "beneficiary paid by 10+ distinct senders today", test: (c) => c.uniqueSenders >= 10 },
  { id: "pass_through", text: "pass-through ratio 0.9+ on 150,000+ received in 24 hours", test: (c) => c.passThroughRatio >= 0.9 && c.inflow24h >= 150000 },
  { id: "structuring", text: "3+ sub-threshold amounts in 24 hours", test: (c) => c.structuringCount >= 3 },
  { id: "zscore", text: "amount 3+ standard deviations above 30-day mean", test: (c) => c.zscore !== null && c.zscore >= 3 },
];

// Just-below-threshold bands: BDT 10 lakh (BFIU cash reporting) and 10,000.
const inStructuringBand = (amount) => (amount >= 900000 && amount < 1000000) || (amount >= 9000 && amount < 10000);

const partyKey = (party) => {
  if (!party) return null;
  if (party.customer) return `cust:${party.customer}`;
  if (party.account) return `acct:${party.account}`;
  return party.name ? `name:${party.name}` : null;
};

const prune = (queue, cutoff) => {
  while (queue.length && queue[0].at < cutoff) queue.shift();
};
const total = (queue) => queue.reduce((sum, row) => sum + row.amount, 0);

function createAudit({ rules = [], ruleEvaluation = null, profilesById = new Map() } = {}) {
  const executables = [];
  if (ruleEvaluation) {
    for (const rule of rules) {
      if (rule.appliesTo && rule.appliesTo !== "transaction") continue;
      const executable = ruleEvaluation.resolveExecutable(rule);
      if (executable) executables.push({ rule, tree: executable.tree });
    }
  }
  const ruleIndex = [...executables.map((e) => e.rule), ...COLLECTIVE_RULES.map((r) => ({ ruleId: r.id, ruleName: r.name, riskLabel: r.label }))];

  const parties = new Map();
  const stateOf = (key) => {
    let s = parties.get(key);
    if (!s) {
      s = { firstAt: null, prevAt: null, prevAmount: null, last5: [], out24: [], in24: [], hist30: [], band24: [], day: null, beneficiaries: new Set(), senders: new Set() };
      parties.set(key, s);
    }
    return s;
  };
  const onDay = (s, date) => {
    if (s.day !== date) {
      s.day = date;
      s.beneficiaries = new Set();
      s.senders = new Set();
    }
  };

  const rows = []; // one compact row per transaction, finalised in report()
  const amountByCurrency = {};

  /** Collective context for one transaction; updates the running state. */
  function contextFor(txn, date) {
    const at = txn.timestamp.getTime();
    const amount = txn.amount;
    const senderKey = partyKey(txn.sender);
    const beneficiaryKey = partyKey(txn.beneficiary);
    const c = {
      secsSincePrev: null, pctChange: null, sumLast5: 0, count24h: 0, sum24h: 0, count30d: 0, zscore: null,
      freqChangePct: null, uniqueBeneficiaries: 0, uniqueSenders: 0, structuringCount: 0, passThroughRatio: 0, inflow24h: 0,
    };

    // Money direction: a deposit is an inflow to the receiver, a withdrawal an
    // outflow from the sender, a transfer is both.
    const moneyOut = txn.type === "transfer" || txn.type === "withdrawal";
    const moneyIn = txn.type === "transfer" || txn.type === "deposit";

    // Collective figures are kept for the institution's own customers only.
    // An employer paying 200 salaries or a utility collecting 300 bills is a
    // counterparty, not a subject, and would otherwise read as fan-out/fan-in.
    const senderIsCustomer = Boolean(senderKey && txn.sender.customer);
    const beneficiaryIsCustomer = Boolean(beneficiaryKey && txn.beneficiary.customer);

    if (senderIsCustomer) {
      const s = stateOf(senderKey);
      onDay(s, date);
      if (s.prevAt !== null) c.secsSincePrev = (at - s.prevAt) / 1000;
      if (s.prevAmount) c.pctChange = ((amount - s.prevAmount) / s.prevAmount) * 100;

      if (s.firstAt === null) s.firstAt = at;
      prune(s.hist30, at - 30 * DAY_MS);
      if (s.hist30.length >= 10) {
        const mean = total(s.hist30) / s.hist30.length;
        const variance = s.hist30.reduce((sum, r) => sum + (r.amount - mean) ** 2, 0) / s.hist30.length;
        if (variance > 0) c.zscore = (amount - mean) / Math.sqrt(variance);
      }
      s.hist30.push({ at, amount });
      c.count30d = s.hist30.length;

      s.last5.push(amount);
      if (s.last5.length > 5) s.last5.shift();
      c.sumLast5 = s.last5.reduce((a, b) => a + b, 0);

      const last24 = s.hist30.filter((r) => r.at >= at - DAY_MS);
      c.count24h = last24.length;
      c.sum24h = total(last24);
      // Last 24 hours against the customer's daily average. With a full window
      // this is the API sample's figure (3 in 24h, 34 in 30d → +155.9%); until
      // a week of history exists there is no average to compare against.
      const daysObserved = Math.min(29, (at - s.firstAt) / DAY_MS);
      if (daysObserved >= 7 && c.count30d >= 5) c.freqChangePct = (c.count24h / (c.count30d / daysObserved) - 1) * 100;

      if (beneficiaryKey && beneficiaryKey !== senderKey) s.beneficiaries.add(beneficiaryKey);
      c.uniqueBeneficiaries = s.beneficiaries.size;

      prune(s.band24, at - DAY_MS);
      if (inStructuringBand(amount)) s.band24.push({ at, amount });
      c.structuringCount = s.band24.length;

      if (moneyOut) {
        prune(s.out24, at - DAY_MS);
        prune(s.in24, at - DAY_MS);
        s.out24.push({ at, amount });
        const inflow = total(s.in24);
        const outflow = total(s.out24);
        c.inflow24h = inflow;
        if (inflow > 0) c.passThroughRatio = Math.min(inflow, outflow) / Math.max(inflow, outflow);
      }
      s.prevAt = at;
      s.prevAmount = amount;
    }

    if (beneficiaryIsCustomer) {
      const b = stateOf(beneficiaryKey);
      onDay(b, date);
      if (senderKey && senderKey !== beneficiaryKey) b.senders.add(senderKey);
      c.uniqueSenders = b.senders.size;
      if (moneyIn) {
        prune(b.in24, at - DAY_MS);
        b.in24.push({ at, amount });
      }
      // Cash paid in by a third party is structured into the receiving account.
      if (!senderIsCustomer) {
        prune(b.band24, at - DAY_MS);
        if (inStructuringBand(amount)) b.band24.push({ at, amount });
        c.structuringCount = b.band24.length;
      }
    }
    return c;
  }

  /** The transaction as a rule sees it: party customers populated, native amounts. */
  function ruleView(txn) {
    const populate = (party) => {
      const profile = party && party.customer ? profilesById.get(String(party.customer)) : null;
      return profile ? { ...party, customer: profile.doc } : party;
    };
    const { convertedAmountAUD, ...native } = txn;
    return {
      ...native,
      sender: populate(txn.sender),
      receiver: populate(txn.receiver),
      beneficiary: populate(txn.beneficiary),
      // "Hour" (rule R25) is local time in the service's timezone.
      signals: [...(txn.signals || []), { key: "hour", value: dhakaHour(txn.timestamp.getTime()) }],
    };
  }

  /** Feed one day's transactions, in timestamp order. */
  function observe(date, txns) {
    for (const txn of txns) {
      const context = contextFor(txn, date);
      const fired = [];
      if (executables.length) {
        const view = ruleView(txn);
        executables.forEach((e, i) => {
          if (ruleEvaluation.evaluateTree(e.tree, view, { subject: "transaction" }).matched) fired.push(i);
        });
      }
      COLLECTIVE_RULES.forEach((r, i) => {
        if (r.test(context)) fired.push(executables.length + i);
      });
      const signals = COLLECTIVE_SIGNALS.filter((s) => s.test(context)).map((s) => s.id);

      rows.push({ date, typology: txn.metadata.typology, incident: txn.metadata.incident, fired, signals });
      const cur = (amountByCurrency[txn.currency] = amountByCurrency[txn.currency] || { count: 0, sum: 0 });
      cur.count++;
      cur.sum += txn.amount;
    }
  }

  function report() {
    const isPlanted = (row) => row.typology !== null;
    const baseline = rows.filter((row) => !isPlanted(row));

    // A rule that fires on a fifth of ordinary traffic does not discriminate;
    // it is listed, and kept out of the headline figures.
    const baselineHits = new Array(ruleIndex.length).fill(0);
    for (const row of baseline) for (const i of row.fired) baselineHits[i]++;
    const broad = new Set(baselineHits.map((n, i) => (baseline.length && n / baseline.length > 0.2 ? i : -1)).filter((i) => i >= 0));
    // The two "changed by 50% against the previous amount" rules are Medium by
    // design and broad by nature; they stay in, as Medium.
    COLLECTIVE_RULES.forEach((r, i) => r.label === "Medium" && broad.delete(executables.length + i));

    const rank = (row) => {
      let best = 0;
      for (const i of row.fired) if (!broad.has(i)) best = Math.max(best, LABEL_RANK[ruleIndex[i].riskLabel] || 0);
      if (row.signals.length) best = Math.max(best, LABEL_RANK.High);
      return best;
    };

    const hitCounts = new Array(ruleIndex.length).fill(0);
    const ordinaryReasons = {}; // what put an ordinary transaction at High
    const byTypology = {};
    const byDay = {};
    const signalCounts = {};
    const labelCounts = { Critical: 0, High: 0, Medium: 0, Low: 0, none: 0 };
    let plantedHigh = 0;
    let baselineHigh = 0;

    for (const row of rows) {
      const best = rank(row);
      const high = best >= LABEL_RANK.High;
      labelCounts[best === 4 ? "Critical" : best === 3 ? "High" : best === 2 ? "Medium" : best === 1 ? "Low" : "none"]++;
      for (const i of row.fired) hitCounts[i]++;
      for (const s of row.signals) signalCounts[s] = (signalCounts[s] || 0) + 1;

      const day = (byDay[row.date] = byDay[row.date] || { total: 0, planted: 0, high: 0 });
      day.total++;
      if (high) day.high++;

      if (isPlanted(row)) {
        day.planted++;
        if (high) plantedHigh++;
        const t = (byTypology[row.typology] = byTypology[row.typology] || { txns: 0, high: 0, incidents: new Set(), rules: {} });
        t.txns++;
        if (high) t.high++;
        if (row.incident) t.incidents.add(row.incident);
        for (const i of row.fired) if (!broad.has(i)) t.rules[ruleIndex[i].ruleId] = (t.rules[ruleIndex[i].ruleId] || 0) + 1;
        for (const s of row.signals) t.rules[s] = (t.rules[s] || 0) + 1;
      } else if (high) {
        baselineHigh++;
        for (const i of row.fired) {
          if (!broad.has(i) && LABEL_RANK[ruleIndex[i].riskLabel] >= LABEL_RANK.High) ordinaryReasons[ruleIndex[i].ruleId] = (ordinaryReasons[ruleIndex[i].ruleId] || 0) + 1;
        }
        for (const s of row.signals) ordinaryReasons[s] = (ordinaryReasons[s] || 0) + 1;
      }
    }

    const planted = rows.length - baseline.length;
    const describe = (i) => ({ ruleId: ruleIndex[i].ruleId, ruleName: ruleIndex[i].ruleName, riskLabel: ruleIndex[i].riskLabel, count: hitCounts[i] });

    return {
      transactions: rows.length,
      planted,
      baseline: baseline.length,
      rulesEvaluated: executables.length + COLLECTIVE_RULES.length,
      predicted: {
        high: labelCounts.Critical + labelCounts.High,
        byLabel: labelCounts,
        plantedHigh,
        baselineHigh,
      },
      topRules: hitCounts
        .map((n, i) => i)
        .filter((i) => hitCounts[i] > 0 && !broad.has(i))
        .sort((a, b) => hitCounts[b] - hitCounts[a])
        .map(describe),
      broadRules: [...broad].map(describe),
      ordinaryReasons: Object.entries(ordinaryReasons).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, count]) => ({ id, count })),
      collectiveSignals: COLLECTIVE_SIGNALS.map((s) => ({ id: s.id, text: s.text, count: signalCounts[s.id] || 0 })),
      byTypology: Object.fromEntries(
        Object.entries(byTypology).map(([key, t]) => [
          key,
          {
            incidents: t.incidents.size,
            txns: t.txns,
            high: t.high,
            topRules: Object.entries(t.rules).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id),
          },
        ])
      ),
      byDay,
      amountByCurrency: Object.fromEntries(Object.entries(amountByCurrency).map(([cur, v]) => [cur, { count: v.count, sum: Math.round(v.sum * 100) / 100 }])),
    };
  }

  return { observe, report, contextFor };
}

module.exports = { createAudit, COLLECTIVE_RULES, COLLECTIVE_SIGNALS };
