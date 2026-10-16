require("./setup");

// One stored connection row per company, reused across reconnects.
const mockRow = { current: null };
const makeRow = (fields) => {
  const row = {
    ...fields,
    _id: "conn1",
    set(next) { Object.assign(this, next); },
    async save() { return this; },
  };
  return row;
};
jest.mock("../../models/XeroConnection", () => ({
  findOne: jest.fn((f) => {
    if (f.status === "connected") return { lean: async () => null }; // org not taken elsewhere
    return { sort: async () => mockRow.current };
  }),
  create: jest.fn(async (fields) => fields),
}));
jest.mock("../../services/xero/syncLog", () => ({ logSync: jest.fn() }));
jest.mock("../../services/xero/tokenService", () => ({ clearCache: jest.fn(), getAccessToken: jest.fn(), refreshAccessToken: jest.fn(), markRevoked: jest.fn() }));

const { upsertConnection } = require("../../services/xero/client");

const tokens = { accessToken: "AT", refreshToken: "RT", expiresAt: new Date(Date.now() + 1800e3), scopes: [] };
const configured = {
  tenantId: "org-A",
  settings: { billAccountCode: "412", taxType: "INPUT", taxRatePercent: 10, configuredAt: new Date() },
  baseCurrency: "AUD",
  shortCode: "!A",
  lastSyncAt: new Date(),
  lastSyncStatus: "partial",
  lastSyncSummary: { bills: { failed: 1 } },
  outboundCursor: new Date(),
  inboundCursor: new Date(),
};

beforeEach(() => { mockRow.current = makeRow(configured); });

describe("reconnecting a company to Xero", () => {
  it("keeps the mapping and history when the SAME organisation is reconnected", async () => {
    const conn = await upsertConnection({ tokens, tenant: { tenantId: "org-A", tenantName: "A" }, userId: "u1", companyId: "co1" });
    expect(conn.settings.billAccountCode).toBe("412");
    expect(conn.lastSyncStatus).toBe("partial");
    expect(conn.status).toBe("connected");
  });

  it("starts clean for a DIFFERENT organisation: no inherited mapping, cursors or sync state", async () => {
    const conn = await upsertConnection({ tokens, tenant: { tenantId: "org-B", tenantName: "B" }, userId: "u1", companyId: "co1" });
    expect(conn.tenantId).toBe("org-B");
    expect(conn.settings).toEqual({}); // configuredAt gone → nothing is sent until an admin saves settings
    expect(conn).toMatchObject({
      baseCurrency: null, shortCode: null, lastSyncAt: null, lastSyncStatus: "idle",
      lastSyncSummary: null, outboundCursor: null, inboundCursor: null,
    });
  });
});
