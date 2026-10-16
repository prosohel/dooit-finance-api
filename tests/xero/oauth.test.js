require("./setup");
const { makeStore } = require("./fakes");

const mockStates = makeStore();
jest.mock("../../models/XeroOAuthState", () => ({
  create: (d) => mockStates.create(d),
  findOneAndDelete: (f) => mockStates.findOneAndDelete(f),
}));
jest.mock("../../services/xero/syncLog", () => ({ logSync: jest.fn(), hashPayload: jest.fn() }));
jest.mock("../../services/xero/client", () => ({ connect: jest.fn(), disconnect: jest.fn() }));

const oauth = require("../../services/xero/oauth");
const xeroClient = require("../../services/xero/client");
const controller = require("../../controllers/xeroController");

beforeEach(() => { mockStates.reset(); jest.clearAllMocks(); });

describe("OAuth state", () => {
  it("issues a high-entropy state and stores only its hash", async () => {
    const state = await oauth.createState("u1", "c1");
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(mockStates.rows[0].stateHash).toBe(oauth.sha256(state));
    expect(JSON.stringify(mockStates.rows)).not.toContain(state);
  });

  it("consumes a state exactly once (replay is rejected)", async () => {
    const state = await oauth.createState("u1", "c1");
    expect(await oauth.consumeState(state)).toMatchObject({ userId: "u1", companyId: "c1" });
    expect(await oauth.consumeState(state)).toBeNull();
  });

  it("rejects unknown, empty and oversized states", async () => {
    expect(await oauth.consumeState("nope")).toBeNull();
    expect(await oauth.consumeState("")).toBeNull();
    expect(await oauth.consumeState("x".repeat(500))).toBeNull();
    expect(await oauth.consumeState(undefined)).toBeNull();
  });
});

describe("authorize URL", () => {
  it("carries client id, redirect, state and offline_access + minimum scopes", () => {
    const url = new URL(oauth.buildAuthUrl("abc"));
    expect(url.origin + url.pathname).toBe("https://login.xero.com/identity/connect/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(process.env.XERO_REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.searchParams.get("response_type")).toBe("code");
    const scopes = url.searchParams.get("scope").split(" ");
    // Granular scopes only — Xero no longer issues accounting.transactions to new apps.
    expect(scopes.sort()).toEqual(
      ["accounting.contacts", "accounting.invoices", "accounting.payments", "accounting.settings.read", "offline_access"]
    );
  });
});

describe("callback controller", () => {
  // asyncHandler does not return its promise, so wait for the handler to
  // finish by resolving when it responds, redirects or calls next().
  const run = (query) =>
    new Promise((resolve) => {
      const req = { query };
      const done = () => resolve({ res, next });
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(done),
        redirect: jest.fn(done),
      };
      const next = jest.fn(done);
      controller.callback(req, res, next);
    });

  it("rejects a callback with an unknown state before touching Xero", async () => {
    const { next } = await run({ code: "c", state: "forged" });
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    expect(xeroClient.connect).not.toHaveBeenCalled();
  });

  it("completes the connection for the user/company bound to the state", async () => {
    const state = await oauth.createState("u9", "c9");
    xeroClient.connect.mockResolvedValue({ tenantName: "Acme", status: "connected", toJSON: () => ({}) });
    const { res } = await run({ code: "auth-code", state });
    expect(xeroClient.connect).toHaveBeenCalledWith({ code: "auth-code", userId: "u9", companyId: "c9" });
    expect(res.status).toHaveBeenCalledWith(200);
    // The same state cannot be replayed.
    const again = await run({ code: "auth-code", state });
    expect(again.next).toHaveBeenCalled();
  });

  it("surfaces a user cancel without connecting", async () => {
    const state = await oauth.createState("u1", "c1");
    const { next } = await run({ error: "access_denied", state });
    expect(next.mock.calls[0][0].message).toMatch(/cancelled/i);
    expect(xeroClient.connect).not.toHaveBeenCalled();
  });
});
