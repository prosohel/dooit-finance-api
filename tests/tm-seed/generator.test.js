/**
 * Transaction-monitoring seed — the generator and its audit (no database).
 *
 * The seed is only useful if (a) what it writes is valid, (b) the planted
 * incidents really have the shape a detector looks for, and (c) ordinary
 * traffic does not. These tests pin all three, plus reproducibility.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const Customer = require("../../models/Customer");
const CustomerAccount = require("../../models/CustomerAccount");
const Transaction = require("../../models/Transaction");
const ruleEvaluation = require("../../services/ruleEvaluation");

const { createGenerator } = require("../../seeds/tmTransactions/generate");
const { createAudit } = require("../../seeds/tmTransactions/audit");
const { CATALOGUE } = require("../../seeds/tmTransactions/typologies");
const { dhakaDate } = require("../../seeds/tmTransactions/context");
const { MARK, SOURCE } = require("../../seeds/tmTransactions/reference");

// 15:00 in Dhaka on 5 Nov 2026 — the last generated day is a partial one.
const NOW = Date.parse("2026-11-05T09:00:00Z");
const IDS = {
  clientId: new mongoose.Types.ObjectId(),
  branchId: new mongoose.Types.ObjectId(),
  authorId: new mongoose.Types.ObjectId(),
};

const build = (over = {}) => {
  const generator = createGenerator({ ...IDS, institution: "Prime Bank PLC", now: NOW, stamp: 1, seed: 42, customers: 120, days: 20, perDay: 400, ...over });
  const txns = [];
  for (const day of generator.days()) txns.push(...day.txns);
  return { ...generator, txns };
};

const groupBy = (list, key) =>
  list.reduce((map, item) => {
    const k = key(item);
    if (k !== null && k !== undefined) (map[k] = map[k] || []).push(item);
    return map;
  }, {});

let data;
let incidents; // { typology: [[txn, …], …] }
beforeAll(() => {
  data = build();
  const byIncident = groupBy(data.txns, (t) => t.metadata.incident);
  incidents = groupBy(Object.values(byIncident), (list) => list[0].metadata.typology);
});

describe("dataset", () => {
  test("the same seed reproduces the same data", () => {
    const again = build();
    const shape = (t) => [t.timestamp.getTime(), t.amount, t.currency, t.type, t.channel, t.metadata.typology, t.sender.name, t.receiver.name];
    expect(again.txns.map(shape)).toEqual(data.txns.map(shape));
    expect(build({ seed: 43 }).txns.map(shape)).not.toEqual(data.txns.map(shape));
  });

  test("every document passes its model's validation", async () => {
    const { cohort, txns } = build({ customers: 40, days: 4, perDay: 150 });
    for (const doc of cohort.customers) await new Customer(doc).validate();
    for (const doc of cohort.accounts) await new CustomerAccount(doc).validate();
    for (const doc of txns) await new Transaction(doc).validate();
    expect(cohort.customers).toHaveLength(40);
    expect(cohort.accounts).toHaveLength(40);
  });

  test("nothing is dated in the future, and days are Asia/Dhaka days", () => {
    for (const day of build({ customers: 40, days: 3, perDay: 200 }).days()) {
      for (const t of day.txns) {
        expect(t.timestamp.getTime()).toBeLessThan(NOW);
        expect(dhakaDate(t.timestamp.getTime())).toBe(day.date);
      }
    }
    expect(dhakaDate(Math.max(...data.txns.map((t) => t.timestamp.getTime())))).toBe("2026-11-05");
  });

  test("rows carry the seed marker, and never the one seedCaseWorkflow cleans", () => {
    const uids = [...data.txns.map((t) => t.uid), ...data.cohort.customers.map((c) => c.uid), ...data.cohort.accounts.map((a) => a.uid)];
    expect(new Set(uids).size).toBe(uids.length);
    for (const uid of uids) {
      expect(uid).toContain(MARK);
      expect(uid).not.toMatch(/SEED/);
    }
    expect(data.txns.every((t) => t.metadata.source === SOURCE)).toBe(true);
    expect(data.cohort.customers.every((c) => c.metadata.source === SOURCE)).toBe(true);
  });

  test("transfers name both parties and mirror receiver into beneficiary", () => {
    for (const t of data.txns) {
      expect(t.sender.name).toBeTruthy();
      expect(t.receiver.name).toBeTruthy();
      expect(t.beneficiary).toEqual(t.receiver);
    }
  });

  test("about the requested share is planted, across every typology", () => {
    const planted = data.txns.filter((t) => t.metadata.typology && t.metadata.typology !== "kyc_profile_gap");
    const share = planted.length / data.txns.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.42);
    for (const { key } of CATALOGUE) expect(Object.keys(incidents)).toContain(key);
  });
});

describe("ordinary traffic", () => {
  const ordinary = () => data.txns.filter((t) => !t.metadata.typology);

  test("stays under the plain-amount High thresholds", () => {
    for (const t of ordinary()) {
      expect(t.currency === "BDT" ? t.amount : 0).toBeLessThanOrEqual(95000);
      if (t.amount >= 50000) expect(Math.floor(t.amount) % 500).not.toBe(0);
    }
  });

  test("avoids the words keyword rules look for", () => {
    const keywords = /cash|invoice|services|consult|gift|loan|crypto|exchange|unknown|test|sample|\?\?\?/i;
    for (const t of ordinary()) {
      expect(t.narrative).not.toMatch(keywords);
      expect(t.reference).not.toMatch(/test|sample/i);
    }
  });

  test("respects what the customer's profile allows", () => {
    const { profilesById } = data.ctx;
    // Whichever side of the payment the customer is on.
    for (const t of ordinary()) {
      for (const party of [t.sender, t.receiver]) {
        const p = party.customer ? profilesById.get(String(party.customer)) : null;
        if (!p) continue;
        expect(t.timestamp.getTime()).toBeGreaterThan(p.openedAt);
        expect(t.timestamp.getTime()).toBeLessThan(p.activeUntil);
        if (p.traits.has("minor")) expect(t.amount).toBeLessThanOrEqual(4500);
        if (p.segment === "newAccount" || p.traits.has("unemployed") || p.traits.has("elderly")) expect(t.amount).toBeLessThanOrEqual(45000);
      }
    }
  });
});

describe("typologies have the shape they claim", () => {
  const each = (key, check) => {
    expect(incidents[key].length).toBeGreaterThan(0);
    incidents[key].forEach((list) => check([...list].sort((a, b) => a.timestamp - b.timestamp)));
  };

  test("structuring_cash: four or more cash deposits just under BDT 10 lakh", () => {
    each("structuring_cash", (list) => {
      expect(list.length).toBeGreaterThanOrEqual(4);
      for (const t of list) {
        expect(t.type).toBe("deposit");
        expect(t.channel).toBe("CASH");
        expect(t.amount).toBeGreaterThanOrEqual(900000);
        expect(t.amount).toBeLessThan(1000000);
      }
    });
  });

  test("structuring_transfers: amounts in the 9,000–9,999 band", () => {
    each("structuring_transfers", (list) => {
      expect(list.length).toBeGreaterThanOrEqual(6);
      for (const t of list) {
        expect(t.amount).toBeGreaterThanOrEqual(9000);
        expect(t.amount).toBeLessThan(10000);
      }
    });
  });

  test("rapid_fire: consecutive transfers under 60 seconds apart", () => {
    each("rapid_fire", (list) => {
      expect(list.length).toBeGreaterThanOrEqual(8);
      for (let i = 1; i < list.length; i++) expect(list[i].timestamp - list[i - 1].timestamp).toBeLessThan(60000);
    });
  });

  test("burst_large: the last five transfers sum past 1,000,000", () => {
    each("burst_large", (list) => {
      const lastFive = list.slice(-5).reduce((sum, t) => sum + t.amount, 0);
      expect(list.length).toBeGreaterThanOrEqual(5);
      expect(lastFive).toBeGreaterThan(1000000);
    });
  });

  test("fan_out: twelve or more distinct beneficiaries from one sender", () => {
    each("fan_out", (list) => {
      const outgoing = list.filter((t) => t.sender.customer);
      expect(new Set(outgoing.map((t) => String(t.sender.customer))).size).toBe(1);
      expect(new Set(outgoing.map((t) => t.receiver.account)).size).toBeGreaterThanOrEqual(12);
    });
  });

  test("fan_in: twelve or more senders into one account", () => {
    each("fan_in", (list) => {
      const account = list[0].receiver.account;
      const incoming = list.filter((t) => t.receiver.account === account && t.sender.account !== account);
      expect(incoming.length).toBeGreaterThanOrEqual(12);
    });
  });

  test("pass_through: at least 90% of what came in goes straight out", () => {
    each("pass_through", (list) => {
      const [first, ...rest] = list;
      const out = rest.reduce((sum, t) => sum + t.amount, 0);
      expect(String(first.receiver.customer)).toBe(String(rest[0].sender.customer));
      expect(out / first.amount).toBeGreaterThanOrEqual(0.9);
      expect(out / first.amount).toBeLessThanOrEqual(1);
      expect(rest[rest.length - 1].timestamp - first.timestamp).toBeLessThan(3 * 3600e3);
    });
  });

  test("layering_chain: each hop forwards what the previous one received", () => {
    each("layering_chain", (list) => {
      expect(list.length).toBeGreaterThanOrEqual(5);
      for (let i = 1; i < list.length; i++) {
        expect(String(list[i].sender.customer)).toBe(String(list[i - 1].receiver.customer));
        expect(list[i].amount).toBeLessThan(list[i - 1].amount);
        expect(list[i].amount).toBeGreaterThan(list[i - 1].amount * 0.98);
      }
    });
  });

  test("new_account_abuse: the account is under 30 days old", () => {
    each("new_account_abuse", (list) => {
      const p = data.ctx.profilesById.get(String(list[0].receiver.customer));
      expect(p.segment).toBe("newAccount");
      expect(list[0].timestamp.getTime() - p.openedAt).toBeLessThan(30 * 86400e3);
      expect(list[0].timestamp.getTime()).toBeGreaterThan(p.openedAt);
    });
  });

  test("crypto_exposure: wallet, travel-rule and forensic evidence are present", () => {
    each("crypto_exposure", (list) => {
      for (const t of list) {
        expect(t.crypto.walletAddress).toBeTruthy();
        expect(t.travelRule.travelMessageId).toBeTruthy();
        expect(t.forensic.notes).toBeTruthy();
        expect(t.amount).toBeGreaterThan(150000);
      }
    });
  });
});

describe("audit", () => {
  const rule = (ruleId, riskLabel, conditions) => ({ ruleId, ruleName: ruleId, riskLabel, appliesTo: "transaction", conditions, ruleCondition: "x" });

  test("collective context follows a customer across transactions", () => {
    const customer = new mongoose.Types.ObjectId();
    const txn = (minute, amount) => ({
      uid: `t${minute}`,
      type: "transfer",
      amount,
      currency: "BDT",
      timestamp: new Date(Date.parse("2026-11-04T04:00:00Z") + minute * 60000),
      sender: { customer, name: "A", account: "1" },
      receiver: { name: `B${minute}`, account: `b${minute}` },
      beneficiary: { name: `B${minute}`, account: `b${minute}` },
      metadata: { typology: null, incident: null },
    });
    const audit = createAudit();
    const first = audit.contextFor(txn(0, 400000), "2026-11-04");
    const second = audit.contextFor(txn(0.5, 700000), "2026-11-04");
    expect(first).toMatchObject({ secsSincePrev: null, pctChange: null, sumLast5: 400000, uniqueBeneficiaries: 1 });
    expect(second).toMatchObject({ secsSincePrev: 30, pctChange: 75, sumLast5: 1100000, count24h: 2, uniqueBeneficiaries: 2 });
  });

  test("planted transactions read as High far more often than ordinary ones", () => {
    const rules = [
      rule("R1", "High", [{ field: "amount", operator: "gt", value: 1000000 }]),
      rule("R4", "High", [{ field: "amount", operator: "gt", value: 750000 }, { field: "channel", operator: "eq", value: "CASH" }]),
      rule("R121", "High", [{ field: "customer.personalKyc.funds_wealth.source_of_funds", operator: "eq", value: "UNKNOWN" }]),
    ];
    const { ctx, days } = build({ customers: 80, days: 12, perDay: 300 });
    const audit = createAudit({ rules, ruleEvaluation, profilesById: ctx.profilesById });
    for (const day of days()) audit.observe(day.date, day.txns);
    const report = audit.report();

    expect(report.transactions).toBe(report.planted + report.baseline);
    // Three rules is a thin corpus; the full one takes planted well past 90%.
    const plantedRate = report.predicted.plantedHigh / report.planted;
    const ordinaryRate = report.predicted.baselineHigh / report.baseline;
    expect(plantedRate).toBeGreaterThan(0.55);
    expect(ordinaryRate).toBeLessThan(0.25);
    expect(plantedRate).toBeGreaterThan(ordinaryRate * 2.5);
    expect(report.topRules.map((r) => r.ruleId)).toEqual(expect.arrayContaining(["R1", "R4", "R121", "R81", "R84"]));
    expect(report.byTypology.structuring_cash.high).toBe(report.byTypology.structuring_cash.txns);
  });
});
