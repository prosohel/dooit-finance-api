const asyncHandler = require("../middleware/async");
const ObligationLibrary = require("../models/ObligationLibrary");
const ErrorResponse = require("../utils/errorResponse");

// @desc   List obligations (filterable by entityType, license, service, category)
// @route  GET /api/v1/obligation-library
// @access Protected
exports.getObligations = asyncHandler(async (req, res) => {
  const { category, entityType, license, service, search, jurisdiction, page = 1, limit = 50 } = req.query;

  const filter = { active: true };

  if (category) filter.category = category;
  // Pre-pack records have no jurisdiction field: treat them as AU.
  if (jurisdiction) {
    const j = String(jurisdiction).toUpperCase();
    filter.jurisdiction = j === "AU" ? { $in: ["AU", null] } : j;
  }

  if (entityType) {
    filter.$or = [
      { applicableEntityTypes: { $in: ["All", "All Entities", "All AFSL Holders", "ALL"] } },
      { applicableEntityTypes: { $regex: entityType, $options: "i" } },
    ];
  }

  if (license) {
    const licenseOr = [
      { applicableLicenses: { $in: [license, "Any"] } },
    ];
    filter.$or = filter.$or ? [...filter.$or, ...licenseOr] : licenseOr;
  }

  if (service) {
    filter.applicableServices = { $in: [service, "Any", "All"] };
  }

  if (search) {
    filter.$or = [
      { obligationId: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
      { regulatorySource: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [data, total] = await Promise.all([
    ObligationLibrary.find(filter).sort({ obligationId: 1 }).skip(skip).limit(parseInt(limit)),
    ObligationLibrary.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    totalRecords: total,
    pagination: { page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) },
    data,
  });
});

// @desc   Get single obligation
// @route  GET /api/v1/obligation-library/:obligationId
// @access Protected
exports.getObligation = asyncHandler(async (req, res, next) => {
  const ob = await ObligationLibrary.findOne({ obligationId: req.params.obligationId.toUpperCase() });
  if (!ob) return next(new ErrorResponse("Obligation not found", 404));
  res.status(200).json({ success: true, data: ob });
});

// @desc   Create obligation
// @route  POST /api/v1/obligation-library
// @access Protected
exports.createObligation = asyncHandler(async (req, res) => {
  const ob = await ObligationLibrary.create(req.body);
  res.status(201).json({ success: true, data: ob });
});

// @desc   Update obligation
// @route  PUT /api/v1/obligation-library/:obligationId
// @access Protected
exports.updateObligation = asyncHandler(async (req, res, next) => {
  const ob = await ObligationLibrary.findOneAndUpdate(
    { obligationId: req.params.obligationId.toUpperCase() },
    req.body,
    { new: true, runValidators: true }
  );
  if (!ob) return next(new ErrorResponse("Obligation not found", 404));
  res.status(200).json({ success: true, data: ob });
});

// @desc   Delete obligation
// @route  DELETE /api/v1/obligation-library/:obligationId
// @access Protected
exports.deleteObligation = asyncHandler(async (req, res, next) => {
  const ob = await ObligationLibrary.findOneAndDelete({
    obligationId: req.params.obligationId.toUpperCase(),
  });
  if (!ob) return next(new ErrorResponse("Obligation not found", 404));
  res.status(200).json({ success: true, data: {} });
});

// @desc   Bulk import obligations from array
// @route  POST /api/v1/obligation-library/bulk-import
// @access Protected
exports.bulkImport = asyncHandler(async (req, res) => {
  const { obligations } = req.body;
  if (!Array.isArray(obligations) || !obligations.length) {
    return res.status(400).json({ success: false, message: "obligations array required" });
  }

  let inserted = 0;
  let updated = 0;
  const errors = [];

  for (const ob of obligations) {
    try {
      const result = await ObligationLibrary.findOneAndUpdate(
        { obligationId: ob.obligationId?.toUpperCase() },
        { ...ob, obligationId: ob.obligationId?.toUpperCase() },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      );
      result.isNew ? inserted++ : updated++;
    } catch (err) {
      errors.push({ id: ob.obligationId, error: err.message });
    }
  }

  res.status(200).json({
    success: true,
    message: `${inserted} inserted, ${updated} updated, ${errors.length} errors.`,
    data: { inserted, updated, errors },
  });
});

// @desc   List all unique categories
// @route  GET /api/v1/obligation-library/categories
// @access Protected
exports.getCategories = asyncHandler(async (req, res) => {
  const catFilter = { active: true };
  if (req.query.jurisdiction) {
    const j = String(req.query.jurisdiction).toUpperCase();
    catFilter.jurisdiction = j === "AU" ? { $in: ["AU", null] } : j;
  }
  const categories = await ObligationLibrary.distinct("category", catFilter);
  res.status(200).json({ success: true, data: categories.sort() });
});
