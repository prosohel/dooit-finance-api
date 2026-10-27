/**
 * Case ↔ alert ↔ customer (POI) linkage — docs/74 §6.1, phase C1.
 *
 *   services/caseLinking        deriveCaseRisk · attachAlertsToCase · detachAlertFromCase ·
 *                               addCustomersToCase · removeCustomerFromCase · listAttachableCases
 *   POST /alert/:id/escalate    create · attach:'auto' · caseId · closed-case guard
 *   GET  /alert/:id/attachable-cases
 *   POST /cases/:id/alerts · DELETE /cases/:id/alerts/:alertId
 *   POST /cases/:id/customers · DELETE /cases/:id/customers/:customerId
 *
 * Same harness as tests/alerts: in-memory Mongo, handlers called directly with
 * a stub req/res/next.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let Case, Alert, Transaction, Customer, AuditLog, linking, alertCtrl, caseCtrl;

const call = (handler, { params = {}, query = {}, body = {}, user } = {}) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; resolve({ res, err: null }); return this; },
    };
    const next = (e) => resolve({ res, err: e || null });
    const timer = setTimeout(() => resolve({ res, err: new Error("handler did not respond") }), 10000);
    Promise.resolve(handler({ params, query, body, user, headers: {}, ip: "127.0.0.1" }, res, next)).finally(() => clearTimeout(timer));
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  require("../../models/User");
  require("../../models/Client");
  require("../../models/Branch");
  require("../../models/Counter");
  require("../../models/Notify");
  require("../../models/RuleEngine");
  require("../../models/RuleEngineVersion");
  require("../../models/CaseNote");
  Case = require("../../models/Case");
  Alert = require("../../models/Alert");
  Transaction = require("../../models/Transaction");
  Customer = require("../../models/Customer");
  AuditLog = require("../../models/AuditLog");
  linking = require("../../services/caseLinking");
  alertCtrl = require("../../controllers/alertController");
  caseCtrl = require("../../controllers/caseController");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const user = { _id: new mongoose.Types.ObjectId(), name: "Ayesha Rahman", role: "admin" };
const CLIENT = new mongoose.Types.ObjectId();

let poi, counterparty, txn1, txn2, alert1, alert2;

const makeAlert = (over = {}) =>
  Alert.create({
    customer: poi._id,
    caseType: "AML",
    riskScore: 55,
    riskLabel: "Medium",
    alertOrigin: "Rule Based",
    ruleId: "R-1",
    ruleName: "Rule one",
    ...over,
  });

beforeEach(async () => {
  await Promise.all([Case.deleteMany({}), Alert.deleteMany({}), Transaction.deleteMany({}), Customer.deleteMany({}), AuditLog.deleteMany({})]);
  const relations = [{ client: CLIENT, type: "individual", registeredAt: new Date("2026-06-01") }];
  poi = await Customer.create({ country: "AU", relations });
  counterparty = await Customer.create({ country: "NL", relations });
  // txn1: POI pays the counterparty (both are our customers → both become POIs)
  txn1 = await Transaction.create({
    amount: 48175, currency: "AUD", type: "transfer",
    sender: { customer: poi._id, name: "POI" }, receiver: { customer: counterparty._id, name: "CP" },
    timestamp: new Date(),
  });
  txn2 = await Transaction.create({
    amount: 265754, currency: "USD", convertedAmountAUD: 403946, type: "withdrawal",
    sender: { customer: poi._id, name: "POI" }, timestamp: new Date(),
  });
  alert1 = await makeAlert({ transaction: txn1._id, riskScore: 55, riskLabel: "Medium" });
  alert2 = await makeAlert({ transaction: txn2._id, riskScore: 85, riskLabel: "High", ruleId: "R-2", ruleName: "Rule two", caseType: "Fraud" });
});

// ── deriveCaseRisk ──────────────────────────────────────────────────────────

describe("case identity", () => {
  test("a created case gets a uid in the same write, with no counter involved", async () => {
    const created = await Case.create({ title: "Identified", createdBy: user._id });
    expect(created.uid).toMatch(/^CA-\d{13}-\d{6}$/);

    // It is on the document the caller holds AND in the database — the old
    // sequence-derived version produced neither (docs/74 C17).
    const stored = await Case.findById(created._id).lean();
    expect(stored.uid).toBe(created.uid);
    expect(stored.sequence).toBeUndefined();
  });

  test("cases minted together stay unique", async () => {
    // Same millisecond is the case the random suffix exists for; the unique
    // index would reject a collision, so creating a batch must not throw.
    const batch = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        Case.create({ title: `Batch ${i}`, createdBy: user._id })
      )
    );
    expect(new Set(batch.map((c) => c.uid)).size).toBe(25);
  });
});

describe("tenancy (docs/74 C15)", () => {
  const BRANCH = new mongoose.Types.ObjectId();
  const admin = { _id: user._id, name: "Platform Admin", role: "admin" }; // no client of their own

  test("a case inherits the alert's client and branch, not the escalating user's", async () => {
    await Alert.updateOne({ _id: alert1._id }, { $set: { client: CLIENT, branch: BRANCH } });
    const escalated = await Alert.findById(alert1._id).lean();

    // An admin has no tenant; the case must still belong to the alert's.
    const { res, err } = await call(alertCtrl.escalateAlertToCase, {
      params: { id: String(escalated._id) }, body: {}, user: admin,
    });
    expect(err).toBeNull();

    const c = await Case.findById(res.body.data._id).lean();
    expect(String(c.client)).toBe(String(CLIENT));
    expect(String(c.branch)).toBe(String(BRANCH));
  });

  test("createCase takes its tenant from the alerts too", async () => {
    await Alert.updateOne({ _id: alert1._id }, { $set: { client: CLIENT, branch: BRANCH } });
    const { res, err } = await call(caseCtrl.createCase, {
      body: { title: "From an admin", alertIds: [String(alert1._id)] }, user: admin,
    });
    expect(err).toBeNull();
    const c = await Case.findById(res.body.data._id).lean();
    expect(String(c.client)).toBe(String(CLIENT));
    expect(String(c.branch)).toBe(String(BRANCH));
  });

  test("a case can never hold another client's alert", async () => {
    const otherClient = new mongoose.Types.ObjectId();
    const caseDoc = await Case.create({ title: "Client A case", createdBy: user._id, client: CLIENT });
    await Alert.updateOne({ _id: alert2._id }, { $set: { client: otherClient } });

    const { err } = await call(caseCtrl.linkAlerts, {
      params: { id: String(caseDoc._id) }, body: { alertIds: [String(alert2._id)] }, user: admin,
    });
    expect(err).not.toBeNull();
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/different client or branch/i);
    expect((await Case.findById(caseDoc._id).lean()).linkedAlerts).toHaveLength(0);
  });

  test("a branch-less alert still belongs to any branch of its client", async () => {
    const caseDoc = await Case.create({
      title: "Branch case", createdBy: user._id, client: CLIENT, branch: BRANCH,
    });
    await Alert.updateOne({ _id: alert1._id }, { $set: { client: CLIENT, branch: null } });

    const { err } = await call(caseCtrl.linkAlerts, {
      params: { id: String(caseDoc._id) }, body: { alertIds: [String(alert1._id)] }, user: admin,
    });
    expect(err).toBeNull();
    expect((await Case.findById(caseDoc._id).lean()).linkedAlerts).toHaveLength(1);
  });
});

describe("deriveCaseRisk", () => {
  test("top-scoring alert sets score + label; most common caseType wins; priority follows the label", () => {
    const d = linking.deriveCaseRisk([
      { riskScore: 40, riskLabel: "Low", caseType: "AML" },
      { riskScore: 85, riskLabel: "high", caseType: "Fraud" },
      { riskScore: 60, riskLabel: "Medium", caseType: "AML" },
    ]);
    expect(d).toEqual({ riskScore: 85, riskLabel: "High", caseType: "AML", priority: "high" });
  });

  test("returns null with no scored alerts", () => {
    expect(linking.deriveCaseRisk([])).toBeNull();
    expect(linking.deriveCaseRisk([{ caseType: "AML" }])).toBeNull();
  });
});

// ── escalate: create ────────────────────────────────────────────────────────

describe("POST /alert/:id/escalate (no open case)", () => {
  test("creates a case, pulls customer + transaction + party customers, derives risk, updates the alert", async () => {
    const { res, err } = await call(alertCtrl.escalateAlertToCase, { params: { id: String(alert1._id) }, body: {}, user });
    expect(err).toBeNull();
    expect(res.statusCode).toBe(201);
    expect(res.body.attached).toBe(false);

    const c = await Case.findById(res.body.data._id).lean();
    expect(String(c.customer)).toBe(String(poi._id));                       // primary POI
    expect(c.linkedAlerts.map(String)).toEqual([String(alert1._id)]);
    expect(c.linkedTransactions.map(String)).toEqual([String(txn1._id)]);
    expect(c.linkedCustomers.map(String).sort()).toEqual([String(poi._id), String(counterparty._id)].sort()); // party pulled through (G13)
    expect(c.riskScore).toBe(55);
    expect(c.riskLabel).toBe("Medium");
    expect(c.caseType).toBe("AML");

    const a = await Alert.findById(alert1._id).lean();
    expect(a.status).toBe("escalated_to_case");
    expect(String(a.linkedCase)).toBe(String(c._id));
    expect(String(a.analyst)).toBe(String(user._id));                        // unowned alert → escalating user

    const t = await Transaction.findById(txn1._id).lean({ autopopulate: false });
    expect(String(t.investigation.case)).toBe(String(c._id));
    expect(t.investigation.flagged).toBe(true);

    const actions = (await AuditLog.find({ case: c._id }).lean()).map((r) => r.action).sort();
    expect(actions).toEqual(expect.arrayContaining(["case_created", "alert_linked"]));
  });
});

// ── escalate: attach ────────────────────────────────────────────────────────

describe("POST /alert/:id/escalate — attach to the customer's open case", () => {
  let caseId;
  beforeEach(async () => {
    const { res } = await call(alertCtrl.escalateAlertToCase, { params: { id: String(alert1._id) }, body: {}, user });
    caseId = res.body.data._id;
  });

  test("attach:'auto' lands on the existing case and raises the derived risk", async () => {
    const { res, err } = await call(alertCtrl.escalateAlertToCase, { params: { id: String(alert2._id) }, body: { attach: "auto" }, user });
    expect(err).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(res.body.attached).toBe(true);
    expect(String(res.body.data._id)).toBe(String(caseId));

    const c = await Case.findById(caseId).lean();
    expect(c.linkedAlerts.map(String).sort()).toEqual([String(alert1._id), String(alert2._id)].sort());
    expect(c.linkedTransactions.map(String).sort()).toEqual([String(txn1._id), String(txn2._id)].sort());
    expect(c.riskScore).toBe(85);          // max of 55 / 85
    expect(c.riskLabel).toBe("High");
    expect(c.priority).toBe("high");       // raised from medium
    expect(c.caseType).toBe("AML");        // kept — only filled when empty
    expect(await Case.countDocuments({})).toBe(1);

    const a = await Alert.findById(alert2._id).lean();
    expect(String(a.linkedCase)).toBe(String(caseId));
    expect(a.activity.at(-1).title).toBe("Attached to case");
  });

  test("without attach a second case is created (today's behaviour is preserved)", async () => {
    const { res } = await call(alertCtrl.escalateAlertToCase, { params: { id: String(alert2._id) }, body: {}, user });
    expect(res.statusCode).toBe(201);
    expect(res.body.attached).toBe(false);
    expect(await Case.countDocuments({})).toBe(2);
  });

  test("explicit caseId attaches; a closed case is refused", async () => {
    const ok = await call(alertCtrl.escalateAlertToCase, { params: { id: String(alert2._id) }, body: { caseId }, user });
    expect(ok.err).toBeNull();
    expect(ok.res.body.attached).toBe(true);

    await Case.updateOne({ _id: caseId }, { $set: { status: "closed" } });
    const alert3 = await makeAlert({ ruleId: "R-3" });
    const { err } = await call(alertCtrl.escalateAlertToCase, { params: { id: String(alert3._id) }, body: { caseId }, user });
    expect(err).not.toBeNull();
    expect(err.statusCode).toBe(400);
  });

  test("GET /alert/:id/attachable-cases lists the open case and hides closed ones", async () => {
    let r = await call(alertCtrl.getAttachableCases, { params: { id: String(alert2._id) }, user });
    expect(r.err).toBeNull();
    expect(r.res.body.count).toBe(1);
    expect(r.res.body.data[0]).toMatchObject({ alertCount: 1, poiCount: 2, status: "open" });

    await Case.updateOne({ _id: caseId }, { $set: { status: "closed" } });
    r = await call(alertCtrl.getAttachableCases, { params: { id: String(alert2._id) }, user });
    expect(r.res.body.count).toBe(0);
  });
});

// ── link / unlink alerts through caseController ─────────────────────────────

describe("POST /cases/:id/alerts · DELETE /cases/:id/alerts/:alertId", () => {
  let caseDoc;
  beforeEach(async () => {
    caseDoc = await Case.create({ title: "Manual case", createdBy: user._id, priority: "low" });
  });

  test("linkAlerts pulls customers and transactions through and derives risk (G12)", async () => {
    const { res, err } = await call(caseCtrl.linkAlerts, { params: { id: String(caseDoc._id) }, body: { alertIds: [String(alert1._id), String(alert2._id)] }, user });
    expect(err).toBeNull();
    const c = await Case.findById(caseDoc._id).lean();
    expect(String(c.customer)).toBe(String(poi._id));
    expect(c.linkedCustomers.map(String).sort()).toEqual([String(poi._id), String(counterparty._id)].sort());
    expect(c.linkedTransactions).toHaveLength(2);
    expect(c.riskScore).toBe(85);
    expect(c.priority).toBe("high");
    expect(res.body.data.linkedAlerts).toHaveLength(2);
  });

  test("unlinkAlert drops the alert's transaction only when no other alert uses it, and re-derives risk", async () => {
    await call(caseCtrl.linkAlerts, { params: { id: String(caseDoc._id) }, body: { alertIds: [String(alert1._id), String(alert2._id)] }, user });
    // a third alert on txn1 keeps txn1 on the case when alert1 leaves
    const alert3 = await makeAlert({ transaction: txn1._id, ruleId: "R-3", riskScore: 20, riskLabel: "Low" });
    await call(caseCtrl.linkAlerts, { params: { id: String(caseDoc._id) }, body: { alertIds: [String(alert3._id)] }, user });

    let r = await call(caseCtrl.unlinkAlert, { params: { id: String(caseDoc._id), alertId: String(alert1._id) }, user });
    expect(r.err).toBeNull();
    let c = await Case.findById(caseDoc._id).lean();
    expect(c.linkedTransactions.map(String).sort()).toEqual([String(txn1._id), String(txn2._id)].sort()); // txn1 still used by alert3

    r = await call(caseCtrl.unlinkAlert, { params: { id: String(caseDoc._id), alertId: String(alert2._id) }, user });
    expect(r.err).toBeNull();
    c = await Case.findById(caseDoc._id).lean();
    expect(c.linkedTransactions.map(String)).toEqual([String(txn1._id)]);   // txn2 released
    expect(c.riskScore).toBe(20);                                            // re-derived from alert3
    expect(c.priority).toBe("high");                                         // never lowered

    const t2 = await Transaction.findById(txn2._id).lean({ autopopulate: false });
    expect(t2.investigation.case).toBeNull();
    const a2 = await Alert.findById(alert2._id).lean();
    expect(a2.linkedCase).toBeNull();
    expect(a2.status).toBe("under_review");
  });
});

// ── POI linkage ─────────────────────────────────────────────────────────────

describe("POST /cases/:id/customers · DELETE /cases/:id/customers/:customerId", () => {
  let caseDoc, third;
  beforeEach(async () => {
    third = await Customer.create({ country: "DE", relations: [{ client: CLIENT, type: "individual" }] });
    caseDoc = await Case.create({ title: "POI case", createdBy: user._id, customer: poi._id, linkedCustomers: [poi._id] });
  });

  test("adds POIs, ignores duplicates, and refuses unknown customers", async () => {
    let r = await call(caseCtrl.linkCustomers, { params: { id: String(caseDoc._id) }, body: { customerIds: [String(third._id), String(poi._id)] }, user });
    expect(r.err).toBeNull();
    expect(r.res.body.data.linkedCustomers).toHaveLength(2);

    r = await call(caseCtrl.linkCustomers, { params: { id: String(caseDoc._id) }, body: { customerIds: [String(third._id)] }, user });
    expect(r.err.statusCode).toBe(400);                                      // already linked

    r = await call(caseCtrl.linkCustomers, { params: { id: String(caseDoc._id) }, body: { customerIds: [String(new mongoose.Types.ObjectId())] }, user });
    expect(r.err.statusCode).toBe(404);
  });

  test("tenant users cannot link a customer outside their tenant", async () => {
    const tenantUser = { ...user, client: { _id: new mongoose.Types.ObjectId() } };
    const r = await call(caseCtrl.linkCustomers, { params: { id: String(caseDoc._id) }, body: { customerIds: [String(third._id)] }, user: tenantUser });
    expect(r.err.statusCode).toBe(403);
  });

  test("removes a linked POI but never the primary customer", async () => {
    await call(caseCtrl.linkCustomers, { params: { id: String(caseDoc._id) }, body: { customerIds: [String(third._id)] }, user });

    let r = await call(caseCtrl.unlinkCustomer, { params: { id: String(caseDoc._id), customerId: String(poi._id) }, user });
    expect(r.err.statusCode).toBe(400);                                      // primary POI

    r = await call(caseCtrl.unlinkCustomer, { params: { id: String(caseDoc._id), customerId: String(third._id) }, user });
    expect(r.err).toBeNull();
    expect(r.res.body.data.linkedCustomers).toHaveLength(1);

    const actions = (await AuditLog.find({ case: caseDoc._id }).lean()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["customer_linked", "customer_unlinked"]));
  });
});

// ── createCase uses the same derivation ─────────────────────────────────────

describe("POST /cases with alertIds", () => {
  test("risk = top alert (not the average) and transaction parties become POIs", async () => {
    const { res, err } = await call(caseCtrl.createCase, {
      body: { title: "From alerts", alertIds: [String(alert1._id), String(alert2._id)] },
      user,
    });
    expect(err).toBeNull();
    const c = await Case.findById(res.body.data._id).lean();
    expect(c.riskScore).toBe(85);
    expect(c.riskLabel).toBe("High");
    expect(c.priority).toBe("high");
    expect(c.linkedCustomers.map(String).sort()).toEqual([String(poi._id), String(counterparty._id)].sort());
  });
});
