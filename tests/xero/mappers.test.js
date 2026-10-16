require("./setup");
const mongoose = require("mongoose");
const m = require("../../services/xero/mappers");
const { toDecimal } = require("../../utils/money");

const oid = () => new mongoose.Types.ObjectId();

describe("Customer -> Contact", () => {
  const customer = {
    _id: oid(),
    personalKyc: { personal_form: {
      customer_details: { given_name: "Jane", surname: "Citizen" },
      contact_details: { email: "jane@example.com", phone: "0400 000 000" },
      residential_address: { address: "1 Main St", suburb: "Sydney", state: "NSW", postcode: "2000", country: "AU" },
    } },
  };

  it("maps name, email, phone and address", () => {
    const c = m.customerToContact(customer);
    expect(c).toMatchObject({
      Name: "Jane Citizen", FirstName: "Jane", LastName: "Citizen", EmailAddress: "jane@example.com",
      Phones: [{ PhoneType: "DEFAULT", PhoneNumber: "0400 000 000" }],
      Addresses: [{ AddressType: "STREET", AddressLine1: "1 Main St", City: "Sydney", Region: "NSW", PostalCode: "2000", Country: "AU" }],
    });
    expect(c.AccountNumber).toMatch(/^DOOIT-C-/);
  });

  it("never sends masked or ciphertext PII to Xero", () => {
    const enc = `${"a".repeat(32)}:${"b".repeat(32)}:cafe`;
    const c = m.customerToContact({ _id: oid(), personalKyc: { personal_form: {
      customer_details: { given_name: "Jane", surname: "***" },
      contact_details: { email: enc, phone: "***" },
    } } });
    expect(c.Name).toBe("Jane");
    expect(c.EmailAddress).toBeUndefined();
    expect(c.Phones).toBeUndefined();
  });

  it("returns null when there is no usable name", () => {
    expect(m.customerToContact({ _id: oid(), personalKyc: {} })).toBeNull();
  });
});

describe("Customer eligibility for Xero", () => {
  it.each([
    [{ kycStatus: "verified", isActive: true }, null],
    [{ kycStatus: "verified", isPep: true, amlStatus: "yellow" }, null],
    [{ kycStatus: "pending" }, "KYC pending"],
    [{ kycStatus: "in_review" }, "KYC in review"],
    [{ kycStatus: "rejected" }, "KYC rejected"],
    [{ kycStatus: "verified", sanction: true }, "sanctions match"],
    [{ kycStatus: "verified", amlStatus: "flagged" }, "AML screening flagged"],
    [{ kycStatus: "verified", status: "Offboarded" }, "customer was offboarded"],
    [{ kycStatus: "verified", isActive: false }, "customer is inactive"],
  ])("%j -> %s", (c, reason) => expect(m.customerSyncBlock(c)).toBe(reason));
});

describe("Supplier contact", () => {
  it("is Dooit, from config", () => {
    expect(m.supplierToContact()).toEqual({ Name: "Dooit Pty Ltd", EmailAddress: "billing@dooit.example" });
  });
  it("returns null without a name", () => expect(m.supplierToContact({ name: " " })).toBeNull());
});

describe("Invoice -> Bill (ACCPAY)", () => {
  const settings = (over = {}) => ({
    billAccountCode: "485", billAccountName: "Subscriptions", taxType: "INPUT", taxTypeName: "GST on Expenses",
    taxRatePercent: 10, billStatus: "DRAFT", roundingAccountCode: "860", roundingTaxType: "BASEXCLUDED", ...over,
  });
  // 100 + 25 - 12.50 = 112.50; GST 10% = 11.25; total 123.75 (discount stored POSITIVE, as Dooit does)
  const invoice = (over = {}) => ({
    _id: "inv1", invoiceNumber: "INV-2026-0001", status: "open", currency: "AUD", taxRatePercent: 10,
    issuedAt: new Date("2026-03-01T10:00:00Z"), dueAt: new Date("2026-03-15T10:00:00Z"),
    total: toDecimal(123.75),
    lineItems: [
      { description: "Platform fee", quantity: 1, unitPrice: toDecimal(100), amount: toDecimal(100), lineType: "base" },
      { description: "ID checks", quantity: 10, unitPrice: toDecimal(2.5), amount: toDecimal(25), lineType: "usage" },
      { description: "Loyalty discount", amount: toDecimal(12.5), lineType: "discount" },
      { description: "GST", amount: toDecimal(11.25), lineType: "tax" },
    ],
    ...over,
  });
  const bill = (inv = invoice(), s = settings(), appUrl = "https://app.example.com") =>
    m.invoiceToBill(inv, { contactId: "supplier-1", settings: s, appUrl });

  it("is a bill from the Dooit supplier, coded to the mapped account and tax rate", () => {
    const { payload } = bill();
    expect(payload).toMatchObject({
      Type: "ACCPAY", Contact: { ContactID: "supplier-1" }, InvoiceNumber: "INV-2026-0001", LineAmountTypes: "Exclusive",
      Date: "2026-03-01", DueDate: "2026-03-15", Status: "DRAFT", CurrencyCode: "AUD",
      Url: "https://app.example.com/dashboard/client/billing/invoices/inv1",
    });
    payload.LineItems.forEach((l) => expect(l).toMatchObject({ AccountCode: "485", TaxType: "INPUT" }));
  });

  it("never posts tax as an amount — the tax line is dropped and Xero computes it", () => {
    const { payload } = bill();
    expect(payload.LineItems.map((l) => l.Description)).toEqual(["Platform fee", "ID checks", "Loyalty discount"]);
    expect(payload.LineItems.some((l) => "TaxAmount" in l)).toBe(false);
  });

  it("sends the discount as a negative line and keeps Xero's total equal to Dooit's", () => {
    const { payload, expectedTotal } = bill();
    expect(payload.LineItems[2]).toMatchObject({ Quantity: 1, UnitAmount: -12.5 });
    const sub = payload.LineItems.reduce((s, l) => s + m.round2(l.Quantity * l.UnitAmount), 0);
    const tax = payload.LineItems.reduce((s, l) => s + m.round2((m.round2(l.Quantity * l.UnitAmount) * 10) / 100), 0);
    expect(m.round2(sub + tax)).toBe(123.75);
    expect(expectedTotal).toBe(123.75);
  });

  it("adds a rounding line when Xero's per-line tax rounding differs by a cent", () => {
    // Three lines of 25.06 / 25.61 / 25.63 at 15%: Xero rounds per line (11.44), Dooit once (11.45).
    const inv = invoice({
      taxRatePercent: 15, total: toDecimal(87.75),
      lineItems: [
        { description: "A", quantity: 1, unitPrice: toDecimal(25.06), amount: toDecimal(25.06), lineType: "base" },
        { description: "B", quantity: 1, unitPrice: toDecimal(25.61), amount: toDecimal(25.61), lineType: "usage" },
        { description: "C", quantity: 1, unitPrice: toDecimal(25.63), amount: toDecimal(25.63), lineType: "overage" },
      ],
    });
    const { payload } = bill(inv, settings({ taxRatePercent: 15 }));
    expect(payload.LineItems.at(-1)).toMatchObject({ UnitAmount: 0.01, AccountCode: "860", TaxType: "BASEXCLUDED", Quantity: 1 });
  });

  it("refuses to send when the mapped tax rate differs from what the invoice charged", () => {
    expect(bill(invoice(), settings({ taxRatePercent: 0 })).error).toMatch(/0% but invoice INV-2026-0001 charged 10%/);
  });

  it("refuses to send without a complete mapping", () => {
    expect(bill(invoice(), settings({ billAccountCode: null })).error).toMatch(/Settings → Xero/);
    expect(m.billMappingComplete({ billAccountCode: "485" })).toBe(false);
  });

  it("refuses when totals cannot be reconciled", () => {
    expect(bill(invoice({ total: toDecimal(130) })).error).toMatch(/totals 130.00 in Dooit but would total 123.75/);
  });

  it("keeps qty × unit only when Xero reproduces the line exactly (≤ 4 dp)", () => {
    const inv = invoice({
      taxRatePercent: 0, total: toDecimal(61.17 + 61.2),
      lineItems: [
        { description: "fine", quantity: 1000, unitPrice: toDecimal(0.061171), amount: toDecimal(61.17), lineType: "overage" },
        { description: "ok", quantity: 1000, unitPrice: toDecimal(0.0612), amount: toDecimal(61.2), lineType: "usage" },
      ],
    });
    const { payload } = bill(inv, settings({ taxRatePercent: 0 }));
    expect(payload.LineItems[0]).toMatchObject({ Quantity: 1, UnitAmount: 61.17 });
    expect(payload.LineItems[1]).toMatchObject({ Quantity: 1000, UnitAmount: 0.0612 });
  });

  it("only adds the deep link for an https app URL", () => {
    expect(bill(invoice(), settings(), "http://localhost:8001").payload.Url).toBeUndefined();
  });

  it.each([["DRAFT", "DELETED"], ["SUBMITTED", "DELETED"], ["AUTHORISED", "VOIDED"], ["PAID", null]])(
    "a Dooit void of a %s bill -> %s", (from, to) => expect(m.voidStatusFor(from)).toBe(to)
  );
});

describe("Payment -> Payment", () => {
  const pay = (over = {}) => ({ type: "payment", status: "paid", amount: toDecimal(50), uid: "PAY-0000001", paidAt: new Date("2026-03-02T00:00:00Z"), ...over });
  const s = { syncPayments: true, paymentAccountId: "acct-bank" };

  it("maps a settled payment to the mapped account", () => {
    expect(m.paymentToXero(pay(), "inv-1", s)).toEqual({
      Invoice: { InvoiceID: "inv-1" }, Account: { AccountID: "acct-bank" }, Amount: 50, Date: "2026-03-02", Reference: "PAY-0000001",
    });
  });
  it("skips refunds, unsettled payments and organisations that did not opt in", () => {
    expect(m.paymentToXero(pay({ type: "refund" }), "i", s)).toBeNull();
    expect(m.paymentToXero(pay({ status: "pending" }), "i", s)).toBeNull();
    expect(m.paymentToXero(pay(), "i", { syncPayments: false, paymentAccountId: "a" })).toBeNull();
    expect(m.paymentToXero(pay(), "i", { syncPayments: true })).toBeNull();
  });
});

describe("inbound helpers", () => {
  it("parses .NET and ISO dates", () => {
    expect(m.parseXeroDate("/Date(1700000000000+0000)/").getTime()).toBe(1700000000000);
    expect(m.parseXeroDate("2026-01-01T00:00:00Z")).toBeInstanceOf(Date);
    expect(m.parseXeroDate(null)).toBeNull();
  });
});
