require("./setup");
const { makeStore } = require("./fakes");

const mockConns = makeStore();
jest.mock("../../models/XeroConnection", () => ({
  findById: (id) => mockConns.findById(id),
  updateOne: (f, u) => mockConns.updateOne(f, u),
  findOne: (f) => mockConns.findOne(f),
}));
jest.mock("../../services/xero/syncLog", () => ({ logSync: jest.fn(), hashPayload: jest.fn() }));
jest.mock("../../services/xero/http", () => ({ send: jest.fn(), sleep: jest.fn().mockResolvedValue() }));

const http = require("../../services/xero/http");
const { encrypt, decrypt } = require("../../utils/encryption");
const tokens = require("../../services/xero/tokenService");
const client = require("../../services/xero/client");

const seed = (over = {}) => {
  mockConns.reset();
  tokens.clearCache("conn1");
  mockConns.rows.push({
    _id: "conn1", tenantId: "t1", companyId: "co1", status: "connected",
    refreshToken: encrypt("refresh-OLD"), accessToken: encrypt("access-OLD"),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000), ...over,
  });
};
const tokenResponse = (n) => ({ status: 200, data: { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 1800 } });

beforeEach(() => { jest.clearAllMocks(); seed(); });

describe("token service", () => {
  it("returns the cached access token without calling Xero while it is fresh", async () => {
    expect(await tokens.getAccessToken("conn1")).toBe("access-OLD");
    expect(http.send).not.toHaveBeenCalled();
  });

  it("refreshes when the token is inside the expiry window, rotating + encrypting the refresh token", async () => {
    seed({ expiresAt: new Date(Date.now() + 5_000) }); // < 60s skew
    http.send.mockResolvedValueOnce(tokenResponse(1));
    expect(await tokens.getAccessToken("conn1")).toBe("access-1");

    const sent = http.send.mock.calls[0][0];
    expect(sent.url).toBe("https://identity.xero.com/connect/token");
    expect(sent.data).toContain("grant_type=refresh_token");
    expect(sent.data).toContain("refresh_token=refresh-OLD");

    const row = mockConns.rows[0];
    expect(row.refreshToken).not.toContain("refresh-1");           // never plaintext
    expect(decrypt(row.refreshToken)).toBe("refresh-1");           // rotated
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 25 * 60 * 1000); // expiry recalculated
  });

  it("serialises concurrent refreshes into a single token-endpoint call", async () => {
    seed({ expiresAt: new Date(Date.now() - 1000) });
    http.send.mockResolvedValue(tokenResponse(2));
    const [a, b, c] = await Promise.all([tokens.getAccessToken("conn1"), tokens.getAccessToken("conn1"), tokens.getAccessToken("conn1")]);
    expect([a, b, c]).toEqual(["access-2", "access-2", "access-2"]);
    expect(http.send).toHaveBeenCalledTimes(1);
  });

  it("marks the connection revoked on invalid_grant and tells the caller to reconnect", async () => {
    seed({ expiresAt: new Date(Date.now() - 1000) });
    http.send.mockResolvedValueOnce({ status: 400, data: { error: "invalid_grant" } });
    await expect(tokens.getAccessToken("conn1")).rejects.toMatchObject({ statusCode: 401 });
    expect(mockConns.rows[0]).toMatchObject({ status: "revoked", refreshToken: null });
    await expect(tokens.getAccessToken("conn1")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("refuses to run for a disconnected connection", async () => {
    seed({ status: "disconnected" });
    await expect(tokens.getAccessToken("conn1")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("API client request helper", () => {
  const conn = () => ({ _id: "conn1", tenantId: "t1", status: "connected" });

  it("sends bearer + xero-tenant-id headers", async () => {
    http.send.mockResolvedValueOnce({ status: 200, data: { Contacts: [{ ContactID: "x" }] } });
    const out = await client.getContacts(conn());
    expect(out).toEqual([{ ContactID: "x" }]);
    expect(http.send.mock.calls[0][0].headers).toMatchObject({ Authorization: "Bearer access-OLD", "xero-tenant-id": "t1" });
  });

  it("retries exactly once after a 401 using a refreshed token", async () => {
    http.send
      .mockResolvedValueOnce({ status: 401, data: {} })       // API: expired
      .mockResolvedValueOnce(tokenResponse(3))                 // refresh
      .mockResolvedValueOnce({ status: 200, data: { Invoices: [] } }); // retry
    await client.getInvoices(conn());
    expect(http.send).toHaveBeenCalledTimes(3);
    expect(http.send.mock.calls[2][0].headers.Authorization).toBe("Bearer access-3");
  });

  it("does not loop forever on a persistent 401", async () => {
    http.send
      .mockResolvedValueOnce({ status: 401, data: {} })
      .mockResolvedValueOnce(tokenResponse(4))
      .mockResolvedValueOnce({ status: 401, data: {} });
    await expect(client.getInvoices(conn())).rejects.toMatchObject({ statusCode: 401 });
    expect(http.send).toHaveBeenCalledTimes(3);
  });

  it("honours Retry-After on 429", async () => {
    http.send
      .mockResolvedValueOnce({ status: 429, data: {}, headers: { "retry-after": "2" } })
      .mockResolvedValueOnce({ status: 200, data: { Contacts: [] } });
    await client.getContacts(conn());
    expect(http.sleep).toHaveBeenCalledWith(2000);
  });

  it("retries network failures then reports a 503", async () => {
    http.send.mockRejectedValue(Object.assign(new Error("x"), { code: "ECONNRESET" }));
    await expect(client.getContacts(conn())).rejects.toMatchObject({ statusCode: 503 });
    expect(http.send).toHaveBeenCalledTimes(3);
  });

  it("flags a duplicate-contact validation error", async () => {
    http.send.mockResolvedValueOnce({
      status: 400,
      data: { Elements: [{ ValidationErrors: [{ Message: "The contact name Acme is already assigned to another contact. The contact name must be unique across all active contacts." }] }] },
    });
    await expect(client.createContact(conn(), { Name: "Acme" })).rejects.toMatchObject({ code: "DUPLICATE_CONTACT", statusCode: 400 });
  });

  it("fails fast when no organisation is linked or the connection is gone", async () => {
    await expect(client.getContacts({ _id: "conn1", status: "disconnected" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(client.getContacts({ _id: "conn1", status: "connected", tenantId: null })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("creates never update by accident", () => {
  // Xero's POST /Contacts and /Invoices are create-or-update (contacts match on
  // name), which silently merged same-name customers. Creates must use PUT.
  it("creates contacts and bills with PUT, updates with POST", async () => {
    http.send.mockResolvedValue({ status: 200, data: { Contacts: [{ ContactID: "C" }], Invoices: [{ InvoiceID: "I" }] } });
    await client.createContact("conn1", { Name: "Jane" });
    await client.createInvoice("conn1", { Type: "ACCPAY" });
    await client.updateContact("conn1", "C", { Name: "Jane" });
    expect(http.send.mock.calls.map(([r]) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "PUT /api.xro/2.0/Contacts",
      "PUT /api.xro/2.0/Invoices",
      "POST /api.xro/2.0/Contacts/C",
    ]);
  });
});
