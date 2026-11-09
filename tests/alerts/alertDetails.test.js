/**
 * Alert-details companions (docs/72 Status box, 21 Aug 2026):
 *   GET  /alert/:id                      — populated shape the details page relies on
 *   POST /alert/:id/notes                — analyst note → alert.activity (type 'note')
 *   GET  /alert/:id/audit                — alert-scoped AuditLog rows
 *   GET  /alert/:id/related-transactions — other transactions of the alert's customer
 *   GET  /alert/:id/monitoring-result    — AI transaction-monitoring result behind the alert
 *
 * Self-contained model pattern: in-memory Mongo, handlers invoked directly
 * with a stub req/res/next (asyncHandler just awaits the promise).
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let Alert, Transaction, Customer, RuleEngine, AuditLog, AiResult, ctrl;

// asyncHandler does not hand back the handler's promise, so settle on whichever
// of res.json / next fires first (with a guard so a hung handler fails fast).
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
  require("../../models/Case");
  require("../../models/Counter");
  require("../../models/Notify");
  require("../../models/RuleEngineVersion");
  Customer = require("../../models/Customer");
  Transaction = require("../../models/Transaction");
  RuleEngine = require("../../models/RuleEngine");
  AuditLog = require("../../models/AuditLog");
  Alert = require("../../models/Alert");
  AiResult = require("../../models/TransactionMonitoringAiResult");
  ctrl = require("../../controllers/alertController");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const user = { _id: new mongoose.Types.ObjectId(), name: "Ayesha Rahman", role: "admin" };
let customer, txn, other, older, rule, alert;

beforeEach(async () => {
  await Promise.all([Alert.deleteMany({}), Transaction.deleteMany({}), Customer.deleteMany({}), RuleEngine.deleteMany({}), AuditLog.deleteMany({}), AiResult.deleteMany({})]);
  customer = await Customer.create({ isPep: true, country: "AU", relations: [{ client: new mongoose.Types.ObjectId(), type: "individual", registeredAt: new Date("2026-06-24") }] });
  txn = await Transaction.create({ amount: 139983, currency: "AUD", type: "withdrawal", sender: { customer: customer._id, name: "S" }, timestamp: new Date() });
  other = await Transaction.create({ amount: 9850, currency: "AUD", type: "withdrawal", sender: { customer: customer._id, name: "S" }, timestamp: new Date(Date.now() - 2 * 86400e3) });
  older = await Transaction.create({ amount: 50, currency: "AUD", type: "withdrawal", sender: { customer: customer._id, name: "S" }, timestamp: new Date(Date.now() - 200 * 86400e3) });
  rule = await RuleEngine.create({ ruleId: "R-XB-075", ruleName: "Large international transfer", ruleCondition: "amount > 50000", caseType: "AML", riskScore: 85, riskLabel: "High", conditions: [{ field: "amount", operator: "gt", value: 50000 }] });
  alert = await Alert.create({
    customer: customer._id, transaction: txn._id, ruleRef: rule._id, ruleId: rule.ruleId, ruleName: rule.ruleName, ruleVersion: 1,
    ruleMeta: { matched: [{ field: "amount", operator: "gt", expected: 50000, actual: 139983, pass: true }], source: "conditions" },
    riskScore: 85, riskLabel: "High", caseType: "AML", alertOrigin: "Rule Based",
    auditLogs: [{ action: "alert_created", performedBy: null, newValue: { ruleId: "R-XB-075" } }],
  });
});

describe("GET /alert/:id", () => {
  test("returns the populated shape the details page reads", async () => {
    const { res, err } = await call(ctrl.getAlert, { params: { id: String(alert._id) } });
    expect(err).toBeNull();
    expect(res.body.succeed).toBe(true);
    const a = res.body.data;
    expect(a.customer.isPep).toBe(true);                      // customer populated
    expect(a.transaction.amount).toBe(139983);                // transaction populated
    expect(a.ruleRef.ruleCondition).toBe("amount > 50000");   // rule definition selected
    expect(a.ruleRef.hitCount).toBe(0);                       // telemetry selected
    expect(a.ruleMeta.matched[0].field).toBe("amount");       // snapshot intact
    expect(a.isOverdue).toBe(false);                          // virtuals serialised
  });

  test("404 for an unknown alert", async () => {
    const { err } = await call(ctrl.getAlert, { params: { id: String(new mongoose.Types.ObjectId()) } });
    expect(err && err.statusCode).toBe(404);
  });
});

describe("POST /alert/:id/notes", () => {
  test("appends a type:'note' activity and audits it", async () => {
    const { res, err } = await call(ctrl.addAlertNote, { params: { id: String(alert._id) }, body: { message: "Beneficiary has no prior relationship." }, user });
    expect(err).toBeNull();
    expect(res.statusCode).toBe(201);
    expect(res.body.data.type).toBe("note");
    expect(res.body.data.createdBy.name).toBe("Ayesha Rahman");

    const fresh = await Alert.findById(alert._id).lean();
    const notes = fresh.activity.filter((a) => a.type === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toBe("Beneficiary has no prior relationship.");
    expect(String(notes[0].createdBy)).toBe(String(user._id));
  });

  test("rejects an empty note", async () => {
    const { err } = await call(ctrl.addAlertNote, { params: { id: String(alert._id) }, body: { message: "   " }, user });
    expect(err && err.statusCode).toBe(400);
  });
});

describe("GET /alert/:id/audit", () => {
  test("returns AuditLog rows scoped to the alert, newest first", async () => {
    await AuditLog.create([
      { service: "alert", action: "alert_review_started", alert: alert._id, createdAt: new Date(Date.now() - 1000) },
      { service: "alert", action: "alert_assigned", alert: alert._id },
      { service: "alert", action: "alert_created", alert: new mongoose.Types.ObjectId() }, // another alert
    ]);
    const { res, err } = await call(ctrl.getAlertAudit, { params: { id: String(alert._id) }, query: {} });
    expect(err).toBeNull();
    expect(res.body.count).toBe(2);
    expect(res.body.data.map((r) => r.action)).toEqual(["alert_assigned", "alert_review_started"]);
  });
});

describe("GET /alert/:id/reports", () => {
  test("finds reports by alert ref, by legacy caseNumber, and via the linked case", async () => {
    const Case = mongoose.model("Case");
    const EcddReport = require("../../models/EcddReport");
    const RFI = require("../../models/Rfi");
    const caseDoc = await Case.create({ title: "t", type: "other", createdBy: user._id });
    await Alert.updateOne({ _id: alert._id }, { $set: { linkedCase: caseDoc._id } });
    await EcddReport.create({ caseNumber: alert.uid });                             // legacy key (default status)
    await RFI.create({ alert: alert._id, status: "Draft" });                          // alert ref
    await RFI.create({ case: caseDoc._id, status: "Sent" });                          // via case
    await RFI.create({ alert: new mongoose.Types.ObjectId(), status: "Draft" });      // someone else's

    const { res, err } = await call(ctrl.getAlertReports, { params: { id: String(alert._id) } });
    expect(err).toBeNull();
    expect(res.body.summary.counts).toMatchObject({ ecdd: 1, rfi: 2, smr: 0 });
    expect(res.body.summary.total).toBe(3);
    expect(res.body.summary.sarFiled).toBe(false);
  });
});

describe("GET /alert/:id/related-transactions", () => {
  test("lists the customer's other transactions in the window, excluding the alert's own", async () => {
    const { res, err } = await call(ctrl.getRelatedTransactions, { params: { id: String(alert._id) }, query: { days: "90" } });
    expect(err).toBeNull();
    const ids = res.body.data.map((t) => String(t._id));
    expect(ids).toContain(String(other._id));
    expect(ids).not.toContain(String(txn._id));    // the alert's transaction itself
    expect(ids).not.toContain(String(older._id));  // outside the 90-day window
    expect(res.body.total).toBe(1);
  });

  test("empty result when the alert has no customer", async () => {
    const orphan = await Alert.create({ riskLabel: "Low" });
    const { res } = await call(ctrl.getRelatedTransactions, { params: { id: String(orphan._id) }, query: {} });
    expect(res.body.data).toEqual([]);
  });
});

describe("GET /alert/:id/monitoring-result", () => {
  const resultFor = (a, extra = {}) => AiResult.create({
    transactionId: a.transaction, alert: { alertId: a._id, uid: a.uid, status: "new", action: "created" },
    overall: { isRisky: true, riskScore: 75, riskLabel: "High", detectedBy: ["rule"], agreement: "1/3" },
    ruleHits: [{ ruleId: "R223", matchedConditions: [{ field: "x", operator: "between", expected: { min: 1, max: 2 }, actual: 1.5 }] }],
    ...extra,
  });

  test("returns the result linked to the alert", async () => {
    const r = await resultFor(alert);
    const { res, err } = await call(ctrl.getAlertMonitoringResult, { params: { id: String(alert._id) } });
    expect(err).toBeNull();
    expect(String(res.body.data._id)).toBe(String(r._id));
    expect(res.body.data.ruleHits[0].matchedConditions[0].expected).toEqual({ min: 1, max: 2 });
  });

  test("GET /alert/:id embeds it as monitoringResult (null when there is none)", async () => {
    const before = JSON.parse(JSON.stringify((await call(ctrl.getAlert, { params: { id: String(alert._id) } })).res.body.data));
    expect(before.monitoringResult).toBeNull();
    const r = await resultFor(alert);
    const after = JSON.parse(JSON.stringify((await call(ctrl.getAlert, { params: { id: String(alert._id) } })).res.body.data));
    expect(after.monitoringResult._id).toBe(String(r._id));
    expect(after.monitoringResult.overall.riskLabel).toBe("High");
  });

  test("ignores a result for the same transaction that belongs to another alert", async () => {
    await resultFor({ ...alert.toObject(), _id: new mongoose.Types.ObjectId() });
    const { res } = await call(ctrl.getAlertMonitoringResult, { params: { id: String(alert._id) } });
    expect(res.body).toEqual({ succeed: true, data: null });
  });

  test("data: null for an alert with no AI result, 404 for an unknown alert", async () => {
    const { res } = await call(ctrl.getAlertMonitoringResult, { params: { id: String(alert._id) } });
    expect(res.body).toEqual({ succeed: true, data: null });
    const { err } = await call(ctrl.getAlertMonitoringResult, { params: { id: String(new mongoose.Types.ObjectId()) } });
    expect(err.statusCode).toBe(404);
  });
});
