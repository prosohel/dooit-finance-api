const mongoose = require("mongoose");
const { buildRiskAssessmentFromCustomer } = require("../utils/riskAssessment");
const { hashForSearch } = require("../utils/encryption");
const { canReadDecrypted } = require("../utils/roleEncryptionPlugin");
const { findIdsByDecryptedKyc } = require("../utils/customerSearch");

const isEmpty = (v) =>
    v === undefined || v === null || v === "" || v === "null";

const toBool = (v) => v === "true" || v === true;

// Only stored scalar fields can be sorted at the DB level. Referenced fields
// (user.name) and computed virtuals (riskLabel/riskScore) are excluded.
const SORTABLE = new Set([
    "createdAt",
    "updatedAt",
    "uid",
    "country",
    "kycStatus",
    "sequence",
]);

const parseSort = (raw) => {
    if (isEmpty(raw)) return "-createdAt";
    const field = raw.startsWith("-") ? raw.slice(1) : raw;
    return SORTABLE.has(field) ? raw : "-createdAt";
};

module.exports =
    ({ model, populate = null, searchFields = [] } = {}) =>
        async (req, res, next) => {
            try {
                const client = req?.user?.client?._id || null;
                const branch = req?.user?.branch?._id || null;

                // -----------------------------
                // 1. DB-level filters
                // -----------------------------
                const dbQuery = {};

                // tenant isolation
                if (client) dbQuery["relations.client"] = client;
                if (branch) dbQuery["relations.branch"] = branch;

                // simple indexed filters
                ["kycStatus", "country", "isActive", "isPep", "sanction"].forEach(
                    (field) => {
                        if (!isEmpty(req.query[field])) {
                            dbQuery[field] =
                                field === "isActive" ||
                                    field === "isPep" ||
                                    field === "sanction"
                                    ? toBool(req.query[field])
                                    : req.query[field];
                        }
                    },
                );

                // relation type — accept both `type` (queue list) and `relationType`
                const relType = req.query.relationType ?? req.query.type;
                if (!isEmpty(relType)) dbQuery["relations.type"] = relType;

                if (!isEmpty(req.query.clientId)) {
                    dbQuery["relations.client"] = req.query.clientId;
                }
                if (!isEmpty(req.query.branchId)) {
                    dbQuery["relations.branch"] = req.query.branchId;
                }

                // Customer ID — prefix/contains match (UI strips a leading '#').
                // User input is escaped before it becomes a $regex — see peers
                // like ruleEngineResults.js.
                if (!isEmpty(req.query.uid)) {
                    const uid = String(req.query.uid).replace(/^#/, "").trim();
                    if (uid) dbQuery.uid = new RegExp(uid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
                }

                // -----------------------------
                // 2. OR-group filters (combined via $and so they don't clobber)
                // -----------------------------
                const andGroups = [];

                // KYC name/email are AES-encrypted at rest once the Privacy
                // module encrypts them, so the regexes below only match
                // plaintext rows. Viewers allowed to read decrypted PII also
                // match on decrypted values; masked viewers can't search by a
                // name they can't see. Scoped by dbQuery (tenant + filters).
                const decryptedSearch = canReadDecrypted();

                if (!isEmpty(req.query.q) && searchFields.length) {
                    const regex = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
                    const orGroup = searchFields.map((path) => ({ [path]: regex }));
                    if (decryptedSearch) {
                        const ids = await findIdsByDecryptedKyc(dbQuery, req.query.q, { email: false });
                        if (ids.length) orGroup.push({ _id: { $in: ids } });
                    }
                    andGroups.push({ $or: orGroup });
                }

                // Email filter — the account email lives on the encrypted Users
                // ref (AES-256-GCM) and is looked up by HMAC hash, so an *exact*
                // email matches the linked user via emailHash; partial input still
                // substring-matches the customer's own KYC/metadata email fields.
                if (!isEmpty(req.query.email)) {
                    // Raw email feeds hashForSearch below — only the regex is escaped
                    const email = String(req.query.email).trim();
                    const regex = new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
                    const orGroup = [
                        { "personalKyc.personal_form.contact_details.email": regex },
                        { "metadata.email": regex },
                    ];
                    if (decryptedSearch) {
                        const ids = await findIdsByDecryptedKyc(dbQuery, email, { name: false });
                        if (ids.length) orGroup.push({ _id: { $in: ids } });
                    }
                    try {
                        const User = mongoose.model("Users");
                        const matched = await User.find({ emailHash: hashForSearch(email) })
                            .select("_id")
                            .lean();
                        if (matched.length) {
                            orGroup.push({ user: { $in: matched.map((u) => u._id) } });
                        }
                    } catch (e) {
                        // Users model not registered / hash secret missing — fall back
                        // to the customer-field substring match only.
                    }
                    andGroups.push({ $or: orGroup });
                }

                if (andGroups.length) dbQuery.$and = andGroups;

                // -----------------------------
                // 3. Base mongoose query
                // -----------------------------
                let baseQuery = model.find(dbQuery);
                if (populate) baseQuery = baseQuery.populate(populate);

                // -----------------------------
                // 4. Sorting (whitelisted)
                // -----------------------------
                const sort = parseSort(req.query.sort);
                baseQuery = baseQuery.sort(sort);

                // -----------------------------
                // 5. Pagination
                // -----------------------------
                const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
                const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
                const skip = (page - 1) * limit;

                // -----------------------------
                // 6. In-memory filters (computed risk virtuals)
                // -----------------------------
                const needsMemoryFilter =
                    !isEmpty(req.query.minRiskScore) ||
                    !isEmpty(req.query.maxRiskScore) ||
                    !isEmpty(req.query.riskLabel);

                let totalRecords = 0;
                let results = [];

                if (needsMemoryFilter) {
                    // riskLabel/riskScore are computed (no lean-virtuals plugin), so
                    // fetch the DB-filtered set, compute risk per doc, then filter.
                    const docs = await baseQuery.lean().exec();

                    docs.forEach((doc) => {
                        const ra = buildRiskAssessmentFromCustomer(doc);
                        doc.riskScore = ra.riskScore;
                        doc.riskLabel = ra.riskLabel;
                        doc.riskAssessment = ra.riskAssessment;
                    });

                    const filtered = docs.filter((doc) => {
                        if (
                            !isEmpty(req.query.minRiskScore) &&
                            doc.riskScore < Number(req.query.minRiskScore)
                        )
                            return false;
                        if (
                            !isEmpty(req.query.maxRiskScore) &&
                            doc.riskScore > Number(req.query.maxRiskScore)
                        )
                            return false;
                        if (
                            !isEmpty(req.query.riskLabel) &&
                            doc.riskLabel !== req.query.riskLabel
                        )
                            return false;
                        return true;
                    });

                    totalRecords = filtered.length;
                    results = filtered.slice(skip, skip + limit);
                    // docs are already populated (baseQuery.populate before .lean())
                } else {
                    // DB-level pagination
                    totalRecords = await model.countDocuments(dbQuery);
                    results = await baseQuery.skip(skip).limit(limit);
                }

                // -----------------------------
                // 7. Pagination meta
                // -----------------------------
                const pagination = {};
                if (skip + limit < totalRecords) {
                    pagination.next = { page: page + 1, limit };
                }
                if (skip > 0) {
                    pagination.prev = { page: page - 1, limit };
                }

                // -----------------------------
                // 8. Attach response
                // -----------------------------
                res.advancedResults = {
                    success: true,
                    totalRecords,
                    count: results.length,
                    pagination,
                    data: results,
                };

                next();
            } catch (err) {
                next(err);
            }
        };
