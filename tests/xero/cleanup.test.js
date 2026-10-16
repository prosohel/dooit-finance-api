require("./setup");
const { makeStore } = require("./fakes");

const mockConnections = makeStore();
const mockSignups = makeStore();
jest.mock("../../models/XeroConnection", () => ({
  findOne: (f) => mockConnections.findOne(f),
  find: (f) => mockConnections.find(f),
}));
jest.mock("../../models/XeroSignup", () => ({
  find: (f) => mockSignups.find(f),
  updateOne: (f, u) => mockSignups.updateOne(f, u),
}));
jest.mock("../../models/Client", () => ({ findById: jest.fn() }));
jest.mock("../../models/Subscription", () => ({ find: jest.fn() }));
jest.mock("../../services/xero/http", () => ({ send: jest.fn(), sleep: jest.fn() }));
jest.mock("../../services/xero/syncLog", () => ({ logSync: jest.fn() }));

const http = require("../../services/xero/http");
const Client = require("../../models/Client");
const Subscription = require("../../models/Subscription");
const { logSync } = require("../../services/xero/syncLog");
const { encrypt } = require("../../utils/encryption");
const cleanup = require("../../services/xero/connectionCleanup");

const lean = (v) => ({ select: () => ({ lean: async () => v }) });

beforeEach(() => {
  mockConnections.reset();
  mockSignups.reset();
  jest.clearAllMocks();
});

describe("releaseGrant", () => {
  it("refreshes the discarded grant and DELETEs its connection at Xero", async () => {
    http.send
      .mockResolvedValueOnce({ status: 200, data: { access_token: "AT2", refresh_token: "RT2", expires_in: 1800 } })
      .mockResolvedValueOnce({ status: 204 });
    const out = await cleanup.releaseGrant({ tokens: { refreshToken: "RT1" }, tenantId: "t9", connectionId: "conn-9", reason: "test" });
    expect(out.released).toBe(true);
    expect(http.send.mock.calls[1][0]).toMatchObject({ method: "DELETE", url: "https://api.xero.com/connections/conn-9", headers: { Authorization: "Bearer AT2" } });
    expect(logSync).toHaveBeenCalledWith(expect.objectContaining({ action: "release_unused", status: "success" }));
  });

  it("never touches an organisation that is live for a Dooit company", async () => {
    await mockConnections.create({ tenantId: "t9", status: "connected" });
    const out = await cleanup.releaseGrant({ tokens: { refreshToken: "RT1" }, tenantId: "t9", connectionId: "conn-9", reason: "test" });
    expect(out).toMatchObject({ released: false, skipped: "organisation in use" });
    expect(http.send).not.toHaveBeenCalled();
  });

  it("logs (never throws) when the grant is already dead", async () => {
    http.send.mockResolvedValueOnce({ status: 400, data: { error: "invalid_grant" } });
    const out = await cleanup.releaseGrant({ tokens: { refreshToken: "RT1" }, tenantId: "t9", reason: "test" });
    expect(out.released).toBe(false);
    expect(logSync).toHaveBeenCalledWith(expect.objectContaining({ action: "release_unused", status: "failed" }));
  });
});

describe("abandoned sign-ups", () => {
  it("releases only unfinished sign-ups older than the ticket lifetime, once", async () => {
    const old = new Date(Date.now() - cleanup.ABANDONED_SIGNUP_MS - 1000);
    await mockSignups.create({ clientId: null, createdAt: old, refreshToken: encrypt("RT-old"), tenant: { tenantId: "tA", connectionId: "cA" } });
    await mockSignups.create({ clientId: null, createdAt: new Date(), refreshToken: encrypt("RT-new"), tenant: { tenantId: "tB", connectionId: "cB" } });
    await mockSignups.create({ clientId: "client-1", createdAt: old, refreshToken: encrypt("RT-done"), tenant: { tenantId: "tC", connectionId: "cC" } });
    http.send
      .mockResolvedValueOnce({ status: 200, data: { access_token: "AT", refresh_token: "RT", expires_in: 1800 } })
      .mockResolvedValueOnce({ status: 204 });

    expect(await cleanup.releaseAbandonedSignups()).toBe(1);
    expect(http.send.mock.calls[1][0].url).toMatch(/\/connections\/cA$/);
    expect(mockSignups.rows[0].refreshToken).toBeUndefined(); // tokens wiped
    expect(await cleanup.releaseAbandonedSignups()).toBe(0); // nothing left to release
  });
});

describe("off-boarding", () => {
  it("disconnects deactivated companies and companies whose subscriptions have all ended", async () => {
    await mockConnections.create({ tenantId: "t1", companyId: "inactive", status: "connected" });
    await mockConnections.create({ tenantId: "t2", companyId: "ended", status: "connected" });
    await mockConnections.create({ tenantId: "t3", companyId: "paying", status: "connected" });
    await mockConnections.create({ tenantId: "t4", companyId: "trial", status: "connected" });
    Client.findById.mockImplementation((id) => lean({ status: id === "inactive" ? "Inactive" : "Active" }));
    Subscription.find.mockImplementation(({ client }) => lean(
      client === "ended" ? [{ status: "cancelled" }, { status: "expired" }]
        : client === "paying" ? [{ status: "expired" }, { status: "active" }]
          : []
    ));
    const disconnect = jest.fn(async () => ({}));

    expect(await cleanup.disconnectOffboarded(disconnect)).toBe(2);
    expect(disconnect.mock.calls.map(([c, o]) => [c.companyId, o.reason])).toEqual([
      ["inactive", "company_inactive"],
      ["ended", "subscription_ended"],
    ]);
  });
});
