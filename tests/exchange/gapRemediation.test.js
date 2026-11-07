/**
 * Exchange hub: accepted gaps → Issue Register + remediation tasks → events back
 * to AFC OS (worklog item 45).
 *
 *   submission.accepted (from AFC OS) → projection opens one issue + one task per
 *     gap and queues `submission.issues_opened` to afcos; re-delivery adds nothing
 *   PUT /issue/:id/tasks/:taskId {status} on such a task → `gap.remediation_updated`
 *   PUT /issue/:id {status: Closed} → `gap.remediation_updated` (issue-level)
 *   an issue that did not come from AFC OS → no event
 *
 * Self-contained model pattern: in-memory Mongo, handlers invoked directly.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.EXCHANGE_SIGNING_KEY = "test-exchange-key";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod, Client, ExchangeEvent, IssueRegister, RemediationTask, project, ctrl, client;

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
  // Every model, so the issue controller's populate() paths (owner, linked control / test) resolve.
  for (const f of require("fs").readdirSync(require("path").join(__dirname, "../../models")).filter((x) => x.endsWith(".js"))) { try { require(`../../models/${f}`); } catch { /* a model that needs env we do not set */ } }
  Client = require("../../models/Client");
  ExchangeEvent = require("../../models/ExchangeEvent");
  IssueRegister = require("../../models/IssueRegister");
  RemediationTask = require("../../models/RemediationTask");
  ({ project } = require("../../services/exchangeProjections"));
  ctrl = require("../../controllers/issueRegisterController");
  client = await Client.create({ name: "Test Bank PLC", uid: "RO-TEST", clientType: "Bank" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const user = { _id: new mongoose.Types.ObjectId(), name: "Head of Compliance", client: { _id: null } };

async function acceptedEvent(submissionId = "SUB-2026-00001") {
  return ExchangeEvent.create({
    seq: await ExchangeEvent.nextSeq(), eventId: `EVT-${submissionId}`, type: "submission.accepted", occurredAt: new Date(),
    from: { app: "afcos" }, to: { app: "grc", client: client._id, roId: "RO-TEST" },
    subject: { kind: "Submission", uid: submissionId },
    payload: { submission_id: submissionId, due_in_days: 45, gaps: [{ gap_id: "G-01", text: "No independent audit cycle", obligation_id: "BD-AML-006", severity: "High", proposed_fix: "Adopt an annual internal audit cycle" }, { gap_id: "G-02", text: "Training rate not tracked", severity: "Medium" }] },
    idempotencyKey: `afcos:${submissionId}:accepted`,
  });
}

describe("projection", () => {
  test("opens an issue and a task per gap and queues submission.issues_opened to afcos; re-delivery is a no-op", async () => {
    const event = await acceptedEvent();
    const r = await project(event);
    expect(r.ok).toBe(true);
    const issues = await IssueRegister.find({ client: client._id, tags: "SUB-2026-00001" }).sort("issueId").lean();
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ source: "Regulatory", severity: "High", status: "Open" });
    const tasks = await RemediationTask.find({ issue: { $in: issues.map((i) => i._id) } }).lean();
    expect(tasks).toHaveLength(2);
    const t1 = tasks.find((t) => String(t.issue) === String(issues[0]._id));
    expect(t1).toMatchObject({ title: "Adopt an annual internal audit cycle", priority: "High", status: "Open", notes: "afcos:SUB-2026-00001:G-01" });
    expect(Math.round((t1.dueDate - Date.now()) / 86_400_000)).toBe(45);

    const out = await ExchangeEvent.findOne({ type: "submission.issues_opened", "subject.uid": "SUB-2026-00001" }).lean();
    expect(out).toBeTruthy();
    expect(out.to.app).toBe("afcos");
    expect(out.from).toMatchObject({ app: "grc", roId: "RO-TEST" });
    expect(out.status).toBe("queued");
    expect(out.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.payload.gaps.map((g) => [g.gap_id, g.issue_id, g.task_id])).toEqual([["G-01", issues[0].issueId, "REM-0001"], ["G-02", issues[1].issueId, "REM-0001"]]);

    // The hub re-delivers the same event: nothing new.
    await project(event);
    expect(await IssueRegister.countDocuments({ tags: "SUB-2026-00001" })).toBe(2);
    expect(await ExchangeEvent.countDocuments({ type: "submission.issues_opened" })).toBe(1);
  });
});

describe("status changes reach AFC OS", () => {
  test("completing the task emits gap.remediation_updated with the AFC OS key; a non-status update does not", async () => {
    const issue = await IssueRegister.findOne({ tags: "afcos:SUB-2026-00001:G-01" });
    const task = await RemediationTask.findOne({ issue: issue._id });

    await call(ctrl.updateTask, { params: { issueId: String(issue._id), taskId: String(task._id) }, body: { description: "more detail" }, user });
    expect(await ExchangeEvent.countDocuments({ type: "gap.remediation_updated" })).toBe(0);

    const { res } = await call(ctrl.updateTask, { params: { issueId: String(issue._id), taskId: String(task._id) }, body: { status: "Completed", notes: "Charter approved by the board" }, user });
    expect(res.statusCode).toBe(200);
    const out = await ExchangeEvent.findOne({ type: "gap.remediation_updated" }).lean();
    expect(out).toBeTruthy();
    expect(out.payload).toMatchObject({ submission_id: "SUB-2026-00001", gap_id: "G-01", issue_id: issue.issueId, task_id: "REM-0001", status: "Completed", by: "Head of Compliance", note: "Charter approved by the board" });
    expect(out.payload.completed_at).toBeTruthy();
    expect(out.to.app).toBe("afcos");
  });

  test("closing the issue emits an issue-level update", async () => {
    const issue = await IssueRegister.findOne({ tags: "afcos:SUB-2026-00001:G-02" });
    const { res, err } = await call(ctrl.updateIssue, { params: { id: String(issue._id) }, body: { status: "Closed" }, user });
    expect(err).toBeNull();
    expect(res.statusCode).toBe(200);
    const out = await ExchangeEvent.findOne({ type: "gap.remediation_updated", "payload.gap_id": "G-02" }).lean();
    expect(out.payload).toMatchObject({ status: "Closed", task_id: null });
  });

  test("an issue that did not come from AFC OS stays silent", async () => {
    const own = await IssueRegister.create({ client: client._id, title: "Self-identified", domain: "COM", severity: "Low", status: "Open", source: "Self-Identified" });
    const before = await ExchangeEvent.countDocuments({ type: "gap.remediation_updated" });
    await call(ctrl.updateIssue, { params: { id: String(own._id) }, body: { status: "Closed" }, user });
    expect(await ExchangeEvent.countDocuments({ type: "gap.remediation_updated" })).toBe(before);
  });
});
