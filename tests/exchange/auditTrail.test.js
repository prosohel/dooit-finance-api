/**
 * Platform audit rows for the exchange hub and the AFC OS routes.
 *
 * Those controllers describe an event the AFC OS way: `target: { kind, id, uid }`,
 * `before` / `after`, status "failure". AuditLog stores a string target,
 * `beforeValue` / `afterValue` and status "success" | "failed". Before
 * utils/audit.js translated between the two, every such row failed validation
 * and was dropped with only a console line, so exchange events, handoffs and
 * vault file access left no audit trail on the platform.
 *
 * Self-contained: in-memory Mongo, the writer called directly.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod, AuditLog, logEvent, normalise, errors;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  AuditLog = require("../../models/AuditLog");
  ({ logEvent, normalise } = require("../../utils/audit"));
  errors = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  errors.mockRestore();
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AuditLog.deleteMany({});
  errors.mockClear();
});

const req = { user: { _id: new mongoose.Types.ObjectId(), name: "Hub", role: "service" }, headers: {}, ip: "127.0.0.1" };

describe("normalise", () => {
  test("an object target becomes its uid, and the kind goes to details", () => {
    const id = new mongoose.Types.ObjectId();
    expect(normalise({ status: "success", target: { kind: "ExchangeEvent", id, uid: "EVT-2026-000001" } })).toMatchObject({ target: "EVT-2026-000001", details: "ExchangeEvent" });
  });

  test("without a uid the id is used", () => {
    const id = new mongoose.Types.ObjectId();
    expect(normalise({ target: { kind: "FileVault", id } }).target).toBe(String(id));
    expect(normalise({ target: { kind: "FileVault", id: null } }).target).toBeNull();
  });

  test("details given by the caller are kept", () => {
    expect(normalise({ target: { kind: "FileVault", id: "f1" }, details: "served to afcos" }).details).toBe("served to afcos");
  });

  test("a string target, the shape every other service uses, is untouched", () => {
    expect(normalise({ status: "success", target: "SMR-2026-0001", reportType: "SMR" })).toEqual({ status: "success", target: "SMR-2026-0001", reportType: "SMR" });
  });

  test("before / after map to beforeValue / afterValue; an explicit value wins", () => {
    expect(normalise({ before: { a: 1 }, after: { a: 2 } })).toMatchObject({ beforeValue: { a: 1 }, afterValue: { a: 2 } });
    expect(normalise({ after: { a: 2 }, afterValue: { a: 3 } }).afterValue).toEqual({ a: 3 });
  });

  test('status "failure" is stored as "failed"', () => {
    expect(normalise({ status: "failure" }).status).toBe("failed");
    expect(normalise({ status: "success" }).status).toBe("success");
  });
});

describe("logEvent", () => {
  test("an exchange event is written to the audit log (it used to be dropped)", async () => {
    const id = new mongoose.Types.ObjectId();
    await logEvent({ req, service: "exchange", action: "ingested", target: { kind: "ExchangeEvent", id, uid: "EVT-2026-000001" }, after: { type: "rfi.issued", to: "portal" } });

    const rows = await AuditLog.find({ service: "exchange" }).lean();
    expect(errors).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "ingested", status: "success", target: "EVT-2026-000001", details: "ExchangeEvent", afterValue: { type: "rfi.issued", to: "portal" }, actorName: "Hub" });
  });

  test("a failed projection is recorded as failed, with its reason", async () => {
    await logEvent({ req, service: "exchange", action: "projected", status: "failure", target: { kind: "ExchangeEvent", id: new mongoose.Types.ObjectId(), uid: "EVT-2026-000002" }, details: "client not found" });

    const row = await AuditLog.findOne({ action: "projected" }).lean();
    expect(row).toMatchObject({ status: "failed", target: "EVT-2026-000002", details: "client not found" });
  });

  test("vault access for AFC OS is recorded against the file id", async () => {
    await logEvent({ req, service: "afc-os", action: "file_purged", target: { kind: "FileVault", id: "66f0aa11bb22cc33dd44ee55" }, details: "afcos" });

    const row = await AuditLog.findOne({ action: "file_purged" }).lean();
    expect(row).toMatchObject({ service: "afc-os", target: "66f0aa11bb22cc33dd44ee55", details: "afcos" });
  });

  test("the existing string-target callers still work", async () => {
    await logEvent({ req, service: "report", action: "smr_submitted", reportType: "SMR", target: "SMR-2026-0001", beforeValue: { status: "draft" }, afterValue: { status: "submitted" } });

    const row = await AuditLog.findOne({ action: "smr_submitted" }).lean();
    expect(row).toMatchObject({ target: "SMR-2026-0001", reportType: "SMR", beforeValue: { status: "draft" }, afterValue: { status: "submitted" } });
  });
});
