"use strict";

// Account / tax / payment mapping for one connected organisation.
//
// Xero certification ("Account and Payment mapping", "Taxes", "Data integrity"):
//   • the user picks accounts and tax rates from THEIR chart of accounts —
//     dropdowns, never a typed code, never an assumed default;
//   • lists are filtered: ACTIVE only, no system accounts, the right types;
//   • mappings are re-validated before use, because accounts and tax rates can
//     be archived in Xero after setup;
//   • documents are only created in a currency the organisation has enabled.

const XeroConnection = require("../../models/XeroConnection");
const ErrorResponse = require("../../utils/errorResponse");
const xero = require("./client");
const { logSync } = require("./syncLog");

// Account types a supplier bill line may be coded to.
const BILL_ACCOUNT_TYPES = new Set(["EXPENSE", "OVERHEADS", "DIRECTCOSTS"]);
const BILL_STATUSES = ["DRAFT", "SUBMITTED", "AUTHORISED"];
// Zero-rate tax types to prefer on the rounding line, by region.
const ZERO_TAX_PREFERENCE = ["BASEXCLUDED", "NONE", "NOVAT", "EXEMPTEXPENSES", "EXEMPTINPUT"];

const CLASS_FLAG = {
  ASSET: "CanApplyToAssets",
  EQUITY: "CanApplyToEquity",
  EXPENSE: "CanApplyToExpenses",
  LIABILITY: "CanApplyToLiabilities",
  REVENUE: "CanApplyToRevenue",
};

const isActive = (x) => (x?.Status || "ACTIVE") === "ACTIVE";
const byCode = (a, b) => String(a.Code || a.Name).localeCompare(String(b.Code || b.Name), undefined, { numeric: true });
const rateOf = (t) => Number(t.EffectiveRate ?? t.DisplayTaxRate ?? 0);

const billAccountsOf = (accounts) =>
  accounts
    .filter((a) => isActive(a) && BILL_ACCOUNT_TYPES.has(a.Type) && !a.SystemAccount && a.Code)
    .sort(byCode)
    .map((a) => ({ code: a.Code, name: a.Name, type: a.Type, taxType: a.TaxType || null }));

// Payments can be applied to bank accounts and any account with payments enabled
// (e.g. a clearing account).
const paymentAccountsOf = (accounts) =>
  accounts
    .filter((a) => isActive(a) && (a.Type === "BANK" || a.EnablePaymentsToAccount === true))
    .sort(byCode)
    .map((a) => ({ id: a.AccountID, code: a.Code || null, name: a.Name, type: a.Type, currency: a.CurrencyCode || null }));

const expenseTaxRatesOf = (taxRates) =>
  taxRates
    .filter((t) => isActive(t) && t.CanApplyToExpenses !== false && t.TaxType)
    .map((t) => ({ taxType: t.TaxType, name: t.Name, rate: rateOf(t) }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** The organisation's rounding account and a zero-rate tax type valid for it. */
const roundingOf = (accounts, taxRates) => {
  const acct = accounts.find((a) => a.SystemAccount === "ROUNDING" && isActive(a));
  if (!acct) return { roundingAccountCode: null, roundingTaxType: null };
  const flag = CLASS_FLAG[acct.Class];
  const zero = taxRates.filter((t) => isActive(t) && rateOf(t) === 0 && (!flag || t[flag] !== false));
  const preferred = ZERO_TAX_PREFERENCE.map((p) => zero.find((t) => t.TaxType === p)).find(Boolean) || zero[0];
  return { roundingAccountCode: acct.Code || null, roundingTaxType: preferred?.TaxType || null };
};

/** Suggest, never decide: the first account whose name looks like a software/subscription cost. */
const suggestBillAccount = (accounts) =>
  accounts.find((a) => /subscri|software|computer|it\b|licen[cs]e|compliance|consult/i.test(a.name))?.code || null;

const deepLink = (shortCode, path) =>
  shortCode ? `https://go.xero.com/organisationlogin/default.aspx?shortcode=${encodeURIComponent(shortCode)}&redirecturl=${encodeURIComponent(path)}` : null;

/**
 * Everything the mapping screen needs, read live from Xero, plus the saved
 * settings and any problems with them.
 */
const loadOptions = async (conn) => {
  const [accounts, taxRates, currencies, org] = await Promise.all([
    xero.getAccounts(conn),
    xero.getTaxRates(conn),
    xero.getCurrencies(conn),
    xero.getOrganisation(conn),
  ]);

  const facts = { baseCurrency: org?.BaseCurrency || null, countryCode: org?.CountryCode || null, shortCode: org?.ShortCode || null };
  if (org && (facts.baseCurrency !== conn.baseCurrency || facts.shortCode !== conn.shortCode)) {
    await XeroConnection.updateOne({ _id: conn._id }, { $set: facts });
  }

  const billAccounts = billAccountsOf(accounts);
  const options = {
    billAccounts,
    taxRates: expenseTaxRatesOf(taxRates),
    paymentAccounts: paymentAccountsOf(accounts),
    billStatuses: BILL_STATUSES,
    currencies: [...new Set([facts.baseCurrency, ...currencies.map((c) => c.Code)].filter(Boolean))],
    baseCurrency: facts.baseCurrency,
    suggested: { billAccountCode: suggestBillAccount(billAccounts) },
    links: {
      chartOfAccounts: deepLink(facts.shortCode, "/GeneralLedger/ChartOfAccounts.aspx"),
      taxRates: deepLink(facts.shortCode, "/Setup/TaxRates.aspx"),
      // Xero moved this page; /Setup/Currencies.aspx now 404s (checked 2026-10-09).
      currencies: deepLink(facts.shortCode, "/Setup/CurrencyRates.aspx"),
    },
  };
  return { options, problems: problemsWith(conn.settings || {}, { accounts, taxRates }) };
};

/** What is wrong with the saved mapping against Xero as it is now (empty = fine). */
const problemsWith = (settings, { accounts, taxRates }) => {
  const problems = [];
  if (settings.billAccountCode) {
    const a = accounts.find((x) => x.Code === settings.billAccountCode);
    if (!a || !isActive(a) || !BILL_ACCOUNT_TYPES.has(a.Type)) {
      problems.push(`Expense account ${settings.billAccountCode}${settings.billAccountName ? ` (${settings.billAccountName})` : ""} is no longer an active expense account in Xero`);
    }
  }
  if (settings.taxType) {
    const t = taxRates.find((x) => x.TaxType === settings.taxType);
    if (!t || !isActive(t)) problems.push(`Tax rate "${settings.taxTypeName || settings.taxType}" is no longer active in Xero`);
    else if (settings.taxRatePercent != null && Math.abs(rateOf(t) - settings.taxRatePercent) > 0.0001) {
      problems.push(`Tax rate "${t.Name}" changed from ${settings.taxRatePercent}% to ${rateOf(t)}% in Xero — review the mapping`);
    }
  }
  if (settings.syncPayments && settings.paymentAccountId) {
    const p = accounts.find((x) => x.AccountID === settings.paymentAccountId);
    if (!p || !isActive(p) || !(p.Type === "BANK" || p.EnablePaymentsToAccount === true)) {
      problems.push(`Payment account ${settings.paymentAccountName || ""} can no longer receive payments in Xero`.replace(/ {2}/g, " "));
    }
  }
  return problems;
};

/**
 * Validate the user's choices against Xero's CURRENT lists and save them.
 * Every code must come from the dropdown data — nothing typed is trusted.
 */
const saveSettings = async (conn, input = {}, { actor = null } = {}) => {
  const [accounts, taxRates] = await Promise.all([xero.getAccounts(conn), xero.getTaxRates(conn)]);

  const account = billAccountsOf(accounts).find((a) => a.code === input.billAccountCode);
  if (!account) throw new ErrorResponse("Choose an active expense account from your Xero chart of accounts", 400);

  const tax = expenseTaxRatesOf(taxRates).find((t) => t.taxType === input.taxType);
  if (!tax) throw new ErrorResponse("Choose an active Xero tax rate that applies to expenses", 400);

  const billStatus = BILL_STATUSES.includes(input.billStatus) ? input.billStatus : "DRAFT";
  const syncPayments = input.syncPayments === true;
  let payment = null;
  if (syncPayments) {
    payment = paymentAccountsOf(accounts).find((a) => a.id === input.paymentAccountId);
    // With DRAFT/SUBMITTED bills, payments wait until the client approves the bill in Xero.
    if (!payment) throw new ErrorResponse("Choose a bank or payment-enabled account for payments", 400);
  }

  const settings = {
    billAccountCode: account.code,
    billAccountName: account.name,
    taxType: tax.taxType,
    taxTypeName: tax.name,
    taxRatePercent: tax.rate,
    billStatus,
    syncPayments,
    paymentAccountId: payment?.id || null,
    paymentAccountCode: payment?.code || null,
    paymentAccountName: payment?.name || null,
    syncCustomers: input.syncCustomers === true, // personal data: opt-in only
    ...roundingOf(accounts, taxRates),
    configuredAt: new Date(),
    configuredBy: actor,
  };

  await XeroConnection.updateOne({ _id: conn._id }, { $set: { settings, lastSyncError: null } });
  await logSync({
    tenantId: conn.tenantId,
    companyId: conn.companyId,
    entity: "settings",
    action: "mapping_saved",
    status: "success",
    actor,
    meta: {
      billAccountCode: settings.billAccountCode,
      taxType: settings.taxType,
      billStatus,
      syncPayments,
      paymentAccountCode: settings.paymentAccountCode,
      syncCustomers: settings.syncCustomers,
    },
  });
  return settings;
};

/**
 * Pre-sync check: is the saved mapping still valid in Xero, and which document
 * currencies can this organisation accept? Two cheap GETs per sync run.
 * @returns {Promise<{ problems: string[], currencies: string[] }>}
 */
const validateForSync = async (conn) => {
  const [accounts, taxRates, currencies] = await Promise.all([
    xero.getAccounts(conn),
    xero.getTaxRates(conn),
    xero.getCurrencies(conn),
  ]);
  const settings = conn.settings || {};
  const rounding = roundingOf(accounts, taxRates);
  if (rounding.roundingAccountCode !== (settings.roundingAccountCode || null) || rounding.roundingTaxType !== (settings.roundingTaxType || null)) {
    await XeroConnection.updateOne(
      { _id: conn._id },
      { $set: { "settings.roundingAccountCode": rounding.roundingAccountCode, "settings.roundingTaxType": rounding.roundingTaxType } }
    );
    Object.assign(settings, rounding);
  }
  return {
    problems: problemsWith(settings, { accounts, taxRates }),
    currencies: [...new Set([conn.baseCurrency, ...currencies.map((c) => c.Code)].filter(Boolean))],
  };
};

module.exports = {
  loadOptions,
  saveSettings,
  validateForSync,
  problemsWith,
  billAccountsOf,
  paymentAccountsOf,
  expenseTaxRatesOf,
  roundingOf,
  BILL_STATUSES,
};
