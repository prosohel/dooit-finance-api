/**
 * Report drafting — docs/74 §4 and §6.3, phase C3.
 *
 *   services/aiReports     the narrative whitelist, PII rejection, enum
 *                          normalisation, and failure → meta.error
 *   services/reportDrafts  ECDD / SMR / GFS / RFI facts built from our models,
 *                          idempotency, regeneration vs analyst edits
 *   POST /cases/:id/reports/:type/draft
 *
 * The AI service is never called: axios is stubbed for the client's own tests
 * and `aiReports.draftNarrative` is stubbed for the drafting tests.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("axios");
const axios = require("axios");

// The RFI send path emails the customer; never actually send from a test.
jest.mock("../../utils/sendEmail", () => jest.fn().mockResolvedValue(true));

let mongod;
let Case, Alert, Transaction, Customer, Client, EcddReport, SMR, GFS, RFI, AuditLog;
let aiReports, reportDrafts, caseCtrl;

const call = (handler, { params = {}, query = {}, body = {}, user } = {}) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; resolve({ res, err: null }); return this; },
    };
    const next = (e) => resolve({ res, err: e || null });
    const timer = setTimeout(() => resolve({ res, err: new Error("handler did not respond") }), 15000);
    Promise.resolve(handler({ params, query, body, user, headers: {}, ip: "127.0.0.1" }, res, next)).finally(() => clearTimeout(timer));
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  require("../../models/User");
  require("../../models/Branch");
  require("../../models/Counter");
  require("../../models/Notify");
  require("../../models/RuleEngine");
  require("../../models/RuleEngineVersion");
  require("../../models/CaseNote");
  require("../../models/Device");
  require("../../models/TtrReport");
  require("../../models/IftiReport");
  Client = require("../../models/Client");
  Case = require("../../models/Case");
  Alert = require("../../models/Alert");
  Transaction = require("../../models/Transaction");
  Customer = require("../../models/Customer");
  EcddReport = require("../../models/EcddReport");
  SMR = require("../../models/SmrReport");
  GFS = require("../../models/gfsReport");
  RFI = require("../../models/Rfi");
  AuditLog = require("../../models/AuditLog");
  aiReports = require("../../services/aiReports");
  reportDrafts = require("../../services/reportDrafts");
  caseCtrl = require("../../controllers/caseController");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const user = { _id: new mongoose.Types.ObjectId(), name: "Ayesha Rahman", email: "ayesha@dooit.test", role: "admin" };
const daysAgo = (n) => new Date(Date.now() - n * 86400e3);

let client, poi, caseDoc, alert, txnIn, txnOut;

// What a healthy AI response maps to, per type.
const NARRATIVE = {
  ecdd: {
    profileSummary: "The customer was onboarded in-branch.",
    transactionAnalysis: "Activity exceeds the declared expectation.",
    behavioralAnalysis: "Deposits are inconsistent with a student profile.",
    recommendation: "Escalate for SMR consideration.",
    recommendationType: "SMR",
    decisionRationale: "Cash deposits inconsistent with occupation.",
    immediateActions: ["Apply enhanced monitoring", "Obtain source-of-funds evidence"],
    keyIndicators: ["Occupation is Student"],
    typologies: [],
  },
  smr: {
    groundsForSuspicion: "Cash deposits materially above the declared expectation.",
    groundsList: ["Deposits inconsistent with occupation", "Outbound wire shortly after deposit"],
    investigationNotes: "Retain under monitoring.",
  },
  gfs: { suspicionSummary: "Pattern inconsistent with the declared profile." },
  dismissal: {
    title: "Sub-10k Cash = Till Float, Not Structuring",
    category: "Financial Institution",
    intro: "This report assesses an alert raised on a cash deposit.",
    profile: "The customer is an individual onboarded in-branch.",
    transactionAnalysis: "The deposits reconcile with the declared till float.",
    additionalInfo: "Device and IP patterns are consistent with prior activity.",
    conclusion: "The evidence supports dismissing this alert.",
  },
  rfi: {
    requestedItems: ["Provide a recent payslip", "Explain the payments to Sigma Logistics BV"],
    itemsRationale: "Declared occupation does not support the deposit volume.",
    draftSubject: "Request for information",
    draftBody: "Dear MOHAMMAD, ...",
  },
};

// Stands in for the AI service. Echoes the tenant and counts it was called
// with, the way the real client does, so every draft test exercises the C15
// provenance plumbing rather than a meta object that knows nothing.
const stubAi = (type, over = {}) =>
  jest.spyOn(aiReports, "draftNarrative").mockImplementation(async (_type, opts = {}) => ({
    narrative: NARRATIVE[type],
    meta: {
      provider: "ai-report-summary", apiVersion: "2.0", model: "gemini-2.5-flash",
      generatedAt: new Date(), generationMs: 4200, piiMode: "pseudonymize",
      alertScope: "all_case_alerts", alertIds: [], sectionsUsed: [], sectionsRejected: [],
      client: opts.client || null,
      requestedBy: opts.requestedBy || null,
      // A healthy service sees exactly what this client's case holds.
      scope: {
        ourTransactionCount: opts.expected?.transactions ?? null,
        theirTransactionCount: opts.expected?.transactions ?? null,
        ourAlertCount: opts.expected?.alerts ?? null,
        theirAlertCount: opts.expected?.alerts ?? null,
        mismatch: false,
      },
      dataQuality: { missingFields: ["customer.date_of_birth"], warnings: [], complete: false },
      error: { code: null, message: null, at: null },
      ...over,
    },
  }));

beforeEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([
    Case.deleteMany({}), Alert.deleteMany({}), Transaction.deleteMany({}), Customer.deleteMany({}),
    Client.deleteMany({}), EcddReport.deleteMany({}), SMR.deleteMany({}), GFS.deleteMany({}),
    RFI.deleteMany({}), AuditLog.deleteMany({}),
  ]);

  client = await Client.create({
    name: "Linkcaps", clientType: "Banks & ADIs", registrationNumber: "6566565",
    email: "compliance@linkcaps.test",
    address: { street: "120 Collins Street", city: "Melbourne", state: "VIC", zipcode: "3000", country: "Australia" },
  });

  poi = await Customer.create({
    country: "AU", kycStatus: "pending", amlStatus: "yellow", amlRiskLabels: ["adverseMedia"],
    relations: [{ client: client._id, type: "individual", registeredAt: daysAgo(60) }],
    personalKyc: {
      personal_form: {
        customer_details: { given_name: "MOHAMMAD", surname: "HOSSAIN", date_of_birth: daysAgo(9000) },
        contact_details: { email: "m.hossain@example.test", phone: "018111275653" },
        employment_details: { occupation: "Student" },
        residential_address: { address: "12 Smith St", suburb: "Carlton", state: "VIC", postcode: "3053", country: "Australia" },
        identificationNo: "RB1714332",
      },
      funds_wealth: {
        source_of_funds: "Investment Income", source_of_wealth: "Real Estate / Property",
        account_purpose: "Money Transfer / Remittance", estimated_trading_volume: "$1,000 – $5,000 per month",
      },
    },
  });

  txnIn = await Transaction.create({
    uid: "TXN_IN", client: client._id, amount: 48175, currency: "AUD", type: "deposit",
    subtype: "cash", channel: "branch-counter", status: "completed", timestamp: daysAgo(9),
    riskFlags: ["cash-intensive"], receiver: { customer: poi._id, name: "MOHAMMAD HOSSAIN" },
    sender: { name: "Sigma Logistics BV", account: "NL91ABNA0417164300", institution: "ABN AMRO Bank", institutionCountry: "NL", bic: "ABNANL2A" },
    metadata: { ip: "203.0.113.45", ipCountry: "NL" },
  });
  txnOut = await Transaction.create({
    uid: "TXN_OUT", client: client._id, amount: 265754, currency: "USD", convertedAmountAUD: 403946,
    type: "withdrawal", channel: "swift", status: "pending", timestamp: daysAgo(4),
    riskFlags: ["high-risk-jurisdiction", "rapid-movement"], relatedPartyFlag: true,
    sender: { customer: poi._id, name: "MOHAMMAD HOSSAIN" },
    beneficiary: { name: "Sigma Logistics BV", account: "NL91ABNA0417164300", institution: "ABN AMRO Bank", institutionCountry: "NL", bic: "ABNANL2A" },
    crypto: { walletAddress: "bc1qseeddemowallet", txHash: "0xseed1", network: "Bitcoin", hops: 2, cluster: "exchange-hosted" },
    forensic: { chainalysisScore: 91 },
  });

  alert = await Alert.create({
    client: client._id, customer: poi._id, transaction: txnIn._id, ruleId: "RULE-CSH-021",
    ruleName: "Cash deposit inconsistent with customer profile", ruleVersion: 2,
    caseType: "AML", riskScore: 55, riskLabel: "Medium", alertOrigin: "Rule Based",
    explanation: "Large cash deposit inconsistent with stated occupation.", status: "escalated_to_case",
  });

  caseDoc = await Case.create({
    client: client._id, title: "Cash deposit inconsistent with customer profile", createdBy: user._id,
    status: "open", priority: "medium", caseType: "AML", riskScore: 55, riskLabel: "Medium",
    customer: poi._id, linkedCustomers: [poi._id], linkedAlerts: [alert._id],
    linkedTransactions: [txnIn._id, txnOut._id],
  });
});

const draft = (type, body = {}) =>
  call(caseCtrl.draftCaseReport, { params: { id: String(caseDoc._id), type }, body, user });

/* ── the AI client itself ───────────────────────────────────────────────── */

describe("aiReports.draftNarrative", () => {
  const respond = (data) => axios.post.mockResolvedValue({ data });

  test("keeps only the whitelisted prose and drops every fact the service sends", async () => {
    respond({
      profile_summary: "Prose.",
      transaction_analysis: "More prose.",
      // None of the following may reach a draft — they are facts, and the
      // service computes them cross-tenant (docs/74 C15).
      total_deposits_AUD: 999999, risk_score: 55, risk_label: "Medium",
      name: "SOMEONE ELSE", counterparties: [{ name: "X" }], ecdd_create_payload: { totalDepositsAUD: 1 },
      _meta: { api_version: "2.0", llm_model: "gemini-2.5-flash", generation_ms: 1200, pii_mode: "pseudonymize" },
      data_quality: { missing_fields: ["customer.date_of_birth"], warnings: ["KYC pending"], complete: false },
    });

    const { narrative, meta } = await aiReports.draftNarrative("ecdd", { caseId: "c1" });
    expect(narrative).toEqual({ profileSummary: "Prose.", transactionAnalysis: "More prose." });
    expect(Object.keys(narrative)).not.toContain("totalDepositsAUD");
    expect(meta.model).toBe("gemini-2.5-flash");
    expect(meta.dataQuality.missingFields).toEqual(["customer.date_of_birth"]);
    expect(meta.sectionsUsed).toEqual(["profileSummary", "transactionAnalysis"]);

    // db_source and case_id are what the v2 contract expects.
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining("/v2/ecdd_report"),
      expect.objectContaining({ case_id: "c1", db_source: expect.any(Number) }),
      expect.any(Object)
    );
  });

  test("the tenant goes with the request, and a wider read than ours is flagged", async () => {
    // The service saw 5 transactions across 3 clients; this client's case has 2.
    respond({
      profile_summary: "Prose written from everything it could see.",
      _meta: { transaction_count: 5, alert_count: 1 },
    });

    const { meta } = await aiReports.draftNarrative("ecdd", {
      caseId: "c1",
      client: "6a447ec49effa00e718e4b45",
      branch: "6a716afc2544b240f81a7dba",
      requestedBy: "u1",
      expected: { transactions: 2, alerts: 1, sharedCustomers: 1 },
    });

    // Which tenant this report is for, recorded on the draft either way.
    expect(String(meta.client)).toBe("6a447ec49effa00e718e4b45");
    expect(String(meta.branch)).toBe("6a716afc2544b240f81a7dba");
    expect(String(meta.requestedBy)).toBe("u1");
    expect(meta.scope).toMatchObject({
      ourTransactionCount: 2, theirTransactionCount: 5, sharedCustomers: 1, mismatch: true,
    });
    // The analyst reviewing before filing is told, told first, and told WHY.
    expect(meta.dataQuality.warnings[0]).toMatch(/outside this tenant/i);
    expect(meta.dataQuality.warnings[0]).toMatch(/also onboarded under another client/i);

    // Both tenant ids are sent so the service can scope its own reads once it
    // supports them.
    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        client_id: "6a447ec49effa00e718e4b45",
        branch_id: "6a716afc2544b240f81a7dba",
      }),
      expect.any(Object)
    );
  });

  test("matching counts raise no scope warning", async () => {
    respond({ profile_summary: "Prose.", _meta: { transaction_count: 2, alert_count: 1 } });
    const { meta } = await aiReports.draftNarrative("ecdd", {
      caseId: "c1", client: "c-1", expected: { transactions: 2, alerts: 1 },
    });
    expect(meta.scope.mismatch).toBe(false);
    expect(meta.dataQuality.warnings).toEqual([]);
  });

  test("a count we cannot compare is not treated as a mismatch", async () => {
    // No `_meta` counts at all — silence is not evidence of a wider read.
    respond({ profile_summary: "Prose." });
    const { meta } = await aiReports.draftNarrative("ecdd", {
      caseId: "c1", client: "c-1", expected: { transactions: 2, alerts: 1 },
    });
    expect(meta.scope.mismatch).toBe(false);
  });

  test("a failed call still records which tenant it was for", async () => {
    axios.post.mockRejectedValue({ response: { status: 503, data: { error: "MongoDB unavailable" } } });
    const { meta } = await aiReports.draftNarrative("ecdd", { caseId: "c1", client: "c-9", requestedBy: "u9" });
    expect(meta.error.code).toBe("http_503");
    expect(String(meta.client)).toBe("c-9");
    expect(String(meta.requestedBy)).toBe("u9");
  });

  test("a leaked PII placeholder disqualifies the field", async () => {
    respond({ profile_summary: "The customer ⟨PII_NAME_1⟩ deposited cash.", behavioral_analysis: "Clean prose." });
    const { narrative, meta } = await aiReports.draftNarrative("ecdd", { caseId: "c1" });
    expect(narrative.profileSummary).toBeUndefined();
    expect(narrative.behavioralAnalysis).toBe("Clean prose.");
    expect(meta.sectionsRejected).toContain("profileSummary");
  });

  test("recommendation_type is normalised onto our enum", async () => {
    respond({ recommendation_type: "File a Suspicious Matter Report" });
    const { narrative } = await aiReports.draftNarrative("ecdd", { caseId: "c1" });
    expect(narrative.recommendationType).toBe("SMR");

    respond({ recommendation_type: "continue ongoing monitoring" });
    expect((await aiReports.draftNarrative("ecdd", { caseId: "c1" })).narrative.recommendationType).toBe("monitor");

    respond({ recommendation_type: "something we do not model" });
    expect((await aiReports.draftNarrative("ecdd", { caseId: "c1" })).narrative.recommendationType).toBeUndefined();
  });

  test("a service failure returns no prose and an error, never throws", async () => {
    axios.post.mockRejectedValue({ response: { status: 422, data: { error: "Case lacks required data" } } });
    const { narrative, meta } = await aiReports.draftNarrative("smr", { caseId: "c1" });
    expect(narrative).toEqual({});
    expect(meta.error.code).toBe("http_422");
    expect(meta.error.message).toContain("required data");
  });

  // Observed live 27 Oct 2026: the model failed but the HTTP answer was 200,
  // with bracketed apologies in the prose fields and the cause in
  // `_meta.llm_section_errors`. None of that may reach a draft.
  test("a 200 whose model failed keeps placeholders out and tells the analyst", async () => {
    respond({
      profile_summary: "[Profile summary could not be generated automatically.]",
      transaction_analysis: "[Transaction analysis could not be generated automatically.]",
      behavioral_analysis: "[Behavioral analysis could not be generated automatically.]",
      recommendation: "[Recommendation could not be generated automatically.]",
      recommendation_type: "RFI",
      _meta: {
        llm_section_errors: {
          profile_summary: "LLMError: Gemini request failed.",
          transaction_analysis: "LLMError: Gemini request failed.",
          behavioral_analysis: "LLMError: Gemini request failed.",
          recommendation: "LLMError: Gemini request failed.",
          recommendation_narrative: "LLMError: Gemini request failed.", // not a field of ours
        },
      },
    });
    const { narrative, meta } = await aiReports.draftNarrative("ecdd", { caseId: "c1" });
    expect(narrative.profileSummary).toBeUndefined();
    expect(narrative.transactionAnalysis).toBeUndefined();
    expect(narrative.recommendation).toBeUndefined();
    expect(narrative.recommendationType).toBe("RFI"); // enum, not prose — kept
    expect(meta.sectionsRejected).toEqual(
      expect.arrayContaining(["profileSummary", "transactionAnalysis", "behavioralAnalysis", "recommendation"])
    );
    expect(meta.dataQuality.warnings[0]).toContain("The AI model failed for");
    expect(meta.error.code).toBe("llm_failed"); // no prose survived → banner in the hub
  });

  test("a placeholder is dropped even without an llm_section_errors entry; partial failures stay warnings", async () => {
    respond({
      profile_summary: "[Profile summary could not be generated automatically.]",
      behavioral_analysis: "Clean prose.",
      _meta: { llm_section_errors: { profile_summary: "LLMError" } },
    });
    const { narrative, meta } = await aiReports.draftNarrative("ecdd", { caseId: "c1" });
    expect(narrative.profileSummary).toBeUndefined();
    expect(narrative.behavioralAnalysis).toBe("Clean prose.");
    expect(meta.error.code).toBeNull(); // some prose survived → no hard error
    expect(meta.dataQuality.warnings[0]).toContain("profileSummary");
  });

  // Observed live: GFS answers `suspicionSummary` but reports the failure as
  // `suspicion_summary` — the match must ignore casing style.
  test("an error key in another casing still disqualifies its section", async () => {
    respond({
      suspicionSummary: "[Grounds for suspicion summary could not be generated automatically.]",
      _meta: { llm_section_errors: { suspicion_summary: "LLMError: Gemini request failed." } },
    });
    const { narrative, meta } = await aiReports.draftNarrative("gfs", { caseId: "c1" });
    expect(narrative.suspicionSummary).toBeUndefined();
    expect(meta.dataQuality.warnings[0]).toContain("suspicionSummary");
    expect(meta.error.code).toBe("llm_failed");
  });
});

/* ── ECDD ───────────────────────────────────────────────────────────────── */

describe("ECDD draft", () => {
  test("facts come from our analysis and the case; prose from the whitelist", async () => {
    stubAi("ecdd");
    const { res, err } = await draft("ecdd");
    expect(err).toBeNull();
    expect(res.statusCode).toBe(201);

    const r = res.body.data;
    // ── ours ──
    expect(r.totalDepositsAUD).toBe(48175);
    expect(r.totalWithdrawalsAUD).toBe(403946);
    expect(r.fullName).toBe("MOHAMMAD HOSSAIN");
    expect(r.userId).toBe(poi.uid);
    expect(r.isPEP).toBe("No");
    expect(r.accountPurpose).toBe("Money Transfer / Remittance");
    expect(r.expectedVolumeText).toBe("$1,000 – $5,000 per month");
    expect(r.registeredAddress).toContain("Carlton");
    expect(r.relatedParty).toContain("1 related-party");
    expect(r.ipLocations).toBe(1);
    expect(r.ipAddresses[0]).toMatchObject({ ip: "203.0.113.45" });
    expect(r.depositDetails).toContain("48,175.00");
    // risk is the CASE's, never the AI's
    expect(r.riskScore).toBe(55);
    expect(r.riskLabel).toBe("Medium");
    // linkage
    expect(String(r.caseId)).toBe(String(caseDoc._id));
    expect(String(r.customer)).toBe(String(poi._id));
    expect(r.alerts[0]).toMatchObject({ ruleId: "RULE-CSH-021", ruleVersion: 2 });

    // ── theirs ──
    expect(r.profileSummary).toBe(NARRATIVE.ecdd.profileSummary);
    expect(r.recommendationType).toBe("SMR");
    expect(r.immediateActions).toHaveLength(2);
    expect(r.aiMeta.sectionsUsed).toEqual(expect.arrayContaining(["profileSummary", "recommendation"]));
    expect(r.aiMeta.dataQuality.missingFields).toEqual(["customer.date_of_birth"]);
    // Whose report this is, carried on the draft itself (docs/74 C15).
    expect(String(r.aiMeta.client)).toBe(String(client._id));
    expect(String(r.aiMeta.requestedBy)).toBe(String(user._id));
  });

  test("the draft records the tenant and our counts so a wider read is caught", async () => {
    // The service reports more than this client's case holds.
    jest.spyOn(aiReports, "draftNarrative").mockImplementation(async (type, opts) => ({
      narrative: NARRATIVE.ecdd,
      meta: {
        provider: "ai-report-summary",
        client: opts.client,
        requestedBy: opts.requestedBy,
        scope: {
          ourTransactionCount: opts.expected.transactions,
          theirTransactionCount: opts.expected.transactions + 3,
          ourAlertCount: opts.expected.alerts,
          theirAlertCount: opts.expected.alerts,
          mismatch: true,
        },
        sectionsUsed: [], sectionsRejected: [],
        dataQuality: { missingFields: [], warnings: ["… outside this client …"], complete: false },
        error: { code: null, message: null, at: null },
      },
    }));

    const { res } = await draft("ecdd");
    const scope = res.body.data.aiMeta.scope;
    expect(scope.mismatch).toBe(true);
    expect(scope.ourTransactionCount).toBe(2);        // this client's two transactions
    expect(scope.theirTransactionCount).toBe(5);

    // The case's audit trail says so, so it survives past the toast.
    const drafted = (await AuditLog.find({ case: caseDoc._id }).lean())
      .find((a) => a.action === "report_drafted");
    expect(drafted.details).toMatch(/may reach beyond this client/i);
  });

  test("the draft is still saved when the AI is unavailable", async () => {
    jest.spyOn(aiReports, "draftNarrative").mockResolvedValue({
      narrative: {},
      meta: { provider: "ai-report-summary", sectionsUsed: [], sectionsRejected: [], dataQuality: {}, error: { code: "http_503", message: "MongoDB unavailable", at: new Date() } },
    });

    const { res, err } = await draft("ecdd");
    expect(err).toBeNull();
    const r = res.body.data;
    expect(r.totalDepositsAUD).toBe(48175);      // the facts still stand
    expect(r.profileSummary).toBe("");           // no prose
    expect(r.aiMeta.error.code).toBe("http_503");
  });

  test("drafting twice returns the same record; regenerate refreshes it", async () => {
    stubAi("ecdd");
    const first = await draft("ecdd");
    const again = await draft("ecdd");
    expect(again.res.statusCode).toBe(200);
    expect(again.res.body.created).toBe(false);
    expect(String(again.res.body.data._id)).toBe(String(first.res.body.data._id));
    expect(await EcddReport.countDocuments()).toBe(1);

    // A new transaction changes the facts; regenerate must pick it up.
    await Transaction.create({
      uid: "TXN_IN2", client: client._id, amount: 10000, currency: "AUD", type: "deposit",
      status: "completed", timestamp: daysAgo(2), receiver: { customer: poi._id, name: "M" },
    });
    const regenerated = await draft("ecdd", { regenerate: true });
    expect(regenerated.res.body.regenerated).toBe(true);
    expect(regenerated.res.body.data.totalDepositsAUD).toBe(58175);
    expect(await EcddReport.countDocuments()).toBe(1);
  });

  test("regeneration never overwrites a narrative field the analyst has edited", async () => {
    stubAi("ecdd");
    await draft("ecdd");
    await EcddReport.updateOne(
      { caseId: caseDoc._id },
      { $set: { recommendation: "Analyst's own wording.", editedFields: ["recommendation"] } }
    );

    const { res } = await draft("ecdd", { regenerate: true });
    expect(res.body.data.recommendation).toBe("Analyst's own wording.");     // kept
    expect(res.body.data.profileSummary).toBe(NARRATIVE.ecdd.profileSummary); // refreshed
    expect(res.body.data.aiMeta.sectionsUsed).not.toContain("recommendation");
  });
});

/* ── SMR / GFS / RFI ────────────────────────────────────────────────────── */

describe("SMR draft", () => {
  test("Part A reasons map from risk flags; C, D, F and H are built from our data", async () => {
    stubAi("smr");
    const { res, err } = await draft("smr");
    expect(err).toBeNull();
    const r = res.body.data;

    expect(r.partA.suspicionReasons).toEqual(
      expect.arrayContaining(["Unusual use/exchange of cash", "Country/jurisdiction risk", "Unusual account activity"])
    );
    expect(r.partA.suspiciousIndicators).toMatchObject({
      pep: false, sanctions: false, adverseMedia: true, relatedPartyTransactions: 1,
      rulesTriggered: ["Cash deposit inconsistent with customer profile"],
    });

    expect(r.partC.personOrganisation).toMatchObject({ name: "MOHAMMAD HOSSAIN", occupation: "Student", isCustomer: true });
    expect(r.partC.personOrganisation.businessAddress).toMatchObject({ street: "12 Smith St", city: "Carlton", postcode: "3053" });
    expect(r.partC.personOrganisation.emails).toEqual(["m.hossain@example.test"]);

    expect(r.partD.hasOtherParties).toBe(true);
    expect(r.partD.otherParties[0].name).toBe("Sigma Logistics BV");

    expect(r.partF.transactions).toHaveLength(2);
    const cashLeg = r.partF.transactions.find((t) => t.referenceNumber === "TXN_IN");
    expect(cashLeg.cashAmount).toMatchObject({ currencyCode: "AUD", amount: 48175 });
    expect(cashLeg.payee.name).toBe("MOHAMMAD HOSSAIN");   // inflow → the POI is paid

    expect(r.partH.reportingEntity).toMatchObject({ name: "Linkcaps", internalReference: caseDoc.uid });
    expect(r.partH.reportingEntity.address).toMatchObject({ postcode: "3000", city: "Melbourne" });
    expect(r.partH.reportingEntity.completedBy.name).toBe("Ayesha Rahman");

    // prose
    expect(r.partB.groundsForSuspicion).toBe(NARRATIVE.smr.groundsForSuspicion);
    expect(r.partB.groundsList).toHaveLength(2);
    expect(r.status).toBe("draft");
  });
});

describe("GFS draft", () => {
  test("carries the activity shape, POIs, counterparties and crypto evidence", async () => {
    stubAi("gfs");
    const { res, err } = await draft("gfs");
    expect(err).toBeNull();
    const r = res.body.data;

    expect(r.totalDeposited).toBe(48175);
    expect(r.totalWithdrawn).toBe(403946);
    expect(r.netFlowAUD).toBe(48175 - 403946);
    expect(r.transactionCount).toBe(2);
    expect(r.jurisdictionsInvolved).toEqual(["NL"]);
    expect(r.occupation).toBe("Student");
    expect(r.sourceOfWealth).toBe("Real Estate / Property");
    expect(r.pepFlag).toBe(false);
    expect(r.adverseMediaFlag).toBe(true);

    expect(r.pois.find((p) => p.relationship === "Subject").name).toBe("MOHAMMAD HOSSAIN");
    expect(r.pois.find((p) => p.relationship === "Counterparty").name).toBe("Sigma Logistics BV");
    expect(r.ofis[0]).toMatchObject({ name: "ABN AMRO Bank", country: "NL" });

    // The address list stays a plain string array; detail sits in cryptoLegs.
    expect(r.cryptoAddresses).toEqual(["bc1qseeddemowallet"]);
    expect(r.cryptoLegs[0]).toMatchObject({ network: "Bitcoin", chainalysisScore: 91 });

    expect(r.suspicionSummary).toBe(NARRATIVE.gfs.suspicionSummary);
    expect(r.suspicionReason).toBe(NARRATIVE.gfs.suspicionSummary); // legacy field kept in step
  });
});

describe("RFI draft", () => {
  test("requested items come from the AI; deadlines and the addressee from us", async () => {
    stubAi("rfi");
    const { res, err } = await draft("rfi");
    expect(err).toBeNull();
    const r = res.body.data;

    expect(r.requestedItems.map((i) => i.text)).toEqual(NARRATIVE.rfi.requestedItems);
    expect(r.itemsRationale).toBe(NARRATIVE.rfi.itemsRationale);
    expect(r.primaryContactName).toBe("MOHAMMAD");
    expect(r.replyToEmail).toBe("compliance@linkcaps.test");
    expect(new Date(r.responseDeadline).getTime()).toBeGreaterThan(Date.now());
    expect(r.status).toBe("Draft");
    expect(r.deliveryBlocked).toBe(false);
  });

  test("a live SMR on the case blocks delivery (tipping-off)", async () => {
    stubAi("rfi");
    await SMR.create({ caseId: caseDoc._id, customer: poi._id, status: "review" });

    const { res } = await draft("rfi");
    expect(res.body.data.deliveryBlocked).toBe(true);
    expect(res.body.data.tippingOffWarning).toBe(true);
    expect(res.body.data.deliveryBlockReason).toMatch(/tip off/i);
  });
});

/* ── Dismissal (docs/74 §4.5, C5) ───────────────────────────────────────── */

describe("Dismissal draft", () => {
  let AlertDismissal, dismissalCtrl;
  beforeAll(() => {
    AlertDismissal = require("../../models/AlertDismissal");
    dismissalCtrl = require("../../controllers/dismissalController");
  });
  beforeEach(async () => {
    await AlertDismissal.deleteMany({});
  });

  const draftDismissal = (body) => draft("dismissal", { alertId: String(alert._id), ...body });

  test("records the evidence considered and our own blocking conditions", async () => {
    stubAi("dismissal");
    const { res, err } = await draftDismissal({ dismissalType: "fi_d3" });
    expect(err).toBeNull();
    expect(res.statusCode).toBe(201);

    const d = res.body.data;
    expect(String(d.alert)).toBe(String(alert._id));
    expect(d.dismissalType).toBe("fi_d3");
    expect(d.templateKey).toBe("till_float");           // from our mirrored catalogue
    expect(d.status).toBe("draft");

    // ── ours ──
    expect(d.evidenceReviewed).toMatchObject({
      alertsReviewed: 1,
      transactionsReviewed: 2,
      totalInflowAUD: 48175,
      totalOutflowAUD: 403946,
      counterpartiesReviewed: 1,
      jurisdictions: ["NL"],
    });
    expect(d.evidenceReviewed.rulesTriggered).toEqual(["Cash deposit inconsistent with customer profile"]);
    // KYC is 'pending', so dismissing is blocked on our own rule — not the AI's.
    expect(d.requiresEscalation).toBe(true);
    expect(d.blockingConditions.join(" ")).toMatch(/KYC status is 'pending'/);
    // Only the alert being closed is frozen, not every alert on the case.
    expect(d.alerts).toHaveLength(1);

    // ── theirs ──
    expect(d.conclusion).toBe(NARRATIVE.dismissal.conclusion);
    expect(d.intro).toBe(NARRATIVE.dismissal.intro);
  });

  test("the industry template code reaches the service; 'generic' is left unsent", async () => {
    const spy = jest.spyOn(aiReports, "draftNarrative").mockResolvedValue({ narrative: {}, meta: { sectionsUsed: [], sectionsRejected: [], dataQuality: {} } });
    await draftDismissal({ dismissalType: "vasp_d1" });
    expect(spy).toHaveBeenCalledWith("dismissal", expect.objectContaining({ dismissalType: "vasp_d1" }));

    await AlertDismissal.deleteMany({});
    await draftDismissal({ dismissalType: "generic" });
    expect(spy).toHaveBeenLastCalledWith("dismissal", expect.objectContaining({ dismissalType: "generic" }));
  });

  test("is scoped to one alert, so a second alert on the case gets its own", async () => {
    stubAi("dismissal");
    const second = await Alert.create({
      client: client._id, customer: poi._id, transaction: txnOut._id, ruleId: "RULE-XB-2",
      ruleName: "Rapid movement", riskLabel: "High", riskScore: 85, status: "escalated_to_case",
    });
    await Case.updateOne({ _id: caseDoc._id }, { $push: { linkedAlerts: second._id } });

    await draftDismissal();
    await draft("dismissal", { alertId: String(second._id) });
    expect(await AlertDismissal.countDocuments()).toBe(2);

    // Re-drafting the first returns it rather than creating a third.
    const again = await draftDismissal();
    expect(again.res.body.created).toBe(false);
    expect(await AlertDismissal.countDocuments()).toBe(2);
  });

  test("requires an alert and a known template code", async () => {
    stubAi("dismissal");
    const noAlert = await draft("dismissal", {});
    expect(noAlert.err.statusCode).toBe(400);
    expect(noAlert.err.message).toMatch(/alertId is required/i);

    const badType = await draftDismissal({ dismissalType: "not_a_code" });
    expect(badType.err.statusCode).toBe(400);
    expect(badType.err.message).toMatch(/dismissalType must be one of/i);
  });

  test("appears as the seventh bucket on the case's filings", async () => {
    stubAi("dismissal");
    await draftDismissal();

    const { res } = await call(caseCtrl.getCaseReports, { params: { id: String(caseDoc._id) }, user });
    expect(res.body.summary.counts.dismissal).toBe(1);
    expect(res.body.data.dismissal[0].dismissalType).toBe("generic");
  });

  test("the PDF states the evidence, the sign-off, and any overridden blocks", async () => {
    stubAi("dismissal");
    const { res } = await draftDismissal({ dismissalType: "fi_d3" });
    const doc = await AlertDismissal.findById(res.body.data._id)
      .populate("client", "name")
      .populate("alert", "uid ruleId ruleName riskLabel status")
      .lean();

    // Composition is separate from transport, so the document can be checked
    // without launching a browser.
    const html = dismissalCtrl.buildDismissalReportHtml(doc);
    expect(html).toContain("Alert Dismissal Record");
    expect(html).toContain(doc.uid);
    expect(html).toContain("RULE-CSH-021");
    expect(html).toContain("Escalation advised");          // KYC is pending
    expect(html).toContain("48,175.00");                   // inflow, from our analysis
    expect(html).toContain(NARRATIVE.dismissal.conclusion);
    // A rendering fault must never reach a filed document.
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("[object Object]");
  });

  describe("approval", () => {
    const reviewer = { _id: new mongoose.Types.ObjectId(), name: "Imran Chowdhury", role: "admin" };

    const approve = (id, body = {}, as = reviewer) =>
      call(dismissalCtrl.approveDismissal, { params: { id: String(id) }, body, user: as });

    test("blocked conditions must be resolved or explicitly overridden", async () => {
      stubAi("dismissal");
      const { res } = await draftDismissal();
      const id = res.body.data._id;

      const blocked = await approve(id);
      expect(blocked.err.statusCode).toBe(409);
      expect(blocked.err.message).toMatch(/KYC status/);

      const overridden = await approve(id, { override: true });
      expect(overridden.err).toBeNull();
      expect(overridden.res.body.data.status).toBe("approved");
      expect(String(overridden.res.body.data.reviewer)).toBe(String(reviewer._id));

      // Approving closes the alert it was written about.
      const closed = await Alert.findById(alert._id).lean();
      expect(closed.status).toBe("dismissed");
      expect(closed.closedAt).toBeTruthy();

      const audits = (await AuditLog.find({ alert: alert._id }).lean()).map((a) => a.action);
      expect(audits).toContain("dismissal_approved");
    });

    test("the author cannot approve their own dismissal", async () => {
      stubAi("dismissal");
      const { res } = await draftDismissal();
      // `user` drafted it, so `user` must not be the one to sign it off.
      const selfApproved = await approve(res.body.data._id, { override: true }, user);
      expect(selfApproved.err.statusCode).toBe(403);
      expect(selfApproved.err.message).toMatch(/someone other than its author/i);
    });

    test("a clean case approves without an override, and cannot be edited afterwards", async () => {
      stubAi("dismissal");
      // Remove the blocking condition: verify the customer's KYC.
      await Customer.updateOne({ _id: poi._id }, { $set: { kycStatus: "verified" } });
      const { res } = await draftDismissal();
      expect(res.body.data.requiresEscalation).toBe(false);

      const ok = await approve(res.body.data._id);
      expect(ok.err).toBeNull();

      const edit = await call(dismissalCtrl.updateDismissal, {
        params: { id: String(res.body.data._id) }, body: { conclusion: "changed" }, user: reviewer,
      });
      expect(edit.err.statusCode).toBe(409);
    });

    test("editing marks the field as the analyst's, so a re-draft leaves it alone", async () => {
      stubAi("dismissal");
      const { res } = await draftDismissal();
      await call(dismissalCtrl.updateDismissal, {
        params: { id: String(res.body.data._id) },
        body: { conclusion: "Analyst's own conclusion." },
        user,
      });

      const regenerated = await draftDismissal({ regenerate: true });
      expect(regenerated.res.body.data.conclusion).toBe("Analyst's own conclusion.");
      expect(regenerated.res.body.data.intro).toBe(NARRATIVE.dismissal.intro);
    });
  });
});

/* ── tipping-off guard on send (docs/74 C9) ─────────────────────────────── */

describe("PUT /rfi/:id/send", () => {
  let rfiCtrl;
  beforeAll(() => {
    rfiCtrl = require("../../controllers/rfiController");
  });

  const makeRfi = () =>
    RFI.create({
      case: caseDoc._id, client: client._id, customer: poi._id,
      primaryContactName: "MOHAMMAD", replyToEmail: "compliance@linkcaps.test",
      requestedItems: [{ text: "Provide a recent payslip" }], status: "Draft",
    });

  // A request needs somewhere to go: give the customer a user account with an
  // address, except where a test is specifically about the missing-address case.
  const giveCustomerAnEmail = async () => {
    const User = require("../../models/User");
    const stamp = Date.now();
    const account = await User.create({
      name: "MOHAMMAD HOSSAIN",
      userName: `m.hossain.${stamp}`,
      email: `m.hossain.${stamp}@example.test`,
      password: "x".repeat(12),
      role: "customer",
    });
    await Customer.updateOne({ _id: poi._id }, { $set: { user: account._id } });
    return account.email;
  };

  test("refuses to send while an SMR on the case is in review, and records why", async () => {
    const rfi = await makeRfi();
    const smr = await SMR.create({ caseId: caseDoc._id, customer: poi._id, status: "review" });

    const { err } = await call(rfiCtrl.sendRFI, { params: { id: String(rfi._id) }, query: {}, user });
    expect(err).not.toBeNull();
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain(smr.uid);
    expect(err.message).toMatch(/tipping off/i);

    const stored = await RFI.findById(rfi._id).lean();
    expect(stored.deliveryBlocked).toBe(true);
    expect(stored.tippingOffWarning).toBe(true);
    expect(stored.status).toBe("Draft");           // never moved to Sent
    expect(stored.sentAt).toBeUndefined();
  });

  test("the letter goes to the customer, replying to the compliance mailbox", async () => {
    const sendEmail = require("../../utils/sendEmail");
    sendEmail.mockClear();
    const customerEmail = await giveCustomerAnEmail();

    const rfi = await makeRfi();
    const { err } = await call(rfiCtrl.sendRFI, { params: { id: String(rfi._id) }, query: {}, user });
    expect(err).toBeNull();

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: customerEmail,                         // the customer, not a hardcoded inbox
        replyTo: "compliance@linkcaps.test",          // the reporting entity
      })
    );
    const stored = await RFI.findById(rfi._id).lean();
    expect(stored.activityNote.at(-1).note).toContain(customerEmail);
  });

  test("RFI_REDIRECT_TO diverts delivery and the audit note says so", async () => {
    const sendEmail = require("../../utils/sendEmail");
    sendEmail.mockClear();
    await giveCustomerAnEmail();
    process.env.RFI_REDIRECT_TO = "staging-inbox@dooit.test";
    try {
      const rfi = await makeRfi();
      const { err } = await call(rfiCtrl.sendRFI, { params: { id: String(rfi._id) }, query: {}, user });
      expect(err).toBeNull();
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ email: "staging-inbox@dooit.test" })
      );
      const stored = await RFI.findById(rfi._id).lean();
      expect(stored.activityNote.at(-1).note).toMatch(/redirected from/i);
    } finally {
      delete process.env.RFI_REDIRECT_TO;
    }
  });

  test("a customer with no address on file is refused rather than sent elsewhere", async () => {
    const rfi = await makeRfi();
    // poi has no linked user in the default fixture, so no address.
    const { err } = await call(rfiCtrl.sendRFI, { params: { id: String(rfi._id) }, query: {}, user });
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/no email address on file/i);
    expect((await RFI.findById(rfi._id).lean()).status).toBe("Draft");
  });

  test("an approved SMR blocks it too; a draft SMR does not", async () => {
    await giveCustomerAnEmail();
    const rfi = await makeRfi();
    const smr = await SMR.create({ caseId: caseDoc._id, customer: poi._id, status: "approved" });
    expect((await call(rfiCtrl.sendRFI, { params: { id: String(rfi._id) }, query: {}, user })).err.statusCode).toBe(409);

    // A draft SMR is not yet a suspicion the customer could be tipped off about.
    await SMR.updateOne({ _id: smr._id }, { $set: { status: "draft" } });
    const { err } = await call(rfiCtrl.sendRFI, { params: { id: String(rfi._id) }, query: {}, user });
    expect(err).toBeNull();
    expect((await RFI.findById(rfi._id).lean()).status).toBe("Sent");
  });
});

/* ── endpoint guards + audit ────────────────────────────────────────────── */

describe("POST /cases/:id/reports/:type/draft", () => {
  test("rejects an unknown type, an unlinked alert, a case with no POI, and other tenants", async () => {
    stubAi("ecdd");

    expect((await draft("ttr")).err.statusCode).toBe(400);
    expect((await draft("ecdd", { alertId: String(new mongoose.Types.ObjectId()) })).err.statusCode).toBe(400);

    const bare = await Case.create({ title: "No POI", createdBy: user._id, client: client._id });
    const noPoi = await call(caseCtrl.draftCaseReport, { params: { id: String(bare._id), type: "ecdd" }, body: {}, user });
    expect(noPoi.err.statusCode).toBe(400);
    expect(noPoi.err.message).toMatch(/no customer/i);

    const other = { ...user, client: { _id: new mongoose.Types.ObjectId() } };
    const denied = await call(caseCtrl.draftCaseReport, { params: { id: String(caseDoc._id), type: "ecdd" }, body: {}, user: other });
    expect(denied.err.statusCode).toBe(403);

    const missing = await call(caseCtrl.draftCaseReport, { params: { id: String(new mongoose.Types.ObjectId()), type: "ecdd" }, body: {}, user });
    expect(missing.err.statusCode).toBe(404);
  });

  test("accepts the references the report forms actually hold: case uid, alert id, alert uid", async () => {
    stubAi("ecdd");
    await Alert.updateOne({ _id: alert._id }, { $set: { linkedCase: caseDoc._id } });

    for (const ref of [caseDoc.uid, String(alert._id), alert.uid]) {
      const r = await call(caseCtrl.draftCaseReport, { params: { id: String(ref), type: "ecdd" }, body: {}, user });
      expect(r.err).toBeNull();
      expect(String(r.res.body.data.caseId)).toBe(String(caseDoc._id));
    }
    // All four references resolved to the same case, so only one draft exists.
    expect(await EcddReport.countDocuments()).toBe(1);
  });

  test("an alert that was never escalated says so instead of 404-ing blankly", async () => {
    stubAi("ecdd");
    const loose = await Alert.create({ client: client._id, customer: poi._id, ruleId: "R-X", riskLabel: "Low" });
    const r = await call(caseCtrl.draftCaseReport, { params: { id: loose.uid, type: "ecdd" }, body: {}, user });
    expect(r.err.statusCode).toBe(404);
    expect(r.err.message).toMatch(/escalated to a case/i);
  });

  test("writes an audit row naming the report, and records an AI failure in it", async () => {
    stubAi("ecdd");
    await draft("ecdd");
    let rows = await AuditLog.find({ case: caseDoc._id }).lean();
    expect(rows.map((a) => a.action)).toContain("report_drafted");

    jest.spyOn(aiReports, "draftNarrative").mockResolvedValue({
      narrative: {}, meta: { sectionsUsed: [], sectionsRejected: [], dataQuality: {}, error: { code: "http_504", message: "timeout", at: new Date() } },
    });
    await draft("ecdd", { regenerate: true });
    rows = await AuditLog.find({ case: caseDoc._id }).lean();
    const redraft = rows.find((a) => a.action === "report_redrafted");
    expect(redraft.details).toContain("http_504");
  });
});

/* ── persons of interest in the drafts (ECDD → GFS → SMR) ───────────────── */

describe("persons of interest in drafts", () => {
  const { runWithRole } = require("../../utils/roleEncryptionPlugin");
  const draftAs = (type, canRead = true) =>
    new Promise((resolve) => runWithRole("admin", canRead, () => draft(type, { regenerate: true }).then(resolve)));

  beforeEach(async () => {
    const linking = require("../../services/caseLinking");
    const hydrated = await Case.findById(caseDoc._id);
    const add = (input) => linking.addExternalPoi(hydrated, input, { user });
    await add({ name: "Jane Director", role: "director", nationality: "AU", dateOfBirth: "1970-01-01",
      idDocument: { type: "passport", number: "P123", country: "AU" }, phone: "+61 400 111 222" });
    await add({ name: "Omar Owner", role: "beneficial_owner", nationality: "AE" });
    await add({ name: "Mei Chow", role: "associated_party", relationship: "Sister" });
    // The alert's counterparty, taken off the transaction.
    await add({ fromAlert: { alertId: String(alert._id), slot: "sender" }, kind: "entity", registrationNumber: "NL-778" });
  });

  test("ECDD: owners, directors, related parties and the POI list", async () => {
    stubAi("ecdd");
    const { res, err } = await draftAs("ecdd");
    expect(err).toBeNull();
    const r = res.body.data;
    expect(r.directors).toBe("Jane Director (AU)");
    expect(r.beneficialOwner).toBe("Omar Owner (AE)");
    expect(r.relatedParty).toMatch(/Mei Chow \(Associated party, Sister\)/);
    expect(r.relatedParty).toMatch(/Sigma Logistics BV \(Counterparty\)/);
    expect(r.personsOfInterest).toHaveLength(5);
    expect(r.personsOfInterest[0]).toMatchObject({ name: "MOHAMMAD HOSSAIN", role: "Subject", source: "customer" });
    expect(r.personsOfInterest.find((p) => p.name === "Sigma Logistics BV")).toMatchObject({ kind: "entity", source: "alert" });
    // Identity detail stays on the case.
    expect(JSON.stringify(r.personsOfInterest)).not.toContain("P123");
  });

  test("GFS: a recorded counterparty is one row, named by the POI; others are added", async () => {
    stubAi("gfs");
    const { res } = await draftAs("gfs");
    const rows = res.body.data.pois;
    expect(rows.filter((p) => p.account === "NL91ABNA0417164300")).toHaveLength(1);
    expect(rows.find((p) => p.name === "Sigma Logistics BV").relationship).toBe("Counterparty");
    expect(rows.find((p) => p.name === "Mei Chow").relationship).toBe("Associated party");
    expect(rows.find((p) => p.name === "Jane Director").relationship).toBe("Director");
  });

  test("SMR Part D: recorded POIs with identity detail, counterparties not duplicated", async () => {
    stubAi("smr");
    const { res } = await draftAs("smr");
    const parties = res.body.data.partD.otherParties;
    const jane = parties.find((p) => p.name === "Jane Director");
    expect(jane.personDetails.nationality).toBe("AU");
    expect(new Date(jane.personDetails.dateOfBirth).toISOString().slice(0, 10)).toBe("1970-01-01");
    expect(jane.identityVerification.documents[0]).toMatchObject({ type: "passport", number: "P123", country: "AU" });
    expect(jane.phoneNumbers).toEqual(["+61 400 111 222"]);
    expect(jane.isCustomer).toBe(false);

    const sigma = parties.filter((p) => p.name === "Sigma Logistics BV");
    expect(sigma).toHaveLength(1);
    expect(sigma[0].documentation).toMatch(new RegExp(`Counterparty.*Registration NL-778.*identified from alert ${alert.uid}`));
    // The subject stays in Part C, not D.
    expect(parties.find((p) => p.name === "MOHAMMAD HOSSAIN")).toBeUndefined();
  });

  test("a drafter without the decrypt grant never freezes *** into a report", async () => {
    stubAi("ecdd");
    const { res } = await draftAs("ecdd", false);
    expect(JSON.stringify(res.body.data)).not.toContain("***");
    expect(res.body.data.personsOfInterest).toHaveLength(1); // only the customer — names were masked
  });
});

/* ── editing a draft from the case (Investigation Hub narrative step) ───── */

describe("PATCH /cases/:id/reports/:type and /suggest", () => {
  const edit = (body, type = "ecdd") =>
    call(caseCtrl.saveCaseReportEdits, { params: { id: String(caseDoc._id), type }, body, user });

  beforeEach(async () => {
    stubAi("ecdd");
    await draft("ecdd");
  });

  test("saves only what changed, and marks it analyst-owned", async () => {
    const stored = await EcddReport.findOne({ caseId: caseDoc._id }).lean();
    const { res, err } = await edit({
      directors: "Jane Director",
      profileSummary: "Analyst's own summary.",
      fullName: stored.fullName, // unchanged → not marked
      onboardingDate: stored.onboardingDate.toISOString().slice(0, 10), // same day → not marked
    });
    expect(err).toBeNull();
    expect(res.body.changed.sort()).toEqual(["directors", "profileSummary"]);
    expect(res.body.data.editedFields.sort()).toEqual(["directors", "profileSummary"]);
    expect(await AuditLog.countDocuments({ case: caseDoc._id, action: "report_edited" })).toBe(1);

    // A second autosave inside the window does not add another audit line.
    await edit({ directors: "Jane Director, Omar Owner" });
    expect(await AuditLog.countDocuments({ case: caseDoc._id, action: "report_edited" })).toBe(1);
  });

  test("refuses fields outside the whitelist and types without editing", async () => {
    expect((await edit({ caseId: String(new mongoose.Types.ObjectId()) })).err.statusCode).toBe(400);
    expect((await edit({ alerts: [] })).err.statusCode).toBe(400);
    expect((await edit({ itemsRationale: "x" }, "rfi")).err.statusCode).toBe(400);
  });

  test("a re-draft keeps edited facts AND edited prose; the rest refresh", async () => {
    await edit({ directors: "Jane Director", profileSummary: "Analyst's own summary." });
    await EcddReport.updateOne({ caseId: caseDoc._id }, { $set: { registeredAddress: "stale" } });

    const { res } = await draft("ecdd", { regenerate: true });
    const r = res.body.data;
    expect(r.directors).toBe("Jane Director");
    expect(r.profileSummary).toBe("Analyst's own summary.");
    expect(r.transactionAnalysis).toBe(NARRATIVE.ecdd.transactionAnalysis); // AI-owned → refreshed
    expect(r.registeredAddress).not.toBe("stale"); // fact not edited → recomputed
  });

  test("suggest returns fresh prose without saving it, and sends the POIs", async () => {
    const hydrated = await Case.findById(caseDoc._id);
    await require("../../services/caseLinking").addExternalPoi(hydrated, { name: "Mei Chow", role: "associated_party", relationship: "Sister" }, { user });

    await edit({ profileSummary: "Mine." });
    aiReports.draftNarrative.mockClear();
    const { res, err } = await new Promise((resolve) =>
      require("../../utils/roleEncryptionPlugin").runWithRole("admin", true, () =>
        call(caseCtrl.suggestCaseReportNarrative, { params: { id: String(caseDoc._id), type: "ecdd" }, user }).then(resolve)
      )
    );
    expect(err).toBeNull();
    expect(res.body.data.narrative.profileSummary).toBe(NARRATIVE.ecdd.profileSummary);
    expect((await EcddReport.findOne({ caseId: caseDoc._id }).lean()).profileSummary).toBe("Mine.");

    const opts = aiReports.draftNarrative.mock.calls[0][1];
    expect(opts.personsOfInterest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "MOHAMMAD HOSSAIN", role: "Subject", is_customer: true }),
        { name: "Mei Chow", role: "Associated party", relationship: "Sister", is_customer: false },
      ])
    );
    // Identity numbers never go to the AI.
    expect(JSON.stringify(opts.personsOfInterest)).not.toMatch(/dateOfBirth|idDocument|account/);
  });
});

describe("aiReports sends persons_of_interest", () => {
  test("in the request body when given", async () => {
    jest.restoreAllMocks();
    axios.post.mockResolvedValueOnce({ data: { profile_summary: "ok" } });
    await aiReports.draftNarrative("ecdd", { caseId: "c1", personsOfInterest: [{ name: "A", role: "Subject" }] });
    expect(axios.post.mock.calls.at(-1)[1].persons_of_interest).toEqual([{ name: "A", role: "Subject" }]);
  });
});

describe("PUT /ecdd-report/:id (the standalone ECDD form)", () => {
  test("records only the fields the analyst changed, so a re-draft keeps them", async () => {
    stubAi("ecdd");
    const { res } = await draft("ecdd");
    const doc = res.body.data;
    const ecddCtrl = require("../../controllers/ecddReportController");

    // The form re-sends everything; only `directors` really changed.
    const { err } = await call(ecddCtrl.updateEcddReport, {
      params: { id: String(doc._id) }, user,
      body: { fullName: doc.fullName, directors: "Board of Two", editedFields: ["bogus"] },
    });
    expect(err).toBeNull();
    const stored = await EcddReport.findById(doc._id).lean();
    expect(stored.editedFields).toEqual(["directors"]);

    const redraft = await draft("ecdd", { regenerate: true });
    expect(redraft.res.body.data.directors).toBe("Board of Two");
  });
});

/* ── editing the GFS draft from the case (docs/74 phase C8) ──────────────── */

describe("PATCH /cases/:id/reports/gfs and /suggest", () => {
  const edit = (body) =>
    call(caseCtrl.saveCaseReportEdits, { params: { id: String(caseDoc._id), type: "gfs" }, body, user });

  beforeEach(async () => {
    stubAi("gfs");
    await draft("gfs");
  });

  test("saves only what changed, and marks it analyst-owned", async () => {
    const stored = await GFS.findOne({ case: caseDoc._id }).lean();
    const { res, err } = await edit({
      additionalNotes: "Analyst note.",
      suspicionSummary: "Analyst's own summary.",
      customerName: stored.customerName, // unchanged → not marked
      reviewStartDate: stored.reviewStartDate.toISOString().slice(0, 10), // same day → not marked
    });
    expect(err).toBeNull();
    expect(res.body.changed.sort()).toEqual(["additionalNotes", "suspicionSummary"]);
    expect(res.body.data.editedFields.sort()).toEqual(["additionalNotes", "suspicionSummary"]);
    expect(await AuditLog.countDocuments({ case: caseDoc._id, action: "report_edited" })).toBe(1);
  });

  test("refuses fields outside the whitelist", async () => {
    expect((await edit({ pois: [] })).err.statusCode).toBe(400);
    expect((await edit({ netFlowAUD: 0 })).err.statusCode).toBe(400);
    expect((await edit({ linkedToSMR: true })).err.statusCode).toBe(400);
  });

  test("a re-draft keeps edited facts AND edited prose; the rest refresh", async () => {
    await edit({ suspicionSummary: "Analyst's own summary.", totalDeposited: 1 });
    await GFS.updateOne({ case: caseDoc._id }, { $set: { occupation: "stale" } });

    const { res } = await draft("gfs", { regenerate: true });
    const r = res.body.data;
    expect(r.suspicionSummary).toBe("Analyst's own summary."); // analyst-owned → kept
    expect(r.totalDeposited).toBe(1); // edited fact → kept
    expect(r.occupation).not.toBe("stale"); // fact not edited → recomputed
  });

  test("suggest returns fresh prose without saving it", async () => {
    await edit({ suspicionSummary: "Mine." });
    aiReports.draftNarrative.mockClear();
    const { res, err } = await call(caseCtrl.suggestCaseReportNarrative, {
      params: { id: String(caseDoc._id), type: "gfs" }, user,
    });
    expect(err).toBeNull();
    expect(res.body.data.narrative.suspicionSummary).toBe(NARRATIVE.gfs.suspicionSummary);
    expect((await GFS.findOne({ case: caseDoc._id }).lean()).suspicionSummary).toBe("Mine.");
  });
});

describe("PUT /gfs-report/:id (the standalone GFS form)", () => {
  test("records only the fields the analyst changed, so a re-draft keeps them", async () => {
    stubAi("gfs");
    const { res } = await draft("gfs");
    const doc = res.body.data;
    const gfsCtrl = require("../../controllers/gfsReportController");

    // The form re-sends everything; only `occupation` really changed.
    const { err } = await call(gfsCtrl.updateGFS, {
      params: { id: String(doc._id) }, user,
      body: { customerName: doc.customerName, occupation: "Baker", editedFields: ["bogus"] },
    });
    expect(err).toBeNull();
    const stored = await GFS.findById(doc._id).lean();
    expect(stored.editedFields).toEqual(["occupation"]);

    const redraft = await draft("gfs", { regenerate: true });
    expect(redraft.res.body.data.occupation).toBe("Baker");
  });
});

/* ── editing the SMR draft from the case (docs/74 phase C9) ──────────────── */

describe("PATCH /cases/:id/reports/smr (dotted AUSTRAC part paths)", () => {
  const edit = (body) =>
    call(caseCtrl.saveCaseReportEdits, { params: { id: String(caseDoc._id), type: "smr" }, body, user });

  beforeEach(async () => {
    stubAi("smr");
    await draft("smr");
  });

  test("saves only what changed under a part, and marks the path analyst-owned", async () => {
    const stored = await SMR.findOne({ caseId: caseDoc._id }).lean();
    const { res, err } = await edit({
      "partA.designatedServices": ["Account / deposit-taking services"],
      "partB.groundsForSuspicion": "Analyst's own grounds.",
      "partA.serviceStatus": stored.partA.serviceStatus, // unchanged → not marked
    });
    expect(err).toBeNull();
    expect(res.body.changed.sort()).toEqual(["partA.designatedServices", "partB.groundsForSuspicion"]);
    expect(res.body.data.editedFields.sort()).toEqual(["partA.designatedServices", "partB.groundsForSuspicion"]);
    expect(res.body.data.partB.groundsForSuspicion).toBe("Analyst's own grounds.");
  });

  test("refuses evidence and provenance paths", async () => {
    expect((await edit({ "partC.personOrganisation.name": "x" })).err.statusCode).toBe(400);
    expect((await edit({ "partA.suspiciousIndicators.pep": false })).err.statusCode).toBe(400);
    expect((await edit({ "partF.transactions": [] })).err.statusCode).toBe(400);
    expect((await edit({ "partG.previousReports": [] })).err.statusCode).toBe(400);
  });

  test("a re-draft keeps edited paths — including inside a replaced subdocument — and refreshes the rest", async () => {
    await edit({
      "partB.groundsForSuspicion": "Analyst's own grounds.",
      "partA.designatedServices": ["Digital currency exchange services"],
      // reportingEntity is a subdocument the re-draft rebuilds wholesale — the
      // edited leaf must survive that (reportDrafts setPath).
      "partH.reportingEntity.completedBy.jobTitle": "MLRO",
    });
    await SMR.updateOne({ caseId: caseDoc._id }, { $set: { "partC.personOrganisation.occupation": "stale" } });

    const { res } = await draft("smr", { regenerate: true });
    const r = res.body.data;
    expect(r.partB.groundsForSuspicion).toBe("Analyst's own grounds."); // analyst-owned → kept
    expect(r.partB.groundsList).toEqual(NARRATIVE.smr.groundsList); // AI-owned → refreshed
    expect(r.partA.designatedServices).toEqual(["Digital currency exchange services"]); // edited fact → kept
    expect(r.partH.reportingEntity.completedBy.jobTitle).toBe("MLRO"); // survives subdoc rebuild
    expect(r.partH.reportingEntity.name).toBe("Linkcaps"); // the rest of the subdoc refreshed
    expect(r.partC.personOrganisation.occupation).not.toBe("stale"); // evidence → recomputed
  });

  test("suggest returns fresh Part B prose without saving it", async () => {
    await edit({ "partB.groundsForSuspicion": "Mine." });
    aiReports.draftNarrative.mockClear();
    const { res, err } = await call(caseCtrl.suggestCaseReportNarrative, {
      params: { id: String(caseDoc._id), type: "smr" }, user,
    });
    expect(err).toBeNull();
    expect(res.body.data.narrative.groundsForSuspicion).toBe(NARRATIVE.smr.groundsForSuspicion);
    expect((await SMR.findOne({ caseId: caseDoc._id }).lean()).partB.groundsForSuspicion).toBe("Mine.");
  });
});
