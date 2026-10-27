/**
 * Case header utilities:
 *
 *   POST /cases/:id/duplicate        a fresh investigation over the same facts
 *   services/caseSummaryDocument     the printable Case Summary HTML
 *
 * Same harness as caseLinking.test.js: in-memory Mongo, handlers called
 * directly with a stub req/res/next. The PDF endpoint itself is puppeteer and
 * is not launched here — the document builder is tested as a pure function.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let Case, Customer, Transaction, AuditLog, caseCtrl;
const { buildCaseSummaryHtml } = require("../../services/caseSummaryDocument");

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

let user, customer, txn, sourceCase;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  require("../../models/Client");
  require("../../models/Branch");
  require("../../models/Counter");
  require("../../models/Notify");
  require("../../models/CaseNote");
  const User = require("../../models/User");
  Case = require("../../models/Case");
  Customer = require("../../models/Customer");
  Transaction = require("../../models/Transaction");
  require("../../models/Alert");
  AuditLog = require("../../models/AuditLog");
  caseCtrl = require("../../controllers/caseController");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  user = await User.create({
    name: "Analyst",
    userName: "analyst",
    email: "analyst@test.local",
    password: "x".repeat(12),
    role: "admin",
  });
  customer = await Customer.create({ uid: "CR_TEST_1", kycStatus: "verified" });
  txn = await Transaction.create({
    amount: 1000, currency: "AUD", type: "transfer",
    sender: { customer: customer._id, name: "Subject" },
    receiver: { name: "Counterparty" },
    timestamp: new Date(),
  });
  sourceCase = await Case.create({
    title: "Original investigation",
    description: "Facts under review.",
    type: "transaction_monitoring",
    caseType: "AML",
    priority: "high",
    riskScore: 70,
    status: "under_investigation",
    customer: customer._id,
    linkedCustomers: [customer._id],
    linkedTransactions: [txn._id],
    createdBy: user._id,
  });
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe("POST /cases/:id/duplicate", () => {
  test("copies the facts into a fresh open case and audits both sides", async () => {
    const { res, err } = await call(caseCtrl.duplicateCase, {
      params: { id: String(sourceCase._id) },
      user,
    });
    expect(err).toBeNull();
    expect(res.statusCode).toBe(201);

    const copy = res.body.data;
    expect(copy.title).toBe("Original investigation (copy)");
    expect(copy.status).toBe("open");
    expect(copy.uid).not.toBe(sourceCase.uid);
    expect(String(copy.customer?._id || copy.customer)).toBe(String(customer._id));
    expect(copy.linkedCustomers.map((c) => String(c._id || c))).toEqual([String(customer._id)]);
    expect(copy.linkedTransactions.map((t) => String(t._id || t))).toEqual([String(txn._id)]);
    // An alert belongs to exactly one case; reports/notes stay with the source.
    expect(copy.linkedAlerts).toEqual([]);
    expect(String(copy.createdBy?._id || copy.createdBy)).toBe(String(user._id));

    const audits = await AuditLog.find({ action: "duplicated" }).lean();
    const auditedCases = audits.map((a) => String(a.case)).sort();
    expect(auditedCases).toEqual([String(sourceCase._id), String(copy._id)].sort());
  });

  test("404 on an unknown case id", async () => {
    const { res, err } = await call(caseCtrl.duplicateCase, {
      params: { id: String(new mongoose.Types.ObjectId()) },
      user,
    });
    expect(err?.statusCode || res.statusCode).toBe(404);
  });

  test("another tenant's case is refused", async () => {
    const otherClient = new mongoose.Types.ObjectId();
    const foreign = await Case.create({
      title: "Foreign", client: otherClient, createdBy: user._id,
    });
    const tenantUser = { _id: user._id, role: "admin", clientBelongs: new mongoose.Types.ObjectId() };
    const { res, err } = await call(caseCtrl.duplicateCase, {
      params: { id: String(foreign._id) },
      user: tenantUser,
    });
    expect(err?.statusCode || res.statusCode).toBe(403);
  });
});

describe("buildCaseSummaryHtml", () => {
  const doc = {
    _id: "abc",
    uid: "CA-TEST-1",
    title: "Case <script>alert(1)</script>",
    status: "under_investigation",
    priority: "high",
    caseType: "AML",
    riskScore: 70,
    riskLabel: "High",
    description: "Cash deposits inconsistent with profile.",
    createdAt: new Date("2026-01-02T00:00:00Z"),
    updatedAt: new Date("2026-01-03T00:00:00Z"),
    assignedTo: { name: "Analyst" },
    createdBy: { name: "Creator" },
    customer: { _id: "cust1" },
    linkedCustomers: [
      { _id: "cust1", uid: "CR_1", user: { name: "MOHAMMAD HOSSAIN" }, kycStatus: "pending", isPep: false, sanction: false },
    ],
    externalPois: [
      { name: "***", kind: "entity", role: "counterparty", source: "alert", sourceAlertUid: "AL-1", sourcePartySlot: "receiver" },
    ],
    linkedAlerts: [
      { uid: "AL-1", ruleId: "R-1", ruleName: "Cash rule", riskScore: 55, riskLabel: "Medium", status: "escalated", createdAt: new Date() },
    ],
    linkedTransactions: [
      {
        uid: "TXN-1", amount: 265754, currency: "USD", convertedAmountAUD: 403946,
        type: "transfer", channel: "branch-counter", riskFlags: ["cash-intensive"],
        sender: { name: "MOHAMMAD HOSSAIN" }, receiver: { name: "Meridian GmbH" },
        timestamp: new Date(),
      },
    ],
  };

  test("renders the case facts and totals in AUD", () => {
    const html = buildCaseSummaryHtml(doc, { netActivity: 403946, generatedBy: "Analyst" });
    expect(html).toContain("CA-TEST-1");
    expect(html).toContain("MOHAMMAD HOSSAIN");
    expect(html).toContain("Primary subject");
    expect(html).toContain("R-1: Cash rule");
    expect(html).toContain("cash-intensive");
    expect(html).toContain("$403,946.00");
    expect(html).toContain("Meridian GmbH");
    expect(html).toContain("tipping off");
  });

  test("escapes HTML and keeps masked PII masked", () => {
    const html = buildCaseSummaryHtml(doc, { netActivity: 0 });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
    // The external POI arrived masked for this viewer; the document must not
    // invent a name for it.
    expect(html).toContain("***");
  });

  test("empty collections fall through to stated empty states", () => {
    const html = buildCaseSummaryHtml(
      { ...doc, linkedAlerts: [], linkedTransactions: [], linkedCustomers: [], externalPois: [] },
      { netActivity: 0 }
    );
    expect(html).toContain("No alerts are linked to this case.");
    expect(html).toContain("No transactions are linked to this case.");
    expect(html).toContain("No customers are linked to this case.");
  });
});
