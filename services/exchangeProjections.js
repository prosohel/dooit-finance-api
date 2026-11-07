/**
 * Exchange projections — what the platform does with an inbound event beyond
 * storing it. The hub "stores and routes; it never interprets a payload"
 * (controllers/exchangeController.js), so interpretation lives here, one
 * function per event type, called after the event row is saved. Each one is
 * idempotent (re-delivery of the same event must not duplicate anything) and
 * never throws into the ingest path: a projection failure is logged and the
 * event still counts as delivered — the GRC inbox shows it regardless.
 *
 *   submission.accepted  → one IssueRegister row per accepted gap (docs/77 §1:
 *                           "the GRC Platform turns them into issues"), one
 *                           RemediationTask per row (the proposed fix, due on the
 *                           officer's date), and `submission.issues_opened` back
 *                           to AFC OS so each gap shows its issue / task
 */
const IssueRegister = require("../models/IssueRegister");
const RemediationTask = require("../models/RemediationTask");
const { emitPlatformEvent } = require("./exchangeEmit");

const SEVERITY = { high: "High", medium: "Medium", low: "Low", critical: "Critical" };

/** AFC OS obligation ids look like BD-AML-006; map a few prefixes to the Issue Register domains, default compliance. */
function domainOf(obligationId = "") {
  const id = String(obligationId).toUpperCase();
  if (/CDD|KYC/.test(id)) return "CDD";
  if (/TM|MON/.test(id)) return "TM";
  if (/RPT|STR|CTR/.test(id)) return "RPT";
  if (/SCR|SANCTION/.test(id)) return "SCR";
  if (/GOV/.test(id)) return "GOV";
  if (/TRN|TRAIN/.test(id)) return "TRN";
  return "COM";
}

async function projectSubmissionAccepted(event) {
  const client = event.to?.client;
  if (!client) return { ok: false, note: "no tenant on the event (RO not provisioned)" };
  const p = event.payload ?? {};
  const gaps = Array.isArray(p.gaps) ? p.gaps : [];
  const dueDate = new Date(Date.now() + Number(p.due_in_days ?? 60) * 86_400_000);
  let created = 0;
  const opened = [];
  for (const g of gaps) {
    const key = `afcos:${p.submission_id}:${g.gap_id}`;
    if (await IssueRegister.exists({ client, tags: key })) continue; // re-delivery
    const issue = await IssueRegister.create({
      client,
      title: g.text?.slice(0, 180) || `Gap ${g.gap_id} on ${p.submission_id}`,
      description: [g.proposed_fix ? `Proposed fix: ${g.proposed_fix}` : null, g.obligation_id ? `Obligation: ${g.obligation_id}` : null, `Raised by Bangladesh Bank (MLTFPD) from submission ${p.submission_id}, gap ${g.gap_id}.`].filter(Boolean).join("\n"),
      domain: domainOf(g.obligation_id),
      severity: SEVERITY[String(g.severity ?? "medium").toLowerCase()] ?? "Medium",
      status: "Open",
      source: "Regulatory",
      dueDate,
      notes: `Exchange event ${event.eventId}`,
      tags: ["afc-os", "mltfpd", p.submission_id, g.gap_id, key].filter(Boolean),
    });
    // The first remediation task is the regulator's proposed fix; the RO's GRC team can add more.
    const task = await RemediationTask.create({
      client,
      issue: issue._id,
      title: (g.proposed_fix || `Remediate ${g.gap_id}: ${g.text ?? ""}`).slice(0, 180),
      description: `Remediation of gap ${g.gap_id} on ${p.submission_id}${g.obligation_id ? ` (obligation ${g.obligation_id})` : ""}. Mark it completed once the evidence is attached to the issue; Bangladesh Bank (MLTFPD) sees every status change on its side.`,
      priority: SEVERITY[String(g.severity ?? "medium").toLowerCase()] ?? "Medium",
      status: "Open",
      dueDate,
      notes: key,
    });
    opened.push({ gap_id: g.gap_id, issue_id: issue.issueId, issue: String(issue._id), task_id: task.taskId, task: String(task._id), due_date: dueDate });
    created += 1;
  }
  if (opened.length) {
    await emitPlatformEvent({
      type: "submission.issues_opened",
      client,
      subject: { kind: "Submission", uid: p.submission_id },
      payload: { submission_id: p.submission_id, gaps: opened, due_date: dueDate },
      idempotencyKey: `grc:issues_opened:${event.eventId}`,
    });
  }
  return { ok: true, note: `${created} issue(s) and task(s) opened from ${gaps.length} accepted gap(s)` };
}

const PROJECTIONS = {
  "submission.accepted": projectSubmissionAccepted,
};

/** Runs the projection for the event type, if any. Never throws. */
async function project(event) {
  const fn = PROJECTIONS[event.type];
  if (!fn) return null;
  try {
    return await fn(event);
  } catch (err) {
    console.error(`[exchange] projection ${event.type} ${event.eventId} failed:`, err.message);
    return { ok: false, note: err.message };
  }
}

module.exports = { project, PROJECTIONS };
