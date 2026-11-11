/**
 * Seed the Bangladesh jurisdiction pack (Money Laundering Prevention Act 2012, as amended 2015)
 * into the EWRA GRC collections.
 *
 * Source pack: seed/bangladesh/
 *   pack.json                    — version + metadata
 *   obligations.json             — 44 obligations  (BD-GOV-001 … BD-INT-004)
 *   controls.json                — 14 controls     (BD-CTRL-001 … BD-CTRL-014)
 *   obligation_control_map.json  — 14 obligation ↔ control links
 *
 * Writes (idempotent upserts keyed on obligationId / controlId / obligationId+controlId):
 *   ObligationLibrary, Control, ObligationControlMap
 *
 * IDs are prefixed "BD-" so they never collide with the AU library (GOV-001, AML-001 …).
 * displayId keeps the blueprint ID ("AML-001") for the UI.
 *
 * Run:
 *   node api/seeds/seedBangladeshPack.js             # seed
 *   node api/seeds/seedBangladeshPack.js --dry-run   # validate against schemas only, no DB
 *   node api/seeds/seedAll.js --only=seedBangladeshPack
 */
require("dotenv").config({ path: "./config/config.env" });
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const ObligationLibrary = require("../models/ObligationLibrary");
const Control = require("../models/Control");
const ObligationControlMap = require("../models/ObligationControlMap");
require("colors");

const DRY_RUN = process.argv.includes("--dry-run");
const PACK_DIR = path.resolve(__dirname, "../../seed/bangladesh");

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(PACK_DIR, f), "utf-8"));

const pack = readJson("pack.json");
const obligations = readJson(pack.files.obligations);
const controls = readJson(pack.files.controls);
const mappings = readJson(pack.files.obligation_control_map);

// ── snake_case pack rows → model documents ────────────────────────────────────

const toObligationDoc = (o) => ({
  obligationId: o.obligation_id,
  displayId: o.display_id,
  jurisdiction: o.jurisdiction || pack.jurisdiction,
  category: o.category,
  description: o.description,
  regulatorySource: o.regulatory_source,
  legislativeRef: o.leg_ref,
  addressee: o.addressee || "",
  kind: o.kind || "",
  amended2015: !!o.amended_2015,
  riskCategory: o.risk_category,
  defaultWeight: o.default_weight ?? 0,
  applicableEntityTypes: o.applicable_entity_types || [],
  applicableLicenses: o.applicable_licenses || ["Any"],
  applicableServices: o.applicable_services || ["Any"],
  controlRefs: o.control_refs || [],
  packVersion: pack.version,
  active: true,
});

const toControlDoc = (c) => ({
  controlId: c.control_id,
  displayId: c.display_id,
  jurisdiction: c.jurisdiction || pack.jurisdiction,
  domain: c.domain,
  prefix: c.prefix,
  title: c.title,
  description: c.description,
  controlType: c.control_type,
  automationLevel: c.automation,
  owner: c.owner,
  testingProcedure: c.testing_procedure,
  testingFrequency: c.testing_frequency,
  riskMitigationLevel: c.risk_level,
  fatfRecommendations: c.fatf_recs || [],
  industryTags: c.industry_tags || [],
  obligationRefs: c.obligation_refs || [],
  notes: [c.frequency_literal && c.frequency_literal !== c.testing_frequency ? `Frequency: ${c.frequency_literal}.` : "", c.notes || ""]
    .filter(Boolean)
    .join(" "),
  packVersion: pack.version,
  active: true,
});

const toMapDoc = (m) => ({
  obligationId: m.obligation_id,
  controlId: m.control_id,
  linkType: m.link_type || "Primary",
  mappingNotes: `${pack.pack_id} v${pack.version}: ${m.obligation_display_id} ↔ ${m.control_display_id}`,
});

// ── Pack integrity checks (run before touching the DB) ────────────────────────

function verifyPack() {
  const problems = [];
  const obIds = new Set(obligations.map((o) => o.obligation_id));
  const ctIds = new Set(controls.map((c) => c.control_id));

  if (obIds.size !== obligations.length) problems.push("duplicate obligation_id in obligations.json");
  if (ctIds.size !== controls.length) problems.push("duplicate control_id in controls.json");

  for (const o of obligations) {
    if (!o.obligation_id.startsWith(`${pack.jurisdiction}-`)) problems.push(`${o.obligation_id}: not prefixed ${pack.jurisdiction}-`);
    for (const ref of o.control_refs || []) if (!ctIds.has(ref)) problems.push(`${o.obligation_id}: unknown control ref ${ref}`);
  }
  for (const c of controls) {
    for (const ref of c.obligation_refs || []) if (!obIds.has(ref)) problems.push(`${c.control_id}: unknown obligation ref ${ref}`);
  }
  for (const m of mappings) {
    if (!obIds.has(m.obligation_id)) problems.push(`map: unknown obligation ${m.obligation_id}`);
    if (!ctIds.has(m.control_id)) problems.push(`map: unknown control ${m.control_id}`);
  }

  // Mongoose schema validation (enums, required fields) without a connection
  const validate = (Model, doc, label) => {
    const err = new Model(doc).validateSync();
    if (err) problems.push(`${label}: ${Object.values(err.errors).map((e) => e.message).join("; ")}`);
  };
  obligations.forEach((o) => validate(ObligationLibrary, toObligationDoc(o), o.obligation_id));
  controls.forEach((c) => validate(Control, toControlDoc(c), c.control_id));
  mappings.forEach((m) => validate(ObligationControlMap, toMapDoc(m), `${m.obligation_id}↔${m.control_id}`));

  return problems;
}

async function upsertAll(Model, docs, keyOf, label) {
  let inserted = 0, updated = 0;
  for (const doc of docs) {
    const key = keyOf(doc);
    const existed = await Model.exists(key);
    await Model.findOneAndUpdate(key, { $set: doc }, { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true });
    existed ? updated++ : inserted++;
  }
  console.log(`  ✓ ${label}: ${docs.length} (${inserted} new, ${updated} updated)`.green);
}

async function seed() {
  console.log(`\n${pack.pack_id} v${pack.version} — ${pack.jurisdiction_name}`.cyan.bold);
  console.log(`  ${pack.framework}`.gray);
  console.log(`  obligations=${obligations.length} controls=${controls.length} mappings=${mappings.length}`.gray);

  const problems = verifyPack();
  if (problems.length) {
    console.log(`\n✗ Pack failed verification (${problems.length}):`.red.bold);
    problems.forEach((p) => console.log(`  - ${p}`.red));
    process.exit(1);
  }
  console.log("  ✓ pack verified (ids, cross-refs, schema enums)".green);

  if (DRY_RUN) {
    console.log("\n--dry-run: no database writes.".yellow);
    const byCat = obligations.reduce((a, o) => ((a[o.category] = (a[o.category] || 0) + 1), a), {});
    const byDom = controls.reduce((a, c) => ((a[c.domain] = (a[c.domain] || 0) + 1), a), {});
    console.log(`  obligations by category: ${JSON.stringify(byCat)}`.gray);
    console.log(`  controls by domain:      ${JSON.stringify(byDom)}`.gray);
    process.exit(0);
  }

  await connectDB();
  console.log("Connected to MongoDB".cyan);

  await upsertAll(ObligationLibrary, obligations.map(toObligationDoc), (d) => ({ obligationId: d.obligationId }), "ObligationLibrary");
  await upsertAll(Control, controls.map(toControlDoc), (d) => ({ controlId: d.controlId }), "Control");
  await upsertAll(ObligationControlMap, mappings.map(toMapDoc), (d) => ({ obligationId: d.obligationId, controlId: d.controlId }), "ObligationControlMap");

  const [obCount, ctCount, mapCount] = await Promise.all([
    ObligationLibrary.countDocuments({ jurisdiction: pack.jurisdiction }),
    Control.countDocuments({ jurisdiction: pack.jurisdiction }),
    ObligationControlMap.countDocuments({ obligationId: new RegExp(`^${pack.jurisdiction}-`) }),
  ]);
  console.log(`\n${pack.jurisdiction} totals in DB → obligations ${obCount}, controls ${ctCount}, mappings ${mapCount}`.cyan);

  await mongoose.disconnect();
  console.log("Done. Disconnected.".gray);
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
