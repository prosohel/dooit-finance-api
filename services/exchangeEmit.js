/**
 * Events the platform itself produces on the exchange hub (as opposed to events
 * a tenant's user produces through `POST /exchange/events`). Used when a GRC
 * action should reach the regulator without anyone pressing "send":
 *
 *   submission.issues_opened  — the hub projection turned accepted gaps into
 *                               Issue Register rows + remediation tasks; AFC OS
 *                               links each gap to its issue/task
 *   gap.remediation_updated   — a remediation task's status changed (or the
 *                               issue was closed); AFC OS shows it on the gap
 *
 * Both are addressed to `afcos`, carry the tenant as `from.client` / `from.roId`
 * (so the AFC OS worker resolves the RO the usual way), and are signed by the
 * ExchangeEvent pre-validate hook like every hub-issued event.
 */
const ExchangeEvent = require("../models/ExchangeEvent");
const Client = require("../models/Client");

/** Create a queued hub event from the platform. Idempotent on `idempotencyKey`. */
async function emitPlatformEvent({ type, fromApp = "grc", client = null, subject, payload, idempotencyKey, actor = {} }) {
  const existing = await ExchangeEvent.findOne({ idempotencyKey }).select("eventId seq status").lean();
  if (existing) return { duplicate: true, eventId: existing.eventId, seq: existing.seq };
  const c = client ? await Client.findById(client).select("uid name").lean() : null;
  const doc = await ExchangeEvent.create({
    seq: await ExchangeEvent.nextSeq(),
    eventId: await ExchangeEvent.nextEventId(),
    type,
    version: 1,
    occurredAt: new Date(),
    from: { app: fromApp, body: null, client: client ?? null, roId: c?.uid ?? null },
    to: { app: "afcos", body: null, client: null, roId: null },
    subject,
    payload,
    idempotencyKey,
    status: "queued",
    receivedVia: "platform",
    actor: { user: actor.user ?? null, name: actor.name ?? "GRC Platform", role: actor.role ?? "system", body: c?.name ?? null },
  });
  return { duplicate: false, eventId: doc.eventId, seq: doc.seq };
}

/** The AFC OS key an Issue Register row carries in its tags: `afcos:<submission uid>:<gap id>`. */
function afcOsKeyOf(issue) {
  const key = (issue?.tags ?? []).find((t) => /^afcos:[^:]+:[^:]+$/.test(t));
  if (!key) return null;
  const [, submissionId, gapId] = key.split(":");
  return { key, submissionId, gapId };
}

/**
 * Tell AFC OS a remediation task (or its issue) changed state. No-op for issues
 * that did not come from an AFC OS gap. Never throws into the caller.
 */
async function notifyGapRemediation({ issue, task = null, status, by = null, note = null }) {
  try {
    const ref = afcOsKeyOf(issue);
    if (!ref || !status) return null;
    return await emitPlatformEvent({
      type: "gap.remediation_updated",
      client: issue.client?._id ?? issue.client ?? null, // populated or raw id
      subject: { kind: "Submission", uid: ref.submissionId },
      payload: {
        submission_id: ref.submissionId,
        gap_id: ref.gapId,
        issue_id: issue.issueId ?? null,
        issue: String(issue._id),
        task_id: task?.taskId ?? null,
        task: task ? String(task._id) : null,
        task_title: task?.title ?? null,
        status,
        completed_at: task?.completedAt ?? issue.closedAt ?? null,
        by,
        note,
      },
      // One event per state change (a task may be reopened and completed again).
      idempotencyKey: `grc:gap:${ref.submissionId}:${ref.gapId}:${task?.taskId ?? "issue"}:${status}:${Date.now()}`,
      actor: { name: by },
    });
  } catch (err) {
    console.error(`[exchange] gap.remediation_updated not emitted:`, err.message);
    return null;
  }
}

module.exports = { emitPlatformEvent, notifyGapRemediation, afcOsKeyOf };
