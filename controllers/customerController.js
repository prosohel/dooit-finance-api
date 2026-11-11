const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const asyncHandler = require("../middleware/async");
// Whitelisted filter/sort/pagination builder shared by the company and trust
// list endpoints (docs/65 Step 68).
const { build: buildKybListQuery } = require("../middleware/kybListQuery");
const ErrorResponse = require("../utils/errorResponse");

const { hashToken, initialPassword } = require("../utils");
const sendEmail = require("../utils/sendEmail");
const sendSMS = require("../utils/sendSms");
const InvitationEmailTemplate = require("../utils/email-template/invitation");
const CompanyKyc = require("../models/CompanyKyc");
const NonIndividualKyc = require("../models/NonIndividualKyc");
const TrustKyc = require("../models/TrustKyc");

const Customer = require("../models/Customer");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
const User = require("../models/User");
const UserType = require("../models/UserType");
const { generateQR } = require("../utils/qrService");
const { hashForSearch } = require("../utils/encryption");
const { ensureSumsubApplicant, requestPendingReview, triggerAmlCheck } = require("../services/sumsubService");
const { runInBackground } = require("../utils/backgroundJob");
const {
  findOrCreateJourney,
  syncJourneyStatus,
  writeJourneyStep,
  sanitizeDocuments,
} = require("../services/journeyService");
const OnboardingJourney = require("../models/OnboardingJourney");
const { buildSeedJourney } = require("../utils/journeyUtils");
const EcddReport = require("../models/EcddReport");
const SMR = require("../models/SmrReport");
const TTR = require("../models/TtrReport");
const IFTI = require("../models/IftiReport");
const GFS = require("../models/gfsReport");
const RFI = require("../models/Rfi");
const { canReadDecrypted } = require("../utils/roleEncryptionPlugin");
const { findIdsByDecryptedKyc } = require("../utils/customerSearch");
const { buildRiskAssessmentFromCustomer } = require("../utils/riskAssessment");
const { getCentroid } = require("../utils/countryCentroids");
const { customerRelatedToTenant } = require("../utils/customerTenantGuard");
const { logKybEvent } = require("../utils/kybAudit");
const { logEvent } = require("../utils/audit");
const { recordDevice } = require("../utils/deviceContext");
const AuditLog = require("../models/AuditLog");
const { launchPdfBrowser } = require("../utils/puppeteerLaunch");
const ocrService = require("../utils/ocrService");
const {
  buildCustomerWorkbook,
  pickPrimaryRelation,
  isEmpty: isEmptyExport,
} = require("../utils/customerExcelExport");
const { buildKycReportHtml } = require("../utils/customerKycReport");
const { resolveSelfieUrl } = require("../utils/customerSelfie");
const {
  findOrCreateCustomerUser,
  ensureCustomerMembership,
  isSelfieDoc,
  runFaceVerification,
  runSumsubChain,
} = require("../services/customerImportService");

exports.filterCustomerSection = (c, requestBody) => {
  if (!requestBody || !requestBody.name) return true;
  return c.name
    .toLowerCase()
    .trim()
    .includes(requestBody.name.toLowerCase().trim());
};

// @desc   Get all Customers
// @route  /api/v1/customer
// @access Public (or restrict as needed)
exports.getCustomers = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Customer']
  #swagger.summary = 'Get All Customers '
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  // expects advancedResults middleware to populate res.advancedResults
  await attachSelfieUrls(req, res.advancedResults?.data);
  res.status(200).json(res.advancedResults);
});

// Attach `selfieUrl` to each queue row — the list avatar prefers the live
// onboarding selfie (journey selfie step, else a selfie-typed customer
// document) over user.photoUrl. Journeys live in their own collection, so one
// batched, tenant-scoped query covers the page. Rows are serialized via
// toJSON first (same output res.json would produce) so the ad-hoc field
// survives on mongoose documents.
const attachSelfieUrls = async (req, rows) => {
  if (!rows?.length) return;

  const filter = {
    customer: { $in: rows.map((r) => r._id) },
    "steps.type": "selfie",
  };
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  if (client) filter.client = client;
  if (branch) filter.branch = branch;

  const journeys = await OnboardingJourney.find(filter)
    .select("customer steps.type steps.documents")
    .sort({ createdAt: -1 })
    .lean();

  const byCustomer = new Map();
  for (const j of journeys) {
    const key = String(j.customer);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(j);
  }

  rows.forEach((row, i) => {
    const doc = typeof row.toJSON === "function" ? row.toJSON() : row;
    doc.selfieUrl = resolveSelfieUrl(doc, byCustomer.get(String(doc._id)) || []);
    rows[i] = doc;
  });
};

// @desc   Customer queue analytics / dashboard stats
// @route  /api/v1/customer/stats
// @access Private (admin, client, branch, manager, officer)
exports.getCustomerStats = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Customer']
  #swagger.summary = 'Customer queue analytics (risk, KYC, screening, country distribution)'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/

  // Tenant isolation — mirror the queue list scoping (advancedCustomerResultsQueryOnly)
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  // "New customers" window (default 30 days, clamp 1..365)
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Base match — keep consistent with the queue (isActive=true onboarded customers)
  const match = { isActive: true };
  if (client) match["relations.client"] = client;
  if (branch) match["relations.branch"] = branch;

  // riskLabel is a computed virtual (not stored) so we cannot aggregate it in the DB.
  // Pull the lean docs with only the fields the risk engine + buckets need, then
  // compute everything in a single pass.
  const customers = await Customer.find(match)
    .select(
      "kycStatus country isPep sanction amlStatus authorized createdAt personalKyc relations metadata onboardingChannel",
    )
    .lean();

  const total = customers.length;

  // Risk buckets — score bands: Low / Medium / High / Unacceptable
  const riskCounts = { Unacceptable: 0, High: 0, Medium: 0, Low: 0 };
  // KYC buckets — stored enum
  const kycCounts = { pending: 0, in_review: 0, verified: 0, rejected: 0 };
  const countryCounts = {};

  let pep = 0;
  let sanction = 0;
  let authorized = 0;
  let newInWindow = 0;

  for (const c of customers) {
    // risk label (computed)
    let label = "Low";
    try {
      label = buildRiskAssessmentFromCustomer(c).riskLabel || "Low";
    } catch (err) {
      label = "Low";
    }
    riskCounts[label] = (riskCounts[label] || 0) + 1;

    // kyc status
    const k = c.kycStatus || "pending";
    kycCounts[k] = (kycCounts[k] || 0) + 1;

    // country distribution
    const country = c.country || "Unknown";
    countryCounts[country] = (countryCounts[country] || 0) + 1;

    if (c.isPep) pep += 1;
    if (c.sanction) sanction += 1;
    if (c.authorized && c.authorized.documents_attested) authorized += 1;
    if (c.createdAt && new Date(c.createdAt) >= since) newInWindow += 1;
  }

  const riskDistribution = ["Unacceptable", "High", "Medium", "Low"].map(
    (lbl) => ({ label: lbl, value: riskCounts[lbl] || 0 }),
  );

  const kycDistribution = ["pending", "in_review", "verified", "rejected"].map(
    (status) => ({ status, value: kycCounts[status] || 0 }),
  );

  const countries = Object.entries(countryCounts)
    .map(([name, value]) => {
      const centroid = getCentroid(name);
      return {
        name,
        value,
        lat: centroid ? centroid.lat : null,
        lng: centroid ? centroid.lng : null,
      };
    })
    .sort((a, b) => b.value - a.value);

  res.status(200).json({
    success: true,
    data: {
      total,
      newInWindow,
      windowDays: days,
      risk: {
        distribution: riskDistribution,
        unacceptable: riskCounts.Unacceptable || 0,
        high: riskCounts.High || 0,
      },
      kyc: {
        distribution: kycDistribution,
        pending: kycCounts.pending || 0,
      },
      screening: {
        pep,
        sanction,
        authorized,
        notAuthorized: total - authorized,
      },
      countries,
    },
  });
});

// @desc   Fetch single client by id
// @route  /api/v1/customer/:id
// @access Public
exports.getCustomer = asyncHandler(async (req, res, next) => {

  const client =
    req?.user?.client?._id || null;

  const branch =
    req?.user?.branch?._id || null;

  const customer = await Customer.findById(req.params.id).populate("user");
  if (!customer) {
    return next(
      new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404),
    );
  }

  const userRole = req.user?.role;
  const data = customer.decryptForRole(userRole);

  // also decrypt the populated user document if it carries encrypted fields
  if (customer.user && typeof customer.user.decryptForRole === "function") {
    data.user = customer.user.decryptForRole(userRole);
  }

  const filter = { customer: req.params.id };
  if (client) filter.client = client;
  if (branch) filter.branch = branch;

  const journeys = await OnboardingJourney.find(filter)
    .populate({ path: "client", select: "name" })
    .populate({ path: "branch", select: "name" })
    .sort({ createdAt: -1 })
    .lean({ virtuals: true });

  const journeyData = journeys.length > 0 ? journeys : [buildSeedJourney(customer)];

  res.status(200).json({
    success: true,
    data,
    journeys: journeyData,
  });
});

// @desc   All compliance reports + RFI filed against a customer (360° view)
// @route  GET /api/v1/customers/:id/reports
// @access Private (admin | client | branch)
exports.getCustomerReports = asyncHandler(async (req, res, next) => {
  const customer = await Customer.findById(req.params.id).select("_id").lean();
  if (!customer) {
    return next(
      new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404),
    );
  }

  // Tenant scope: a client/branch user only sees reports in their own tenant
  // (a customer may be shared across clients via relations[]).
  const scope = { customer: customer._id };
  const clientId = req?.user?.client?._id || req?.user?.clientBelongs || null;
  const branchId = req?.user?.branch?._id || req?.user?.branchBelongs || null;
  if (clientId) scope.client = clientId;
  if (branchId) scope.branch = branchId;

  const [ecdd, smr, ttr, ifti, gfs, rfi] = await Promise.all([
    EcddReport.find(scope)
      .select("uid status createdAt caseId alert caseNumber")
      .sort({ createdAt: -1 }).lean(),
    SMR.find(scope)
      .select("uid status createdAt caseId alert caseNumber")
      .sort({ createdAt: -1 }).lean(),
    TTR.find(scope)
      .select("uid status createdAt case alert referenceNumber")
      .sort({ createdAt: -1 }).lean(),
    IFTI.find(scope)
      .select("uid status createdAt case alert")
      .sort({ createdAt: -1 }).lean(),
    GFS.find(scope)
      .select("uid status createdAt case alert customerUID")
      .sort({ createdAt: -1 }).lean(),
    RFI.find(scope)
      .select("uid status createdAt case alert")
      .sort({ createdAt: -1 }).lean(),
  ]);

  const counts = {
    ecdd: ecdd.length, smr: smr.length, ttr: ttr.length,
    ifti: ifti.length, gfs: gfs.length, rfi: rfi.length,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  res.status(200).json({
    success: true,
    data: { ecdd, smr, ttr, ifti, gfs, rfi },
    summary: { counts, total },
  });
});

// @desc   Fetch single client by id
// @route  /api/v1/customer/onboarding/:id
// @access Public
exports.getCustomerOnBoardData = asyncHandler(async (req, res, next) => {
  const { type } = req.query;

  const customer = await Customer.findById(req.params.id)
    .select("_id relations")
    .populate("relations.client", "name")
    .populate("relations.branch", "name")
    .populate("relations.relationId");

  if (!customer) {
    return next(
      new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404)
    );
  }

  // const models = {
  //   individual: Customer,
  //   company: CompanyKyc,
  //   partnership: NonIndividualKyc,
  //   government_body: NonIndividualKyc,
  //   association: NonIndividualKyc,
  //   cooperative: NonIndividualKyc,
  //   trust: TrustKyc,
  // };

  // const Model = models[type];

  // if (!Model) {
  //   return next(new ErrorResponse("Invalid onboarding type.", 400));
  // }



  const relations = customer?.relations ?? []

  const data = relations.filter(relation => relation.type === type)


  res.status(200).json({
    success: true,
    data,
  });
});
// @desc   PUT BY ID
// @route  /api/v1/customer/onboarding/:id/request
// @access Public
exports.submitCustomerOnboardRequest = asyncHandler(async (req, res, next) => {

  const { token } = req.query;

  const {
    relationType,
    client = null,
    branch = null,
    onboardingChannel = 'web',
    source = 'in-branch',
    notes = "",
    entityId = null,
  } = req.body;

  if (!token)
    return next(new ErrorResponse("token required", 400));

  const hashed = hashToken(token);

  console.log(hashed)

  let customer = await Customer.findById(req.params.id).populate("user _id relations");

  if (!customer)
    return next(new ErrorResponse("Invite/customer not found", 404));

  const relMatch = customer.findRelationByHashedToken(hashed);


  if (!relMatch)
    return next(new ErrorResponse("Invalid invite token for this customer", 400));

  const { relation, index } = relMatch; // index used to update the matched relation in place

  if (!relation.inviteToken || !relation.inviteTokenExpire)
    return next(new ErrorResponse("This invite is not valid", 400));

  if (Date.now() > new Date(relation.inviteTokenExpire).getTime())
    return next(new ErrorResponse("Invite expired", 410));

  const models = {
    individual: 'Customer',
    company: 'CompanyKyc',
    partnership: 'NonIndividualKyc',
    government_body: 'NonIndividualKyc',
    association: 'NonIndividualKyc',
    cooperative: 'NonIndividualKyc',
    trust: 'TrustKyc',
  };

  const resolvedRelationModel = models[relationType];

  if (!resolvedRelationModel)
    return next(new ErrorResponse(`Unknown relationType: ${relationType}`, 400));

  // ✅ Update the invited relation in place (matched by hashed token) — do NOT push a duplicate
  const rel = customer.relations[index];
  rel.type = relationType;
  rel.relationModel = resolvedRelationModel;
  if (entityId) rel.relationId = entityId;
  if (onboardingChannel) rel.onboardingChannel = onboardingChannel;
  if (source) rel.source = source;
  if (notes) rel.notes = notes;
  rel.active = true;
  // Only override client/branch when explicitly provided (the invite already set them)
  if (client) rel.client = client;
  if (branch) rel.branch = branch;

  // Clear the relation-level invite token (and any legacy top-level token) before saving
  customer.clearRelationInvite(index);
  customer.clearInviteToken();

  await customer.save();

  res.status(200).json({
    success: true,
    message: `You are Verified as ${relationType}`,
    relMatch,
    relations: customer.relations,
  });
});

// POST /api/v1/invites
// body: { contact: { email?, phone? }, client, branch, expiresInMinutes, source, notes }

exports.createInviteOld = asyncHandler(async (req, res, next) => {
  const loggedInUser = req.user ?? null;
  let client;
  let branch;
  if (loggedInUser?.userType == "branch") {
    const loggedInBranch = await Branch.findOne({ user: loggedInUser?.id });
    branch = loggedInBranch?.id ?? null;
    client = loggedInBranch?.client ?? null;
  } else {
    const loggedInClient = await Client.findOne({ user: loggedInUser?.id });
    client = loggedInClient?.id ?? null;
    branch = null;
  }

  const {
    contact,
    //  client,
    //branch,
    relationType, // new: relation-level type (e.g. "individual"|"company")
    onboardingChannel, // new: relation-level channel
    source = "in-branch",
    notes = "",
  } = req.body;

  if (!contact || (!contact.email && !contact.phone)) {
    return next(new ErrorResponse("Provide email or phone to invite", 400));
  }
  if (!client) return next(new ErrorResponse("client is required", 400));

  // 1) validate client + branch
  const clientExists = await Client.findById(client);
  if (!clientExists) return next(new ErrorResponse("Client not found", 404));

  if (branch) {
    const br = await Branch.findById(branch);
    if (!br) return next(new ErrorResponse("Branch not found", 404));
    if (br.client && br.client.toString() !== client.toString()) {
      return next(
        new ErrorResponse("Branch does not belong to the client", 400),
      );
    }
  }

  // normalize contact
  const email = contact.email ? contact.email.toLowerCase() : null;
  const phone = contact.phone || null;

  // 2) try to find an existing user by email/phone
  let user = null;
  if (email) user = await User.findOne({ emailHash: hashForSearch(email) });
  if (!user && phone) user = await User.findOne({ phone });

  // helper: idempotently add relation to a customer doc (uses relationType & onboardingChannel)
  const addRelationToCustomer = async (customerDoc) => {
    const clientIdStr = client.toString();
    const branchIdStr = branch ? branch.toString() : null;

    const exists = customerDoc.relations.find((r) => {
      const rClient = r.client ? r.client.toString() : null;
      const rBranch = r.branch ? r.branch.toString() : null;
      // match when branch is null/undefined as well
      const branchMatches =
        branchIdStr === null ? !rBranch : rBranch === branchIdStr;
      return rClient === clientIdStr && branchMatches;
    });

    if (exists) {
      customerDoc.metadata = {
        ...customerDoc.metadata,
        email,
        phone,
      };
      await customerDoc.save();
      // update metadata if needed (including relation-level type/onboardingChannel)
      let changed = false;
      if (source && exists.source !== source) {
        exists.source = source;
        changed = true;
      }
      if (notes && exists.notes !== notes) {
        exists.notes = notes;
        changed = true;
      }
      if (relationType && exists.type !== relationType) {
        exists.type = relationType;
        changed = true;
      }
      if (onboardingChannel && exists.onboardingChannel !== onboardingChannel) {
        exists.onboardingChannel = onboardingChannel;
        changed = true;
      }
      if (!exists.active) {
        exists.active = true;
        changed = true;
      }
      if (changed) await customerDoc.save();
      return { customer: customerDoc, added: false };
    }

    // push new relation row with the type & onboardingChannel inside it
    customerDoc.relations.push({
      client,
      branch: branch || undefined,
      type: relationType || "individual",
      onboardingChannel: onboardingChannel || "",
      registeredAt: Date.now(),
      source,
      notes,
      active: true,
    });

    // optional: set primary pointers if you use them
    if (!customerDoc.primaryClient) customerDoc.primaryClient = client;
    if (!customerDoc.primaryBranch && branch)
      customerDoc.primaryBranch = branch;
    const metadata = {
      invitedBy: req.user ? req.user._id : null,
      client: client,
      branch: branch || null,
      ...contact,
    };
    customerDoc.metadata = metadata;
    await customerDoc.save();
    return { customer: customerDoc, added: true };
  };

  // 3) find or create the customer record
  let customer = null;
  if (user) {
    customer = await Customer.findOne({ user: user._id });
    if (!customer && email) {
      customer = await Customer.findOne({
        "personalKyc.personal_form.contact_details.email": email,
      });
    }
  }

  if (customer) {
    await addRelationToCustomer(customer);
  } else {
    // try to find any customer by email (maybe invited earlier)
    if (email) {
      customer = await Customer.findOne({
        "personalKyc.personal_form.contact_details.email": email,
      });
      if (customer) {
        await addRelationToCustomer(customer);
      }
    }
  }

  // if still no customer, create new pending customer with relation
  if (!customer) {
    customer = new Customer({
      // type: relationType || "individual", // top-level fallback (optional)
      relations: [
        {
          client,
          branch: branch || undefined,
          type: relationType || "individual",
          onboardingChannel: onboardingChannel || "",
          registeredAt: Date.now(),
          source,
          notes,
          active: true,
        },
      ],
      invitedBy: req.user ? req.user._id : null,
      metadata: {
        invitedBy: req.user ? req.user._id : null,
        client: client,
        branch: branch || null,
        ...contact,
      },
    });
    await customer.save();
  }

  // 4) ALWAYS generate a fresh invite token, save & send
  const plain = customer.generateInviteToken();
  await customer.save();

  const INVITE_BASE =
    process.env.CLIENT_INVITE_URL || "https://app.example.com/accept-invite";
  const url = `${INVITE_BASE}?token=${plain}&cid=${customer._id}`;

  // 5) send invite (prefer provided contact; fallback to user's contact)
  const targetEmail = email || (user && user.email) || null;
  const targetPhone = phone || (user && user.phone) || null;

  if (targetEmail) {
    try {
      const subject = `${clientExists.name} invited you to register`;
      const html = InvitationEmailTemplate(clientExists.name, url);
      await sendEmail({ email: targetEmail, subject, message: html });
    } catch (err) {
      console.error("sendEmail error", err);
    }
  }
  if (targetPhone) {
    try {
      const message = `You are invited to register: ${url}`;
      await sendSMS(targetPhone, message);
    } catch (err) {
      console.error("sendSMS error", err);
    }
  }

  // 6) Final response
  return res.status(201).json({
    success: true,
    message: "Invite created and sent",
    data: { customerId: customer._id },
    invite:
      process.env.NODE_ENV === "development"
        ? { url, token: plain }
        : undefined,
  });
});

// exports.createInvite = asyncHandler(async (req, res, next) => {
//   const loggedInUser = req.user ?? null;
//   let client;
//   let branch;

//   if (loggedInUser?.userType == "branch") {
//     const loggedInBranch = await Branch.findOne({ user: loggedInUser?.id });
//     branch = loggedInBranch?.id ?? null;
//     client = loggedInBranch?.client ?? null;
//   } else {
//     const loggedInClient = await Client.findOne({ user: loggedInUser?.id });
//     client = loggedInClient?.id ?? null;
//     branch = null;
//   }
//   // ... same client/branch resolution as before ...

//   const {
//     contact,
//     relationType = null,
//     onboardingChannel,
//     source = "in-branch",
//     notes = "",
//   } = req.body;
//   if (!contact || (!contact.email && !contact.phone))
//     return next(new ErrorResponse("Provide email or phone to invite", 400));
//   if (!client) return next(new ErrorResponse("client is required", 400));

//   // validate client + branch
//   const clientExists = await Client.findById(client);
//   if (!clientExists) return next(new ErrorResponse("Client not found", 404));

//   if (branch) {
//     const br = await Branch.findById(branch);
//     if (!br) return next(new ErrorResponse("Branch not found", 404));
//     if (br.client && br.client.toString() !== client.toString()) {
//       return next(
//         new ErrorResponse("Branch does not belong to the client", 400)
//       );
//     }
//   }

//   // find user by email/phone if exists
//   let user = null;
//   const email = contact.email ? contact.email.toLowerCase() : null;
//   const phone = contact.phone || null;
//   if (email) user = await User.findOne({ email });
//   if (!user && phone) user = await User.findOne({ phone });

//   // helper: find existing customer linked to that client/branch or create new
//   let customer = null;
//   if (user) {
//     customer = await Customer.findOne({ user: user._id });
//   }
//   // if (!customer && email) {
//   //   customer = await Customer.findOne({
//   //     "personalKyc.personal_form.contact_details.email": email,
//   //   });
//   // }

//   // Add relation if needed (reuse your addRelationToCustomer logic)...
//   // After ensuring the relation exists, find its index:
//   // find relation index that matches client+branch
//   const ensureRelation = async (customerDoc) => {
//     const clientIdStr = client.toString();
//     const branchIdStr = branch ? branch.toString() : null;
//     let idx = customerDoc.relations.findIndex((r) => {
//       const rClient = r.client ? r.client.toString() : null;
//       const rBranch = r.branch ? r.branch.toString() : null;
//       const branchMatches =
//         branchIdStr === null ? !rBranch : rBranch === branchIdStr;
//       return rClient === clientIdStr && branchMatches;
//     });
//     if (idx === -1) {
//       // create relation row
//       customerDoc.relations.push({
//         client,
//         branch: branch || undefined,
//         type: relationType || "individual",
//         onboardingChannel: onboardingChannel || "",
//         registeredAt: Date.now(),
//         source,
//         notes,
//         active: true,
//         invitedBy: req.user ? req.user._id : null,
//       });
//       await customerDoc.save();
//       idx = customerDoc.relations.length - 1;
//     } else {
//       // update relation fields if needed (same logic you had for update)
//       const r = customerDoc.relations[idx];
//       r.source = source || r.source;
//       r.notes = notes || r.notes;
//       r.type = relationType || r.type || "individual";
//       if (onboardingChannel) r.onboardingChannel = onboardingChannel;
//       r.active = true;
//       if (!r.invitedBy) r.invitedBy = req.user ? req.user._id : null;
//       await customerDoc.save();
//     }
//     return idx;
//   };

//   if (!customer) {
//     // create new customer with relation
//     customer = new Customer({
//       relations: [
//         {
//           client,
//           branch: branch || undefined,
//           type: relationType || "individual",
//           onboardingChannel: onboardingChannel || "",
//           registeredAt: Date.now(),
//           source,
//           notes,
//           active: true,
//           invitedBy: req.user ? req.user._id : null,
//         },
//       ],
//       metadata: {
//         invitedBy: req.user ? req.user._id : null,
//         client: client,
//         branch: branch || null,
//         ...contact,
//       },
//     });
//     await customer.save();
//   }

//   // ensure relation index
//   const relIndex = await ensureRelation(customer); // returns relation index

//   // generate invite token *for the relation*
//   const plain = customer.setRelationInvite(relIndex);
//   // set invitedBy explicitly on relation (if not already)
//   customer.relations[relIndex].invitedBy = req.user
//     ? req.user._id
//     : customer.relations[relIndex].invitedBy;
//   await customer.save();

//   const INVITE_BASE =
//     process.env.CLIENT_INVITE_URL || "http://localhost:3000/accept-invite";
//   const url = `${INVITE_BASE}?token=${plain}&cid=${customer._id}`;

//   // send invite (prefer provided contact; fallback to user's contact)

//   const targetEmail = email || (user && user.email) || null;
//   const targetPhone = phone || (user && user.phone) || null;
//   if (targetEmail) {
//     try {
//       const subject = `${clientExists.name} invited you to register`;
//       const html = InvitationEmailTemplate(clientExists.name, url);
//       await sendEmail({ email: targetEmail, subject, message: html });
//     } catch (err) {
//       console.error("sendEmail error", err);
//     }
//   }
//   if (targetPhone) {
//     try {
//       const message = `You are invited to register: ${url}`;
//       await sendSMS(targetPhone, message);
//     } catch (err) {
//       console.error("sendSMS error", err);
//     }
//   }

//   return res.status(201).json({
//     success: true,
//     message: "Invite created and sent",
//     data: { customerId: customer._id, relationIndex: relIndex },
//     invite:
//       process.env.NODE_ENV === "development"
//         ? { url, token: plain }
//         : undefined,
//   });
// });

exports.createInvite = asyncHandler(async (req, res, next) => {
  const loggedInUser = req.user ?? null;

  let client = null;
  let branch = null;

  // ---------------------------
  // Resolve client + branch
  // ---------------------------
  if (loggedInUser?.userType === "branch") {
    const b = await Branch.findOne({ user: loggedInUser.id });
    if (!b) return next(new ErrorResponse("Branch not found", 404));
    branch = b._id;
    client = b.client;
  } else {
    const c = await Client.findOne({ user: loggedInUser?.id });
    if (!c) return next(new ErrorResponse("Client not found", 404));
    client = c._id;
  }

  // ---------------------------
  // Input
  // ---------------------------
  const {
    contact,
    relationType,
    onboardingChannel,
    source = "in-branch",
    notes = "",
  } = req.body;

  if (!contact || (!contact.email && !contact.phone)) {
    return next(new ErrorResponse("Provide email or phone", 400));
  }

  // ---------------------------
  // Validate relationType
  // ---------------------------
  const allowedTypes = [
    "individual",
    "company",
    "partnership",
    "government_body",
    "association",
    "cooperative",
    "trust",
  ];

  const safeType = allowedTypes.includes(relationType)
    ? relationType
    : "individual";

  // ---------------------------
  // Find user
  // ---------------------------
  const email = contact.email?.toLowerCase() || null;
  const phone = contact.phone || null;

  let user = null;
  if (email) user = await User.findOne({ emailHash: hashForSearch(email) });
  if (!user && phone) user = await User.findOne({ phone });

  // If an account already exists for this contact, ensure they hold an active
  // "customer" UserType membership scoped to this invite's client/branch
  // (update-or-create). Anonymous invitees with no account yet get their
  // membership at accept-time instead (acceptInvitePersonal/acceptInviteEntity).
  if (user) {
    await UserType.findOneAndUpdate(
      {
        user: user._id,
        userType: "customer",
        role: "customer",
        clientBelongs: client ?? null,
        branchBelongs: branch ?? null,
      },
      { $set: { isActive: true }, $setOnInsert: { assignedBy: req.user?._id ?? null } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  // ---------------------------
  // Find customer
  // Pass 1: by linked User account
  // Pass 2: by metadata (email / phone / client / branch) — catches customers
  //         created from a previous anonymous invite with no User yet
  // ---------------------------
  let customer = user ? await Customer.findOne({ user: user._id }) : null;

  if (!customer) {
    const metaOr = [];
    if (email) metaOr.push({ "metadata.email": email });
    if (phone) metaOr.push({ "metadata.phone": phone });

    if (metaOr.length > 0) {
      const metaFilter = { $or: metaOr };
      if (client) metaFilter["metadata.client"] = client;
      if (branch) metaFilter["metadata.branch"] = branch;
      customer = await Customer.findOne(metaFilter);
    }
  }

  // ---------------------------
  // Create customer if needed
  // ---------------------------
  if (!customer) {
    customer = new Customer({
      relations: [
        {
          client,
          branch,
          type: safeType,
          onboardingChannel: onboardingChannel || "",
          source,
          notes,
          active: true,
          relationModel: "Customer",
          relationId: null,
          invitedBy: req.user?._id,
        },
      ],
      metadata: {
        invitedBy: req.user?._id,
        client,
        branch,
        ...contact,
      },
    });
  }

  // ---------------------------
  // 🔧 Repair old broken relations
  // ---------------------------
  customer.relations.forEach((r) => {
    if (!r.type) r.type = "individual";
  });

  // ---------------------------
  // Ensure relation exists
  // ---------------------------
  let relIndex = customer.relations.findIndex(
    (r) =>
      r.client?.toString() === client.toString() &&
      (branch ? r.branch?.toString() === branch.toString() : !r.branch),
  );

  if (relIndex === -1) {
    customer.relations.push({
      client,
      branch,
      type: safeType,
      onboardingChannel: onboardingChannel || "",
      source,
      notes,
      relationModel: "Customer",
      relationId: customer?._id,
      active: false,
      invitedBy: req.user?._id,
    });
    relIndex = customer.relations.length - 1;
  } else {
    const r = customer.relations[relIndex];
    r.type = safeType;
    r.source = source || r.source;
    r.notes = notes || r.notes;
    if (onboardingChannel) r.onboardingChannel = onboardingChannel;
    r.active = false;

    if (!r.relationModel) r.relationModel = "Customer";
    if (!r.relationId) r.relationId = r._id;
    if (!r.invitedBy) r.invitedBy = req.user?._id;
  }

  // ---------------------------
  // Set relation invite token
  // ---------------------------
  const plain = customer.setRelationInvite(relIndex);

  await customer.save();

  // ─────────────────────────────────────────────────────────────────────────
  // Sumsub applicant — idempotent creation
  // Runs after invite is persisted so invite creation never fails due to
  // a Sumsub API error. Result is included in the response for the caller.
  //
  // Decision tree (handled inside ensureSumsubApplicant):
  //   1. sumsubApplicantId exists locally  → verify it's still alive in Sumsub
  //   2. Not found locally                 → look up in Sumsub by externalUserId
  //   3. Not found in Sumsub               → create new applicant
  // ─────────────────────────────────────────────────────────────────────────
  let sumsubResult = null;
  let sumsubError = null;

  try {
    sumsubResult = await ensureSumsubApplicant(customer);
  } catch (err) {
    // Non-fatal — log and surface in response; invite is already saved
    sumsubError = err.message;
    console.error(
      "[createInvite] Sumsub applicant creation failed:",
      err.message,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Record journey_start step — creates/updates the OnboardingJourney so
  // the invite + Sumsub applicant creation is tracked in the local DB.
  // Non-fatal: a journey error must never fail the invite response.
  // ─────────────────────────────────────────────────────────────────────────
  let journeyId = null;
  try {
    const journey = await findOrCreateJourney({
      customerId: customer._id,
      clientId: client,
      branchId: branch || null,
      relationIndex: relIndex,
      channel: onboardingChannel || "Mobile App",
      provider: "dooit",
    });

    const stepStatus = sumsubResult ? "approved" : "submitted";

    journey.setStepStatus("journey_start", stepStatus, {
      required: false, // tracking step — never blocks journey completion
      bumpAttempt: false,
      data: {
        inviteMethod: "direct",
        invitedBy: req.user?._id || null,
        applicantId: sumsubResult?.applicantId || null,
        inspectionId: sumsubResult?.inspectionId || null,
        applicantCreated: sumsubResult?.created ?? null,
        sumsubError: sumsubError || null,
        at: new Date(),
      },
    });

    journey.recordEvent({
      step: "journey_start",
      action: "invite_created",
      status: stepStatus,
      note: sumsubResult
        ? `Applicant ${sumsubResult.created ? "created" : "found"} in Sumsub (${sumsubResult.applicantId})`
        : `Invite created — Sumsub pending${sumsubError ? `: ${sumsubError}` : ""}`,
      actor: req.user?._id || null,
      actorRole: "staff",
      payload: {
        customerId: customer._id,
        inviteMethod: "direct",
        applicantId: sumsubResult?.applicantId || null,
        applicantCreated: sumsubResult?.created ?? null,
        sumsubError: sumsubError || undefined,
      },
    });

    syncJourneyStatus(journey);
    await journey.save();
    journeyId = journey._id;
  } catch (journeyErr) {
    console.error(
      "[createInvite] journey_start recording failed:",
      journeyErr.message,
    );
  }

  // ---------------------------
  // Build invite URL
  // ---------------------------
  const INVITE_BASE =
    process.env.CLIENT_INVITE_URL || "http://localhost:3000/accept-invite";

  const url = `${INVITE_BASE}?token=${plain}&cid=${customer._id}?client=${client}`;

  // ---------------------------
  // Send email / sms
  // ---------------------------
  const targetEmail = email || user?.email;
  const targetPhone = phone || user?.phone;

  if (targetEmail) {
    try {
      await sendEmail({
        email: targetEmail,
        subject: "You are invited to register",
        message: InvitationEmailTemplate("Client", url),
      });
    } catch (e) {
      console.error("email fail", e);
    }
  }

  if (targetPhone) {
    try {
      await sendSMS(targetPhone, `Register here: ${url}`);
    } catch (e) {
      console.error("sms fail", e);
    }
  }

  logEvent({
    req,
    service: "kyc",
    action: "customer_invited",
    customer: customer._id,
  });

  // ---------------------------
  // Response
  // ---------------------------
  res.status(201).json({
    success: true,
    message: "Invite created",
    data: {
      customerId: customer._id,
      relationIndex: relIndex,
      journeyId: journeyId || null,
      sumsub: sumsubResult
        ? {
          applicantId: sumsubResult.applicantId,
          inspectionId: sumsubResult.inspectionId,
          created: sumsubResult.created,
        }
        : null,
      sumsubError: sumsubError || undefined,
    },
    invite:
      process.env.NODE_ENV === "development"
        ? { url, token: plain }
        : undefined,
  });
});
exports.createInviteFromQr = asyncHandler(async (req, res, next) => {
  const {
    client,
    branch,
    contact,
    relationType = "individual",
    onboardingChannel = "app",
    source = "in-branch",
    notes = "",
  } = req.body;

  console.log(relationType)

  const verifyClient = await Client.findById(client);
  const verifyBranch = await Branch.findById(branch);

  if (client && !verifyClient) {
    return next(new ErrorResponse("Client ID not Valid", 400));
  }
  if (branch && !verifyBranch) {
    return next(new ErrorResponse("Branch ID not Valid", 400));
  }

  if (!contact || (!contact.email && !contact.phone)) {
    return next(new ErrorResponse("Provide email or phone", 400));
  }

  // ---------------------------
  // Validate relationType
  // ---------------------------
  const allowedTypes = [
    "individual",
    "company",
    "partnership",
    "government_body",
    "association",
    "cooperative",
    "trust",
  ];

  const safeType = allowedTypes.includes(relationType)
    ? relationType
    : "individual";

  // ---------------------------
  // Find user
  // ---------------------------
  const email = contact.email?.toLowerCase() || null;


  const phone = contact.phone || null;

  let user = null;
  if (email) user = await User.findOne({ emailHash: hashForSearch(email) });

  console.log(user)
  // if (!user && phone) user = await User.findOne({ phone }); // TODO

  // If an account already exists for this contact, ensure they hold an active
  // "customer" UserType membership scoped to this invite's client/branch
  // (update-or-create). Anonymous invitees with no account yet get their
  // membership at accept-time instead (acceptInvitePersonal/acceptInviteEntity).
  if (user) {
    await UserType.findOneAndUpdate(
      {
        user: user._id,
        userType: "customer",
        role: "customer",
        clientBelongs: client ?? null,
        branchBelongs: branch ?? null,
      },
      { $set: { isActive: true }, $setOnInsert: { assignedBy: req.user?._id ?? null } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  // ---------------------------
  // Find customer
  // Pass 1: by linked User account
  // Pass 2: by metadata (email / phone / client / branch) — catches customers
  //         created from a previous anonymous QR invite with no User yet
  // ---------------------------
  let customer = user ? await Customer.findOne({ user: user._id }) : null;



  if (!customer) {
    const metaOr = [];
    if (email) metaOr.push({ "metadata.email": email });
    // if (phone) metaOr.push({ "metadata.phone": phone }); //TODO

    if (metaOr.length > 0) {
      const metaFilter = { $or: metaOr };
      if (client) metaFilter["metadata.client"] = client;
      if (branch) metaFilter["metadata.branch"] = branch;
      customer = await Customer.findOne(metaFilter);
    }
  }
  // return res.status(200).json({
  //   customer,
  // });
  // ---------------------------
  // Create customer if needed
  // ---------------------------
  if (!customer) {
    customer = new Customer({
      relations: [
        {
          client,
          branch,
          type: safeType,
          onboardingChannel: onboardingChannel || "websdk",
          source,
          notes,
          active: false,

          invitedBy: req.user?._id,
        },
      ],
      metadata: {
        invitedBy: req.user?._id,
        client,
        branch,
        ...contact,
      },
    });
  }

  // ---------------------------
  // 🔧 Repair old broken relations
  // ---------------------------
  customer.relations.forEach((r) => {
    if (!r.type) r.type = "individual";
  });

  // ---------------------------
  // Ensure relation exists
  // ---------------------------
  let relIndex = customer.relations.findIndex(
    (r) =>
      r.client?.toString() === client.toString() &&
      (branch ? r.branch?.toString() === branch.toString() : !r.branch),
  );

  if (relIndex === -1) {
    customer.relations.push({
      client,
      branch,
      type: safeType,
      onboardingChannel: onboardingChannel || "",
      source,
      notes,
      active: true,
      invitedBy: req.user?._id,
    });
    relIndex = customer.relations.length - 1;
  } else {
    const r = customer.relations[relIndex];
    r.type = safeType;
    r.source = source || r.source;
    r.notes = notes || r.notes;
    if (onboardingChannel) r.onboardingChannel = onboardingChannel;
    r.active = true;
    if (!r.invitedBy) r.invitedBy = req.user?._id;
  }

  // ---------------------------
  // Set relation invite token
  // ---------------------------
  const plain = customer.setRelationInvite(relIndex);

  await customer.save();

  // ─────────────────────────────────────────────────────────────────────────
  // Sumsub applicant — idempotent creation
  // Runs after invite is persisted so invite creation never fails due to
  // a Sumsub API error. Result is included in the response for the caller.
  //
  // Decision tree (handled inside ensureSumsubApplicant):
  //   1. sumsubApplicantId exists locally  → verify it's still alive in Sumsub
  //   2. Not found locally                 → look up in Sumsub by externalUserId
  //   3. Not found in Sumsub               → create new applicant
  // ─────────────────────────────────────────────────────────────────────────
  let sumsubResult = null;
  let sumsubError = null;

  //TODO
  try {
    sumsubResult = await ensureSumsubApplicant(customer);
  } catch (err) {
    // Non-fatal — log and surface in response; invite is already saved
    sumsubError = err.message;
    console.error(
      "[createInviteFromQr] Sumsub applicant creation failed:",
      err.message,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Record journey_start step — creates/updates the OnboardingJourney so
  // the QR invite + Sumsub applicant creation is tracked in the local DB.
  // Non-fatal: a journey error must never fail the invite response.
  // ─────────────────────────────────────────────────────────────────────────
  let journeyId = null;
  try {
    const journey = await findOrCreateJourney({
      customerId: customer._id,
      clientId: client,
      branchId: branch || null,
      relationIndex: relIndex,
      channel: onboardingChannel || "app",
      provider: "dooit", //TODO Sumsub
    });

    const stepStatus = sumsubResult ? "approved" : "submitted";

    journey.setStepStatus("journey_start", stepStatus, {
      required: false, // tracking step — never blocks journey completion
      bumpAttempt: false,
      data: {
        inviteMethod: "qr",
        invitedBy: req.user?._id || null,
        applicantId: sumsubResult?.applicantId || null,
        inspectionId: sumsubResult?.inspectionId || null,
        applicantCreated: sumsubResult?.created ?? null,
        sumsubError: sumsubError || null,
        at: new Date(),
      },
    });

    journey.recordEvent({
      step: "journey_start",
      action: "invite_created",
      status: stepStatus,
      note: sumsubResult
        ? `Applicant ${sumsubResult.created ? "created" : "found"} in Sumsub (${sumsubResult.applicantId})`
        : `QR invite created — Sumsub pending${sumsubError ? `: ${sumsubError}` : ""}`,
      actor: req.user?._id || null,
      actorRole: "staff",
      payload: {
        customerId: customer._id,
        inviteMethod: "qr",
        applicantId: sumsubResult?.applicantId || null,
        applicantCreated: sumsubResult?.created ?? null,
        sumsubError: sumsubError || undefined,
      },
    });

    syncJourneyStatus(journey);
    await journey.save();
    journeyId = journey._id;
  } catch (journeyErr) {
    console.error(
      "[createInviteFromQr] journey_start recording failed:",
      journeyErr.message,
    );
  }

  // ---------------------------
  // Build invite URL
  // ---------------------------
  const INVITE_BASE =
    process.env.CLIENT_INVITE_URL || "http://localhost:3000/accept-invite";

  const url = `${INVITE_BASE}?token=${plain}&cid=${customer._id}`;

  // Public route — req.user may be undefined; logEvent leaves actor fields null
  logEvent({
    req,
    service: "kyc",
    action: "customer_invited",
    customer: customer._id,
    details: "self-service QR",
  });
  recordDevice({ req, customerId: customer._id, purpose: "registration" });

  // ---------------------------
  // Response
  // ---------------------------
  res.status(201).json({
    success: true,
    message: "Invite created",
    data: {
      url,
      customerId: customer._id,
      token: plain,
      relationIndex: relIndex,
      journeyId: journeyId || null,
      sumsub: sumsubResult
        ? {
          applicantId: sumsubResult.applicantId,
          inspectionId: sumsubResult.inspectionId,
          created: sumsubResult.created,
        }
        : null,
      sumsubError: sumsubError || undefined,
    },
    invite:
      process.env.NODE_ENV === "development"
        ? { url, token: plain, customerId: customer._id }
        : undefined,
  });
});

// GET /api/v1/invites/validate?token=...&cid=...
exports.validateInviteOld = asyncHandler(async (req, res, next) => {
  const { token, cid } = req.query;

  if (!token || !cid)
    return next(new ErrorResponse("token and cid required", 400));
  // const customer = await Customer.findById(cid).populate(
  //   "relations.client relations.branch user"
  // );
  const customer = await Customer.findById(cid).populate("user");
  if (!customer)
    return next(new ErrorResponse("Invite/customer not found", 404));

  if (!customer.inviteToken || !customer.inviteTokenExpire) {
    return next(new ErrorResponse("This invite is not valid", 400));
  }

  const hashed = hashToken(token);
  if (hashed !== customer.inviteToken)
    return next(new ErrorResponse("Invalid invite token", 400));
  if (Date.now() > new Date(customer.inviteTokenExpire).getTime())
    return next(new ErrorResponse("Invite expired", 410));

  // suggested contact info from customer's personalKyc
  const email = customer.metadata?.email ?? null;
  const phone = customer.metadata.phone ?? null;

  // Check user existence:
  // 1) If customer.user exists, prefer that (linked user)
  // 2) Otherwise check by suggestedEmail and suggestedPhone
  let user = null;
  let userExists = false;
  let linkedToCustomer = false;

  if (customer.user) {
    user = await User.findById(customer.user);
    if (user) {
      userExists = true;
      linkedToCustomer = true;
    } else {
      // customer.user reference broken; clear flag
      linkedToCustomer = false;
    }
  } else {
    if (email) {
      user = await User.findOne({ emailHash: hashForSearch(email) });
    }
    if (!user && phone) {
      user = await User.findOne({ phone });
    }
    if (user) userExists = true;
  }

  res.status(200).json({
    success: true,
    data: {
      customerId: customer._id,
      //  relations: customer.relations,
      email,
      phone,
      userExists,
      userId: user ? user._id : null,
      linkedToCustomer,
      isInviteActive: customer.isInviteActive,
      user,
    },
  });
});
exports.validateInvite = asyncHandler(async (req, res, next) => {
  const { token, cid } = req.query;
  if (!token || !cid)
    return next(new ErrorResponse("token and cid required", 400));

  const hashed = hashToken(token);

  // if cid provided, prefer that doc and find matching relation
  let customer = await Customer.findById(cid).populate("user");
  if (!customer)
    return next(new ErrorResponse("Invite/customer not found", 404));

  // find relation whose inviteToken matches
  const relMatch = customer.findRelationByHashedToken(hashed);
  if (!relMatch) {
    return next(
      new ErrorResponse("Invalid invite token for this customer", 400),
    );
  }
  const { relation, index } = relMatch;

  if (!relation.inviteToken || !relation.inviteTokenExpire) {
    return next(new ErrorResponse("This invite is not valid", 400));
  }
  if (Date.now() > new Date(relation.inviteTokenExpire).getTime()) {
    return next(new ErrorResponse("Invite expired", 410));
  }

  // suggested contact info
  const email = customer.metadata?.email ?? null;
  const phone = customer.metadata?.phone ?? null;

  // check user existence logic (unchanged)
  let user = null;
  let userExists = false;
  let linkedToCustomer = false;

  if (customer.user) {
    user = await User.findById(customer.user);
    if (user) {
      userExists = true;
      linkedToCustomer = true;
    } else linkedToCustomer = false;
  } else {
    if (email) user = await User.findOne({ emailHash: hashForSearch(email) });
    // if (!user && phone) user = await User.findOne({ phone }); //TODO
    if (user) userExists = true;
  }
  console.log(user)

  res.status(200).json({
    success: true,
    data: {
      customerId: customer._id,
      relationIndex: index,
      relation: {
        client: relation.client,
        branch: relation.branch,
        type: relation.type,
        onboardingChannel: relation.onboardingChannel,
      },
      email,
      phone,
      userExists,
      userId: user ? user._id : null,
      linkedToCustomer,
      isInviteActive: !!(
        relation.inviteToken &&
        relation.inviteTokenExpire &&
        relation.inviteTokenExpire > Date.now()
      ),
      user,
    },
  });
});

/**
 * Merge/update personalKyc into customer.personalKyc (shallow merge)
 */
async function upsertPersonalKyc(customer, incomingPersonalKyc) {
  if (!incomingPersonalKyc || Object.keys(incomingPersonalKyc).length === 0) {
    return customer.personalKyc && Object.keys(customer.personalKyc).length > 0;
  }

  customer.personalKyc = Object.assign(
    {},
    customer.personalKyc || {},
    incomingPersonalKyc,
  );
  return true;
}

/**
 * acceptInvitePersonal
 * - Upsert personal KYC for invited customer
 * - Link user -> customer
 * - Finalize: clear invite token and activate
 */
exports.acceptInvitePersonalOld = asyncHandler(async (req, res, next) => {
  const user = req.user;
  if (!user) return next(new ErrorResponse("Authentication required", 401));

  const { token, cid, personalKyc } = req.body;
  if (!token) return next(new ErrorResponse("token is required", 400));

  const hashed = hashToken(token);
  let customer;
  if (cid) {
    customer = await Customer.findById(cid);
    if (!customer) return next(new ErrorResponse("Customer not found", 404));
    if (!customer.inviteToken || customer.inviteToken !== hashed)
      return next(
        new ErrorResponse("Invalid invite token for this customer", 400),
      );
  } else {
    customer = await Customer.findOne({ inviteToken: hashed });
    if (!customer) return next(new ErrorResponse("Invite not found", 404));
  }

  // expiry
  if (
    !customer.inviteTokenExpire ||
    Date.now() > new Date(customer.inviteTokenExpire).getTime()
  ) {
    return next(new ErrorResponse("Invite expired", 410));
  }

  // ensure invite has client info
  const clientId = customer.metadata?.client || null;
  const branchId = customer.metadata?.branch || null;
  if (!clientId)
    return next(new ErrorResponse("Invite missing client info", 400));

  // link user if needed
  if (!customer.user || customer.user.toString() !== user._id.toString()) {
    customer.user = user._id;
  }

  // upsert personal KYC (merge)
  const hasPersonalNow = await upsertPersonalKyc(customer, personalKyc || {});

  // finalize and persist
  if (hasPersonalNow) {
    customer.kycStatus = "in_review";
    customer.kycHistory = customer.kycHistory || [];
    customer.kycHistory.push({
      status: "in_review",
      note: "Personal KYC provided by invited user",
      changedBy: user._id,
      changedAt: Date.now(),
    });

    // persist metadata
    customer.metadata = customer.metadata || {};
    customer.metadata.client = clientId;
    if (branchId) customer.metadata.branch = branchId;

    // finalize: clear token & activate
    customer.clearInviteToken();
    customer.isActive = true;

    await customer.save();

    return res.status(200).json({
      success: true,
      message: "Personal KYC accepted and invite finalised",
      data: {
        customerId: customer._id,
        userId: user._id,
        kycStatus: customer.kycStatus,
      },
    });
  }

  // fallback — shouldn't normally happen
  return next(new ErrorResponse("Failed to process personal KYC", 500));
});

exports.acceptInvitePersonal = asyncHandler(async (req, res, next) => {
  const user = req.user;
  if (!user) return next(new ErrorResponse("Authentication required", 401));

  const { token, cid,country='', personalKyc } = req.body;
  if (!token) return next(new ErrorResponse("token is required", 400));
  const hashed = hashToken(token);

  let customer;
  if (cid) {
    customer = await Customer.findById(cid);
    if (!customer) return next(new ErrorResponse("Customer not found", 404));
  } else {
    // find by relation token across customers
    customer = await Customer.findOne({ "relations.inviteToken": hashed });
    if (!customer) return next(new ErrorResponse("Invite not found", 404));
  }

  // find matching relation
  const relMatch = customer.findRelationByHashedToken(hashed);
  if (!relMatch) return next(new ErrorResponse("Invalid invite token", 400));
  const { relation, index: relIndex } = relMatch;

  // expiry
  if (
    !relation.inviteTokenExpire ||
    Date.now() > new Date(relation.inviteTokenExpire).getTime()
  ) {
    return next(new ErrorResponse("Invite expired", 410));
  }

  // ensure invite has client info (relation has client)
  const clientId = relation.client;
  const branchId = relation.branch || null;
  if (!clientId)
    return next(new ErrorResponse("Invite missing client info", 400));

  // link user if needed
  if (!customer.user || customer.user.toString() !== user._id.toString()) {
    customer.user = user._id;
  }

  // upsert personal KYC (same helper)
  const hasPersonalNow = await upsertPersonalKyc(customer, personalKyc || {});

  // ✅ Activate the matched relation
  customer.relations[relIndex].active = true;
  // finalize and persist
  if (hasPersonalNow) {
    customer.kycStatus = "in_review";
    customer.kycHistory = customer.kycHistory || [];
    customer.kycHistory.push({
      status: "in_review",
      note: "Personal KYC provided by invited user",
      changedBy: user._id,
      changedAt: Date.now(),
    });

    // persist relation-level metadata (if desired)
    // keep top-level metadata.client for convenience if you want:
    customer.metadata = customer.metadata || {};
    customer.metadata.client = clientId;
    if (branchId) customer.metadata.branch = branchId;

    // clear token **only for this relation**
    customer.clearRelationInvite(relIndex);

    // optionally activate customer (business rule)
    customer.isActive = true;
    customer.country = country;

    await customer.save();

    // Ensure a customer UserType membership scoped to this client/branch exists
    // for the invited user. Their baseline membership from registration is
    // unscoped (clientBelongs/branchBelongs null); accepting the invite ties
    // them to this specific tenant. Idempotent via the unique index.
    await UserType.findOneAndUpdate(
      {
        user: user._id,
        userType: "customer",
        role: "customer",
        clientBelongs: clientId,
        branchBelongs: branchId,
      },
      { $setOnInsert: { isActive: true, assignedBy: user._id } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (customer?.sumsubApplicantId) {
      console.log(`Request to review to sum sub — scheduling background job`.bgBlue);
      runInBackground(`sumsub:pendingReview+aml [${customer.sumsubApplicantId}]`, async () => {
        await requestPendingReview(customer.sumsubApplicantId);
        await triggerAmlCheck(customer);
      });
    }


    logEvent({
      req,
      service: "kyc",
      action: "customer_registered",
      customer: customer._id,
    });
    recordDevice({ req, customerId: customer._id, purpose: "registration" });

    return res.status(200).json({
      success: true,
      message: "Personal KYC accepted and invite finalised (relation-level)",
      data: {
        customerId: customer._id,
        userId: user._id,
        kycStatus: customer.kycStatus,
        relationIndex: relIndex,
      },
    });
  }

  return next(new ErrorResponse("Failed to process personal KYC", 500));
});

/**
 * Helper: upsert entity doc for Company/Trust/NonIndividual
 * returns the doc or null
 */
async function upsertEntityModel(
  Model,
  payload,
  customerId,
  clientId,
  branchId,
) {
  if (!payload || Object.keys(payload).length === 0) {
    // return existing if any
    return await Model.findOne({ customer: customerId, client: clientId });
  }

  let doc = await Model.findOne({
    customer: customerId,
    client: clientId,
    branch: branchId || undefined,
  });
  if (!doc) {
    payload.client = clientId;
    if (branchId) payload.branch = branchId;
    payload.customer = customerId;
    doc = await Model.create(payload);
  } else {
    // merge important sub docs shallowly
    const keys = Object.keys(payload);
    keys.forEach((k) => {
      if (k === "general_information" || k === "trust_details") {
        doc[k] = Object.assign({}, doc[k] || {}, payload[k] || {});
      } else {
        doc[k] = payload[k];
      }
    });
    await doc.save();
  }
  return doc;
}

/**
 * acceptInviteEntity
 * - Handles company/trust/nonIndividual types
 * - Upserts entity KYC doc
 * - DOES NOT clear invite token unless BOTH personalKyc present AND entity KYC present
 * - If missing pieces, returns a structured response listing what's still required
 */
exports.acceptInviteEntityOld = asyncHandler(async (req, res, next) => {
  const user = req.user;
  if (!user) return next(new ErrorResponse("Authentication required", 401));

  const { token, cid, requestedType, kyc } = req.body;
  if (!token) return next(new ErrorResponse("token is required", 400));
  if (!requestedType)
    return next(new ErrorResponse("requestedType is required", 400));

  const hashed = hashToken(token);
  let customer;
  if (cid) {
    customer = await Customer.findById(cid);
    if (!customer) return next(new ErrorResponse("Customer not found", 404));
    if (!customer.inviteToken || customer.inviteToken !== hashed)
      return next(
        new ErrorResponse("Invalid invite token for this customer", 400),
      );
  } else {
    customer = await Customer.findOne({ inviteToken: hashed });
    if (!customer) return next(new ErrorResponse("Invite not found", 404));
  }

  // expiry
  if (
    !customer.inviteTokenExpire ||
    Date.now() > new Date(customer.inviteTokenExpire).getTime()
  )
    return next(new ErrorResponse("Invite expired", 410));

  const clientId = customer.metadata?.client || null;
  const branchId = customer.metadata?.branch || null;
  if (!clientId)
    return next(new ErrorResponse("Invite missing client info", 400));

  // link user if needed
  if (!customer.user || customer.user.toString() !== user._id.toString()) {
    customer.user = user._id;
  }

  // ensure personalKyc presence
  const hasPersonal =
    customer.personalKyc && Object.keys(customer.personalKyc).length > 0;

  // Upsert entity doc (if payload provided) OR try find existing
  let createdKycDoc = null;
  let typeKycPresent = false;

  if (requestedType === "company") {
    createdKycDoc = await upsertEntityModel(
      CompanyKyc,
      kyc,
      customer._id,
      clientId,
      branchId,
    );
  } else if (requestedType === "trust") {
    createdKycDoc = await upsertEntityModel(
      TrustKyc,
      // The onboarding trust forms still post
      // trust_details.settlor_name, which is no longer a schema field
      // (docs/65 Step 60). Lift it onto settlor.full_name here or Mongoose
      // discards it the moment the document is constructed.
      TrustKyc.liftLegacyTrustFields(kyc),
      customer._id,
      clientId,
      branchId,
    );
  } else if (
    ["partnership", "government_body", "association", "cooperative"].includes(
      requestedType,
    )
  ) {
    createdKycDoc = await upsertEntityModel(
      NonIndividualKyc,
      kyc,
      customer._id,
      clientId,
      branchId,
    );
  } else {
    return next(new ErrorResponse("Unsupported requestedType", 400));
  }

  if (createdKycDoc) {
    typeKycPresent = true;
  }

  // persist metadata client/branch
  customer.metadata = customer.metadata || {};
  customer.metadata.client = clientId;
  if (branchId) customer.metadata.branch = branchId;

  // Determine what's missing
  const missing = [];
  if (!hasPersonal) missing.push("personalKyc"); // representative details (required)
  if (!typeKycPresent) missing.push(`${requestedType}Kyc`);

  if (missing.length > 0) {
    // Do NOT clear token. Save customer with updated metadata (and possibly linked user).
    customer.kycStatus = "pending";
    customer.kycHistory = customer.kycHistory || [];
    customer.kycHistory.push({
      status: "pending",
      note: `Processed entity KYC input for type ${requestedType}; missing: ${missing.join(
        ", ",
      )}`,
      changedBy: user._id,
      changedAt: Date.now(),
    });

    await customer.save();

    // Return structured response telling frontend what to do next
    return res.status(200).json({
      success: true,
      message: "Entity KYC processed but additional steps required",
      required: missing, // frontend can use this to route the user
      data: {
        customerId: customer._id,
        userId: user._id,
        kycStatus: customer.kycStatus,
        createdKycDocId: createdKycDoc ? createdKycDoc._id : null,
      },
    });
  }

  // If we reach here: both personal and entity KYC present -> finalise
  customer.kycStatus = "in_review";
  customer.kycHistory = customer.kycHistory || [];
  customer.kycHistory.push({
    status: "in_review",
    note: `Entity (${requestedType}) KYC provided & representative personal KYC present`,
    changedBy: user._id,
    changedAt: Date.now(),
  });

  // finalize: clear token & activate
  customer.clearInviteToken();
  customer.isActive = true;

  await customer.save();

  return res.status(200).json({
    success: true,
    message: "Entity KYC accepted and invite finalised",
    data: {
      customerId: customer._id,
      userId: user._id,
      kycStatus: customer.kycStatus,
      createdKycDocId: createdKycDoc ? createdKycDoc._id : null,
    },
  });
});
// controllers/customerController.js (replace acceptInviteEntity with this)
exports.acceptInviteEntityOld2 = asyncHandler(async (req, res, next) => {
  const user = req.user;
  if (!user) return next(new ErrorResponse("Authentication required", 401));

  const { token, cid, requestedType, kyc } = req.body;
  if (!token) return next(new ErrorResponse("token is required", 400));
  if (!requestedType)
    return next(new ErrorResponse("requestedType is required", 400));

  const hashed = hashToken(token);

  // find customer: prefer cid then fallback to any customer with relation token
  let customer;
  if (cid) {
    customer = await Customer.findById(cid);
    if (!customer) return next(new ErrorResponse("Customer not found", 404));
  } else {
    customer = await Customer.findOne({ "relations.inviteToken": hashed });
    if (!customer) return next(new ErrorResponse("Invite not found", 404));
  }

  // locate the relation that matches the hashed token
  const match = customer.findRelationByHashedToken(hashed);
  if (!match) return next(new ErrorResponse("Invalid invite token", 400));
  const { relation, index: relIndex } = match;

  // invite expiry check (relation-level)
  if (
    !relation.inviteTokenExpire ||
    Date.now() > new Date(relation.inviteTokenExpire).getTime()
  ) {
    return next(new ErrorResponse("Invite expired", 410));
  }

  // ensure relation has client info
  const clientId = relation.client;
  const branchId = relation.branch || null;
  if (!clientId)
    return next(new ErrorResponse("Invite missing client info", 400));

  // link user -> customer if needed
  if (!customer.user || customer.user.toString() !== user._id.toString()) {
    customer.user = user._id;
  }

  // Optional: update relation type/onboardingChannel if provided (keeps relation consistent)
  if (requestedType && relation.type !== requestedType) {
    relation.type = requestedType;
  }
  // persist any provided relation-level onboardingChannel
  if (req.body.onboardingChannel) {
    relation.onboardingChannel = req.body.onboardingChannel;
  }

  // upsert entity-level KYC doc (single normalized payload 'kyc')
  let createdKycDoc = null;
  let typeKycPresent = false;

  try {
    if (requestedType === "company") {
      createdKycDoc = await upsertEntityModel(
        CompanyKyc,
        kyc,
        customer._id,
        clientId,
        branchId,
      );
    } else if (requestedType === "trust") {
      createdKycDoc = await upsertEntityModel(
        TrustKyc,
        kyc,
        customer._id,
        clientId,
        branchId,
      );
    } else if (
      ["partnership", "government_body", "association", "cooperative"].includes(
        requestedType,
      )
    ) {
      createdKycDoc = await upsertEntityModel(
        NonIndividualKyc,
        kyc,
        customer._id,
        clientId,
        branchId,
      );
    } else {
      return next(new ErrorResponse("Unsupported requestedType", 400));
    }

    if (createdKycDoc) {
      typeKycPresent = true;
      // attach KYC doc id to relation for traceability (persist ref on relation)
      relation.entityKycId = createdKycDoc._id;
      // optionally store the model name so you know which collection holds the doc
      relation.entityKycModel =
        createdKycDoc.constructor && createdKycDoc.constructor.modelName
          ? createdKycDoc.constructor.modelName
          : null;
    }
  } catch (err) {
    console.error("upsertEntityModel error", err);
    return next(new ErrorResponse("Failed to store entity KYC", 500));
  }
  // ✅ Activate the matched relation
  customer.relations[relIndex].active = true;
  // persist client/branch into top-level metadata for quick access (optional)
  customer.metadata = customer.metadata || {};
  customer.metadata.client = clientId;
  if (branchId) customer.metadata.branch = branchId;

  // Ensure a customer UserType membership scoped to this client/branch exists
  // for the invited user (registration baseline is unscoped). Seeded on both the
  // "missing steps" and "finalised" paths since the user is already linked to the
  // relation here. Idempotent via the unique index.
  await UserType.findOneAndUpdate(
    {
      user: user._id,
      userType: "customer",
      role: "customer",
      clientBelongs: clientId,
      branchBelongs: branchId,
    },
    { $setOnInsert: { isActive: true, assignedBy: user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // check presence of personal KYC (representative) on the customer
  const hasPersonal =
    customer.personalKyc && Object.keys(customer.personalKyc).length > 0;

  // what remains to be completed
  const missing = [];
  if (!hasPersonal) missing.push("personalKyc");
  if (!typeKycPresent) missing.push(`${requestedType}Kyc`);

  if (missing.length > 0) {
    // do NOT clear the invite token (relation-level) — let invite stay active for completing steps
    customer.kycStatus = "pending";
    customer.kycHistory = customer.kycHistory || [];
    customer.kycHistory.push({
      status: "pending",
      note: `Entity KYC input processed for type ${requestedType}; missing: ${missing.join(
        ", ",
      )}`,
      changedBy: user._id,
      changedAt: Date.now(),
    });

    // persist relation updates and save
    customer.relations[relIndex] = relation;
    await customer.save();

    return res.status(200).json({
      success: true,
      message: "Entity KYC processed; additional steps required",
      required: missing,
      data: {
        customerId: customer._id,
        userId: user._id,
        kycStatus: customer.kycStatus,
        createdKycDocId: createdKycDoc ? createdKycDoc._id : null,
        relationIndex: relIndex,
      },
    });
  }

  // both personal KYC and entity KYC present -> finalize
  customer.kycStatus = "in_review";
  customer.kycHistory = customer.kycHistory || [];
  customer.kycHistory.push({
    status: "in_review",
    note: `Entity (${requestedType}) KYB provided & representative personal KYC present`,
    changedBy: user._id,
    changedAt: Date.now(),
  });

  // clear invite only for this relation and activate customer
  customer.clearRelationInvite(relIndex);
  customer.isActive = true;

  // persist relation (with entityKycId) + save
  customer.relations[relIndex] = relation;
  await customer.save();

  return res.status(200).json({
    success: true,
    message: "Entity KYC accepted and invite finalised for relation",
    data: {
      customerId: customer._id,
      userId: user._id,
      kycStatus: customer.kycStatus,
      createdKycDocId: createdKycDoc ? createdKycDoc._id : null,
      relationIndex: relIndex,
    },
  });
});
exports.acceptInviteEntity = asyncHandler(async (req, res, next) => {
  const user = req.user;
  if (!user) return next(new ErrorResponse("Authentication required", 401));

  const { token, cid, requestedType, kyc } = req.body;
  if (!token) return next(new ErrorResponse("token is required", 400));
  if (!requestedType)
    return next(new ErrorResponse("requestedType is required", 400));

  const hashed = hashToken(token);

  let customer;
  if (cid) {
    customer = await Customer.findById(cid);
    if (!customer) return next(new ErrorResponse("Customer not found", 404));
  } else {
    customer = await Customer.findOne({ "relations.inviteToken": hashed });
    if (!customer) return next(new ErrorResponse("Invite not found", 404));
  }

  const match = customer.findRelationByHashedToken(hashed);
  if (!match) return next(new ErrorResponse("Invalid invite token", 400));
  const { relation, index: relIndex } = match;

  if (
    !relation.inviteTokenExpire ||
    Date.now() > new Date(relation.inviteTokenExpire).getTime()
  ) {
    return next(new ErrorResponse("Invite expired", 410));
  }

  const clientId = relation.client;
  const branchId = relation.branch || null;
  if (!clientId)
    return next(new ErrorResponse("Invite missing client info", 400));

  if (!customer.user || customer.user.toString() !== user._id.toString()) {
    customer.user = user._id;
  }

  // ✅ Use index consistently — no more mutating `relation` ref directly
  if (requestedType && customer.relations[relIndex].type !== requestedType) {
    customer.relations[relIndex].type = requestedType;
  }
  if (req.body.onboardingChannel) {
    customer.relations[relIndex].onboardingChannel = req.body.onboardingChannel;
  }

  // ✅ Activate the matched relation on ALL paths
  customer.relations[relIndex].active = true;

  let createdKycDoc = null;
  let typeKycPresent = false;

  // ✅ Explicit model name map — no more constructor.modelName risk
  const kycModelNames = {
    company: 'CompanyKyc',
    trust: 'TrustKyc',
    partnership: 'NonIndividualKyc',
    government_body: 'NonIndividualKyc',
    association: 'NonIndividualKyc',
    cooperative: 'NonIndividualKyc',
  };

  try {
    if (requestedType === "company") {
      createdKycDoc = await upsertEntityModel(CompanyKyc, kyc, customer._id, clientId, branchId);
    } else if (requestedType === "trust") {
      createdKycDoc = await upsertEntityModel(TrustKyc, kyc, customer._id, clientId, branchId);
    } else if (
      ["partnership", "government_body", "association", "cooperative"].includes(requestedType)
    ) {
      createdKycDoc = await upsertEntityModel(NonIndividualKyc, kyc, customer._id, clientId, branchId);
    } else {
      return next(new ErrorResponse("Unsupported requestedType", 400));
    }

    if (createdKycDoc) {
      typeKycPresent = true;
      // ✅ Set via index, with explicit model name
      customer.relations[relIndex].entityKycId = createdKycDoc._id;
      customer.relations[relIndex].entityKycModel = kycModelNames[requestedType];
      // customer.relations[relIndex].type = requestedType;
    }
  } catch (err) {
    console.error("upsertEntityModel error", err);
    return next(new ErrorResponse("Failed to store entity KYC", 500));
  }

  customer.metadata = customer.metadata || {};
  customer.metadata.client = clientId;
  if (branchId) customer.metadata.branch = branchId;

  await UserType.findOneAndUpdate(
    {
      user: user._id,
      userType: "customer",
      role: "customer",
      clientBelongs: clientId,
      branchBelongs: branchId,
    },
    { $setOnInsert: { isActive: true, assignedBy: user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const hasPersonal =
    customer.personalKyc && Object.keys(customer.personalKyc).length > 0;

  const missing = [];
  if (!hasPersonal) missing.push("personalKyc");
  if (!typeKycPresent) missing.push(`${requestedType}Kyc`);

  if (missing.length > 0) {
    customer.kycStatus = "pending";
    customer.kycHistory = customer.kycHistory || [];
    customer.kycHistory.push({
      status: "pending",
      note: `Entity KYC input processed for type ${requestedType}; missing: ${missing.join(", ")}`,
      changedBy: user._id,
      changedAt: Date.now(),
    });

    // ✅ No more redundant `customer.relations[relIndex] = relation`
    await customer.save();

    return res.status(200).json({
      success: true,
      message: "Entity KYC processed; additional steps required",
      required: missing,
      data: {
        customerId: customer._id,
        userId: user._id,
        kycStatus: customer.kycStatus,
        createdKycDocId: createdKycDoc ? createdKycDoc._id : null,
        relationIndex: relIndex,
      },
    });
  }

  // customer.kycStatus = "in_review";
  customer.kycHistory = customer.kycHistory || [];
  customer.kycHistory.push({
    status: "in_review",
    note: `Entity (${requestedType}) KYB provided & representative personal KYC present`,
    changedBy: user._id,
    changedAt: Date.now(),
  });

  customer.clearRelationInvite(relIndex);
  customer.isActive = true;

  // ✅ No more redundant `customer.relations[relIndex] = relation`
  await customer.save();

  logEvent({
    req,
    service: "kyc",
    action: "customer_registered",
    customer: customer._id,
  });
  recordDevice({ req, customerId: customer._id, purpose: "registration" });

  return res.status(200).json({
    success: true,
    message: "Entity KYB accepted and invite finalised for relation",
    data: {
      customerId: customer._id,
      userId: user._id,
      kycStatus: customer.kycStatus,
      createdKycDocId: createdKycDoc ? createdKycDoc._id : null,
      relationIndex: relIndex,
    },
  });
});
/**
 * Dispatcher: direct to personal or entity handlers
 */
exports.acceptInvite = asyncHandler(async (req, res, next) => {
  const { requestedType } = req.body;

  if (!requestedType || requestedType === "individual") {
    return exports.acceptInvitePersonal(req, res, next);
  }
  return exports.acceptInviteEntity(req, res, next);
});

/**
 * POST /api/customers/create-with-user
 * Body: the JSON you provided
 */
exports.createCustomerDummy = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Onboarding']
  #swagger.summary = 'Dummy Customer Insert'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/DummyCustomer' } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  const body = req.body || {};
  const { kyc } = body;

  // sensible defaults
  const DEFAULT_PASSWORD = initialPassword;
  const saltRounds = 10;

  // map possible incoming requestedType values to canonical ones
  const mapRequestedType = (t) => {
    if (!t) return "individual";
    const s = String(t).toLowerCase();
    if (["individual"].includes(s)) return "individual";
    if (["company", "corporate", "corp"].includes(s)) return "company";
    if (["trust"].includes(s)) return "trust";
    if (["partnership"].includes(s)) return "partnership";
    if (["government_body", "government", "gov"].includes(s))
      return "government_body";
    if (["association", "cooperative"].includes(s)) return "association";
    return s; // fallback
  };

  const requestedType = mapRequestedType(body.requestedType);

  // start mongoose session for transaction
  const session = await mongoose.startSession();
  try {
    let createdUser = null;
    let createdCustomer = null;
    let createdKyc = [];

    await session.withTransaction(async () => {
      // 1) Find client / branch by name (if provided)
      // branchName preferred — try Branch model and also return its client
      let clientDoc = null;
      let branchDoc = null;

      if (body.branchName) {
        branchDoc = await Branch.findOne({
          name: { $regex: `^${escapeRegExp(body.branchName)}$`, $options: "i" },
        })
          .session(session)
          .populate("client");
        if (branchDoc) clientDoc = branchDoc.client || null;
      }
      if (!clientDoc && body.clientName) {
        clientDoc = await Client.findOne({
          name: { $regex: `^${escapeRegExp(body.clientName)}$`, $options: "i" },
        }).session(session);
      }

      if (!clientDoc) {
        return next(
          new ErrorResponse(`Client Not found, please check client name`, 404),
        );
      }
      if (body.branchName && !branchDoc) {
        return next(
          new ErrorResponse(`Branch Not found, please check client name`, 404),
        );
      }

      // 2) Find or create user by email or userName
      const userPayload = {
        name:
          body.name ||
          `${body.personalKyc?.personal_form?.customer_details?.given_name || ""
            } ${body.personalKyc?.personal_form?.customer_details?.surname || ""
            }`.trim() ||
          body.userName ||
          "Unnamed",
        userName: body.userName,
        email: body.email,
        userType: body.userType || "customer",
        role: body.role || "customer",
        isActive: true,
      };

      // Try find existing user by email or userName
      const existingUser = await User.findOne({
        $or: [
          { emailHash: hashForSearch(userPayload.email) },
          { userName: userPayload.userName },
        ],
      }).session(session);

      if (existingUser) {
        createdUser = existingUser;
      } else {
        const hashed = await bcrypt.hash(DEFAULT_PASSWORD, saltRounds);
        const userToCreate = new User({
          ...userPayload,
          password: hashed,
          photoUrl: User.schema.paths.photoUrl?.defaultValue || undefined,
        });
        createdUser = await userToCreate.save({ session });
      }

      // 2b) Seed this customer's UserType membership scoped to the resolved
      // client/branch. Idempotent — the unique (user, userType, role, client,
      // branch) index dedupes, so re-imports never create duplicate rows.
      await UserType.findOneAndUpdate(
        {
          user: createdUser._id,
          userType: userPayload.userType,
          role: userPayload.role,
          clientBelongs: clientDoc ? clientDoc._id : null,
          branchBelongs: branchDoc ? branchDoc._id : null,
        },
        { $setOnInsert: { isActive: true, assignedBy: req.user?._id ?? null } },
        { upsert: true, new: true, setDefaultsOnInsert: true, session },
      );

      // 3) Build relation object (if we have client or branch info)
      const relationCandidate =
        clientDoc || branchDoc
          ? {
            client: clientDoc ? clientDoc._id : undefined,
            branch: branchDoc ? branchDoc._id : undefined,
            type: requestedType,
            onboardingChannel: body.onboardingChannel || "API",
            registeredAt: body.registeredAt
              ? new Date(body.registeredAt)
              : new Date(),
            source: body.source || "api",
            notes: body.notes || "",
            active: true,
          }
          : null;

      // 4) Create or update Customer
      let customerDoc = await Customer.findOne({
        user: createdUser._id,
      }).session(session);

      if (customerDoc) {
        // ensure relations array exists
        customerDoc.relations = customerDoc.relations || [];

        // if relationCandidate exists, check if same client+branch relation already present
        if (relationCandidate) {
          const exists = customerDoc.relations.some((r) => {
            const sameClient = relationCandidate.client
              ? String(r.client) === String(relationCandidate.client)
              : true;
            const sameBranch = relationCandidate.branch
              ? String(r.branch) === String(relationCandidate.branch)
              : true;
            return sameClient && sameBranch;
          });
          if (!exists) {
            customerDoc.relations.push(relationCandidate);
          } else {
            // update existing relation fields if needed (merge)
            customerDoc.relations = customerDoc.relations.map((r) => {
              const matchClient =
                relationCandidate.client &&
                String(r.client) === String(relationCandidate.client);
              const matchBranch =
                relationCandidate.branch &&
                String(r.branch) === String(relationCandidate.branch);
              if (matchClient || matchBranch) {
                return Object.assign(r, relationCandidate);
              }
              return r;
            });
          }
        }

        // update some other fields from payload if provided
        if (body.personalKyc) customerDoc.personalKyc = body.personalKyc;
        if (body.documents) customerDoc.documents = body.documents;
        if (body.declaration) customerDoc.declaration = body.declaration;
        if (body.country) customerDoc.country = body.country;
        customerDoc.isActive = true;

        // save updated customer
        createdCustomer = await customerDoc.save({ session });
      } else {
        // create new customer
        const customerPayload = {
          user: createdUser ? createdUser._id : null,
          personalKyc: body.personalKyc || {},
          documents: body.documents || [],
          declaration: body.declaration || {},
          country: body.country || "Bangladesh",
          consentToScreen: body.consentToScreen || false,
          isActive: true,
          metadata: body.metadata || {},
          relations: relationCandidate ? [relationCandidate] : [],
        };
        const newCustomer = new Customer(customerPayload);
        createdCustomer = await newCustomer.save({ session });
      }

      // 5) If requestedType is not individual, FIND-AND-UPDATE (or create) KYC
      if (requestedType !== "individual") {
        if (!createdCustomer || !createdCustomer._id) {
          throw new ErrorResponse(
            "Customer creation failed before KYC creation",
            500,
          );
        }

        /**
         * Helper: try find existing kyc record using typical unique fields,
         * update if found, otherwise create new.
         *
         * `model` - mongoose model (CompanyKyc / TrustKyc / NonIndividualKyc)
         * `findQuery` - object to locate existing record (should include client/branch/customer if applicable)
         * `payload` - data to set/create
         * Returns { action: 'created'|'updated', doc }
         */
        async function findOrUpdateKyc(model, findQuery, payload) {
          // try find existing
          const existing = await model.findOne(findQuery).session(session);
          if (existing) {
            // merge payload into existing doc (shallow merge)
            Object.assign(existing, payload);
            await existing.save({ session });
            return { action: "updated", doc: existing };
          } else {
            const created = await model.create([payload], { session });
            return { action: "created", doc: created[0] };
          }
        }

        // Build reasonable queries for each KYC type using common unique fields
        if (requestedType === "company") {
          // Prefer registration number, then legal name / registered business name
          const possibleReg =
            (kyc &&
              (kyc.general_information?.registration_number ||
                kyc.registration_number)) ||
            (kyc && (kyc.registrationNumber || kyc.registration_number));
          const possibleName =
            (kyc && (kyc.general_information?.legal_name || kyc.legal_name)) ||
            (kyc &&
              (kyc.general_information?.registered_business_name ||
                kyc.registered_business_name));

          let findQuery = { customer: createdCustomer._id };
          if (possibleReg) {
            findQuery["general_information.registration_number"] = possibleReg;
          } else if (possibleName) {
            findQuery["general_information.legal_name"] = possibleName;
          } else {
            // fallback to searching by customer + client/branch
            findQuery = {
              customer: createdCustomer._id,
              client: clientDoc ? clientDoc._id : undefined,
              branch: branchDoc ? branchDoc._id : undefined,
            };
          }

          const compPayload = {
            client: clientDoc ? clientDoc._id : undefined,
            branch: branchDoc ? branchDoc._id : undefined,
            customer: createdCustomer._id,
            general_information: (kyc && kyc.general_information) || {},
            documents: (kyc && kyc.documents) || body.documents || [],
            ...kyc, // include other KYC fields if present (careful with collisions)
          };

          const result = await findOrUpdateKyc(
            CompanyKyc,
            findQuery,
            compPayload,
          );
          createdKyc.push({
            type: "CompanyKyc",
            action: result.action,
            id: result.doc._id,
            message:
              result.action === "updated"
                ? `CompanyKyc updated (id: ${result.doc._id})`
                : `CompanyKyc created (id: ${result.doc._id})`,
          });
        } else if (requestedType === "trust") {
          // Prefer trust name or registration numbers when available
          const possibleTrustName =
            (kyc &&
              (kyc.trust_details?.full_trust_name || kyc.full_trust_name)) ||
            (kyc && kyc.trustName);

          const possibleReg =
            (kyc &&
              (kyc.trust_details?.trust_type?.unregulated_trust
                ?.registration_number ||
                kyc.trust_details?.trust_type?.self_managed_super_fund?.abn)) ||
            (kyc && kyc.registrationNumber);

          let findQuery = { customer: createdCustomer._id };
          if (possibleTrustName) {
            findQuery["trust_details.full_trust_name"] = possibleTrustName;
          } else if (possibleReg) {
            // try the registration number in common nested paths
            findQuery[
              "trust_details.trust_type.unregulated_trust.registration_number"
            ] = possibleReg;
          } else {
            findQuery = {
              customer: createdCustomer._id,
              client: clientDoc ? clientDoc._id : undefined,
              branch: branchDoc ? branchDoc._id : undefined,
            };
          }

          const trustPayload = {
            client: clientDoc ? clientDoc._id : undefined,
            branch: branchDoc ? branchDoc._id : undefined,
            customer: createdCustomer._id,
            trust_details: (kyc && kyc.trust_details) || {},
            documents: (kyc && kyc.documents) || body.documents || [],
            ...kyc,
          };

          const result = await findOrUpdateKyc(
            TrustKyc,
            findQuery,
            trustPayload,
          );
          createdKyc.push({
            type: "TrustKyc",
            action: result.action,
            id: result.doc._id,
            message:
              result.action === "updated"
                ? `TrustKyc updated (id: ${result.doc._id})`
                : `TrustKyc created (id: ${result.doc._id})`,
          });
        } else {
          // NonIndividualKyc: try registered_business_name or entity_name
          const possibleName =
            (kyc &&
              (kyc.general_information?.registered_business_name ||
                kyc.registered_business_name)) ||
            (kyc && (kyc.general_information?.entity_name || kyc.entity_name));

          let findQuery = { customer: createdCustomer._id };
          if (possibleName) {
            findQuery["general_information.registered_business_name"] =
              possibleName;
          } else {
            findQuery = {
              customer: createdCustomer._id,
              client: clientDoc ? clientDoc._id : undefined,
              branch: branchDoc ? branchDoc._id : undefined,
            };
          }

          const nonIndPayload = {
            client: clientDoc ? clientDoc._id : undefined,
            branch: branchDoc ? branchDoc._id : undefined,
            customer: createdCustomer._id,
            general_information: (kyc && kyc.general_information) || {},
            documents: (kyc && kyc.documents) || body.documents || [],
            ...kyc,
          };

          const result = await findOrUpdateKyc(
            NonIndividualKyc,
            findQuery,
            nonIndPayload,
          );
          createdKyc.push({
            type: "NonIndividualKyc",
            action: result.action,
            id: result.doc._id,
            message:
              result.action === "updated"
                ? `NonIndividualKyc updated (id: ${result.doc._id})`
                : `NonIndividualKyc created (id: ${result.doc._id})`,
          });
        }
      } // end KYC block
    }); // end transaction

    // return created items (refresh customer to include generated uid)
    const resultCustomer = await Customer.findById(createdCustomer._id)
      .populate("user", "name email uid userName")
      .populate("relations.client")
      .populate("relations.branch")
      .lean();

    // SECURITY NOTE: we return a flag that a default password was created.
    res.status(201).json({
      success: true,
      message: "Customer (and user/kyc where applicable) created",
      data: {
        user: {
          _id: createdUser._id,
          name: createdUser.name,
          userName: createdUser.userName,
          email: createdUser.email,
          // DO NOT return password or hashed password.
          defaultPasswordSet: existingWas(createdUser) ? false : true,
        },
        customer: resultCustomer,
        kyc: createdKyc,
      },
    });

    // helper to check existing user earlier (we can't reference existingUser outside transaction easily)
    function existingWas(u) {
      // if sequence existed before creation it's probably existing, but best is to check createdAt vs now.
      // For simplicity: assume defaultPasswordSet true only if createdAt is within last 2 minutes
      return new Date() - new Date(u.createdAt) > 120000;
    }
  } catch (err) {
    console.error("createCustomerWithUserAndKyc error:", err);
    throw err; // asyncHandler will turn into 500 response
  } finally {
    session.endSession();
  }
});

function escapeRegExp(string) {
  return String(string || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

///Company Controller:

/**
 * Whitelist shared by the create/update writers below — uid/sequence/
 * customer/name_history/osintStatus are server-owned and ignored even if
 * sent (docs/65 Step 30 extracted this from the two inline copies).
 */
function pickKybPayload(b = {}) {
  const payload = {
    general_information: b.general_information,
    identifiers: b.identifiers,
    appointments: b.appointments,
    directors_beneficial_owner: b.directors_beneficial_owner,
    share_capital: b.share_capital,
    shareholders: b.shareholders,
    related_entities: b.related_entities,
    documents: b.documents,
    questionnaires: b.questionnaires,
  };
  Object.keys(payload).forEach(
    (k) => payload[k] === undefined && delete payload[k],
  );
  return payload;
}

/**
 * Trust / Nominee / Minor handling for shareholders (docs/65 Step 43; the
 * entity-level "company itself is a Trust" branch this originally also had
 * was removed in Step 45 — Trust is no longer an entity_type option, so a
 * Trust entity is onboarded via the separate TrustKyc flow instead of the
 * Companies module). Reuses the existing TrustKyc model rather than
 * duplicating its schema onto CompanyKyc:
 *  - For each shareholder row with beneficially_held===false, requires
 *    beneficial_arrangement.arrangement_type (renamed from `type` in Step
 *    66). A "trust" arrangement additionally requires that row's
 *    trust.trust_details.full_trust_name (the
 *    `{ id, trust_details, individual_trustees, beneficiaries }` wrapper
 *    shape), gets its own companion TrustKyc, and is linked via the
 *    existing holder_model/holder_entity polymorphic ref
 *    (holder_model:"TrustKyc") rather than a new field — nominee/minor
 *    aren't TrustKyc-shaped, so they instead require the beneficiary to be
 *    named: beneficiary.entity_name for an entity beneficiary,
 *    beneficiary.full_name (or first+last) for a person.
 * `shareholders[].trust` is payload-only — not a field on CompanyKyc's
 * schema; it's consumed here to create/update the linked TrustKyc doc(s),
 * then dropped before the shareholder rows are persisted. Passing back an
 * already-linked id (`.trust.id`, or shareholders[].holder_entity when
 * holder_model is "TrustKyc") updates that same TrustKyc instead of minting
 * a new one on every save.
 * The field whitelist lives in `pickTrustPayload` below — shared with the
 * standalone trust writers (Step 57) so the two can't drift.
 * Throws { status, message } on validation failure — callers catch and
 * forward to ErrorResponse.
 */

/**
 * Whitelist of client-writable TrustKyc fields (docs/65 Step 46, widened in
 * Step 55 for the expanded schema; lifted to module scope in Step 57 so
 * `resolveTrustLinks` and the standalone POST/PUT trust writers share one
 * definition rather than two that drift).
 *
 * Deliberately absent: `review_status` / `review_history` /
 * `next_review_date` — the review workflow is server-owned and never
 * accepted from a payload, same rule as CompanyKyc (Step 31), pinned by
 * test. Also absent: `uid` / `sequence` / `customer` / `osintStatus`.
 *
 * `aml_kyc` IS whitelisted: these endpoints are staff-gated, and its fields
 * (source of funds/wealth, screening statuses) are working data an
 * authorised staff member legitimately records — unlike a review decision,
 * they don't gate an approval workflow.
 */
function pickTrustPayload(t = {}) {
  // Retired paths are lifted onto their canonical fields before anything
  // else touches the payload (docs/65 Step 60) — Mongoose would drop them
  // silently otherwise. Operates on a shallow copy of trust_details so the
  // caller's object isn't mutated underneath it.
  const lifted = TrustKyc.liftLegacyTrustFields({
    ...t,
    ...(t.trust_details ? { trust_details: { ...t.trust_details } } : {}),
    ...(t.settlor ? { settlor: { ...t.settlor } } : {}),
  });
  const p = {
    trust_details: lifted.trust_details,
    individual_trustees: lifted.individual_trustees,
    beneficiaries: lifted.beneficiaries,
    company_trustees: lifted.company_trustees,
    settlor: lifted.settlor,
    controllers: lifted.controllers,
    appointors: lifted.appointors,
    aml_kyc: lifted.aml_kyc,
    documents: lifted.documents,
  };
  Object.keys(p).forEach((k) => p[k] === undefined && delete p[k]);
  return p;
}

async function resolveTrustLinks(b) {
  // findById + assign + save(), NOT findByIdAndUpdate: the model's
  // canonical/alias reconciliation runs in a `save` hook (docs/65 Step 59)
  // and findOneAndUpdate bypasses save hooks entirely, so an update through
  // that path would leave settlor_name / the variant identifiers out of
  // sync. Same pattern updateTrustKyc and updateCompanyKyc already use.
  const upsertTrust = async (existingId, t) => {
    const payload = pickTrustPayload(t);
    if (existingId) {
      const existing = await TrustKyc.findById(existingId);
      if (existing) {
        Object.assign(existing, payload);
        await existing.save();
        return existing._id;
      }
    }
    const created = await TrustKyc.create(payload);
    return created._id;
  };
  const fail = (message) => {
    const err = new Error(message);
    err.status = 400;
    throw err;
  };

  const shareholders = Array.isArray(b.shareholders)
    ? await Promise.all(
        b.shareholders.map(async (h, i) => {
          if (h?.beneficially_held !== false) return h;
          const arrangement = h.beneficial_arrangement || {};
          if (!arrangement.arrangement_type) {
            fail(`shareholders[${i}].beneficial_arrangement.arrangement_type is required when beneficially_held is false`);
          }
          if (arrangement.arrangement_type === "trust") {
            if (!h.trust?.trust_details?.full_trust_name?.trim()) {
              fail(`shareholders[${i}].trust.trust_details.full_trust_name is required for a trust arrangement`);
            }
            const existingId = h.trust?.id || (h.holder_model === "TrustKyc" ? h.holder_entity : undefined);
            const id = await upsertTrust(existingId, h.trust);
            const { trust, ...rest } = h;
            return { ...rest, holder_model: "TrustKyc", holder_entity: id };
          }
          // Non-trust arrangements must still say WHO benefits (docs/65 Step
          // 66). An entity beneficiary is named by entity_name; a person by
          // full_name, or by first+last when the payload carries split parts.
          const ben = arrangement.beneficiary || {};
          const named =
            arrangement.beneficiary_type === "entity"
              ? ben.entity_name?.trim()
              : ben.full_name?.trim() || (ben.first_name?.trim() && ben.last_name?.trim());
          if (!named) {
            const expected = arrangement.beneficiary_type === "entity" ? "beneficiary.entity_name" : "beneficiary.full_name";
            fail(
              `shareholders[${i}].beneficial_arrangement.${expected} is required for a ${arrangement.arrangement_type} arrangement`,
            );
          }
          const { trust, ...rest } = h;
          return rest;
        }),
      )
    : b.shareholders;

  return { shareholders };
}

/**
 * Duplicate guard (docs/65 Step 30): the registration-number index is sparse
 * but not unique, so the writers check explicitly and answer 409 with the
 * existing record's id — friendlier than a raw index error, and lets the UI
 * offer "open the existing record". `excludeId` skips the record being
 * updated so saving a record against its own number stays legal.
 */
async function findRegistrationConflict(regNumber, excludeId) {
  const value = String(regNumber || "").trim();
  if (!value) return null;
  const query = { "general_information.registration_number": value };
  if (excludeId) query._id = { $ne: excludeId };
  return CompanyKyc.findOne(query).select("_id uid general_information.legal_name").lean();
}

/**
 * @desc   Create a CompanyKyc record from the companies add-form.
 * @route  POST /api/v1/customer/company
 * @access admin | client | branch | manager | officer
 *
 * Scope note (docs/65 KYB log): this writer does NOT attempt tenancy linkage
 * (Customer.relations) — that's out of scope here by explicit instruction;
 * tenant scoping for KYB records is Customer.relations design work, not a
 * standalone endpoint concern. The created doc has no `customer` set.
 */
exports.createCompanyKyc = asyncHandler(async (req, res, next) => {
  const b = req.body || {};
  if (!b.general_information?.legal_name?.trim()) {
    return next(
      new ErrorResponse("general_information.legal_name is required", 400),
    );
  }

  const conflict = await findRegistrationConflict(
    b.general_information?.registration_number,
  );
  if (conflict) {
    return next(
      new ErrorResponse(
        `A company with registration number ${String(b.general_information.registration_number).trim()} already exists: ${conflict.general_information?.legal_name || conflict.uid} (id: ${conflict._id})`,
        409,
      ),
    );
  }

  let trustLinks;
  try {
    trustLinks = await resolveTrustLinks(b);
  } catch (err) {
    return next(new ErrorResponse(err.message, err.status || 400));
  }

  const payload = pickKybPayload(b);
  if (trustLinks.shareholders) payload.shareholders = trustLinks.shareholders;
  // Review workflow is server-owned (docs/65 Step 31): a wizard submission
  // lands in the review queue, never pre-approved — regardless of what the
  // client sent (review_status/review_history aren't in the whitelist).
  const doc = await CompanyKyc.create({
    ...payload,
    review_status: "in_review",
    review_history: [
      {
        status: "in_review",
        note: "Submitted for review",
        changedBy: req.user?._id,
        changedAt: new Date(),
      },
    ],
  });

  await logKybEvent({
    req,
    company: doc,
    action: "KYB_CREATED",
    after: payload,
    target: doc.general_information?.legal_name || doc.uid,
  });

  res.status(201).json({ success: true, data: doc });
});

/**
 * @desc   Update an existing CompanyKyc record from the companies edit-form.
 * @route  PUT /api/v1/customer/company/:id
 * @access admin | client | branch | manager | officer
 *
 * Same whitelist as createCompanyKyc. Uses findById + Object.assign + save()
 * (not findByIdAndUpdate) so the model's pre-save hooks — director-mirror,
 * name_history, number_of_directors sync — still run on every update.
 */
exports.updateCompanyKyc = asyncHandler(async (req, res, next) => {
  const doc = await CompanyKyc.findById(req.params.id);
  if (!doc) {
    return next(new ErrorResponse("CompanyKyc not found", 404));
  }

  const b = req.body || {};
  if (
    b.general_information &&
    "legal_name" in b.general_information &&
    !b.general_information.legal_name?.trim()
  ) {
    return next(
      new ErrorResponse("general_information.legal_name is required", 400),
    );
  }

  const conflict = await findRegistrationConflict(
    b.general_information?.registration_number,
    doc._id,
  );
  if (conflict) {
    return next(
      new ErrorResponse(
        `A company with registration number ${String(b.general_information.registration_number).trim()} already exists: ${conflict.general_information?.legal_name || conflict.uid} (id: ${conflict._id})`,
        409,
      ),
    );
  }

  let trustLinks;
  try {
    trustLinks = await resolveTrustLinks(b);
  } catch (err) {
    return next(new ErrorResponse(err.message, err.status || 400));
  }

  const payload = pickKybPayload(b);
  if (trustLinks.shareholders) payload.shareholders = trustLinks.shareholders;

  // Per-register audit diff (docs/65 Step 31): compare the STORED state
  // before vs after the save — both sides schema-cast — rather than payload
  // vs storage, which false-positives on schema defaults (empty arrays) and
  // date-string casting. Subdocument _ids are stripped from the comparison
  // only (re-casting an array mints fresh _ids even for identical content);
  // the audited snapshots keep them.
  const stripIds = (k, v) => (k === "_id" ? undefined : v);
  const beforeDoc = doc.toObject();

  Object.assign(doc, payload);
  await doc.save();
  // Reload for the after-snapshot: assigning a plain object to a nested path
  // leaves the in-memory doc without that path's array defaults, while a
  // hydrated doc carries them as [] — comparing in-memory vs hydrated would
  // flag every update as a change. Symmetric hydration fixes that.
  const afterDoc = (await CompanyKyc.findById(doc._id)).toObject();

  const changedBefore = {};
  const changedAfter = {};
  const diffKeys = Object.keys(payload);
  for (const key of diffKeys) {
    if (
      JSON.stringify(beforeDoc[key] ?? null, stripIds) !==
      JSON.stringify(afterDoc[key] ?? null, stripIds)
    ) {
      changedBefore[key] = beforeDoc[key] ?? null;
      changedAfter[key] = afterDoc[key] ?? null;
    }
  }

  if (Object.keys(changedAfter).length) {
    await logKybEvent({
      req,
      company: doc,
      action: "KYB_UPDATED",
      before: changedBefore,
      after: changedAfter,
      target: doc.general_information?.legal_name || doc.uid,
    });
  }

  res.status(200).json({ success: true, data: doc });
});

/**
 * Shared body for every OCR pre-fill endpoint (docs/65 Step 48/50) — pure
 * extraction, does NOT create or touch any KYC record. `processFn` is one
 * of ocrService's processEkyb* functions; the response envelope and error
 * handling are identical across all of them (same upstream EKYBResponse
 * shape). Reshaping `data` into wizard state is a frontend concern —
 * kept as-is here so the two stay honest about what the OCR service
 * actually returned.
 */
async function ocrExtract(req, res, next, processFn) {
  if (!req.file) {
    return next(new ErrorResponse("A document (image or PDF) is required", 400));
  }
  let upstream;
  try {
    upstream = await processFn(req.file.buffer, req.file.originalname, req.file.mimetype);
  } catch (err) {
    const status = err.response?.status;
    // Upstream validation (bad/unreadable file) surfaces as a 4xx we can
    // relay directly; anything else (network/timeout/5xx) is our problem to
    // report, not the caller's input.
    if (status && status >= 400 && status < 500) {
      return next(new ErrorResponse(err.response?.data?.detail?.[0]?.msg || "The OCR service rejected this document", status));
    }
    return next(new ErrorResponse("OCR extraction service is currently unavailable", 502));
  }

  if (!upstream?.success) {
    return next(new ErrorResponse(upstream?.error || "Could not extract data from this document", 422));
  }

  res.status(200).json({
    success: true,
    document_type: upstream.document_type,
    data: upstream.data || null,
  });
}

/**
 * @desc   Extract company KYB data from an ASIC Company Extract / Form 201
 *         via the external eKYB OCR service, for pre-filling the add-wizard.
 * @route  POST /api/v1/customer/company/ocr
 * @access admin | client | branch | manager | officer
 */
exports.ocrExtractCompany = asyncHandler((req, res, next) => ocrExtract(req, res, next, ocrService.processEkybCompany));

/**
 * @desc   Extract trust KYB data from a Trust Deed via the external eKYB OCR
 *         service, for pre-filling the shareholder "held on behalf of a
 *         trust" arrangement's linked-TrustKyc form (docs/65 Step 43/46).
 * @route  POST /api/v1/customer/trust/ocr
 * @access admin | client | branch | manager | officer
 */
exports.ocrExtractTrust = asyncHandler((req, res, next) => ocrExtract(req, res, next, ocrService.processEkybTrust));

const KYB_REVIEW_ALLOWED = ["draft", "in_review", "approved", "escalated", "declined"];

/**
 * @desc   Advance a company's KYB review status (with decision note).
 * @route  PATCH /api/v1/customer/company/:id/review-status
 * @access admin | client | branch | manager | officer
 *
 * Mirrors updateCustomerKycStatus (the platform's KYC decision pattern):
 * enum-validated status, note required on escalate/decline, history entry
 * attributed to the acting user, updateOne (no unrelated pre-save hooks),
 * and a KYB_REVIEW_* audit entry (docs/65 Step 31).
 */
exports.updateCompanyReviewStatus = asyncHandler(async (req, res, next) => {
  const { status, note } = req.body || {};

  if (!status || !KYB_REVIEW_ALLOWED.includes(status)) {
    return next(
      new ErrorResponse(`status must be one of: ${KYB_REVIEW_ALLOWED.join(", ")}`, 400),
    );
  }
  if ((status === "escalated" || status === "declined") && !note) {
    return next(new ErrorResponse(`note is required when status is "${status}"`, 400));
  }

  const doc = await CompanyKyc.findById(req.params.id).select(
    "review_status general_information.legal_name uid customer",
  );
  if (!doc) {
    return next(new ErrorResponse("CompanyKyc not found", 404));
  }

  const prev = doc.review_status || "draft";
  if (prev === status) {
    return next(new ErrorResponse(`Company review status is already "${status}"`, 400));
  }

  const defaultNotes = {
    draft: "Reset to draft",
    in_review: "Moved to review",
    approved: "Approved by reviewer",
    escalated: "Escalated by reviewer",
    declined: "Declined by reviewer",
  };
  const historyEntry = {
    status,
    note: note || defaultNotes[status],
    changedBy: req.user?._id,
    changedAt: new Date(),
  };

  await CompanyKyc.updateOne(
    { _id: doc._id },
    { $set: { review_status: status }, $push: { review_history: historyEntry } },
  );

  await logKybEvent({
    req,
    company: doc,
    action: `KYB_REVIEW_${status.toUpperCase()}`,
    before: { review_status: prev },
    after: { review_status: status, note: historyEntry.note },
    target: doc.general_information?.legal_name || doc.uid,
  });

  res.status(200).json({
    success: true,
    message: `Company review ${status}`,
    data: {
      companyId: doc._id,
      prevStatus: prev,
      review_status: status,
      historyEntry,
    },
  });
});

/**
 * @desc   Compliance audit trail for one company (service "kyb" entries).
 * @route  GET /api/v1/customer/company/:id/audit
 * @access admin | client | branch | manager | officer
 */
exports.getCompanyKycAudit = asyncHandler(async (req, res, next) => {
  const exists = await CompanyKyc.exists({ _id: req.params.id });
  if (!exists) {
    return next(new ErrorResponse("CompanyKyc not found", 404));
  }

  const qPage = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const qLimit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

  const filter = { service: "kyb", companyKyc: req.params.id };
  const total = await AuditLog.countDocuments(filter);
  const entries = await AuditLog.find(filter)
    .sort("-createdAt")
    .skip((qPage - 1) * qLimit)
    .limit(qLimit)
    .lean();

  res.status(200).json({
    success: true,
    count: entries.length,
    total,
    page: qPage,
    pages: Math.ceil(total / qLimit),
    data: entries,
  });
});

// Company document rows: keep only the fields a client may set — the binary
// itself lives in the file store; verification_status starts server-side.
const sanitizeKybDoc = (d = {}) => {
  const doc = {
    name: d.name,
    url: d.url,
    mimeType: d.mimeType,
    docType: d.docType,
    category: d.category,
    document_date: d.document_date,
    expiry_date: d.expiry_date,
    file: d.file,
  };
  Object.keys(doc).forEach((k) => doc[k] === undefined && delete doc[k]);
  return doc;
};

/**
 * @desc   Attach one or more documents to a company (metadata + file-store ref).
 * @route  POST /api/v1/customer/company/:id/documents
 * @access admin | client | branch | manager | officer
 */
exports.addCompanyDocuments = asyncHandler(async (req, res, next) => {
  const raw = Array.isArray(req.body?.documents)
    ? req.body.documents
    : req.body?.document
      ? [req.body.document]
      : [];

  const docs = raw.map(sanitizeKybDoc).filter((d) => d.url);
  if (docs.length === 0) {
    return next(new ErrorResponse("At least one document with a url is required", 400));
  }

  const company = await CompanyKyc.findById(req.params.id).select(
    "documents general_information.legal_name uid customer",
  );
  if (!company) {
    return next(new ErrorResponse("CompanyKyc not found", 404));
  }

  const existing = new Set((company.documents || []).map((d) => d.url));
  const fresh = docs.filter((d) => !existing.has(d.url));
  if (fresh.length === 0) {
    return next(new ErrorResponse("Document(s) already attached to this company", 400));
  }

  await CompanyKyc.updateOne(
    { _id: company._id },
    { $push: { documents: { $each: fresh } } },
  );

  await logKybEvent({
    req,
    company,
    action: "KYB_DOCUMENT_ADDED",
    after: fresh.map((d) => ({ name: d.name, url: d.url, category: d.category })),
    target: company.general_information?.legal_name || company.uid,
  });

  const updated = await CompanyKyc.findById(company._id).select("documents").lean();
  res.status(200).json({
    success: true,
    message: `${fresh.length} document(s) added`,
    data: updated.documents,
  });
});

/**
 * @desc   Remove a company document by row id or URL.
 * @route  DELETE /api/v1/customer/company/:id/documents?docId=... | ?url=...
 * @access admin | client | branch | manager | officer
 */
exports.removeCompanyDocument = asyncHandler(async (req, res, next) => {
  const docId = req.query.docId || req.body?.docId;
  const url = req.query.url || req.body?.url;
  if (!docId && !url) {
    return next(new ErrorResponse("docId or url (query or body) is required", 400));
  }

  const company = await CompanyKyc.findById(req.params.id).select(
    "documents general_information.legal_name uid customer",
  );
  if (!company) {
    return next(new ErrorResponse("CompanyKyc not found", 404));
  }

  const target = (company.documents || []).find(
    (d) => (docId && String(d._id) === String(docId)) || (url && d.url === url),
  );
  if (!target) {
    return next(new ErrorResponse("Document not found on this company", 404));
  }

  const pull = docId ? { _id: target._id } : { url };
  await CompanyKyc.updateOne({ _id: company._id }, { $pull: { documents: pull } });

  await logKybEvent({
    req,
    company,
    action: "KYB_DOCUMENT_REMOVED",
    before: { name: target.name, url: target.url, category: target.category },
    target: company.general_information?.legal_name || company.uid,
  });

  const updated = await CompanyKyc.findById(company._id).select("documents").lean();
  res.status(200).json({
    success: true,
    message: "Document removed",
    data: updated.documents,
  });
});

const KYB_DOC_VERIFICATION_STATUSES = ["unverified", "verified", "rejected"];

/**
 * @desc   Set a company document's verification outcome (and/or expiry date)
 *         — the reviewer-side counterpart to sanitizeKybDoc leaving
 *         verification_status server-owned on add.
 * @route  PATCH /api/v1/customer/company/:id/documents/:docId
 * @access admin | client | branch | manager | officer
 */
exports.updateCompanyDocument = asyncHandler(async (req, res, next) => {
  const { verification_status, expiry_date } = req.body || {};

  if (verification_status === undefined && expiry_date === undefined) {
    return next(new ErrorResponse("verification_status or expiry_date is required", 400));
  }
  if (verification_status !== undefined && !KYB_DOC_VERIFICATION_STATUSES.includes(verification_status)) {
    return next(
      new ErrorResponse(`verification_status must be one of: ${KYB_DOC_VERIFICATION_STATUSES.join(", ")}`, 400),
    );
  }

  const company = await CompanyKyc.findById(req.params.id).select(
    "documents general_information.legal_name uid customer",
  );
  if (!company) {
    return next(new ErrorResponse("CompanyKyc not found", 404));
  }

  const target = company.documents.id(req.params.docId);
  if (!target) {
    return next(new ErrorResponse("Document not found on this company", 404));
  }

  const before = { verification_status: target.verification_status, expiry_date: target.expiry_date };
  if (verification_status !== undefined) target.verification_status = verification_status;
  if (expiry_date !== undefined) target.expiry_date = expiry_date || undefined;
  await company.save();

  await logKybEvent({
    req,
    company,
    action: "KYB_DOCUMENT_VERIFIED",
    before,
    after: { verification_status: target.verification_status, expiry_date: target.expiry_date },
    target: company.general_information?.legal_name || company.uid,
  });

  res.status(200).json({
    success: true,
    message: "Document updated",
    data: target,
  });
});

// Get many company KYC records (with filters, pagination, search).
// Filter/sort/pagination building lives in middleware/kybListQuery.js
// (docs/65 Step 68) — one whitelisted implementation shared with the trust
// list. `req.kybQuery` is set by the route's middleware; the ?? fallback
// keeps the controller callable directly (tests invoke it without a router).
exports.getCompanyKycs = asyncHandler(async (req, res, next) => {
  const { filter, sort, page: qPage, limit: qLimit, skip } =
    req.kybQuery || buildKybListQuery("company", req.query);

  const total = await CompanyKyc.countDocuments(filter);
  const pages = Math.ceil(total / qLimit);

  const docs = await CompanyKyc.find(filter)
    // .populate("client", "name _id")
    // .populate("branch", "name _id")
    // .populate("customer", "personalKyc country isPep sanction kycStatus") // adjust fields as you like
    .sort(sort)
    .skip(skip)
    .limit(qLimit)
    .lean();

  res.status(200).json({
    success: true,
    count: docs.length,
    total,
    page: qPage,
    pages,
    data: docs,
  });
});

// Get single company KYC by id|uid|sequence
exports.getCompanyKyc = asyncHandler(async (req, res, next) => {
  const identifier = req.params.id; // can be ObjectId, uid (COMKYC_...), or sequence number

  // Try find by Mongo ObjectId
  let doc = null;
  const isObjectId = mongoose.Types.ObjectId.isValid(identifier);

  if (isObjectId) {
    doc = await CompanyKyc.findById(identifier)
      // .populate("client", "name _id")
      // .populate("branch", "name _id")
      .populate("customer", "personalKyc country isPep sanction kycStatus")
      .populate("shareholders.holder_entity")
      .lean();
  }

  // If not found by ObjectId, try uid match (e.g. COMKYC_123456) or sequence.
  // No client/branch populates here — those paths don't exist on CompanyKyc
  // and threw StrictPopulateError under Mongoose 8 (docs/65 Step 30).
  if (!doc) {
    // if identifier looks like COMKYC_* or contains non-numeric chars treat as uid
    if (typeof identifier === "string" && identifier.match(/^COMKYC_/i)) {
      doc = await CompanyKyc.findOne({ uid: identifier })
        .populate("customer", "user _id")
        .populate("shareholders.holder_entity")
        .lean();
    } else if (!Number.isNaN(Number(identifier))) {
      // numeric -> sequence
      doc = await CompanyKyc.findOne({ sequence: Number(identifier) })
        .populate("customer", "user _id")
        .populate("shareholders.holder_entity")
        .lean();
    } else {
      // fallback: try search by legal_name (exact) as last resort
      doc = await CompanyKyc.findOne({
        "general_information.legal_name": identifier,
      })
        .populate("customer", "user _id")
        .populate("shareholders.holder_entity")
        .lean();
    }
  }

  if (!doc) {
    return next(
      new ErrorResponse(
        `CompanyKyc not found for identifier: ${identifier}`,
        404,
      ),
    );
  }

  res.status(200).json({
    success: true,
    data: doc,
  });
});

///For Trust:

// Get many trust KYC records. Same whitelisted query builder as the company
// list (middleware/kybListQuery.js, docs/65 Step 68) — the two lists cannot
// drift apart on filter names, search behaviour or sort safety.
exports.getTrustKycs = asyncHandler(async (req, res, next) => {
  const { filter, sort, page: qPage, limit: qLimit, skip } =
    req.kybQuery || buildKybListQuery("trust", req.query);

  const total = await TrustKyc.countDocuments(filter);
  const pages = Math.ceil(total / qLimit);

  const docs = await TrustKyc.find(filter)
    // .populate("client", "name _id")
    // .populate("branch", "name _id")
    // .populate("customer", "personalKyc country isPep sanction kycStatus")
    .sort(sort)
    .skip(skip)
    .limit(qLimit)
    .lean();

  res.status(200).json({
    success: true,
    count: docs.length,
    total,
    page: qPage,
    pages,
    data: docs,
  });
});

// Get single trust KYC by id | uid | sequence
exports.getTrustKyc = asyncHandler(async (req, res, next) => {
  const identifier = req.params.id;

  let doc = null;
  const isObjectId = mongoose.Types.ObjectId.isValid(identifier);

  // No client/branch populates — those paths don't exist on TrustKyc and
  // threw StrictPopulateError on EVERY branch, including the plain ObjectId
  // path, so every GET /trust/:id 500'd (docs/65 Step 30).

  // Try ObjectId
  if (isObjectId) {
    doc = await TrustKyc.findById(identifier)
      .populate("customer", "personalKyc country isPep sanction kycStatus")
      .lean();
  }

  // Try UID
  if (!doc && /^TRKYC_/i.test(identifier)) {
    doc = await TrustKyc.findOne({ uid: identifier })
      .populate("customer", "user _id")
      .lean();
  }

  // Try sequence
  if (!doc && !Number.isNaN(Number(identifier))) {
    doc = await TrustKyc.findOne({ sequence: Number(identifier) })
      .populate("customer", "user _id")
      .lean();
  }

  // Try trust name fallback
  if (!doc) {
    doc = await TrustKyc.findOne({
      "trust_details.full_trust_name": identifier,
    })
      .populate("customer", "user _id")
      .lean();
  }

  if (!doc) {
    return next(
      new ErrorResponse(
        `TrustKyc not found for identifier: ${identifier}`,
        404,
      ),
    );
  }

  res.status(200).json({
    success: true,
    data: doc,
  });
});

/**
 * @desc   The companies a trust holds an interest in — the reverse of the
 *         company wizard's "held on behalf of a trust" link.
 * @route  GET /api/v1/customer/trust/:id/companies
 * @access admin | client | branch
 *
 * A company records its trust link on `shareholders[].holder_entity` with
 * `holder_model: "TrustKyc"` (api/models/CompanyKyc.js). Nothing on TrustKyc
 * points back, deliberately — one link, one source of truth — so the trust
 * side has to ask this question by query. Without it the trust dossier can
 * only ever show the parties INSIDE the trust, never what the trust owns,
 * which is the half a reviewer actually needs to see (docs/65 Step 70).
 *
 * `beneficial_arrangement.trust_kyc` is included in the $or because the path
 * exists on the schema; it is documented as never written, so in practice
 * every match comes from the holder_entity ref. Matching both means a record
 * created by some future writer can't quietly go missing from this view.
 *
 * Only the fields the graph and the badge draw are projected — the caller is
 * rendering a map, not opening the files, and a trust with many holdings
 * would otherwise ship a very large payload.
 */
exports.getCompaniesForTrust = asyncHandler(async (req, res, next) => {
  const identifier = req.params.id;

  // Resolve to the _id the company documents actually store. A uid is
  // accepted because the trust pages route by whichever identifier they hold.
  let trustId = null;
  if (mongoose.Types.ObjectId.isValid(identifier)) {
    trustId = new mongoose.Types.ObjectId(identifier);
  } else {
    const trust = await TrustKyc.findOne(
      /^TRKYC_/i.test(identifier)
        ? { uid: identifier }
        : { "trust_details.full_trust_name": identifier },
    )
      .select("_id")
      .lean();
    if (!trust) {
      return next(new ErrorResponse(`TrustKyc not found for identifier: ${identifier}`, 404));
    }
    trustId = trust._id;
  }

  const docs = await CompanyKyc.find({
    $or: [
      { shareholders: { $elemMatch: { holder_model: "TrustKyc", holder_entity: trustId } } },
      { "shareholders.beneficial_arrangement.trust_kyc": trustId },
    ],
  })
    .select(
      "uid review_status general_information.legal_name general_information.entity_type " +
        "general_information.country_of_incorporation general_information.registration_number " +
        "shareholders directors_beneficial_owner.beneficial_owners appointments related_entities",
    )
    .lean();

  // The holding itself is what makes this row meaningful, so it is computed
  // here rather than leaving every client to re-derive it from shareholders[].
  const data = docs.map((c) => {
    const held = (c.shareholders || []).filter(
      (s) =>
        (s.holder_model === "TrustKyc" && String(s.holder_entity) === String(trustId)) ||
        String(s.beneficial_arrangement?.trust_kyc || "") === String(trustId),
    );
    return {
      ...c,
      trust_holding: {
        // A trust can appear on more than one share class, so these are sums.
        percent_held: held.reduce((n, s) => n + (s.percent_held || 0), 0),
        units_held: held.reduce((n, s) => n + (s.units_held || 0), 0),
        security_classes: [...new Set(held.map((s) => s.security_class).filter(Boolean))],
        holder_names: [...new Set(held.map((s) => s.holder_name).filter(Boolean))],
      },
    };
  });

  res.status(200).json({ success: true, count: data.length, trust: trustId, data });
});

/**
 * @desc   Portfolio analytics for the companies list dashboard.
 * @route  GET /api/v1/customer/company/stats
 * @access admin | client | branch | manager | officer
 *
 * Computed server-side over the WHOLE collection on purpose (docs/65 Step
 * 58). `getCompanyKycs` is paginated — default 25, hard-capped at 200 — so a
 * dashboard tallied from that response in the browser would silently report
 * on the first page only and under-count every figure. In a compliance
 * product a confidently wrong total is worse than no total, so the numbers
 * come from one `$facet` aggregation instead.
 *
 * `ubo_unresolved` mirrors the Review page's own rule (a parent entity is
 * recorded but no beneficial owner meets the UBO test) and the `ubos`
 * virtual's thresholds — >=25% ownership, >=25% voting, or control_type
 * "other_means". The virtual can't be used here (aggregations don't hydrate
 * documents), so the same predicate is expressed in the pipeline; if the
 * virtual's thresholds ever change, this must change with it.
 */
exports.getCompanyKycStats = asyncHandler(async (req, res, next) => {
  const now = new Date();
  const DAY = 24 * 60 * 60 * 1000;
  const in30Days = new Date(now.getTime() + 30 * DAY);
  const last30 = new Date(now.getTime() - 30 * DAY);
  // 12 whole months back, from the start of that month.
  const trendFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

  const countBy = (field) => [{ $group: { _id: field, count: { $sum: 1 } } }, { $sort: { count: -1 } }];

  const [facet] = await CompanyKyc.aggregate([
    {
      $facet: {
        total: [{ $count: "n" }],
        byReviewStatus: countBy("$review_status"),
        byRegistryStatus: countBy("$general_information.status"),
        byEntityType: countBy("$general_information.entity_type"),
        byCountry: [
          { $match: { "general_information.country_of_incorporation": { $nin: [null, ""] } } },
          ...countBy("$general_information.country_of_incorporation"),
          { $limit: 6 },
        ],
        // Added per month for the last 12 months.
        trend: [
          { $match: { createdAt: { $gte: trendFrom } } },
          { $group: { _id: { y: { $year: "$createdAt" }, m: { $month: "$createdAt" } }, count: { $sum: 1 } } },
          { $sort: { "_id.y": 1, "_id.m": 1 } },
        ],
        // Ownership that doesn't resolve to a natural person — the single
        // most actionable compliance signal on this register.
        uboUnresolved: [
          {
            $match: {
              "related_entities.relation": "parent",
              "directors_beneficial_owner.beneficial_owners": {
                $not: {
                  $elemMatch: {
                    $or: [
                      { ownership_percent: { $gte: 25 } },
                      { voting_percent: { $gte: 25 } },
                      { control_type: "other_means" },
                    ],
                  },
                },
              },
            },
          },
          { $count: "n" },
        ],
        noDocuments: [{ $match: { $or: [{ documents: { $size: 0 } }, { documents: { $exists: false } }] } }, { $count: "n" }],
        docsExpired: [{ $match: { "documents.expiry_date": { $lt: now } } }, { $count: "n" }],
        docsExpiringSoon: [
          { $match: { documents: { $elemMatch: { expiry_date: { $gte: now, $lte: in30Days } } } } },
          { $count: "n" },
        ],
        docsRejected: [{ $match: { "documents.verification_status": "rejected" } }, { $count: "n" }],
        screeningPending: [{ $match: { "appointments.screening_status": "pending" } }, { $count: "n" }],
        // Companies whose ownership involves a linked trust.
        withTrustHolders: [{ $match: { "shareholders.holder_model": "TrustKyc" } }, { $count: "n" }],

        // ── panels added for the Company Dashboard design (docs/65 Step 58) ──
        addedLast30: [{ $match: { createdAt: { $gte: last30 } } }, { $count: "n" }],
        // Days from creation to the most recent "approved" history entry.
        // Collected raw and reduced to a median in JS — $percentile needs
        // Mongo 7 and this collection is small enough that it isn't worth
        // the version floor.
        approvalDays: [
          { $match: { review_status: "approved", "review_history.status": "approved" } },
          {
            $project: {
              createdAt: 1,
              approvedAt: {
                $max: {
                  $map: {
                    input: { $filter: { input: "$review_history", as: "h", cond: { $eq: ["$$h.status", "approved"] } } },
                    as: "h",
                    in: "$$h.changedAt",
                  },
                },
              },
            },
          },
          { $match: { approvedAt: { $ne: null } } },
          { $project: { days: { $divide: [{ $subtract: ["$approvedAt", "$createdAt"] }, DAY] } } },
        ],
        oldestInReview: [
          { $match: { review_status: "in_review" } },
          { $sort: { createdAt: 1 } },
          { $limit: 1 },
          { $project: { legal_name: "$general_information.legal_name", createdAt: 1 } },
        ],
        withAnyDocument: [{ $match: { "documents.0": { $exists: true } } }, { $count: "n" }],
        // How many companies hold at least one document of each kind —
        // de-duplicated per company so three copies of the same docType on
        // one file still count once.
        docCoverage: [
          {
            $project: {
              types: {
                $setUnion: [{ $map: { input: { $ifNull: ["$documents", []] }, as: "d", in: "$$d.docType" } }, []],
              },
            },
          },
          { $unwind: "$types" },
          { $match: { types: { $nin: [null, ""] } } },
          { $group: { _id: "$types", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 6 },
        ],
      },
    },
  ]);

  const n = (arr) => arr?.[0]?.n || 0;
  const asMap = (rows) =>
    (rows || []).reduce((acc, r) => {
      acc[r._id == null ? "unspecified" : r._id] = r.count;
      return acc;
    }, {});

  // Emit a dense 12-month series (zero-filled) so the client renders a real
  // timeline rather than only the months that happen to have records.
  const trendMap = (facet.trend || []).reduce((acc, r) => {
    acc[`${r._id.y}-${String(r._id.m).padStart(2, "0")}`] = r.count;
    return acc;
  }, {});
  const trend = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    trend.push({ month: key, count: trendMap[key] || 0 });
  }

  // Median, not mean: a couple of files that sat for months would drag a
  // mean far away from what a reviewer actually experiences.
  const days = (facet.approvalDays || []).map((r) => r.days).sort((x, z) => x - z);
  const medianApprovalDays = days.length
    ? Math.round((days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2) * 10) / 10
    : null;

  const oldest = facet.oldestInReview?.[0];
  const totalCount = n(facet.total);
  const withDocs = n(facet.withAnyDocument);

  res.status(200).json({
    success: true,
    data: {
      total: totalCount,
      by_review_status: asMap(facet.byReviewStatus),
      by_registry_status: asMap(facet.byRegistryStatus),
      by_entity_type: asMap(facet.byEntityType),
      by_country: (facet.byCountry || []).map((r) => ({ country: r._id, count: r.count })),
      trend,
      added_last_30_days: n(facet.addedLast30),
      review_timing: {
        median_days_to_approval: medianApprovalDays,
        oldest_in_review: oldest
          ? {
              legal_name: oldest.legal_name || "Unnamed company",
              days: Math.max(0, Math.floor((now - new Date(oldest.createdAt)) / DAY)),
            }
          : null,
      },
      document_coverage: {
        // Share of the register carrying at least one document at all.
        overall_pct: totalCount ? Math.round((withDocs / totalCount) * 100) : 0,
        with_any_document: withDocs,
        by_type: (facet.docCoverage || []).map((r) => ({
          doc_type: r._id,
          count: r.count,
          pct: totalCount ? Math.round((r.count / totalCount) * 100) : 0,
        })),
      },
      attention: {
        ubo_unresolved: n(facet.uboUnresolved),
        no_documents: n(facet.noDocuments),
        docs_expired: n(facet.docsExpired),
        docs_expiring_soon: n(facet.docsExpiringSoon),
        docs_rejected: n(facet.docsRejected),
        screening_pending: n(facet.screeningPending),
      },
      with_trust_holders: n(facet.withTrustHolders),
      generated_at: now,
    },
  });
});

/**
 * @desc   Create a standalone TrustKyc record.
 * @route  POST /api/v1/customer/trust
 * @access admin | client | branch | manager | officer
 *
 * Until docs/65 Step 57 a TrustKyc could only come into existence as a
 * companion record created by the Company writer (`resolveTrustLinks`).
 * That made "connect an existing trust" nearly useless — there was no way
 * to save a trust on its own for another company to link to later. These
 * writers close that gap. Same whitelist as the companion path
 * (`pickTrustPayload`), so a trust saved here and a trust saved through a
 * company submit accept exactly the same fields.
 */
exports.createTrustKyc = asyncHandler(async (req, res, next) => {
  const name = req.body?.trust_details?.full_trust_name;
  if (!name || !String(name).trim()) {
    return next(new ErrorResponse("trust_details.full_trust_name is required", 400));
  }
  const doc = await TrustKyc.create(pickTrustPayload(req.body));
  res.status(201).json({ success: true, data: doc });
});

/**
 * @desc   Update an existing TrustKyc record.
 * @route  PUT /api/v1/customer/trust/:id
 * @access admin | client | branch | manager | officer
 *
 * findById + Object.assign + save() (not findByIdAndUpdate) so the model's
 * pre-save hooks still run — same reason as updateCompanyKyc (Step 29).
 */
exports.updateTrustKyc = asyncHandler(async (req, res, next) => {
  const doc = await TrustKyc.findById(req.params.id);
  if (!doc) {
    return next(new ErrorResponse("TrustKyc not found", 404));
  }
  if (
    req.body?.trust_details &&
    "full_trust_name" in req.body.trust_details &&
    !String(req.body.trust_details.full_trust_name || "").trim()
  ) {
    return next(new ErrorResponse("trust_details.full_trust_name is required", 400));
  }
  Object.assign(doc, pickTrustPayload(req.body));
  await doc.save();
  res.status(200).json({ success: true, data: doc });
});

///For Non individual by Type
exports.getNonIndividualKycs = asyncHandler(async (req, res, next) => {
  function buildNonIndividualTypeFilter(type) {
    switch (type) {
      case "partnership":
        return { "partnership.partnership_type": { $exists: true, $ne: null } };

      case "government_body":
        return {
          "government_body.government_body_type": { $exists: true, $ne: null },
        };

      case "association":
      case "cooperative":
        return {
          "association_cooperative.entity_type": { $exists: true, $ne: null },
        };

      default:
        return {};
    }
  }

  const {
    page = 1,
    limit = 25,
    client,
    branch,
    customer,
    type,
    uid,
    sequence,
    search,
    sort = "-createdAt",
  } = req.query;

  const qPage = Math.max(parseInt(page, 10) || 1, 1);
  const qLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);

  const filter = {};

  if (client) filter.client = client;
  if (branch) filter.branch = branch;
  if (customer) filter.customer = customer;
  if (uid) filter.uid = uid;
  if (sequence) filter.sequence = Number(sequence);

  // ✅ type filter
  if (type) {
    Object.assign(filter, buildNonIndividualTypeFilter(type));
  }

  // ✅ search by name (escaped — literal match, docs/65 Step 30)
  if (search) {
    const rx = new RegExp(escapeRegExp(String(search).trim()), "i");
    filter.$or = [
      { "general_information.entity_name": rx },
      { "general_information.registered_business_name": rx },
    ];
  }

  const skip = (qPage - 1) * qLimit;

  const total = await NonIndividualKyc.countDocuments(filter);
  const pages = Math.ceil(total / qLimit);
  const docs = await NonIndividualKyc.find(filter)
    .sort(sort)
    .skip(skip)
    .limit(qLimit)
    .lean();

  res.status(200).json({
    success: true,
    count: docs.length,
    total,
    page: qPage,
    pages,
    data: docs,
  });
});

exports.downloadQR = asyncHandler(async (req, res, next) => {
  const { format = "png" } = req.query;

  const clientId = req.user?.client?._id;
  const branchId = req.user?.branch?._id || null;

  if (!clientId) {
    return next(new ErrorResponse("Client not found for this user", 400));
  }

  // ============================
  // Generate QR
  // ============================

  const qr = await generateQR({
    clientId: clientId.toString(),
    branchId: branchId ? branchId.toString() : null,
    format,
    useUrl: true,
  });

  // ============================
  // Send File
  // ============================

  if (format === "svg") {
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=qr-${branchId || clientId}.svg`,
    );
    return res.send(qr);
  }

  // Default PNG
  res.setHeader("Content-Type", "image/png");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=qr-${branchId || clientId}.png`,
  );

  return res.send(qr);
});

// ═════════════════════════════════════════════════════════════════════════════
// Customer documents (Documents tab) — merged from customerDocumentsController.
// Reviewer-side management of Customer.documents (DocumentMetaSchema): add via
// the Documents tab and remove by URL. Persisted with updateOne ($push/$pull)
// so the Customer pre-save encryption hooks don't re-process untouched PII.
// ═════════════════════════════════════════════════════════════════════════════

// Keep only the DocumentMetaSchema fields — never trust arbitrary keys.
const sanitizeDoc = (doc = {}) => ({
  name: String(doc.name || "").slice(0, 200),
  url: String(doc.url || ""),
  mimeType: String(doc.mimeType || "application/octet-stream"),
  type: String(doc.type || "manual_upload"),
  docType: String(doc.docType || "other"),
  uploadedAt: new Date(),
});

const loadGuardedCustomer = async (req, next) => {
  const customer = await Customer.findById(req.params.id).select("documents relations");
  if (!customer) {
    next(new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404));
    return null;
  }
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  if (!customerRelatedToTenant(customer, client, branch)) {
    next(new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404));
    return null;
  }
  return customer;
};

// @desc   Add one or more documents to a customer
// @route  POST /api/v1/customer/:id/documents
// @access Private (admin, client, branch, manager, officer)
exports.addCustomerDocuments = asyncHandler(async (req, res, next) => {
  const raw = Array.isArray(req.body?.documents)
    ? req.body.documents
    : req.body?.document
      ? [req.body.document]
      : [];

  const docs = raw.map(sanitizeDoc).filter((d) => d.url);
  if (docs.length === 0) {
    return next(new ErrorResponse("At least one document with a url is required", 400));
  }

  const customer = await loadGuardedCustomer(req, next);
  if (!customer) return;

  // No duplicate URLs — documents have no _id, URL is the identity.
  const existing = new Set((customer.documents || []).map((d) => d.url));
  const fresh = docs.filter((d) => !existing.has(d.url));
  if (fresh.length === 0) {
    return next(new ErrorResponse("Document(s) already attached to this customer", 400));
  }

  await Customer.updateOne(
    { _id: customer._id },
    { $push: { documents: { $each: fresh } } },
  );

  logEvent({
    req,
    service: "kyc",
    action: "kyc_document_added",
    customer: customer._id,
    afterValue: {
      count: fresh.length,
      names: fresh.map((d) => d.name || d.docType || d.url),
    },
  });

  const updated = await Customer.findById(customer._id).select("documents").lean();
  res.status(200).json({
    success: true,
    message: `${fresh.length} document(s) added`,
    data: updated.documents,
  });
});

// @desc   Remove a customer document by its URL
// @route  DELETE /api/v1/customer/:id/documents?url=...
// @access Private (admin, client, branch, manager, officer)
exports.removeCustomerDocument = asyncHandler(async (req, res, next) => {
  const url = req.query.url || req.body?.url;
  if (!url) {
    return next(new ErrorResponse("url (query or body) is required", 400));
  }

  const customer = await loadGuardedCustomer(req, next);
  if (!customer) return;

  const removed = (customer.documents || []).find((d) => d.url === url);
  if (!removed) {
    return next(new ErrorResponse("Document not found on this customer", 404));
  }

  await Customer.updateOne({ _id: customer._id }, { $pull: { documents: { url } } });

  logEvent({
    req,
    service: "kyc",
    action: "kyc_document_removed",
    customer: customer._id,
    beforeValue: {
      url: removed.url,
      name: removed.name || "",
      docType: removed.docType || "",
    },
  });

  const updated = await Customer.findById(customer._id).select("documents").lean();
  res.status(200).json({
    success: true,
    message: "Document removed",
    data: updated.documents,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// KYC status decisions — merged from customerKycStatusController.
// Manual KYC decision (approve / reject / status change) and per-step review,
// each writing an audit entry. updateOne (not doc.save) so the Customer
// pre-save encryption hooks don't re-process untouched PII fields.
// ═════════════════════════════════════════════════════════════════════════════

const KYC_STATUS_ALLOWED = ["pending", "in_review", "verified", "rejected"];

// @desc   Manually set a customer's KYC status (with audit note)
// @route  PATCH /api/v1/customer/:id/kyc-status
// @access Private (admin, client, branch, manager, officer)
exports.updateCustomerKycStatus = asyncHandler(async (req, res, next) => {
  const { status, note } = req.body || {};

  if (!status || !KYC_STATUS_ALLOWED.includes(status)) {
    return next(new ErrorResponse(`status must be one of: ${KYC_STATUS_ALLOWED.join(", ")}`, 400));
  }
  if (status === "rejected" && !note) {
    return next(new ErrorResponse("note is required when rejecting", 400));
  }

  const customer = await Customer.findById(req.params.id).select(
    "kycStatus kycVerifiedAt kycRejectReason relations",
  );
  if (!customer) {
    return next(new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404));
  }

  // Tenant guard — a client/branch user may only act on customers related to them.
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  if (!customerRelatedToTenant(customer, client, branch)) {
    return next(new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404));
  }

  const prev = customer.kycStatus;
  if (prev === status) {
    return next(new ErrorResponse(`Customer KYC status is already "${status}"`, 400));
  }

  const defaultNotes = {
    verified: "Approved by reviewer",
    rejected: "Rejected by reviewer",
    in_review: "Moved to review",
    pending: "Reset to pending",
  };
  const historyEntry = {
    status,
    note: note || defaultNotes[status],
    changedBy: req.user._id,
    changedAt: new Date(),
  };

  const set = { kycStatus: status };
  if (status === "verified") {
    set.kycVerifiedAt = new Date();
    set.kycRejectReason = null;
  }
  if (status === "rejected") set.kycRejectReason = note;

  await Customer.updateOne(
    { _id: customer._id },
    { $set: set, $push: { kycHistory: historyEntry } },
  );

  logEvent({
    req,
    service: "kyc",
    action: "kyc_status_changed",
    customer: customer._id,
    beforeValue: { kycStatus: prev },
    afterValue: { kycStatus: status },
    ...(note ? { details: note } : {}),
  });

  res.status(200).json({
    success: true,
    message: `Customer KYC ${status}`,
    data: {
      customerId: customer._id,
      prevStatus: prev,
      kycStatus: status,
      kycVerifiedAt: set.kycVerifiedAt ?? customer.kycVerifiedAt,
      kycRejectReason:
        status === "rejected" ? note : status === "verified" ? null : customer.kycRejectReason,
      historyEntry,
    },
  });
});

const STEP_DECISIONS = ["approved", "rejected"];

// @desc   Manually approve/reject a verification journey step (e.g. ID Document)
// @route  PATCH /api/v1/customer/:id/journeys/:journeyId/steps/:stepType/review
// @access Private (admin, client, branch, manager, officer)
exports.reviewJourneyStep = asyncHandler(async (req, res, next) => {
  const { status, note, cascadeSteps } = req.body || {};
  const { id, journeyId, stepType } = req.params;

  if (!status || !STEP_DECISIONS.includes(status)) {
    return next(new ErrorResponse(`status must be one of: ${STEP_DECISIONS.join(", ")}`, 400));
  }
  if (status === "rejected" && !note) {
    return next(new ErrorResponse("note is required when rejecting", 400));
  }
  if (!OnboardingJourney.STEP_TYPES.includes(stepType)) {
    return next(new ErrorResponse(`Unknown step type "${stepType}"`, 400));
  }

  // Optional cascade — apply the same decision to sibling steps in one review
  // (e.g. the UI's combined "ID Document & Selfie" section approves/rejects both).
  const extraSteps = [
    ...new Set(
      (Array.isArray(cascadeSteps) ? cascadeSteps : []).filter(
        (t) => t !== stepType && OnboardingJourney.STEP_TYPES.includes(t),
      ),
    ),
  ];

  // Tenant scope — same journey filter as getCustomer.
  const filter = { _id: journeyId, customer: id };
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  if (client) filter.client = client;
  if (branch) filter.branch = branch;

  const journey = await OnboardingJourney.findOne(filter);
  if (!journey) {
    return next(new ErrorResponse(`Journey not found with id of ${journeyId}`, 404));
  }

  const step = journey.steps.find((s) => s.type === stepType);
  if (!step) {
    return next(new ErrorResponse(`Step "${stepType}" not found on this journey`, 404));
  }
  if (step.status === status) {
    return next(new ErrorResponse(`Step is already "${status}"`, 400));
  }

  // setStepStatus → recordEvent → syncJourneyStatus → save. A manual decision
  // is not a customer attempt, so don't bump the attempt counter.
  await writeJourneyStep(journey, {
    step: stepType,
    status,
    rejectionReason: status === "rejected" ? note : undefined,
    bumpAttempt: false,
    event: {
      action: "manual_review",
      note: note || (status === "approved" ? "Approved by reviewer" : ""),
      actor: req.user._id,
      actorRole: req.user.role || "reviewer",
    },
  });

  // Cascade the same decision to the sibling steps (skip absent steps and
  // steps already in the requested status — the primary decision stands alone).
  const cascaded = [];
  for (const extraType of extraSteps) {
    const extraStep = journey.steps.find((s) => s.type === extraType);
    if (!extraStep || extraStep.status === status) continue;

    await writeJourneyStep(journey, {
      step: extraType,
      status,
      rejectionReason: status === "rejected" ? note : undefined,
      bumpAttempt: false,
      event: {
        action: "manual_review",
        note: `${note || (status === "approved" ? "Approved by reviewer" : "")} (reviewed together with ${stepType})`,
        actor: req.user._id,
        actorRole: req.user.role || "reviewer",
      },
    });
    cascaded.push(extraType);
  }

  logEvent({
    req,
    service: "kyc",
    action: "onboarding_step_reviewed",
    customer: id,
    target: stepType,
    afterValue: {
      status,
      ...(cascaded.length ? { cascadedSteps: cascaded } : {}),
    },
  });

  res.status(200).json({
    success: true,
    message: cascaded.length
      ? `Steps ${[stepType, ...cascaded].join(" + ")} ${status}`
      : `Step ${stepType} ${status}`,
    data: {
      journeyId: journey._id,
      stepType,
      stepStatus: status,
      cascadedSteps: cascaded,
      journeyStatus: journey.status,
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Excel export — merged from customerExportController.
// Professional, fully-populated .xlsx of the Customer queue. Mirrors the queue
// list's tenant scoping + filters; the grouped column model + workbook styling
// live in utils/customerExcelExport.
// ═════════════════════════════════════════════════════════════════════════════

// @desc   Professional Excel export of the customer queue
// @route  GET /api/v1/customer/export
// @access Private (admin, client, branch, manager, officer)
exports.exportCustomers = asyncHandler(async (req, res, next) => {
  // ── Tenant scope + filters (mirror advancedCustomerResultsQueryOnly) ────────
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  const dbQuery = {};
  if (client) dbQuery["relations.client"] = client;
  if (branch) dbQuery["relations.branch"] = branch;

  // default the queue's isActive=true unless explicitly overridden
  dbQuery.isActive = isEmptyExport(req.query.isActive) ? true : req.query.isActive === "true";

  ["kycStatus", "country"].forEach((f) => {
    if (!isEmptyExport(req.query[f])) dbQuery[f] = req.query[f];
  });
  ["isPep", "sanction"].forEach((f) => {
    if (!isEmptyExport(req.query[f])) dbQuery[f] = req.query[f] === "true";
  });
  // relation type — accept both `type` (queue list) and `relationType`
  const relType = req.query.relationType || req.query.type;
  if (!isEmptyExport(relType)) dbQuery["relations.type"] = relType;
  if (!isEmptyExport(req.query.uid)) {
    // Escape user input before it becomes a $regex — see ruleEngineResults.js
    const uid = String(req.query.uid).replace(/^#/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    dbQuery.uid = new RegExp(uid, "i");
  }

  // OR-groups combined via $and so search + email don't clobber each other.
  const andGroups = [];
  // Same decrypted-value matching as the queue list (see
  // advancedCustomerResultsQueryOnly) — only for viewers who may read PII.
  const decryptedSearch = canReadDecrypted();
  if (!isEmptyExport(req.query.q)) {
    const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const orGroup = [
      { "personalKyc.personal_form.customer_details.given_name": rx },
      { "personalKyc.personal_form.customer_details.surname": rx },
      { uid: rx },
    ];
    if (decryptedSearch) {
      const ids = await findIdsByDecryptedKyc(dbQuery, req.query.q, { email: false });
      if (ids.length) orGroup.push({ _id: { $in: ids } });
    }
    andGroups.push({ $or: orGroup });
  }
  if (!isEmptyExport(req.query.email)) {
    // Raw email feeds hashForSearch below — only the regex is escaped
    const email = String(req.query.email).trim();
    const rx = new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const orGroup = [
      { "personalKyc.personal_form.contact_details.email": rx },
      { "metadata.email": rx },
    ];
    if (decryptedSearch) {
      const ids = await findIdsByDecryptedKyc(dbQuery, email, { name: false });
      if (ids.length) orGroup.push({ _id: { $in: ids } });
    }
    // Exact email → match the linked (encrypted) Users record via emailHash.
    try {
      const matched = await User.find({ emailHash: hashForSearch(email) })
        .select("_id")
        .lean();
      if (matched.length) orGroup.push({ user: { $in: matched.map((u) => u._id) } });
    } catch (e) {
      /* fall back to customer-field match */
    }
    andGroups.push({ $or: orGroup });
  }
  if (andGroups.length) dbQuery.$and = andGroups;

  const MAX_ROWS = 10000;
  const docs = await Customer.find(dbQuery)
    .populate([
      { path: "user", select: "name email userName photoUrl userType role" },
      { path: "relations.client", select: "name" },
      { path: "relations.branch", select: "name" },
    ])
    .sort("-createdAt")
    .limit(MAX_ROWS);

  // Decrypt + materialize virtuals; optional in-memory riskLabel filter.
  const role = req.user?.role;
  let rows = docs.map((doc) => {
    const row =
      typeof doc.decryptForRole === "function"
        ? doc.decryptForRole(role)
        : doc.toObject({ virtuals: true });
    // user.name/email are AES-256-GCM encrypted on the Users model; the
    // customer's own decryptForRole doesn't touch the populated subdoc, so
    // decrypt it separately (mirrors getCustomer) for a real Account Email.
    if (doc.user && typeof doc.user.decryptForRole === "function") {
      row.user = doc.user.decryptForRole(role);
    }
    // Primary Client/Branch scoped to the current logged-in tenant.
    row._primaryRelation = pickPrimaryRelation(row.relations, client, branch);
    return row;
  });
  if (!isEmptyExport(req.query.riskLabel)) {
    rows = rows.filter((d) => d.riskLabel === req.query.riskLabel);
  }

  // User Type / Role moved off the Users model into the UserType collection
  // (multi-userType migration). Attach each customer's membership scoped to the
  // current tenant so those columns reflect *this* client/branch's view.
  const userIds = rows.map((r) => r.user?._id).filter(Boolean);
  if (userIds.length) {
    const mFilter = { user: { $in: userIds }, userType: "customer" };
    if (client) mFilter.clientBelongs = client;
    if (branch) mFilter.branchBelongs = branch;
    const memberships = await UserType.find(mFilter)
      .select("user userType role clientBelongs branchBelongs isActive")
      .lean();
    const byUser = new Map();
    memberships.forEach((m) => {
      const k = String(m.user);
      // prefer an active membership when a user has more than one
      if (!byUser.has(k) || (m.isActive && !byUser.get(k).isActive)) {
        byUser.set(k, m);
      }
    });
    rows.forEach((r) => {
      const k = r.user?._id ? String(r.user._id) : null;
      r._membership = k ? byUser.get(k) || null : null;
    });
  }

  // ── Workbook (grouped column model + styling in utils/customerExcelExport) ──
  const activeFilters = ["kycStatus", "country", "isPep", "sanction", "type", "relationType", "riskLabel", "uid", "email", "q"]
    .filter((k) => !isEmptyExport(req.query[k]))
    .map((k) => `${k}=${req.query[k]}`)
    .join("  |  ");

  const wb = buildCustomerWorkbook(rows, {
    recordCount: rows.length,
    capped: docs.length >= MAX_ROWS,
    maxRows: MAX_ROWS,
    activeFilters,
  });

  // ── Stream ──────────────────────────────────────────────────────────────────
  const filename = `customers-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");

  await wb.xlsx.write(res);
  res.end();

  logEvent({
    req,
    service: "privacy",
    action: "customer_data_exported",
    afterValue: { rowCount: rows.length, format: "xlsx" },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// KYC applicant report (PDF) — merged from customerKycExportController.
// Mirrors getCustomer's decryption + journey tenant scoping; the print-grade
// report HTML lives in utils/customerKycReport, streamed via Puppeteer.
// ═════════════════════════════════════════════════════════════════════════════

// @desc   Sumsub-style KYC applicant report (PDF) for one customer
// @route  GET /api/v1/customer/:id/kyc-export
// @access Private (admin, client, branch, manager, officer)
exports.exportCustomerKycPdf = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  const customer = await Customer.findById(req.params.id).populate("user");
  if (!customer) {
    return next(new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404));
  }

  // Tenant guard — a client/branch user may only export customers related to them.
  if (!customerRelatedToTenant(customer, client, branch)) {
    return next(new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404));
  }

  const role = req.user?.role;
  const data = customer.decryptForRole(role);
  if (customer.user && typeof customer.user.decryptForRole === "function") {
    data.user = customer.user.decryptForRole(role);
  }

  // Journeys — same tenant scoping as getCustomer.
  const filter = { customer: req.params.id };
  if (client) filter.client = client;
  if (branch) filter.branch = branch;
  const journeys = await OnboardingJourney.find(filter)
    .populate({ path: "client", select: "name" })
    .populate({ path: "branch", select: "name" })
    .sort({ createdAt: -1 })
    .lean({ virtuals: true });
  const journeyData = journeys.length > 0 ? journeys : [buildSeedJourney(customer)];

  const html = buildKycReportHtml(data, journeyData);

  let browser;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    // networkidle0 lets Cloudinary document/avatar images load; if a remote
    // image hangs, fall back to rendering without waiting on the network.
    try {
      await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    } catch (e) {
      await page.setContent(html, { waitUntil: "domcontentloaded" });
    }
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "12mm", left: "8mm", right: "8mm" },
    });

    const filename = `KYC_Report_${data.uid || data._id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(Buffer.from(pdfBuffer));

    logEvent({
      req,
      service: "privacy",
      action: "customer_kyc_exported",
      customer: customer._id,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Manual import (staff-side, in-branch) — merged from
// customerManualImportController. This handler owns validation, dedupe, create
// and the response; the portal-user/membership/Sumsub/face-verify helpers live
// in services/customerImportService.
// ═════════════════════════════════════════════════════════════════════════════

// @desc    Manually import an individual customer (staff-side, in-branch)
// @route   POST /api/v1/customer/manual-import
// @access  Protected — admin, client, branch, manager, officer
exports.manualImportCustomer = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Onboarding']
  #swagger.summary = 'Manual import of an individual customer (staff-side)'
  #swagger.responses[201] = { description: 'Customer created (Sumsub chain queued)' }
  #swagger.responses[200] = { description: 'Existing customer linked to this tenant' }
  #swagger.responses[409] = { description: 'Customer already exists for this tenant' }
*/
  const body = req.body || {};
  const {
    personalKyc,
    documents = [],
    authorized,
    declaration,
    country,
    notes = "",
    consentToScreen = false,
    runSumsubCheck = true,
    ocr = null,
  } = body;

  // ── 1. Tenant from session (body only honored for tenant-less admin/dooit) ──
  const sessionClientId = req.user?.client?._id || null;
  const sessionBranchId = req.user?.branch?._id || null;

  const clientId = sessionClientId || body.clientId || null;
  if (!clientId) {
    return next(
      new ErrorResponse(
        "No client context — log in under a client/branch or pass clientId (admin only)",
        400,
      ),
    );
  }

  let branchId = sessionBranchId || null;
  if (!branchId && body.branchId) {
    // client-level staff importing for one of their branches — verify ownership
    const branchDoc = await Branch.findById(body.branchId).select("client");
    if (!branchDoc || String(branchDoc.client) !== String(clientId)) {
      return next(new ErrorResponse("Branch not found under this client", 400));
    }
    branchId = branchDoc._id;
  }

  // ── 2. Validate payload ─────────────────────────────────────────────────────
  const pf = personalKyc?.personal_form || {};
  const givenName = pf.customer_details?.given_name?.trim();
  const email = pf.contact_details?.email?.trim().toLowerCase() || null;
  const phone = pf.contact_details?.phone?.trim() || null;
  const identificationNo = pf.identificationNo?.trim() || null;

  if (!givenName) {
    return next(new ErrorResponse("personalKyc.personal_form.customer_details.given_name is required", 400));
  }
  if (!email && !phone) {
    return next(new ErrorResponse("At least one of contact email or phone is required", 400));
  }

  // normalize what we validated back onto the payload
  if (email) pf.contact_details.email = email;

  const docs = (Array.isArray(documents) ? documents : [])
    .filter((d) => d && typeof d.url === "string" && d.url)
    .map((d) => ({
      name: d.name || "",
      url: d.url,
      mimeType: d.mimeType || "",
      type: d.type || "",
      docType: d.docType || "",
      uploadedAt: d.uploadedAt || new Date(),
    }));

  // ── 3. Dedupe ───────────────────────────────────────────────────────────────
  const orConditions = [];
  if (email) orConditions.push({ "personalKyc.personal_form.contact_details.email": email });
  if (phone) orConditions.push({ "personalKyc.personal_form.contact_details.phone": phone });
  if (identificationNo) {
    orConditions.push({ "personalKyc.personal_form.identificationNo": identificationNo });
  }

  let existing = orConditions.length
    ? await Customer.findOne({ $or: orConditions })
    : null;

  // Privacy-encrypted records won't match plaintext queries — catch the ones
  // that have a linked portal user via the deterministic emailHash index.
  if (!existing && email) {
    const linkedUser = await User.findOne({ emailHash: hashForSearch(email) }).select("_id");
    if (linkedUser) existing = await Customer.findOne({ user: linkedUser._id });
  }

  const relationCandidate = {
    client: clientId,
    branch: branchId,
    type: "individual",
    onboardingChannel: "In-Branch",
    registeredAt: new Date(),
    source: "manual",
    notes,
    active: true,
  };

  if (existing) {
    const alreadyLinked = (existing.relations || []).some(
      (r) =>
        String(r.client) === String(clientId) &&
        String(r.branch || "") === String(branchId || ""),
    );

    if (alreadyLinked) {
      return res.status(409).json({
        success: false,
        message: "Customer already exists for this client/branch",
        data: { customerId: existing._id, uid: existing.uid },
      });
    }

    // Known customer, new tenant — append the relation only. Existing KYC data
    // is not overwritten and the Sumsub chain is not re-run.
    existing.relations.push(relationCandidate);
    await existing.save();

    // extend their portal membership to the new tenant (idempotent)
    if (existing.user) {
      await ensureCustomerMembership(existing.user, clientId, branchId, req.user.id);
    }

    const journey = await findOrCreateJourney({
      customerId: existing._id,
      clientId,
      branchId,
      channel: "In-Branch",
      provider: "internal",
    });
    journey.recordEvent({
      action: "manual_import_relation_added",
      note: "Existing customer linked to this client/branch via manual import",
      actor: req.user.id,
      actorRole: req.user.role,
      payload: { customerId: existing._id },
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });
    syncJourneyStatus(journey, { fallbackStatus: "in_progress" });
    await journey.save();

    return res.status(200).json({
      success: true,
      message: "Existing customer linked to this client/branch",
      data: {
        customerId: existing._id,
        uid: existing.uid,
        relationAdded: true,
        sumsub: "skipped",
      },
    });
  }

  // ── 4. Portal user FIRST (link if one already exists), then the customer ───
  const { user: portalUser, created: userCreated } = await findOrCreateCustomerUser({
    email,
    phone,
    displayName: `${givenName} ${pf.customer_details?.surname || ""}`.trim(),
  });
  if (portalUser) {
    await ensureCustomerMembership(portalUser._id, clientId, branchId, req.user.id);

    // Use the customer's uploaded selfie as their portal avatar so the details
    // page shows a real photo instead of the generic placeholder. Never
    // overwrite a photo the user already set — only fill the default/empty one.
    const selfieDoc = docs.find(isSelfieDoc);
    const defaultPhoto = User.schema.paths.photoUrl?.defaultValue || null;
    if (
      selfieDoc?.url &&
      (!portalUser.photoUrl || portalUser.photoUrl === defaultPhoto)
    ) {
      portalUser.photoUrl = selfieDoc.url;
      await portalUser.save();
    }
  }

  const customer = await Customer.create({
    user: portalUser ? portalUser._id : null, // null only for phone-only imports
    relations: [relationCandidate],
    personalKyc,
    documents: docs,
    declaration: declaration || {},
    authorized: authorized || {},
    country: country || pf.residential_address?.country || "",
    consentToScreen: !!consentToScreen,
    isActive: true,
    kycStatus: "pending",
    kycHistory: [
      {
        status: "pending",
        note: "Customer created via staff manual import",
        changedBy: req.user.id,
        changedAt: Date.now(),
      },
    ],
  });

  logEvent({
    req,
    service: "kyc",
    action: "customer_created",
    customer: customer._id,
    details: "manual import",
  });
  recordDevice({ req, purpose: "registration" });

  // ── 5. Real audit journey (not the display-only seed fallback) ──────────────
  const journey = await findOrCreateJourney({
    customerId: customer._id,
    clientId,
    branchId,
    channel: "In-Branch",
    provider: "internal",
  });

  journey.setStepStatus("personal_form", "submitted", {
    data: { source: "manual-import" },
    bumpAttempt: true,
  });
  const idDocs = docs.filter((d) => !isSelfieDoc(d));
  const selfieDocs = docs.filter(isSelfieDoc);

  // Persist the OCR extraction (run in the UI to pre-fill the form) onto the
  // id_document step so the details page can render the "OCR Data" panel —
  // same shape the invite flow writes via onboarding-journey/ocr-document.
  const ocrData =
    ocr && (ocr.fields || ocr.cardType || ocr.detectedType)
      ? {
          cardType: ocr.cardType || null,
          detectedType: ocr.detectedType || null,
          fields: ocr.fields || {},
          checkedAt: new Date(),
        }
      : null;

  if (idDocs.length) {
    journey.setStepStatus("id_document", "submitted", {
      documents: sanitizeDocuments(idDocs),
      ...(ocrData ? { data: { ocr: ocrData } } : {}),
      bumpAttempt: true,
    });
  }
  if (selfieDocs.length) {
    journey.setStepStatus("selfie", "submitted", {
      documents: sanitizeDocuments(selfieDocs),
      bumpAttempt: true,
    });
  }
  journey.recordEvent({
    action: "manual_import",
    status: "submitted",
    note: notes,
    actor: req.user.id,
    actorRole: req.user.role,
    payload: { customerId: customer._id, docCount: docs.length },
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });
  syncJourneyStatus(journey, { fallbackStatus: "in_progress" });
  await journey.save();

  // ── 6. Background verification — staff never waits on the AI providers ───────
  // Face match (ID photo vs selfie) then the Sumsub chain, run sequentially in
  // ONE job so both mutate the same journey without a concurrent-write clash.
  const staffId = req.user.id;
  const faceDocImage =
    idDocs.find((d) => String(d.type).toLowerCase() === "front") || idDocs[0] || null;
  const faceSelfieImage = selfieDocs[0] || null;
  const faceVerifyQueued = !!(faceDocImage && faceSelfieImage);
  const sumsubQueued = runSumsubCheck !== false && docs.length > 0;

  if (faceVerifyQueued || sumsubQueued) {
    runInBackground(`manual-import:verify [${customer._id}]`, async () => {
      if (faceVerifyQueued) {
        await runFaceVerification({
          customer,
          clientId,
          branchId,
          staffId,
          docImage: faceDocImage,
          selfieImage: faceSelfieImage,
        });
      }
      if (sumsubQueued) {
        await runSumsubChain({
          customer,
          clientId,
          branchId,
          staffId,
          documents: docs,
          ocrFields: ocrData?.fields || null,
        });
      }
    });
  }

  return res.status(201).json({
    success: true,
    message: sumsubQueued
      ? "Customer imported — verification queued"
      : "Customer imported — verification skipped",
    data: {
      customerId: customer._id,
      uid: customer.uid,
      userId: portalUser ? portalUser._id : null,
      userCreated,
      kycStatus: customer.kycStatus,
      sumsub: sumsubQueued ? "queued" : "skipped",
      faceVerify: faceVerifyQueued ? "queued" : "skipped",
    },
  });
});
