/**
 * Transaction-monitoring seed — the command itself, against an in-memory
 * MongoDB: it writes what it reports, numbers rows from the shared sequence
 * counters, refuses to pile a second batch on by accident, and --clean
 * removes exactly its own rows.
 *
 * MONGO_URI is set in the child's environment, which dotenv does not
 * override; and the client id exists only in the in-memory database, so the
 * command could not write anywhere else even if that ever changed.
 */
const path = require("path");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const API_DIR = path.join(__dirname, "..", "..");
const CLIENT = new mongoose.Types.ObjectId();
const OTHER_CLIENT = new mongoose.Types.ObjectId();
const SMALL = ["--customers=30", "--days=4", "--per-day=120"];

let mongod;
let db;

// Asynchronous on purpose: this process also drains the in-memory mongod's
// log pipe, so blocking it (spawnSync) stalls the database the child talks to.
const run = (args = [], client = CLIENT) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["seeds/seedTmTransactions.js", ...SMALL, `--client=${client}`, ...args], {
      cwd: API_DIR,
      env: { ...process.env, MONGO_URI: mongod.getUri("tm-seed-test") },
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });

const count = (collection, filter = {}) => db.collection(collection).countDocuments(filter);
const mine = { "metadata.source": "seedTmTransactions" };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("tm-seed-test"));
  db = mongoose.connection.db;

  await db.collection("clients").insertMany([{ _id: CLIENT, name: "Test Bank PLC" }, { _id: OTHER_CLIENT, name: "Other Bank" }]);
  await db.collection("branches").insertOne({ client: CLIENT, name: "Test Bank PLC — Head Office", branchCode: "HO-001" });
  await db.collection("ruleengines").insertOne({
    client: null, ruleId: "R1", ruleName: "high_value_tx", ruleCondition: "Amount > 1,000,000", caseType: "Fraud", riskScore: 85, riskLabel: "High",
    appliesTo: "transaction", engine: "predicate", status: "active", deletedAt: null, conditions: [{ field: "amount", operator: "gt", value: 1000000 }],
  });
  // Rows that are not the seed's: they must survive every run and every clean.
  await db.collection("counters").insertOne({ id: "transaction_sequence", reference_value: null, seq: 500 });
  await db.collection("transactions").insertOne({ uid: "TXN_REAL_1", client: CLIENT, amount: 10, currency: "BDT", sequence: 500, metadata: { source: "api" } });
  await db.collection("customers").insertOne({ uid: "CR_REAL_1", relations: [{ client: CLIENT, type: "individual" }], metadata: {} });
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test("--dry-run validates and reports without writing", async () => {
  const { code, out } = await run(["--dry-run"]);
  expect(code).toBe(0);
  expect(out).toMatch(/DRY RUN/);
  expect(out).toMatch(/Detection audit/);
  expect(await count("transactions", mine)).toBe(0);
  expect(await count("customers", mine)).toBe(0);
}, 120000);

test("a run writes customers, accounts and transactions for the client", async () => {
  const { code, out } = await run();
  expect(code).toBe(0);

  const written = Number(/written\s+([\d,]+) transactions/.exec(out)[1].replace(/,/g, ""));
  expect(written).toBeGreaterThan(200);
  expect(await count("transactions", mine)).toBe(written);
  expect(await count("customers", mine)).toBe(30);
  expect(await count("customeraccounts", mine)).toBe(30);
  expect(await count("transactions", { ...mine, client: { $ne: CLIENT } })).toBe(0);

  // Numbered from the shared counter, with no gaps and no reuse.
  const sequences = (await db.collection("transactions").find(mine, { projection: { sequence: 1 } }).toArray()).map((d) => d.sequence).sort((a, b) => a - b);
  expect(sequences[0]).toBe(501);
  expect(sequences[sequences.length - 1]).toBe(500 + written);
  expect((await db.collection("counters").findOne({ id: "transaction_sequence" })).seq).toBe(500 + written);

  // Every party customer is one of the seeded customers; nothing is in the future.
  const ids = new Set((await db.collection("customers").find(mine, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
  const txns = await db.collection("transactions").find(mine).toArray();
  for (const t of txns) {
    for (const party of [t.sender, t.receiver, t.beneficiary]) if (party.customer) expect(ids.has(String(party.customer))).toBe(true);
    expect(t.timestamp.getTime()).toBeLessThan(Date.now());
  }
  expect(txns.some((t) => t.metadata.typology)).toBe(true);
  expect(await count("alerts")).toBe(0);
}, 120000);

test("a second run is refused until --fresh or --append is given", async () => {
  const before = await count("transactions", mine);
  const refused = await run();
  expect(refused.code).toBe(1);
  expect(refused.out).toMatch(/already exist/);
  expect(await count("transactions", mine)).toBe(before);

  expect((await run(["--fresh"])).code).toBe(0);
  expect(await count("customers", mine)).toBe(30);

  expect((await run(["--append", "--seed=9"])).code).toBe(0);
  expect(await count("customers", mine)).toBe(60);
}, 240000);

test("--clean removes the seed's rows and nothing else", async () => {
  const other = await run(["--clean"], OTHER_CLIENT);
  expect(other.code).toBe(0);
  expect(await count("customers", mine)).toBe(60);

  const { code } = await run(["--clean"]);
  expect(code).toBe(0);
  expect(await count("transactions", mine)).toBe(0);
  expect(await count("customers", mine)).toBe(0);
  expect(await count("customeraccounts", mine)).toBe(0);
  expect(await count("transactions", { uid: "TXN_REAL_1" })).toBe(1);
  expect(await count("customers", { uid: "CR_REAL_1" })).toBe(1);
}, 120000);

test("bad arguments stop the run before it connects", async () => {
  const typo = await run(["--dryrun"]);
  expect(typo.code).toBe(1);
  expect(typo.out).toMatch(/Unknown argument/);
  expect((await run(["--days=0"])).out).toMatch(/--days must be a number/);
});
