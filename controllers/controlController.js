const asyncHandler = require("../middleware/async");
const Control = require("../models/Control");
const ErrorResponse = require("../utils/errorResponse");

const getClient = (req) => req.user?.client?._id || req.user?.clientBelongs || null;

// @desc   Get all controls (filterable by domain, type, search)
// @route  GET /api/v1/control
// @access Protected
exports.getControls = asyncHandler(async (req, res) => {
  const {
    domain, controlType, automationLevel, riskMitigationLevel, owner, jurisdiction,
    active = "true", search, page = 1, limit = 50,
  } = req.query;

  const filter = {};
  if (domain) filter.domain = domain;
  // Pre-pack records have no jurisdiction field: treat them as AU.
  if (jurisdiction) {
    const j = String(jurisdiction).toUpperCase();
    filter.jurisdiction = j === "AU" ? { $in: ["AU", null] } : j;
  }
  if (controlType) filter.controlType = controlType;
  if (automationLevel) filter.automationLevel = automationLevel;
  if (riskMitigationLevel) filter.riskMitigationLevel = riskMitigationLevel;
  if (owner) filter.owner = { $regex: owner, $options: "i" };
  if (active !== "all") filter.active = active === "true";
  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: "i" } },
      { controlId: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
    ];
  }

  const options = {
    page: parseInt(page),
    limit: parseInt(limit),
    sort: { domain: 1, controlId: 1 },
  };

  const result = await Control.paginate(filter, options);

  res.status(200).json({
    success: true,
    pagination: {
      page: result.page,
      limit: result.limit,
      total: result.totalDocs,
      totalPages: result.totalPages,
    },
    data: result.docs,
  });
});

// @desc   Get domain summary counts
// @route  GET /api/v1/control/domains
// @access Protected
exports.getDomains = asyncHandler(async (req, res) => {
  const domains = await Control.aggregate([
    { $match: { active: true } },
    { $group: { _id: "$domain", count: { $sum: 1 }, prefix: { $first: "$prefix" } } },
    { $sort: { _id: 1 } },
  ]);
  res.status(200).json({ success: true, data: domains });
});

// @desc   Get a single control
// @route  GET /api/v1/control/:id
// @access Protected
exports.getControl = asyncHandler(async (req, res, next) => {
  const control = await Control.findById(req.params.id);
  if (!control) return next(new ErrorResponse("Control not found", 404));
  res.status(200).json({ success: true, data: control });
});

// @desc   Create a control
// @route  POST /api/v1/control
// @access Protected
exports.createControl = asyncHandler(async (req, res) => {
  req.body.client = getClient(req);
  const control = await Control.create(req.body);
  res.status(201).json({ success: true, data: control });
});

// @desc   Update a control
// @route  PUT /api/v1/control/:id
// @access Protected
exports.updateControl = asyncHandler(async (req, res, next) => {
  const control = await Control.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!control) return next(new ErrorResponse("Control not found", 404));
  res.status(200).json({ success: true, data: control });
});

// @desc   Delete a control (soft-delete via active flag)
// @route  DELETE /api/v1/control/:id
// @access Protected
exports.deleteControl = asyncHandler(async (req, res, next) => {
  const control = await Control.findByIdAndUpdate(
    req.params.id,
    { active: false },
    { new: true }
  );
  if (!control) return next(new ErrorResponse("Control not found", 404));
  res.status(200).json({ success: true, data: {} });
});

// @desc   Bulk import / upsert controls from array
// @route  POST /api/v1/control/bulk-import
// @access Protected
exports.bulkImport = asyncHandler(async (req, res) => {
  const { controls } = req.body;
  if (!Array.isArray(controls) || controls.length === 0) {
    return res.status(400).json({ success: false, message: "controls array required" });
  }

  const ops = controls.map((c) => ({
    updateOne: {
      filter: { controlId: c.controlId.toUpperCase() },
      update: { $set: { ...c, controlId: c.controlId.toUpperCase() } },
      upsert: true,
    },
  }));

  const result = await Control.bulkWrite(ops, { ordered: false });
  res.status(200).json({
    success: true,
    data: {
      upserted: result.upsertedCount,
      modified: result.modifiedCount,
      total: controls.length,
    },
  });
});

// @desc   Assign owner to one or many controls
// @route  PUT /api/v1/control/assign-owner
// @access Protected
exports.assignOwner = asyncHandler(async (req, res) => {
  const { controlIds, owner, testingFrequency } = req.body;
  if (!Array.isArray(controlIds) || !owner) {
    return res.status(400).json({ success: false, message: "controlIds[] and owner required" });
  }

  const update = { owner };
  if (testingFrequency) update.testingFrequency = testingFrequency;

  const result = await Control.updateMany(
    { controlId: { $in: controlIds.map((id) => id.toUpperCase()) } },
    { $set: update }
  );

  res.status(200).json({ success: true, data: { matched: result.matchedCount, modified: result.modifiedCount } });
});

// @desc   Sync industryTags on controls from Controls_Entity_Map seed data
// @route  POST /api/v1/control/sync-industry-tags
// @access Protected
exports.syncIndustryTags = asyncHandler(async (req, res) => {
  const { CONTROL_INDUSTRY_TAGS } = require("../data/controlAssignmentSeed");

  const ops = Object.entries(CONTROL_INDUSTRY_TAGS)
    .filter(([, tags]) => tags.length > 0)
    .map(([controlId, tags]) => ({
      updateOne: {
        filter: { controlId },
        update: { $set: { industryTags: tags } },
      },
    }));

  const result = await Control.bulkWrite(ops, { ordered: false });
  res.status(200).json({
    success: true,
    data: { matched: result.matchedCount, modified: result.modifiedCount, total: ops.length },
  });
});

// @desc   Get controls linked to a specific obligation
// @route  GET /api/v1/control/by-obligation/:obligationId
// @access Protected
exports.getByObligation = asyncHandler(async (req, res) => {
  const controls = await Control.find({
    obligationRefs: req.params.obligationId,
    active: true,
  }).sort({ domain: 1, controlId: 1 });
  res.status(200).json({ success: true, count: controls.length, data: controls });
});
