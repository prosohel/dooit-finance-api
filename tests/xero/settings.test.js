require("./setup");

jest.mock("../../models/XeroConnection", () => ({ updateOne: jest.fn(async () => ({ modifiedCount: 1 })) }));
jest.mock("../../services/xero/syncLog", () => ({ logSync: jest.fn() }));
jest.mock("../../services/xero/client", () => ({
  getAccounts: jest.fn(), getTaxRates: jest.fn(), getCurrencies: jest.fn(), getOrganisation: jest.fn(),
}));

const xero = require("../../services/xero/client");
const XeroConnection = require("../../models/XeroConnection");
const { logSync } = require("../../services/xero/syncLog");
const svc = require("../../services/xero/settingsService");

const ACCOUNTS = [
  { AccountID: "a1", Code: "485", Name: "Subscriptions", Type: "OVERHEADS", Status: "ACTIVE", Class: "EXPENSE" },
  { AccountID: "a2", Code: "429", Name: "General Expenses", Type: "EXPENSE", Status: "ARCHIVED", Class: "EXPENSE" },
  { AccountID: "a3", Code: "200", Name: "Sales", Type: "REVENUE", Status: "ACTIVE", Class: "REVENUE" },
  { AccountID: "a4", Code: "090", Name: "Business Bank", Type: "BANK", Status: "ACTIVE", Class: "ASSET" },
  { AccountID: "a5", Code: "610", Name: "Accounts Receivable", Type: "CURRENT", Status: "ACTIVE", SystemAccount: "DEBTORS", Class: "ASSET" },
  { AccountID: "a6", Code: "855", Name: "Clearing", Type: "CURRLIAB", Status: "ACTIVE", EnablePaymentsToAccount: true, Class: "LIABILITY" },
  { AccountID: "a7", Code: "860", Name: "Rounding", Type: "CURRLIAB", Status: "ACTIVE", SystemAccount: "ROUNDING", Class: "LIABILITY" },
];
const TAX = [
  { TaxType: "INPUT", Name: "GST on Expenses", EffectiveRate: 10, Status: "ACTIVE", CanApplyToExpenses: true, CanApplyToLiabilities: true },
  { TaxType: "OUTPUT", Name: "GST on Income", EffectiveRate: 10, Status: "ACTIVE", CanApplyToExpenses: false },
  { TaxType: "EXEMPTEXPENSES", Name: "GST Free Expenses", EffectiveRate: 0, Status: "ACTIVE", CanApplyToExpenses: true, CanApplyToLiabilities: false },
  { TaxType: "BASEXCLUDED", Name: "BAS Excluded", EffectiveRate: 0, Status: "ACTIVE", CanApplyToExpenses: true, CanApplyToLiabilities: true },
  { TaxType: "OLD", Name: "Old rate", EffectiveRate: 5, Status: "DELETED", CanApplyToExpenses: true },
];
const conn = { _id: "c1", tenantId: "t1", companyId: "co1", settings: {} };

beforeEach(() => {
  jest.clearAllMocks();
  xero.getAccounts.mockResolvedValue(ACCOUNTS);
  xero.getTaxRates.mockResolvedValue(TAX);
  xero.getCurrencies.mockResolvedValue([{ Code: "AUD" }, { Code: "USD" }]);
  xero.getOrganisation.mockResolvedValue({ BaseCurrency: "AUD", CountryCode: "AU", ShortCode: "!abc12" });
});

describe("dropdown lists (certification: filtered, active, no typed codes)", () => {
  it("offers only active, non-system expense accounts for bills", () => {
    expect(svc.billAccountsOf(ACCOUNTS).map((a) => a.code)).toEqual(["485"]);
  });
  it("offers bank and payment-enabled accounts for payments", () => {
    expect(svc.paymentAccountsOf(ACCOUNTS).map((a) => a.code)).toEqual(["090", "855"]);
  });
  it("offers active tax rates that apply to expenses", () => {
    expect(svc.expenseTaxRatesOf(TAX).map((t) => t.taxType)).toEqual(["BASEXCLUDED", "EXEMPTEXPENSES", "INPUT"]);
  });
  it("finds the rounding account and a zero-rate tax type valid for it", () => {
    expect(svc.roundingOf(ACCOUNTS, TAX)).toEqual({ roundingAccountCode: "860", roundingTaxType: "BASEXCLUDED" });
  });
  it("loadOptions returns currencies, deep links and a non-binding suggestion", async () => {
    const { options, problems } = await svc.loadOptions(conn);
    expect(options.currencies).toEqual(["AUD", "USD"]);
    expect(options.suggested.billAccountCode).toBe("485");
    expect(options.links.chartOfAccounts).toMatch(/^https:\/\/go\.xero\.com\/organisationlogin\/default\.aspx\?shortcode=!abc12/);
    expect(problems).toEqual([]);
  });
});

describe("saveSettings", () => {
  it("rejects an account or tax rate that is not in the organisation's current lists", async () => {
    await expect(svc.saveSettings(conn, { billAccountCode: "429", taxType: "INPUT" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.saveSettings(conn, { billAccountCode: "200", taxType: "INPUT" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.saveSettings(conn, { billAccountCode: "485", taxType: "OUTPUT" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.saveSettings(conn, { billAccountCode: "485", taxType: "OLD" })).rejects.toMatchObject({ statusCode: 400 });
    expect(XeroConnection.updateOne).not.toHaveBeenCalled();
  });

  it("requires a payment account when payments are switched on", async () => {
    await expect(svc.saveSettings(conn, { billAccountCode: "485", taxType: "INPUT", syncPayments: true, paymentAccountId: "a1" }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("saves names and the rate snapshot, keeps customers opt-in, and audits the change", async () => {
    const s = await svc.saveSettings(conn, { billAccountCode: "485", taxType: "INPUT", billStatus: "AUTHORISED", syncPayments: true, paymentAccountId: "a4" }, { actor: "u1" });
    expect(s).toMatchObject({
      billAccountCode: "485", billAccountName: "Subscriptions", taxType: "INPUT", taxRatePercent: 10, billStatus: "AUTHORISED",
      paymentAccountId: "a4", paymentAccountName: "Business Bank", syncCustomers: false, roundingAccountCode: "860", configuredBy: "u1",
    });
    expect(logSync).toHaveBeenCalledWith(expect.objectContaining({ entity: "settings", action: "mapping_saved", actor: "u1" }));
  });

  it("falls back to DRAFT for an unknown bill status", async () => {
    expect((await svc.saveSettings(conn, { billAccountCode: "485", taxType: "INPUT", billStatus: "PAID" })).billStatus).toBe("DRAFT");
  });
});

describe("re-validation before each sync", () => {
  it("reports an archived account, an inactive tax rate and a changed rate", () => {
    const accounts = ACCOUNTS.map((a) => (a.Code === "485" ? { ...a, Status: "ARCHIVED" } : a));
    expect(svc.problemsWith({ billAccountCode: "485" }, { accounts, taxRates: TAX })[0]).toMatch(/485 .*no longer an active expense account/);
    expect(svc.problemsWith({ taxType: "OLD" }, { accounts: ACCOUNTS, taxRates: TAX })[0]).toMatch(/no longer active/);
    expect(svc.problemsWith({ taxType: "INPUT", taxRatePercent: 15 }, { accounts: ACCOUNTS, taxRates: TAX })[0]).toMatch(/changed from 15% to 10%/);
  });
  it("validateForSync returns the organisation's currencies", async () => {
    const out = await svc.validateForSync({ ...conn, baseCurrency: "AUD", settings: { billAccountCode: "485", taxType: "INPUT", taxRatePercent: 10, roundingAccountCode: "860", roundingTaxType: "BASEXCLUDED" } });
    expect(out).toEqual({ problems: [], currencies: ["AUD", "USD"] });
  });
});
