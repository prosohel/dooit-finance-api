/**
 * seedAll.js — Fresh-DB reference-data orchestrator
 *
 * Runs every production reference seeder in dependency order, each as its own
 * child process (the individual seeders manage their own Mongo connection and
 * call process.exit / mongoose.disconnect, so they can't share one process).
 *
 * Run from anywhere:
 *   node api/seeds/seedAll.js
 *   node seeds/seedAll.js            (from inside api/)
 *
 * Flags:
 *   --stop            Stop on the first seeder that fails (default: continue).
 *   --only=a,b,c      Run only the named seeders (by file stem, e.g. seedControls).
 *   --list            Print the ordered seeder list and exit.
 *
 * NOT included (run manually when needed):
 *   - bootstrapAdmin.js  — creates the first admin (needs credentials).
 *   - seedAMLTemplates.js — needs docs/amldocs/*.docx + FileVault + LibreOffice.
 *   - seedRiskData.js    — legacy CRA writer; superseded by seedCountryRisk + seedRiskFactors.
 *   - *AlertSeeder.js    — demo/sample data, not for production.
 *   - Risk pool / control assignments — seed via POST /risk-pool/seed and
 *                                       POST /control-assignments/seed after boot.
 *
 * After this finishes, RESTART the API so loadRiskCache() picks up CountryRisk
 * and RiskFactorOption.
 */
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
require("colors");

// api/ root — child seeders that load "./config/config.env" relatively need this as cwd.
const API_DIR = path.resolve(__dirname, "..");

// Ordered by dependency: entity types → controls → obligations(ref controls) →
// CRA(country/factors) → EWRA(config/factors) → operations(rules/templates/questions).
const SEEDERS = [
  ["seedEntityTypes",        "Entity / License / Designated-Service types (foundational)"],
  ["seedControls",           "Controls library (~181 controls)"],
  ["seedObligations",        "Obligation library (~145, references control IDs)"],
  ["seedBangladeshPack",     "Bangladesh MLPA 2012 pack: 44 obligations + 14 controls + map (seed/bangladesh)"],
  ["seedCountryRisk",        "Country risk register (~201 jurisdictions, CRA)"],
  ["seedRiskFactors",        "CRA V2 RiskFactorOptions (+ product scores)"],
  ["seedEntityConfig",       "EWRA EntityConfig (risk pool config)"],
  ["seedEwraFactors",        "EWRA risk factors (21)"],
  ["seedMonitoringRules",    "Ongoing-monitoring rules (19)"],
  ["seedNotificationRules",  "Notification-engine rules (47)"],
  ["seedRapTemplates",       "Remediation Action Plan templates (17)"],
  ["seedOnboardingQuestions","Onboarding questionnaire (38)"],
];

function parseArgs(argv) {
  const opts = { stop: false, only: null, list: false };
  for (const a of argv) {
    if (a === "--stop") opts.stop = true;
    else if (a === "--list") opts.list = true;
    else if (a.startsWith("--only=")) {
      opts.only = a.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  let plan = SEEDERS;
  if (opts.only) {
    plan = SEEDERS.filter(([file]) => opts.only.includes(file));
    const unknown = opts.only.filter((o) => !SEEDERS.some(([file]) => file === o));
    if (unknown.length) {
      console.log(`Unknown seeder(s): ${unknown.join(", ")}`.red);
      console.log(`Valid names: ${SEEDERS.map(([f]) => f).join(", ")}`.gray);
      process.exit(1);
    }
  }

  if (opts.list) {
    console.log("\nSeed order:".cyan.bold);
    plan.forEach(([file, desc], i) =>
      console.log(`  ${String(i + 1).padStart(2)}. ${file.padEnd(24)} ${desc}`.gray)
    );
    console.log("");
    return;
  }

  console.log("\n=== seedAll: fresh-DB reference data ===".cyan.bold);
  console.log(`api dir: ${API_DIR}`.gray);
  console.log(`mode:    ${opts.stop ? "stop on first error" : "continue on error"}\n`.gray);

  const results = [];
  for (const [file, desc] of plan) {
    const scriptPath = path.join(__dirname, `${file}.js`);
    console.log(`\n▶ ${file}`.yellow.bold + `  — ${desc}`.gray);

    const res = spawnSync(process.execPath, [scriptPath], {
      cwd: API_DIR,
      stdio: "inherit",
    });

    const ok = res.status === 0 && !res.error;
    results.push({ file, ok, code: res.status, error: res.error });

    if (ok) {
      console.log(`✓ ${file} done`.green);
    } else {
      console.log(`✗ ${file} FAILED (exit ${res.status})`.red + (res.error ? ` ${res.error.message}` : ""));
      if (opts.stop) break;
    }
  }

  // Summary
  const failed = results.filter((r) => !r.ok);
  console.log("\n=== Summary ===".cyan.bold);
  for (const r of results) {
    console.log(`  ${r.ok ? "✓".green : "✗".red} ${r.file}`);
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} seeders succeeded.`[failed.length ? "yellow" : "green"]
  );

  if (failed.length) {
    console.log(`\nRe-run the failed ones individually, e.g.:`.gray);
    console.log(`  node seeds/${failed[0].file}.js`.gray);
  } else {
    console.log(`\nNext steps:`.cyan);
    console.log(`  1. node seeds/bootstrapAdmin.js --email you@dooit.ai --password '...'`.gray);
    console.log(`  2. Restart the API so loadRiskCache() reloads.`.gray);
  }

  process.exit(failed.length ? 1 : 0);
}

main();
