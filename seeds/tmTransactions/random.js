// seeds/tmTransactions/random.js
//
// Deterministic random source for the transaction-monitoring seed. Every
// draw goes through one seeded generator, so `--seed=N` reproduces the same
// customers, incidents and amounts run after run (only ids/uids differ).

const round2 = (n) => Math.round(n * 100) / 100;

function createRng(seed = 1) {
  // mulberry32
  let state = seed >>> 0;
  const float = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Integer in [min, max], both inclusive. */
  const int = (min, max) => Math.floor(float() * (max - min + 1)) + min;

  const pick = (list) => list[Math.floor(float() * list.length)];

  const chance = (p) => float() < p;

  /** pairs: [[value, weight], …] */
  const weighted = (pairs) => {
    const total = pairs.reduce((sum, [, w]) => sum + w, 0);
    let roll = float() * total;
    for (const [value, w] of pairs) {
      roll -= w;
      if (roll < 0) return value;
    }
    return pairs[pairs.length - 1][0];
  };

  /** Standard normal (Box–Muller). */
  const normal = () => {
    const u = Math.max(float(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * float());
  };

  /** Log-normal around `median`; sigma ≈ 0.4 is a tight spread, 1.0 a wide one. */
  const logNormal = (median, sigma = 0.5) => median * Math.exp(sigma * normal());

  /** Amount in [min, max] with paisa/cents. */
  const money = (min, max) => round2(min + float() * (max - min));

  const shuffle = (list) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(float() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  const sample = (list, n) => shuffle(list).slice(0, Math.min(n, list.length));

  const digits = (n) => Array.from({ length: n }, () => int(0, 9)).join("");

  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");

  return { float, int, pick, chance, weighted, normal, logNormal, money, shuffle, sample, digits, hex };
}

module.exports = { createRng, round2 };
