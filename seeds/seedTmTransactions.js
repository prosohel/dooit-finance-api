/**
 * Seeds transaction-monitoring demo data: a customer cohort with a 30-day+
 * transaction history, and suspicious activity planted on every day of it.
 *
 * It exists to feed the AFC Transaction Monitoring service (ui/api-doc.pdf),
 * which scans the previous Asia/Dhaka day of `transactions` each night and
 * turns what it finds into AI alerts and cases — the "AI Generated Alerts"
 * tab, and the AI-origin rows in the "Alerts" tab. That service needs three
 * things from the data, and this seed provides each:
 *
 *   • history    every customer has a baseline (amounts, frequency, payees),
 *                so the ML/DL models have a training window and a z-score or
 *                frequency change means something;
 *   • typologies 20 kinds of incident — structuring, velocity bursts, fan-in /
 *                fan-out, pass-through mules, layering, high-risk corridors,
 *                crypto exposure … — written with the Rule Engine's own
 *                constants so its conditions match (seeds/tmTransactions/typologies.js);
 *   • recency    activity on every day up to now, so whichever day a run
 *                scans has something to flag. Nothing is dated in the future.
 *
 * This script writes Customers, CustomerAccounts and Transactions only. It
 * does NOT create alerts or cases — detecting is the monitoring service's
 * job, and pre-made alerts would hide whether it works.
 *
 * Usage (run from api/):
 *   node seeds/seedTmTransactions.js --dry-run          generate, validate and report; write nothing
 *   node seeds/seedTmTransactions.js                    400 customers · 45 days · ~1,000 txns/day
 *   node seeds/seedTmTransactions.js --client=<id>      target another client (default: Prime Bank PLC)
 *   node seeds/seedTmTransactions.js --customers=800 --days=60 --per-day=2500
 *   node seeds/seedTmTransactions.js --suspicious=0.4   share of each day planted as typologies (default 0.3)
 *   node seeds/seedTmTransactions.js --until=2026-11-04 last Asia/Dhaka day to generate (default: today)
 *   node seeds/seedTmTransactions.js --seed=7           different random dataset (same seed → same data)
 *   node seeds/seedTmTransactions.js --fresh            remove this seed's earlier rows for the client, then seed
 *   node seeds/seedTmTransactions.js --append           add another batch next to an earlier one
 *   node seeds/seedTmTransactions.js --clean            remove this seed's rows for the client and exit
 *   node seeds/seedTmTransactions.js --export=<dir>     also write customers/accounts/transactions as
 *                                                       mongoimport-ready NDJSON (works with --dry-run)
 *   node seeds/seedTmTransactions.js --report=<file>    write the audit report as JSON
 *   node seeds/seedTmTransactions.js --no-audit         skip the rule/collective audit (faster on huge runs)
 *
 * Everything written carries metadata.source = "seedTmTransactions" and a uid
 * containing "TMDEMO"; that marker is how --fresh / --clean find it. The uids
 * deliberately do not contain "SEED", which seedCaseWorkflow's --clean would
 * match. No other document is touched.
 *
 * After seeding, ask the monitoring service to scan:
 *   POST {TM_API_URL}/runs/monitoring      (scans the previous Asia/Dhaka day)
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "config", "config.env"), quiet: true });

const mongoose = require("mongoose");
// loadRiskCache() and several models log through the colors String extensions.
require("colors");

const Client = require("../models/Client");
const Branch = require("../models/Branch");
const User = require("../models/User");
const Customer = require("../models/Customer");
const CustomerAccount = require("../models/CustomerAccount");
const Transaction = require("../models/Transaction");
const RuleEngine = require("../models/RuleEngine");
const ruleEvaluation = require("../services/ruleEvaluation");

const { SOURCE, DEFAULT_CLIENT, HOME } = require("./tmTransactions/reference");
const { createGenerator, DEFAULTS } = require("./tmTransactions/generate");
const { createAudit } = require("./tmTransactions/audit");
const { CATALOGUE } = require("./tmTransactions/typologies");
const { dhakaDate, dayStartUtc } = require("./tmTransactions/context");

// ── Arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const FLAGS = ["dry-run", "fresh", "append", "clean", "no-audit", "help"];
const OPTIONS = ["client", "customers", "days", "per-day", "suspicious", "until", "seed", "export", "report"];

const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  // Last one wins, so a wrapper script's defaults can be overridden.
  const hit = [...argv].reverse().find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

function readArgs() {
  for (const arg of argv) {
    const name = arg.replace(/^--/, "").split("=")[0];
    const known = arg.includes("=") ? OPTIONS.includes(name) : FLAGS.includes(name);
    if (!arg.startsWith("--") || !known) throw new Error(`Unknown argument: ${arg} (see --help)`);
  }

  const number = (name, fallback, min, max) => {
    const raw = option(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`--${name} must be a number between ${min} and ${max}`);
    }
    return value;
  };

  const until = option("until");
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error("--until must be YYYY-MM-DD");

  return {
    dryRun: flag("dry-run"),
    fresh: flag("fresh"),
    append: flag("append"),
    clean: flag("clean"),
    audit: !flag("no-audit"),
    clientId: option("client") || DEFAULT_CLIENT,
    customers: Math.round(number("customers", DEFAULTS.customers, 20, 20000)),
    days: Math.round(number("days", DEFAULTS.days, 1, 366)),
    perDay: Math.round(number("per-day", DEFAULTS.perDay, 10, 200000)),
    suspicious: number("suspicious", DEFAULTS.suspicious, 0, 0.9),
    seed: Math.round(number("seed", DEFAULTS.seed, 0, 2 ** 31)),
    until,
    exportDir: option("export"),
    reportFile: option("report"),
  };
}

// ── Output helpers ───────────────────────────────────────────────────────────

const hr = "─".repeat(78);
const fmt = (n) => Number(n).toLocaleString("en-US");
const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");
const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

/** Host and database of the connection string, without credentials. */
const describeTarget = (uri) => {
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)\/?([^?]*)/.exec(uri || "");
  return m ? `${m[2] || "(default db)"} @ ${m[1]}` : "(unparseable MONGO_URI)";
};

// ── Sequences ────────────────────────────────────────────────────────────────
// `sequence` is filled by mongoose-sequence in a pre-save hook, which
// insertMany does not run. Reserve a block on the plugin's own counter so
// seeded rows are numbered like any others and later saves carry on after them.

async function reserveSequence(id, count) {
  const counters = mongoose.connection.db.collection("counters");
  const after = await counters.findOneAndUpdate(
    { id, reference_value: null },
    { $inc: { seq: count } },
    { upsert: true, returnDocument: "after" }
  );
  const doc = after && after.value !== undefined ? after.value : after;
  return doc.seq - count + 1;
}

// ── Clean ────────────────────────────────────────────────────────────────────

/**
 * Removes what this seed wrote for one client. Alerts, cases and monitoring
 * results the service derived from those transactions belong to the service
 * and are only counted, so the operator knows they are now orphaned.
 */
async function clean(clientId) {
  const db = mongoose.connection.db;
  const txnFilter = { client: clientId, "metadata.source": SOURCE };
  const ids = (await Transaction.collection.find(txnFilter, { projection: { _id: 1 } }).toArray()).map((d) => d._id);

  let alerts = 0;
  let results = 0;
  const hasResults = (await db.listCollections({ name: "transaction-monitoring-ai-results" }).toArray()).length > 0;
  for (let i = 0; i < ids.length; i += 20000) {
    const chunk = ids.slice(i, i + 20000);
    alerts += await db.collection("alerts").countDocuments({ transaction: { $in: chunk } });
    if (hasResults) {
      results += await db
        .collection("transaction-monitoring-ai-results")
        .countDocuments({ transactionId: { $in: [...chunk, ...chunk.map(String)] } });
    }
  }

  const removed = {
    transactions: (await Transaction.deleteMany(txnFilter)).deletedCount,
    accounts: (await CustomerAccount.deleteMany({ client: clientId, "metadata.source": SOURCE })).deletedCount,
    customers: (await Customer.deleteMany({ "relations.client": clientId, "metadata.source": SOURCE })).deletedCount,
  };
  console.log("\n  Removed this seed's rows:");
  for (const [name, n] of Object.entries(removed)) line(`  − ${name}`, fmt(n));
  if (alerts || results) {
    console.log("\n  Left in place (created by the monitoring service from those transactions):");
    if (alerts) line("  alerts", fmt(alerts));
    if (results) line("  monitoring results", fmt(results));
  }

  const elsewhere = await Transaction.countDocuments({ "metadata.source": SOURCE });
  if (elsewhere) line("\n  Still present for other clients", `${fmt(elsewhere)} transactions`);
}

// ── Export ───────────────────────────────────────────────────────────────────

function createExporter(dir) {
  if (!dir) return null;
  const { EJSON } = mongoose.mongo.BSON;
  fs.mkdirSync(dir, { recursive: true });
  const streams = {};
  const write = (name, docs) => {
    streams[name] = streams[name] || fs.createWriteStream(path.join(dir, `${name}.ndjson`));
    // Canonical-enough Extended JSON: `mongoimport --collection <name>` restores ids and dates.
    for (const doc of docs) streams[name].write(`${EJSON.stringify(doc, { relaxed: true })}\n`);
  };
  const close = () => Promise.all(Object.values(streams).map((s) => new Promise((done) => s.end(done))));
  return { write, close, dir: path.resolve(dir) };
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Runs schema validation (and pre-validate hooks) without saving. */
async function validateAll(Model, docs, label) {
  for (let i = 0; i < docs.length; i += 500) {
    await Promise.all(
      docs.slice(i, i + 500).map((doc) =>
        new Model(doc).validate().catch((err) => {
          throw new Error(`${label} ${doc.uid} failed validation: ${err.message}`);
        })
      )
    );
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

function printReport(report, catalogue) {
  console.log(`\n${hr}\n  Detection audit — how the generated data reads to the rule corpus\n${hr}`);
  line("transactions", fmt(report.transactions));
  line("planted in a typology", `${fmt(report.planted)}  (${pct(report.planted, report.transactions)})`);
  line("rules evaluated", fmt(report.rulesEvaluated));
  line("predicted High / Critical", `${fmt(report.predicted.high)}  (${pct(report.predicted.high, report.transactions)})`);
  line("  of planted transactions", `${fmt(report.predicted.plantedHigh)}  (${pct(report.predicted.plantedHigh, report.planted)})`);
  line("  of ordinary transactions", `${fmt(report.predicted.baselineHigh)}  (${pct(report.predicted.baselineHigh, report.baseline)})`);
  line("highest label per transaction", Object.entries(report.predicted.byLabel).map(([k, v]) => `${k} ${fmt(v)}`).join(" · "));

  console.log("\n  By typology                         incidents    txns   High+   leading evidence");
  for (const t of catalogue) {
    const row = report.byTypology[t.key];
    if (!row) continue;
    console.log(
      `  ${t.key.padEnd(26)} ${t.caseType.padEnd(6)} ${String(row.incidents).padStart(8)} ${String(row.txns).padStart(7)} ${pct(row.high, row.txns).padStart(7)}   ${row.topRules.join(", ")}`
    );
  }
  const gap = report.byTypology.kyc_profile_gap;
  if (gap) {
    console.log(`  ${"kyc_profile_gap".padEnd(26)} ${"Fraud".padEnd(6)} ${"—".padStart(8)} ${String(gap.txns).padStart(7)} ${pct(gap.high, gap.txns).padStart(7)}   ${gap.topRules.join(", ")}`);
  }

  console.log("\n  Rules that fired most");
  for (const r of report.topRules.slice(0, 18)) {
    console.log(`  ${r.ruleId.padEnd(8)} ${String(r.ruleName || "").slice(0, 34).padEnd(34)} ${String(r.riskLabel).padEnd(9)} ${fmt(r.count).padStart(8)}`);
  }
  console.log(`  … ${report.topRules.length} rules fired in total`);

  console.log("\n  Collective signals (thresholds are this audit's, not the service's)");
  for (const s of report.collectiveSignals) console.log(`  ${s.id.padEnd(14)} ${fmt(s.count).padStart(8)}   ${s.text}`);

  if (report.broadRules.length) {
    console.log("\n  Rules firing on more than 20% of ordinary traffic (excluded from the figures above)");
    for (const r of report.broadRules) console.log(`  ${r.ruleId.padEnd(14)} ${String(r.ruleName || "").slice(0, 34).padEnd(34)} ${fmt(r.count).padStart(8)}`);
  }

  if (report.ordinaryReasons.length) {
    console.log("\n  Why ordinary transactions reached High (a customer stays hot after an incident)");
    console.log(`  ${report.ordinaryReasons.map((r) => `${r.id} ${fmt(r.count)}`).join(" · ")}`);
  }

  console.log("\n  Last 7 days (Asia/Dhaka)            total   planted   predicted High+");
  for (const [date, d] of Object.entries(report.byDay).slice(-7)) {
    console.log(`  ${date.padEnd(30)} ${fmt(d.total).padStart(9)} ${fmt(d.planted).padStart(9)} ${fmt(d.high).padStart(11)}`);
  }

  console.log("\n  Amount by currency");
  for (const [cur, v] of Object.entries(report.amountByCurrency)) {
    console.log(`  ${cur.padEnd(6)} ${fmt(v.count).padStart(9)} txns   ${fmt(v.sum).padStart(22)}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

let wroteAnything = false;

async function main() {
  if (flag("help")) {
    const header = fs.readFileSync(__filename, "utf8").split("*/")[0];
    console.log(header.replace(/^\/\*\*\n?/, "").replace(/^ \* ?/gm, ""));
    return;
  }
  const args = readArgs();
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set (config/config.env)");
  if (!mongoose.Types.ObjectId.isValid(args.clientId)) throw new Error(`--client is not a valid ObjectId: ${args.clientId}`);

  const now = Date.now();
  if (args.until && dayStartUtc(args.until) > now) throw new Error(`--until ${args.until} has not started yet in ${HOME.timezone}`);

  console.log(`\n${hr}\n  Transaction-monitoring seed${args.dryRun ? "  —  DRY RUN, nothing will be written" : ""}\n${hr}`);
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  line("database", describeTarget(process.env.MONGO_URI));

  const clientId = new mongoose.Types.ObjectId(args.clientId);
  const client = await Client.findById(clientId).select("name user").lean();
  if (!client) throw new Error(`Client not found: ${args.clientId}`);
  line("client", `${client.name || "(unnamed)"}  ${args.clientId}`);

  if (args.clean) {
    await clean(clientId);
    console.log("\n  Clean complete.\n");
    return;
  }

  const existing = await Transaction.countDocuments({ client: clientId, "metadata.source": SOURCE });
  if (existing && !args.fresh && !args.append && !args.dryRun) {
    throw new Error(
      `${fmt(existing)} transactions from an earlier run of this seed already exist for this client.\n` +
        `  Pass --fresh to replace them, --append to add another batch, or --clean to remove them.`
    );
  }
  if (existing && args.fresh && !args.dryRun) await clean(clientId);

  const branch = await Branch.findOne({ client: clientId }).select("_id name").lean();
  line("branch", branch ? branch.name : "(none — transactions will carry no branch)");

  const author = (client.user && (await User.findById(client.user).select("_id").lean())) || (await User.findOne().select("_id").lean());

  const rules = args.audit
    ? await RuleEngine.find({
        deletedAt: null,
        status: "active",
        appliesTo: "transaction",
        engine: { $in: ["predicate", "aggregate"] },
        $or: [{ client: null }, { client: clientId }],
      }).lean()
    : [];

  const generator = createGenerator({
    seed: args.seed,
    customers: args.customers,
    days: args.days,
    perDay: args.perDay,
    suspicious: args.suspicious,
    until: args.until,
    now,
    stamp: now,
    clientId,
    branchId: branch ? branch._id : null,
    authorId: author ? author._id : null,
    institution: client.name || "Dooit Bank",
  });
  const { cohort, dates, ctx } = generator;
  line("period", `${dates[0]} → ${dates[dates.length - 1]}  (${dates.length} days, ${HOME.timezone})`);
  line("customers", `${fmt(cohort.customers.length)}  (seed ${args.seed})`);
  line("batch", String(ctx.stamp));

  const exporter = createExporter(args.exportDir);
  const audit = args.audit ? createAudit({ rules, ruleEvaluation, profilesById: ctx.profilesById }) : null;

  // ── Customers and accounts ──
  await validateAll(Customer, cohort.customers, "Customer");
  await validateAll(CustomerAccount, cohort.accounts, "CustomerAccount");
  if (!args.dryRun) {
    wroteAnything = true;
    let seq = await reserveSequence("customer_sequence", cohort.customers.length);
    for (const doc of cohort.customers) doc.sequence = seq++;
    seq = await reserveSequence("customer_account_sequence", cohort.accounts.length);
    for (const doc of cohort.accounts) doc.sequence = seq++;
    await Customer.insertMany(cohort.customers, { ordered: true });
    await CustomerAccount.insertMany(cohort.accounts, { ordered: true });
  }
  if (exporter) {
    exporter.write("customers", cohort.customers);
    exporter.write("customeraccounts", cohort.accounts);
  }

  // ── Transactions, one day at a time ──
  let written = 0;
  const lastActivity = new Map();
  process.stdout.write("\n  ");
  for (const { date, txns } of generator.days()) {
    if (audit) audit.observe(date, txns);
    if (args.dryRun) {
      await validateAll(Transaction, txns, "Transaction");
    } else {
      let seq = await reserveSequence("transaction_sequence", txns.length);
      for (const doc of txns) doc.sequence = seq++;
      for (let i = 0; i < txns.length; i += 1000) {
        await Transaction.insertMany(txns.slice(i, i + 1000), { ordered: true });
      }
    }
    if (exporter) exporter.write("transactions", txns);
    for (const doc of txns) {
      for (const party of [doc.sender, doc.receiver]) {
        if (party && party.customer) lastActivity.set(String(party.customer), doc.timestamp);
      }
    }
    written += txns.length;
    process.stdout.write(`${date.slice(5)} `);
  }
  console.log();

  // Accounts show when they were last used.
  if (!args.dryRun && lastActivity.size) {
    const ops = [...lastActivity].map(([customer, at]) => ({
      updateOne: { filter: { customer: new mongoose.Types.ObjectId(customer), "metadata.source": SOURCE }, update: { $set: { lastActivityAt: at } } },
    }));
    for (let i = 0; i < ops.length; i += 1000) await CustomerAccount.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
  }
  if (exporter) await exporter.close();

  // ── Summary ──
  const report = audit ? audit.report() : null;
  if (report) printReport(report, CATALOGUE);
  if (report && args.reportFile) {
    fs.mkdirSync(path.dirname(path.resolve(args.reportFile)), { recursive: true });
    fs.writeFileSync(args.reportFile, JSON.stringify({ generatedAt: new Date(now).toISOString(), args, period: { from: dates[0], to: dates[dates.length - 1] }, ...report }, null, 2));
  }

  console.log(`\n${hr}`);
  line(args.dryRun ? "validated (not written)" : "written", `${fmt(written)} transactions · ${fmt(cohort.customers.length)} customers · ${fmt(cohort.accounts.length)} accounts`);
  if (exporter) line("exported to", exporter.dir);
  if (report && args.reportFile) line("report", path.resolve(args.reportFile));
  if (!args.dryRun) {
    const scanned = dhakaDate(dayStartUtc(dhakaDate(now)) - 1);
    console.log(`\n  Next: POST {TM_API_URL}/runs/monitoring — a run started now scans ${scanned} (${HOME.timezone}).`);
    console.log(`  Undo: node seeds/seedTmTransactions.js --clean --client=${args.clientId}`);
  }
  console.log(`${hr}\n`);
}

main()
  .catch((err) => {
    console.error(`\n  ✗ ${err.message}\n`);
    if (wroteAnything) console.error("  The run stopped part-way. Remove what it wrote with --clean, then try again.\n");
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
