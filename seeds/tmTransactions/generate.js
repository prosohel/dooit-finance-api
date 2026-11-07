// seeds/tmTransactions/generate.js
//
// Pure generation — no database. Builds the customer cohort up front, then
// yields one Asia/Dhaka day of transactions at a time so a large run never
// holds the whole dataset in memory.

const { createRng } = require("./random");
const { createContext, DAY_MS, dhakaDate, dayStartUtc } = require("./context");
const { buildCohort } = require("./customers");
const { generateBaseline } = require("./baseline");
const { generateTypologies } = require("./typologies");

const DEFAULTS = {
  seed: 20261105,
  customers: 400,
  days: 45,
  perDay: 1000,
  // Share of each day's transactions that belong to a planted typology.
  suspicious: 0.3,
};

/**
 * options: { clientId, branchId, authorId, institution, now, stamp,
 *            [seed, customers, days, perDay, suspicious, until] }
 * `until` is the last Asia/Dhaka date to generate (YYYY-MM-DD, default today).
 * Returns { ctx, cohort, dates, days() } — days() is a generator of
 * { date, txns } with txns sorted by timestamp.
 */
function createGenerator(options) {
  const o = { ...DEFAULTS, ...options };
  const rng = createRng(o.seed);
  const ctx = createContext({
    rng,
    stamp: o.stamp,
    clientId: o.clientId,
    branchId: o.branchId,
    authorId: o.authorId,
    institution: o.institution,
    now: o.now,
  });

  const lastDayStart = dayStartUtc(o.until || dhakaDate(o.now));
  const dates = Array.from({ length: o.days }, (_, i) => dhakaDate(lastDayStart - (o.days - 1 - i) * DAY_MS));
  const cohort = buildCohort(ctx, { count: o.customers, historyStart: dayStartUtc(dates[0]), lastDayStart });

  function* days() {
    for (const date of dates) {
      // Skips days that have not started yet; trims today to what has elapsed.
      if (!ctx.openDay(date)) continue;
      const elapsed = (ctx.day.end - ctx.day.start) / DAY_MS;
      const volume = Math.round(o.perDay * (ctx.isWeekend() ? 0.65 : 1) * (0.92 + rng.float() * 0.16) * elapsed);
      const planted = generateTypologies(ctx, Math.round(volume * o.suspicious));
      generateBaseline(ctx, Math.max(0, volume - planted));
      ctx.day.txns.sort((a, b) => a.timestamp - b.timestamp);
      yield { date, txns: ctx.day.txns };
    }
  }

  return { ctx, cohort, dates, days };
}

module.exports = { createGenerator, DEFAULTS };
