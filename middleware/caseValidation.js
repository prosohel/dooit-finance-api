const ErrorResponse = require('../utils/errorResponse');

const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const VALID_TYPES      = ['SAR', 'PEP', 'transaction_monitoring', 'other'];
const VALID_CASE_TYPES = ['Fraud', 'AML', 'Compliance', 'TF'];
const VALID_STATUSES   = ['open', 'under_investigation', 'pending_review', 'closed', 'escalated'];
const VALID_DECISIONS  = ['true_positive', 'false_positive', 'sar_filed', 'no_action'];

const isObjectIdLike = (v) => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v);

exports.validateCreateCase = (req, res, next) => {
  const { title, type, caseType, priority, assignedTo, alertIds, linkedCustomers, linkedTransactions } = req.body;
  const errors = [];

  if (!title || !String(title).trim())                  errors.push('title is required');
  if (String(title || '').trim().length > 200)          errors.push('title cannot exceed 200 characters');
  if (type && !VALID_TYPES.includes(type))              errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
  if (caseType && !VALID_CASE_TYPES.includes(caseType)) errors.push(`caseType must be one of: ${VALID_CASE_TYPES.join(', ')}`);
  if (priority && !VALID_PRIORITIES.includes(priority)) errors.push(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`);

  if (assignedTo !== undefined && !isObjectIdLike(String(assignedTo)))
    errors.push('assignedTo must be a valid user ID');

  if (alertIds !== undefined) {
    if (!Array.isArray(alertIds))                               errors.push('alertIds must be an array');
    else if (alertIds.some((id) => !isObjectIdLike(id)))        errors.push('alertIds must contain valid IDs');
  }
  if (linkedCustomers !== undefined) {
    if (!Array.isArray(linkedCustomers))                        errors.push('linkedCustomers must be an array');
    else if (linkedCustomers.some((id) => !isObjectIdLike(id))) errors.push('linkedCustomers must contain valid IDs');
  }
  if (linkedTransactions !== undefined) {
    if (!Array.isArray(linkedTransactions))                           errors.push('linkedTransactions must be an array');
    else if (linkedTransactions.some((id) => !isObjectIdLike(id)))    errors.push('linkedTransactions must contain valid IDs');
  }

  if (errors.length) return next(new ErrorResponse(errors.join('; '), 400));
  next();
};

exports.validateUpdateCase = (req, res, next) => {
  const { priority, type, caseType, closureReason, decision, tags } = req.body;
  const errors = [];

  if (priority && !VALID_PRIORITIES.includes(priority))
    errors.push(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`);
  if (type && !VALID_TYPES.includes(type))
    errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
  if (caseType && !VALID_CASE_TYPES.includes(caseType))
    errors.push(`caseType must be one of: ${VALID_CASE_TYPES.join(', ')}`);
  if (decision && !VALID_DECISIONS.includes(decision))
    errors.push(`decision must be one of: ${VALID_DECISIONS.join(', ')}`);
  if (closureReason !== undefined && typeof closureReason !== 'string')
    errors.push('closureReason must be a string');
  if (tags !== undefined && !Array.isArray(tags))
    errors.push('tags must be an array of strings');

  if (errors.length) return next(new ErrorResponse(errors.join('; '), 400));
  next();
};

exports.validateStatusUpdate = (req, res, next) => {
  const { status, closureReason } = req.body;

  if (!status) return next(new ErrorResponse('status is required', 400));
  if (!VALID_STATUSES.includes(status))
    return next(new ErrorResponse(`status must be one of: ${VALID_STATUSES.join(', ')}`, 400));
  if (closureReason !== undefined && typeof closureReason !== 'string')
    return next(new ErrorResponse('closureReason must be a string', 400));
  next();
};

exports.validateAddNote = (req, res, next) => {
  const { content, attachments } = req.body;

  if (!content || !String(content).trim())
    return next(new ErrorResponse('Note content is required', 400));
  if (attachments !== undefined && !Array.isArray(attachments))
    return next(new ErrorResponse('attachments must be an array of URLs', 400));
  next();
};

exports.validateAssignment = (req, res, next) => {
  const { investigatorId } = req.body;

  // investigatorId can be null/undefined to unassign
  if (investigatorId !== undefined && investigatorId !== null && !isObjectIdLike(String(investigatorId)))
    return next(new ErrorResponse('investigatorId must be a valid user ID', 400));
  next();
};

exports.validateLinkAlerts = (req, res, next) => {
  const { alertIds } = req.body;

  if (!alertIds)                return next(new ErrorResponse('alertIds is required', 400));
  if (!Array.isArray(alertIds)) return next(new ErrorResponse('alertIds must be an array', 400));
  if (alertIds.length === 0)    return next(new ErrorResponse('alertIds must not be empty', 400));
  if (alertIds.some((id) => !isObjectIdLike(id)))
    return next(new ErrorResponse('alertIds must contain valid IDs', 400));
  next();
};



exports.validateLinkCustomers = (req, res, next) => {
  const { customerIds } = req.body;

  if (!customerIds)                return next(new ErrorResponse('customerIds is required', 400));
  if (!Array.isArray(customerIds)) return next(new ErrorResponse('customerIds must be an array', 400));
  if (customerIds.length === 0)    return next(new ErrorResponse('customerIds must not be empty', 400));
  if (customerIds.some((id) => !isObjectIdLike(id)))
    return next(new ErrorResponse('customerIds must contain valid IDs', 400));
  next();
};

// POST /cases/:id/pois (isCreate) and PATCH /cases/:id/pois/:poiId.
// Enum and length limits are enforced again by the schema; this catches the
// shape errors early with a readable message.
const POI_KINDS = ['individual', 'entity'];
const POI_ROLE_VALUES = ['subject', 'associated_party', 'counterparty', 'beneficiary', 'beneficial_owner', 'director', 'third_party', 'other'];
const POI_SLOTS = ['sender', 'receiver', 'beneficiary', 'intermediary'];

const POI_MAX_LENGTHS = {
  name: 200,
  'idDocument.number': 100,
  address: 500,
  email: 200,
  phone: 50,
  account: 100,
  notes: 2000,
};

const validateExternalPoi = (isCreate) => (req, res, next) => {
  const b = req.body || {};
  const errors = [];

  if (isCreate && !b.fromAlert && !(typeof b.name === 'string' && b.name.trim()))
    errors.push('name is required');
  if (!isCreate && 'name' in b && !(typeof b.name === 'string' && b.name.trim()))
    errors.push('name cannot be empty');
  if (!isCreate && b.fromAlert) errors.push('fromAlert can only be set when adding a POI');

  if (b.fromAlert) {
    if (!isObjectIdLike(b.fromAlert.alertId)) errors.push('fromAlert.alertId must be a valid ID');
    if (!POI_SLOTS.includes(b.fromAlert.slot))
      errors.push(`fromAlert.slot must be one of: ${POI_SLOTS.join(', ')}`);
  }
  if (b.kind !== undefined && !POI_KINDS.includes(b.kind))
    errors.push(`kind must be one of: ${POI_KINDS.join(', ')}`);
  if (b.role !== undefined && !POI_ROLE_VALUES.includes(b.role))
    errors.push(`role must be one of: ${POI_ROLE_VALUES.join(', ')}`);
  if (b.dateOfBirth) {
    const dob = new Date(b.dateOfBirth);
    if (Number.isNaN(dob.getTime())) errors.push('dateOfBirth must be a valid date');
    else if (dob > new Date()) errors.push('dateOfBirth cannot be in the future');
  }
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) errors.push('email must be a valid email address');
  // Encrypted fields have no schema maxlength (ciphertext is longer than the
  // value), so the limits are enforced here, on the plaintext.
  for (const [key, max] of Object.entries(POI_MAX_LENGTHS)) {
    const v = key === 'idDocument.number' ? b.idDocument?.number : b[key];
    if (typeof v === 'string' && v.length > max) errors.push(`${key} cannot exceed ${max} characters`);
  }
  if (Array.isArray(b.aliases) && b.aliases.some((a) => String(a).length > 200))
    errors.push('each alias cannot exceed 200 characters');
  if (b.aliases !== undefined && !Array.isArray(b.aliases)) errors.push('aliases must be an array');
  if (b.idDocument !== undefined && b.idDocument !== null && typeof b.idDocument !== 'object')
    errors.push('idDocument must be an object');

  if (errors.length) return next(new ErrorResponse(errors.join('; '), 400));
  next();
};

exports.validateAddPoi = validateExternalPoi(true);
exports.validateUpdatePoi = validateExternalPoi(false);

exports.validateReviewWindow = (req, res, next) => {
  const { start, end } = req.body;
  const errors = [];

  const parsed = {};
  for (const [key, value] of Object.entries({ start, end })) {
    if (value === undefined || value === null || value === '') continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) errors.push(`${key} must be a valid date`);
    else parsed[key] = date;
  }
  if (parsed.start && parsed.end && parsed.start > parsed.end)
    errors.push('start must be before end');

  if (errors.length) return next(new ErrorResponse(errors.join('; '), 400));
  next();
};
