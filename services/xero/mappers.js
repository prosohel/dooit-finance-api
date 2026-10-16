"use strict";

// Pure mapping functions: Dooit documents -> Xero payloads. No I/O here, so
// they are trivially testable.
//
// Direction of the books: the connected Xero organisation belongs to the Dooit
// CLIENT. A Dooit invoice is therefore a BILL in their Xero (ACCPAY, supplier =
// Dooit), coded to the expense account and tax rate the client chose in
// Settings → Xero. It is never a sales invoice in their books.

const { toNumber } = require("../../utils/money");
const { getConfig } = require("../../config/xero");

const MASKED = "***";

/** Treat masked / ciphertext-looking values as absent. */
const clean = (v) => {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!s || s === MASKED) return undefined;
  if (s.split(":").length === 3 && s.split(":")[0].length === 32) return undefined; // ciphertext
  return s;
};

const compact = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));

const toIsoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);

/** Round half away from zero to cents — how Xero rounds line and tax amounts. */
const round2 = (n) => (Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-9)) / 100;

const decimals = (n) => {
  const s = String(n);
  return s.includes(".") ? s.split(".")[1].length : 0;
};

const addressBlock = (type, a = {}) => {
  const block = compact({
    AddressType: type,
    AddressLine1: clean(a.street || a.address),
    City: clean(a.city || a.suburb),
    Region: clean(a.state),
    PostalCode: clean(a.zipcode || a.postcode),
    Country: clean(a.country),
  });
  return Object.keys(block).length > 1 ? block : null;
};

/** Customer (individual KYC record) -> Xero Contact. Returns null if unnameable. */
const customerToContact = (customer) => {
  const form = customer?.personalKyc?.personal_form || {};
  const d = form.customer_details || {};
  const name = [clean(d.given_name), clean(d.middle_name), clean(d.surname)].filter(Boolean).join(" ");
  if (!name) return null;

  const addr = addressBlock("STREET", form.residential_address);
  const phone = clean(form.contact_details?.phone);
  return compact({
    Name: name,
    FirstName: clean(d.given_name),
    LastName: clean(d.surname),
    EmailAddress: clean(form.contact_details?.email),
    Addresses: addr ? [addr] : undefined,
    Phones: phone ? [{ PhoneType: "DEFAULT", PhoneNumber: phone }] : undefined,
    // Dooit id stays discoverable from the Xero side without being the dedupe key.
    AccountNumber: `DOOIT-C-${String(customer._id).slice(-8).toUpperCase()}`,
  });
};

/**
 * Why a customer must NOT be in the client's Xero, or null when it may be.
 * Only customers whose KYC is verified go to Xero — never anyone with a
 * sanctions match or flagged screening, nor offboarded or deactivated records.
 * (A contact in Xero is someone the client can invoice; an AML tool must not
 * hand them a sanctioned or unverified person to trade with.)
 */
const customerSyncBlock = (c = {}) => {
  if (c.isActive === false) return "customer is inactive";
  if (c.status === "Offboarded") return "customer was offboarded";
  if (c.sanction) return "sanctions match";
  if (c.amlStatus === "flagged") return "AML screening flagged";
  if (c.kycStatus !== "verified") return `KYC ${String(c.kycStatus || "not verified").replace(/_/g, " ")}`;
  return null;
};

/** Dooit itself, as the supplier contact on the client's bills. */
const supplierToContact = (supplier = getConfig().supplier) => {
  const name = clean(supplier?.name);
  if (!name) return null;
  return compact({
    Name: name,
    EmailAddress: clean(supplier.email),
    TaxNumber: clean(supplier.taxNumber),
    Website: clean(supplier.website),
  });
};

/** Mapping is usable for bills once an account and a tax rate are chosen. */
const billMappingComplete = (settings) => !!(settings?.billAccountCode && settings?.taxType);

/**
 * Line amount and the quantity/unit split Xero will accept. Unit prices go up
 * to 4 dp (requests carry `unitdp=4`); anything finer, or a split that does not
 * reproduce the line total exactly, is sent as 1 × amount so totals never drift.
 */
const lineShape = (l, amount) => {
  const qty = l.quantity;
  const unit = l.unitPrice == null ? null : toNumber(l.unitPrice);
  const exact =
    qty > 0 && unit != null && decimals(unit) <= 4 && round2(qty * unit) === amount;
  return exact ? { Quantity: qty, UnitAmount: unit } : { Quantity: 1, UnitAmount: amount };
};

/**
 * Dooit Invoice -> Xero bill (ACCPAY).
 *
 * Tax is NOT posted as an amount: each line carries the mapped Xero TaxType and
 * Xero calculates it (Xero certification, "Taxes"). Xero rounds tax per line
 * while Dooit rounds once on the invoice, so the totals can differ by a cent or
 * two; that difference is posted as a rounding line to the organisation's
 * rounding account (Xero's recommended approach). A larger difference means the
 * mapping is wrong, and the bill is not sent.
 *
 * @returns {{ payload: Object, expectedTotal: number } | { error: string }}
 */
const invoiceToBill = (invoice, { contactId, settings = {}, appUrl = "" } = {}) => {
  if (!billMappingComplete(settings)) {
    return { error: "Choose an expense account and a tax rate in Settings → Xero before bills can be sent" };
  }

  const invoiceRate = Number(invoice.taxRatePercent) || 0;
  const mappedRate = Number(settings.taxRatePercent);
  if (!Number.isFinite(mappedRate) || Math.abs(mappedRate - invoiceRate) > 0.0001) {
    return {
      error: `The mapped Xero tax rate "${settings.taxTypeName || settings.taxType}" is ${Number.isFinite(mappedRate) ? mappedRate : "?"}% but invoice ${invoice.invoiceNumber || ""} charged ${invoiceRate}% — choose a matching tax rate in Settings → Xero`.replace(/ {2}/g, " "),
    };
  }

  const lines = [];
  let expectedSubtotal = 0;
  let expectedTax = 0;
  for (const l of invoice.lineItems || []) {
    if (l.lineType === "tax") continue; // Xero derives tax from TaxType
    let amount = round2(toNumber(l.amount));
    if (l.lineType === "discount") amount = -Math.abs(amount); // stored positive in Dooit
    const shape = l.lineType === "discount" ? { Quantity: 1, UnitAmount: amount } : lineShape(l, amount);
    lines.push({
      Description: l.description,
      ...shape,
      AccountCode: settings.billAccountCode,
      TaxType: settings.taxType,
    });
    expectedSubtotal += amount;
    expectedTax += round2((amount * mappedRate) / 100);
  }
  if (!lines.length) return { error: `Invoice ${invoice.invoiceNumber || ""} has no lines to send`.trim() };

  const dooitTotal = round2(toNumber(invoice.total));
  const xeroTotal = round2(expectedSubtotal + expectedTax);
  const diff = round2(dooitTotal - xeroTotal);
  if (diff !== 0) {
    const tolerance = 0.01 * lines.length;
    if (Math.abs(diff) > tolerance || !settings.roundingAccountCode) {
      return {
        error: `Invoice ${invoice.invoiceNumber || ""} totals ${dooitTotal.toFixed(2)} in Dooit but would total ${xeroTotal.toFixed(2)} in Xero${settings.roundingAccountCode ? "" : " (no rounding account found in Xero)"}`.replace(/ {2}/g, " "),
      };
    }
    lines.push(
      compact({
        Description: `Rounding adjustment: Dooit total ${dooitTotal.toFixed(2)}`,
        Quantity: 1,
        UnitAmount: diff,
        AccountCode: settings.roundingAccountCode,
        TaxType: settings.roundingTaxType || undefined,
      })
    );
  }

  const url = /^https:\/\//i.test(appUrl) ? `${appUrl.replace(/\/+$/, "")}/dashboard/client/billing/invoices/${invoice._id}` : undefined;

  return {
    expectedTotal: dooitTotal,
    payload: compact({
      Type: "ACCPAY",
      Contact: { ContactID: contactId },
      LineItems: lines,
      LineAmountTypes: "Exclusive",
      Date: toIsoDate(invoice.issuedAt || invoice.createdAt || invoice.periodEnd),
      DueDate: toIsoDate(invoice.dueAt),
      // For bills, InvoiceNumber is the supplier's reference — Dooit's number.
      InvoiceNumber: invoice.invoiceNumber || undefined,
      CurrencyCode: invoice.currency || "AUD",
      Status: settings.billStatus || "DRAFT",
      // Adds a "Go to <app>" button on the bill in Xero.
      Url: url,
    }),
  };
};

/**
 * Status a Dooit void becomes in Xero: an unapproved bill is deleted, an
 * approved one is voided. A paid bill cannot be voided through the API.
 * @returns {"DELETED"|"VOIDED"|null}
 */
const voidStatusFor = (remoteStatus) => {
  if (["DRAFT", "SUBMITTED"].includes(remoteStatus)) return "DELETED";
  if (remoteStatus === "AUTHORISED") return "VOIDED";
  return null;
};

/**
 * Dooit Payment -> Xero Payment on the bill. Returns null for anything Xero
 * models differently (refunds are credit notes) or the client has not enabled.
 */
const paymentToXero = (payment, xeroInvoiceId, settings = {}) => {
  if (payment.type !== "payment" || payment.status !== "paid") return null;
  if (!settings.syncPayments || !settings.paymentAccountId) return null;
  return compact({
    Invoice: { InvoiceID: xeroInvoiceId },
    Account: { AccountID: settings.paymentAccountId },
    Amount: round2(toNumber(payment.amount)),
    Date: toIsoDate(payment.paidAt || payment.createdAt),
    Reference: payment.uid || payment.transactionId || undefined,
  });
};

/** Xero returns .NET dates as "/Date(1700000000000+0000)/" in some payloads. */
const parseXeroDate = (v) => {
  if (!v) return null;
  const m = /\/Date\((\d+)/.exec(v);
  const d = m ? new Date(Number(m[1])) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Xero Organisation (+ the signed-in Xero user) -> pre-filled Dooit client form.
 * Only fills what Xero actually knows; `clientType` is left for the user, as it
 * is a regulated-sector choice Xero has no equivalent of.
 */
const organisationToClientPrefill = (org = {}, identity = {}) => {
  const addresses = org.Addresses || [];
  const a = addresses.find((x) => x.AddressType === "STREET") || addresses.find((x) => x.AddressType === "POBOX") || {};
  const street = [a.AddressLine1, a.AddressLine2, a.AddressLine3, a.AddressLine4].map(clean).filter(Boolean).join(", ");

  const ph = (org.Phones || []).find((p) => p.PhoneNumber && ["DEFAULT", "OFFICE"].includes(p.PhoneType)) || (org.Phones || []).find((p) => p.PhoneNumber);
  const phone = ph ? [ph.PhoneCountryCode && `+${ph.PhoneCountryCode}`, ph.PhoneAreaCode, ph.PhoneNumber].filter(Boolean).join(" ") : undefined;

  const site = (org.ExternalLinks || []).find((l) => l.LinkType === "Website" && l.Url)?.Url;
  const fullName = [identity.givenName, identity.familyName].filter(Boolean).join(" ");

  return compact({
    name: clean(org.LegalName) || clean(org.Name),
    tradingName: clean(org.Name),
    registrationNumber: clean(org.RegistrationNumber),
    taxId: clean(org.TaxNumber),
    email: clean(identity.email)?.toLowerCase(),
    phone,
    website: clean(site),
    address: compact({
      street: clean(street),
      city: clean(a.City),
      state: clean(a.Region),
      zipcode: clean(a.PostalCode),
      country: clean(a.Country) || clean(org.CountryCode),
    }),
    legalRepresentative: compact({
      name: clean(fullName),
      email: clean(identity.email)?.toLowerCase(),
    }),
    xeroOrganisationType: clean(org.OrganisationType),
  });
};

module.exports = {
  organisationToClientPrefill,
  customerToContact,
  customerSyncBlock,
  supplierToContact,
  billMappingComplete,
  invoiceToBill,
  voidStatusFor,
  paymentToXero,
  parseXeroDate,
  round2,
};
