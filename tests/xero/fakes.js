// Minimal in-memory stand-ins for the Mongoose models the Xero services touch,
// so the suite needs no MongoDB. Only the query shapes the code uses are supported.

const match = (doc, filter) =>
  Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      if ("$exists" in v) return (doc[k] !== undefined && doc[k] !== null) === v.$exists;
      if ("$in" in v) return v.$in.map(String).includes(String(doc[k]));
      if ("$ne" in v) return String(doc[k]) !== String(v.$ne);
      if ("$lte" in v) return doc[k] <= v.$lte;
      if ("$gt" in v) return doc[k] > v.$gt;
      return true;
    }
    return String(doc[k]) === String(v);
  });

const makeStore = (uniqueKeys = []) => {
  const rows = [];
  let seq = 0;
  const wrap = (row) => (row ? { ...row, save: async () => row, toObject: () => ({ ...row }) } : null);
  const store = {
    rows,
    reset: () => { rows.length = 0; },
    findOne: (f) => { const r = rows.find((x) => match(x, f)); const p = Promise.resolve(wrap(r)); p.select = () => p; p.lean = () => Promise.resolve(r ? { ...r } : null); return p; },
    findById: (id) => store.findOne({ _id: id }),
    find: async (f) => rows.filter((x) => match(x, f)).map(wrap),
    create: async (doc) => {
      for (const keys of uniqueKeys) {
        if (rows.some((r) => keys.every((k) => String(r[k]) === String(doc[k])))) {
          const e = new Error("E11000 duplicate key"); e.code = 11000; throw e;
        }
      }
      const row = { _id: `id${++seq}`, ...doc }; rows.push(row); return wrap(row);
    },
    updateOne: async (f, u) => {
      const r = rows.find((x) => match(x, f));
      if (!r) return { modifiedCount: 0 };
      Object.assign(r, u.$set || {}); Object.keys(u.$unset || {}).forEach((k) => delete r[k]); return { modifiedCount: 1 };
    },
    deleteOne: async (f) => { const i = rows.findIndex((x) => match(x, f)); if (i >= 0) rows.splice(i, 1); },
    // Like Mongoose: returns the document as it was BEFORE the update unless `new: true`.
    findOneAndUpdate: async (f, u, o = {}) => {
      let r = rows.find((x) => match(x, f));
      const before = r ? { ...r } : null;
      if (!r && o.upsert) { r = { _id: `id${++seq}`, ...Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v !== "object")) }; rows.push(r); }
      if (r) { Object.assign(r, u.$set || {}); Object.keys(u.$unset || {}).forEach((k) => delete r[k]); }
      return wrap(o.new === true ? r : before);
    },
    findOneAndDelete: (f) => {
      const i = rows.findIndex((x) => match(x, f));
      const r = i >= 0 ? rows.splice(i, 1)[0] : null;
      const p = Promise.resolve(r); p.lean = () => Promise.resolve(r); return p;
    },
  };
  return store;
};

module.exports = { makeStore };
