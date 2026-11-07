const asyncHandler    = require("../middleware/async");
const ErrorResponse   = require("../utils/errorResponse");
const IssueRegister   = require("../models/IssueRegister");
const RemediationTask = require("../models/RemediationTask");
const { notifyGapRemediation } = require("../services/exchangeEmit");

const POPULATE_ISSUE = [
  { path: "owner",          select: "name email" },
  { path: "createdBy",      select: "name email" },
  { path: "closedBy",       select: "name email" },
  { path: "linkedControl",  select: "controlId title domain" },
  { path: "linkedTest",     select: "name status result" },
];

// ── GET /issue ────────────────────────────────────────────────────────────────
exports.getIssues = asyncHandler(async (req, res) => {
  const { domain, severity, status, source, search, page = 1, limit = 20 } = req.query;
  // The tenant: the user's own client, or the active membership's (a regulator seat opened by handoff has no User.client).
  const client = req.user?.client?._id ?? req.user?.clientBelongs ?? null;

  const filter = { client };
  if (domain)   filter.domain   = domain;
  if (severity) filter.severity = severity;
  if (status)   filter.status   = status;
  if (source)   filter.source   = source;
  if (search)   filter.$or = [
    { title:       { $regex: search, $options: "i" } },
    { description: { $regex: search, $options: "i" } },
    { issueId:     { $regex: search, $options: "i" } },
  ];

  const options = {
    page:     parseInt(page),
    limit:    parseInt(limit),
    sort:     { createdAt: -1 },
    populate: POPULATE_ISSUE,
  };

  const result = await IssueRegister.paginate(filter, options);
  res.json({
    success: true,
    pagination: { page: result.page, total: result.totalDocs, totalPages: result.totalPages },
    data: result.docs,
  });
});

// ── GET /issue/summary ────────────────────────────────────────────────────────
exports.getIssueSummary = asyncHandler(async (req, res) => {
  // The tenant: the user's own client, or the active membership's (a regulator seat opened by handoff has no User.client).
  const client = req.user?.client?._id ?? req.user?.clientBelongs ?? null;

  const [statusCounts, severityCounts] = await Promise.all([
    IssueRegister.aggregate([
      { $match: { client } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    IssueRegister.aggregate([
      { $match: { client } },
      { $group: { _id: "$severity", count: { $sum: 1 } } },
    ]),
  ]);

  res.json({
    success: true,
    data: {
      byStatus:   Object.fromEntries(statusCounts.map((s) => [s._id, s.count])),
      bySeverity: Object.fromEntries(severityCounts.map((s) => [s._id, s.count])),
    },
  });
});

// ── GET /issue/:id ────────────────────────────────────────────────────────────
exports.getIssue = asyncHandler(async (req, res, next) => {
  const doc = await IssueRegister.findById(req.params.id).populate(POPULATE_ISSUE);
  if (!doc) return next(new ErrorResponse("Issue not found", 404));

  const tasks = await RemediationTask.find({ issue: doc._id })
    .populate("assignedTo",  "name email")
    .populate("completedBy", "name email")
    .sort({ createdAt: 1 })
    .lean();

  res.json({ success: true, data: { ...doc.toObject(), remediationTasks: tasks } });
});

// ── POST /issue ───────────────────────────────────────────────────────────────
exports.createIssue = asyncHandler(async (req, res) => {
  // The tenant: the user's own client, or the active membership's (a regulator seat opened by handoff has no User.client).
  const client = req.user?.client?._id ?? req.user?.clientBelongs ?? null;
  const doc = await IssueRegister.create({
    ...req.body,
    client,
    createdBy: req.user?._id,
  });
  res.status(201).json({ success: true, data: doc });
});

// ── PUT /issue/:id ────────────────────────────────────────────────────────────
exports.updateIssue = asyncHandler(async (req, res, next) => {
  const updates = { ...req.body };

  // Auto-set closedAt when status becomes Closed / Accepted Risk
  if (
    ["Closed", "Accepted Risk"].includes(updates.status) &&
    !updates.closedAt
  ) {
    updates.closedAt = new Date();
    updates.closedBy = req.user?._id;
  }

  const before = updates.status ? await IssueRegister.findById(req.params.id).select("status").lean() : null;
  const doc = await IssueRegister.findByIdAndUpdate(req.params.id, updates, {
    new: true, runValidators: true,
  }).populate(POPULATE_ISSUE);
  if (!doc) return next(new ErrorResponse("Issue not found", 404));
  // An issue raised from an AFC OS gap: the regulator sees its status change (closed, accepted risk, reopened).
  if (updates.status && before && before.status !== doc.status) await notifyGapRemediation({ issue: doc, status: doc.status, by: req.user?.name ?? null, note: updates.notes ?? null });
  res.json({ success: true, data: doc });
});

// ── DELETE /issue/:id (soft — set status Closed) ─────────────────────────────
exports.deleteIssue = asyncHandler(async (req, res, next) => {
  const doc = await IssueRegister.findByIdAndUpdate(
    req.params.id,
    { status: "Closed", closedAt: new Date(), closedBy: req.user?._id },
    { new: true }
  );
  if (!doc) return next(new ErrorResponse("Issue not found", 404));
  await notifyGapRemediation({ issue: doc, status: "Closed", by: req.user?.name ?? null });
  res.json({ success: true, data: doc._id });
});

// ─────────────────────────────────────────────────────────────────────────────
// Remediation Tasks (nested under issue)
// ─────────────────────────────────────────────────────────────────────────────

// GET /issue/:id/tasks
exports.getTasks = asyncHandler(async (req, res) => {
  const tasks = await RemediationTask.find({ issue: req.params.id })
    .populate("assignedTo",  "name email")
    .populate("completedBy", "name email")
    .sort({ createdAt: 1 })
    .lean();
  res.json({ success: true, data: tasks });
});

// POST /issue/:id/tasks
exports.createTask = asyncHandler(async (req, res) => {
  // The tenant: the user's own client, or the active membership's (a regulator seat opened by handoff has no User.client).
  const client = req.user?.client?._id ?? req.user?.clientBelongs ?? null;
  const task = await RemediationTask.create({
    ...req.body,
    issue:     req.params.id,
    client,
    createdBy: req.user?._id,
  });
  res.status(201).json({ success: true, data: task });
});

// PUT /issue/:issueId/tasks/:taskId
exports.updateTask = asyncHandler(async (req, res, next) => {
  const updates = { ...req.body };
  if (updates.status === "Completed" && !updates.completedAt) {
    updates.completedAt = new Date();
    updates.completedBy = req.user?._id;
  }
  const before = updates.status ? await RemediationTask.findById(req.params.taskId).select("status").lean() : null;
  const task = await RemediationTask.findByIdAndUpdate(req.params.taskId, updates, {
    new: true, runValidators: true,
  }).populate("assignedTo", "name email");
  if (!task) return next(new ErrorResponse("Task not found", 404));
  // Completed / reopened / in progress on a task that came from an AFC OS gap → the officer's gap card updates.
  if (updates.status && before && before.status !== task.status) {
    const issue = await IssueRegister.findById(task.issue).select("issueId client tags closedAt").lean();
    if (issue) await notifyGapRemediation({ issue, task, status: task.status, by: req.user?.name ?? null, note: updates.notes ?? null });
  }
  res.json({ success: true, data: task });
});

// DELETE /issue/:issueId/tasks/:taskId
exports.deleteTask = asyncHandler(async (req, res, next) => {
  const task = await RemediationTask.findByIdAndUpdate(
    req.params.taskId,
    { status: "Cancelled" },
    { new: true }
  );
  if (!task) return next(new ErrorResponse("Task not found", 404));
  res.json({ success: true, data: task._id });
});
