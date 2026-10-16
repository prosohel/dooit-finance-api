require("./setup");
const { makeStore } = require("./fakes");

const mockLinks = makeStore([["tenantId", "entityType", "localId"], ["tenantId", "entityType", "xeroId"]]);
jest.mock("../../models/XeroEntityLink", () => ({
  findOne: (f) => mockLinks.findOne(f),
  findOneAndUpdate: (f, u, o) => mockLinks.findOneAndUpdate(f, u, o),
  updateOne: (f, u) => mockLinks.updateOne(f, u),
}));
jest.mock("../../models/XeroConnection", () => ({}));
jest.mock("../../models/Customer", () => ({ find: jest.fn() }));
jest.mock("../../models/Invoice", () => ({ findById: jest.fn() }));
jest.mock("../../models/Payment", () => ({ create: jest.fn() }));
jest.mock("../../services/xero/syncLog", () => ({ logSync: jest.fn(), hashPayload: jest.requireActual("../../services/xero/syncLog").hashPayload }));
jest.mock("../../services/xero/client", () => ({
  createContact: jest.fn(), updateContact: jest.fn(), getContacts: jest.fn(),
  createInvoice: jest.fn(), updateInvoice: jest.fn(), getInvoices: jest.fn(), createPayment: jest.fn(),
}));

const xero = require("../../services/xero/client");
const Invoice = require("../../models/Invoice");
const Customer = require("../../models/Customer");
const Payment = require("../../models/Payment");
const sync = require("../../services/xero/syncService");
const { hashPayload, logSync } = require("../../services/xero/syncLog");
const { toDecimal } = require("../../utils/money");

const conn = { tenantId: "t1", companyId: "co1" };
const payload = { Name: "Acme" };
const settings = {
  billAccountCode: "485", taxType: "INPUT", taxTypeName: "GST on Expenses", taxRatePercent: 10,
  billStatus: "DRAFT", syncPayments: true, paymentAccountId: "bank-1", roundingAccountCode: "860",
};
const invoice = (over = {}) => ({
  _id: "I1", invoiceNumber: "INV-1", status: "open", currency: "AUD", taxRatePercent: 10, total: toDecimal(110),
  issuedAt: new Date("2026-03-01"), lineItems: [{ description: "Fee", quantity: 1, unitPrice: toDecimal(100), amount: toDecimal(100), lineType: "base" }],
  ...over,
});
const opts = { supplierId: "SUP", settings, currencies: ["AUD"] };

beforeEach(() => { mockLinks.reset(); jest.clearAllMocks(); });

describe("contact sync — duplicate prevention", () => {
  it("creates once (with an idempotency key), then skips an unchanged contact without any API call", async () => {
    xero.createContact.mockResolvedValue({ ContactID: "X1", UpdatedDateUTC: "2026-01-01T00:00:00Z" });
    expect(await sync.pushContact(conn, "customer", "L1", payload)).toMatchObject({ action: "created", xeroId: "X1" });
    expect(await sync.pushContact(conn, "customer", "L1", payload)).toMatchObject({ action: "skipped", xeroId: "X1" });
    expect(xero.createContact).toHaveBeenCalledTimes(1);
    expect(xero.createContact.mock.calls[0][2].idempotencyKey).toMatch(/^dooit-put-contact-t1-customer-L1-[0-9a-f]{16}$/);
    expect(mockLinks.rows).toHaveLength(1);
    expect(mockLinks.rows[0].payloadHash).toBe(hashPayload(payload));
  });

  it("updates (never re-creates) when the mapped payload changed", async () => {
    xero.createContact.mockResolvedValue({ ContactID: "X1" });
    xero.updateContact.mockResolvedValue({ ContactID: "X1" });
    await sync.pushContact(conn, "customer", "L1", payload);
    const r = await sync.pushContact(conn, "customer", "L1", { Name: "Acme 2" });
    expect(r.action).toBe("updated");
    expect(xero.createContact).toHaveBeenCalledTimes(1);
    expect(xero.updateContact).toHaveBeenCalledWith(conn, "X1", { Name: "Acme 2" });
  });

  it("adopts an existing ACTIVE Xero contact on a duplicate-name error", async () => {
    xero.createContact.mockRejectedValue(Object.assign(new Error("dup"), { code: "DUPLICATE_CONTACT" }));
    xero.getContacts.mockResolvedValue([{ ContactID: "EXISTING" }]);
    xero.updateContact.mockResolvedValue({ ContactID: "EXISTING" });
    const r = await sync.pushContact(conn, "supplier", "dooit", payload);
    expect(r).toMatchObject({ action: "updated", xeroId: "EXISTING" });
    expect(xero.getContacts.mock.calls[0][1].where).toBe('Name=="Acme" AND ContactStatus=="ACTIVE"');
    expect(mockLinks.rows[0]).toMatchObject({ xeroId: "EXISTING", entityType: "supplier" });
  });

  it("explains an archived duplicate instead of adopting it", async () => {
    xero.createContact.mockRejectedValue(Object.assign(new Error("dup"), { code: "DUPLICATE_CONTACT" }));
    xero.getContacts.mockResolvedValue([]);
    const r = await sync.pushContact(conn, "supplier", "dooit", payload);
    expect(r.action).toBe("failed");
    expect(r.error).toMatch(/archived — restore it in Xero/);
  });

  it("records a failure (and no link) for other errors", async () => {
    xero.createContact.mockRejectedValue(new Error("boom"));
    expect(await sync.pushContact(conn, "customer", "L3", payload)).toMatchObject({ action: "failed" });
    expect(mockLinks.rows).toHaveLength(0);
  });

  it("skips entities that cannot be mapped", async () => {
    expect((await sync.pushContact(conn, "customer", "L4", null)).action).toBe("skipped");
    expect(xero.createContact).not.toHaveBeenCalled();
  });
});

describe("bill sync", () => {
  it("never sends draft invoices", async () => {
    expect((await sync.pushBill(conn, invoice({ status: "draft" }), opts)).action).toBe("skipped");
    expect(xero.createInvoice).not.toHaveBeenCalled();
  });

  it("creates the bill once, with an idempotency key, then skips it unchanged", async () => {
    xero.createInvoice.mockResolvedValue({ InvoiceID: "XB1", Status: "DRAFT", Total: 110 });
    expect((await sync.pushBill(conn, invoice(), opts)).action).toBe("created");
    expect((await sync.pushBill(conn, invoice(), opts)).action).toBe("skipped");
    expect(xero.createInvoice).toHaveBeenCalledTimes(1);
    const [, body, o] = xero.createInvoice.mock.calls[0];
    expect(body).toMatchObject({ Type: "ACCPAY", Contact: { ContactID: "SUP" }, Status: "DRAFT" });
    expect(o.idempotencyKey).toMatch(/^dooit-put-bill-t1-I1-/);
    expect(mockLinks.rows[0]).toMatchObject({ entityType: "invoice", xeroId: "XB1", remoteStatus: "DRAFT" });
  });

  it("flags a bill whose Xero total does not match Dooit's", async () => {
    xero.createInvoice.mockResolvedValue({ InvoiceID: "XB1", Status: "DRAFT", Total: 109.99 });
    await sync.pushBill(conn, invoice(), opts);
    expect(logSync).toHaveBeenCalledWith(expect.objectContaining({ action: "verify_total", status: "failed" }));
  });

  it("does not send a currency the organisation has not enabled", async () => {
    const r = await sync.pushBill(conn, invoice({ currency: "USD" }), opts);
    expect(r.action).toBe("failed");
    expect(r.error).toMatch(/USD, which isn't enabled/);
    expect(xero.createInvoice).not.toHaveBeenCalled();
  });

  it("surfaces a mapping problem (tax rate mismatch) without calling Xero", async () => {
    const r = await sync.pushBill(conn, invoice({ taxRatePercent: 0, total: toDecimal(100) }), opts);
    expect(r.action).toBe("failed");
    expect(xero.createInvoice).not.toHaveBeenCalled();
  });

  it("re-codes an unapproved bill when the mapping changes, without touching its status", async () => {
    xero.createInvoice.mockResolvedValue({ InvoiceID: "XB1", Status: "DRAFT", Total: 110 });
    xero.updateInvoice.mockResolvedValue({ InvoiceID: "XB1", Status: "DRAFT" });
    await sync.pushBill(conn, invoice(), opts);
    const r = await sync.pushBill(conn, invoice(), { ...opts, settings: { ...settings, billAccountCode: "489" } });
    expect(r.action).toBe("updated");
    expect(xero.updateInvoice.mock.calls[0][2]).not.toHaveProperty("Status");
  });

  it("leaves an approved bill alone when the mapping changes", async () => {
    await mockLinks.create({ tenantId: "t1", entityType: "invoice", localId: "I1", xeroId: "XB1", remoteStatus: "AUTHORISED", payloadHash: "old" });
    expect((await sync.pushBill(conn, invoice(), opts)).action).toBe("skipped");
    expect(xero.updateInvoice).not.toHaveBeenCalled();
  });

  it.each([["DRAFT", "DELETED"], ["AUTHORISED", "VOIDED"]])("a voided invoice deletes/voids a %s bill (%s), once", async (remote, target) => {
    await mockLinks.create({ tenantId: "t1", entityType: "invoice", localId: "I1", xeroId: "XB1", remoteStatus: remote });
    xero.getInvoices.mockResolvedValue([{ InvoiceID: "XB1", Status: remote }]);
    xero.updateInvoice.mockResolvedValue({ InvoiceID: "XB1", Status: target });
    expect((await sync.pushBill(conn, invoice({ status: "void" }), opts)).action).toBe("updated");
    expect(xero.updateInvoice).toHaveBeenCalledWith(conn, "XB1", { Status: target });
    expect((await sync.pushBill(conn, invoice({ status: "void" }), opts)).action).toBe("skipped");
    expect(xero.updateInvoice).toHaveBeenCalledTimes(1);
  });

  it("flags (once) a voided invoice whose bill is already paid in Xero", async () => {
    await mockLinks.create({ tenantId: "t1", entityType: "invoice", localId: "I1", xeroId: "XB1", remoteStatus: "PAID" });
    xero.getInvoices.mockResolvedValue([{ InvoiceID: "XB1", Status: "PAID" }]);
    expect((await sync.pushBill(conn, invoice({ status: "void" }), opts)).action).toBe("failed");
    expect((await sync.pushBill(conn, invoice({ status: "void" }), opts)).action).toBe("skipped");
    expect(xero.updateInvoice).not.toHaveBeenCalled();
  });

  it("never creates a bill for an invoice voided before it was sent", async () => {
    expect((await sync.pushBill(conn, invoice({ status: "void" }), opts)).action).toBe("skipped");
    expect(xero.createInvoice).not.toHaveBeenCalled();
  });
});

describe("payment sync", () => {
  const p = { _id: "P1", invoice: "I1", type: "payment", status: "paid", amount: 10 };

  it("applies a payment to an APPROVED bill once, and never echoes a Xero-originated one", async () => {
    await mockLinks.create({ tenantId: "t1", entityType: "invoice", localId: "I1", xeroId: "XB1", remoteStatus: "AUTHORISED" });
    xero.createPayment.mockResolvedValue({ PaymentID: "XP1", Invoice: { Status: "PAID" } });
    expect((await sync.pushPayment(conn, p, settings)).action).toBe("created");
    expect((await sync.pushPayment(conn, p, settings)).action).toBe("skipped");
    expect((await sync.pushPayment(conn, { ...p, _id: "P2", gateway: "xero" }, settings)).action).toBe("skipped");
    expect(xero.createPayment).toHaveBeenCalledTimes(1);
    expect(xero.createPayment.mock.calls[0][1]).toMatchObject({ Account: { AccountID: "bank-1" }, Invoice: { InvoiceID: "XB1" } });
  });

  it("waits while the bill is unapproved, unsent, or the organisation has not opted in", async () => {
    await mockLinks.create({ tenantId: "t1", entityType: "invoice", localId: "I1", xeroId: "XB1", remoteStatus: "DRAFT" });
    expect((await sync.pushPayment(conn, p, settings)).action).toBe("skipped");
    expect((await sync.pushPayment(conn, { ...p, invoice: "NOPE" }, settings)).action).toBe("skipped");
    expect((await sync.pushPayment(conn, p, { ...settings, syncPayments: false })).action).toBe("skipped");
    expect(xero.createPayment).not.toHaveBeenCalled();
    expect(logSync).not.toHaveBeenCalled(); // waiting is counted, not logged every run
  });
});

describe("inbound — tracked, never applied to Dooit", () => {
  it("records a bill's new status but never creates payments or edits the invoice", async () => {
    await mockLinks.create({ tenantId: "t1", entityType: "invoice", localId: "I1", xeroId: "XB1", remoteStatus: "AUTHORISED" });
    Invoice.findById.mockReturnValue({ select: () => ({ lean: async () => ({ status: "open", invoiceNumber: "INV-1" }) }) });
    const r = await sync.applyInboundInvoice(conn, {
      InvoiceID: "XB1", Status: "PAID", Payments: [{ PaymentID: "XP9", Amount: 110 }],
    });
    expect(r.action).toBe("updated");
    expect(mockLinks.rows[0].remoteStatus).toBe("PAID");
    expect(Payment.create).not.toHaveBeenCalled();
    expect(logSync).toHaveBeenCalledWith(expect.objectContaining({ action: "status_paid", direction: "inbound" }));
  });

  it("notes a bill voided in Xero without voiding the Dooit invoice", async () => {
    await mockLinks.create({ tenantId: "t1", entityType: "invoice", localId: "I1", xeroId: "XB1", remoteStatus: "AUTHORISED" });
    Invoice.findById.mockReturnValue({ select: () => ({ lean: async () => ({ status: "open", invoiceNumber: "INV-1" }) }) });
    await sync.applyInboundInvoice(conn, { InvoiceID: "XB1", Status: "VOIDED" });
    expect(logSync).toHaveBeenCalledWith(expect.objectContaining({ status: "skipped", error: expect.stringMatching(/Dooit invoice is unchanged/) }));
  });

  it("tracks a linked contact's status; an archived supplier is flagged", async () => {
    await mockLinks.create({ tenantId: "t1", entityType: "supplier", localId: "dooit", xeroId: "SUP", remoteStatus: "ACTIVE" });
    await sync.applyInboundContact(conn, { ContactID: "SUP", Name: "Dooit Pty Ltd", ContactStatus: "ARCHIVED" });
    expect(mockLinks.rows[0].remoteStatus).toBe("ARCHIVED");
    expect(logSync).toHaveBeenCalledWith(expect.objectContaining({ action: "archived_in_xero", status: "failed" }));
  });

  it("ignores contacts and bills Dooit did not create", async () => {
    expect((await sync.applyInboundContact(conn, { ContactID: "OTHER" })).action).toBe("skipped");
    expect((await sync.applyInboundInvoice(conn, { InvoiceID: "OTHER" })).action).toBe("skipped");
  });
});

describe("customer contacts — eligibility, archiving, duplicate names", () => {
  const jane = { Name: "Jane Citizen", FirstName: "Jane", LastName: "Citizen", EmailAddress: "jane@one.example", AccountNumber: "DOOIT-C-AAAA1111" };
  const otherJane = { ...jane, EmailAddress: "jane@two.example", AccountNumber: "DOOIT-C-BBBB2222" };
  const dup = () => Object.assign(new Error("The contact name Jane Citizen is already assigned to another contact."), { code: "DUPLICATE_CONTACT" });

  it("gives a second customer with the same name its own contact instead of overwriting the first", async () => {
    xero.createContact
      .mockResolvedValueOnce({ ContactID: "XC1" }) // first Jane
      .mockRejectedValueOnce(dup()) // second Jane: name taken
      .mockResolvedValueOnce({ ContactID: "XC2" }); // created with a unique name
    xero.getContacts.mockResolvedValue([{ ContactID: "XC1", EmailAddress: "jane@one.example", AccountNumber: "DOOIT-C-AAAA1111" }]);

    expect((await sync.pushContact(conn, "customer", "C1", jane)).xeroId).toBe("XC1");
    expect((await sync.pushContact(conn, "customer", "C2", otherJane)).xeroId).toBe("XC2");
    expect(xero.updateContact).not.toHaveBeenCalled(); // XC1 untouched
    expect(xero.createContact.mock.calls[2][1].Name).toBe("Jane Citizen (DOOIT-C-BBBB2222)");
    expect(mockLinks.rows.find((l) => l.localId === "C2")).toMatchObject({ xeroId: "XC2", displayName: "Jane Citizen (DOOIT-C-BBBB2222)" });

    // Next run: unchanged → no API call, and the unique name is kept.
    expect((await sync.pushContact(conn, "customer", "C2", otherJane)).action).toBe("skipped");
    expect(xero.createContact).toHaveBeenCalledTimes(3);
    xero.updateContact.mockResolvedValue({ ContactID: "XC2" });
    await sync.pushContact(conn, "customer", "C2", { ...otherJane, EmailAddress: "new@two.example" });
    expect(xero.updateContact.mock.calls[0][2].Name).toBe("Jane Citizen (DOOIT-C-BBBB2222)");
  });

  it("adopts an unlinked same-name contact only when the email matches", async () => {
    xero.createContact.mockRejectedValueOnce(dup());
    xero.getContacts.mockResolvedValue([{ ContactID: "CLIENTS-OWN", EmailAddress: "JANE@one.example" }]);
    xero.updateContact.mockResolvedValue({ ContactID: "CLIENTS-OWN" });
    expect((await sync.pushContact(conn, "customer", "C3", jane)).xeroId).toBe("CLIENTS-OWN");
    expect(xero.updateContact).toHaveBeenCalledWith(conn, "CLIENTS-OWN", jane);
  });

  it("never adopts the client's unrelated contact that merely shares the name", async () => {
    xero.createContact.mockRejectedValueOnce(dup()).mockResolvedValueOnce({ ContactID: "XC9" });
    xero.getContacts.mockResolvedValue([{ ContactID: "CLIENTS-OWN", EmailAddress: "someone@else.example" }]);
    await sync.pushContact(conn, "customer", "C4", jane);
    expect(xero.updateContact).not.toHaveBeenCalled();
    expect(xero.createContact.mock.calls[1][1].Name).toBe("Jane Citizen (DOOIT-C-AAAA1111)");
  });

  it("archives a synced customer who is no longer eligible — once — and restores them later", async () => {
    await mockLinks.create({ tenantId: "t1", entityType: "customer", localId: "C5", xeroId: "XC5", remoteStatus: "ACTIVE", payloadHash: "h" });
    xero.updateContact.mockResolvedValue({ ContactID: "XC5", ContactStatus: "ACTIVE" });
    expect((await sync.retireCustomerContact(conn, "C5", "sanctions match")).action).toBe("updated");
    expect(xero.updateContact).toHaveBeenCalledWith(conn, "XC5", { ContactStatus: "ARCHIVED" });
    expect(mockLinks.rows[0]).toMatchObject({ remoteStatus: "ARCHIVED", archivedByDooit: true });
    expect((await sync.retireCustomerContact(conn, "C5", "sanctions match")).action).toBe("skipped");
    expect(xero.updateContact).toHaveBeenCalledTimes(1);

    // Eligible again → restored with ContactStatus ACTIVE.
    const r = await sync.pushContact(conn, "customer", "C5", jane);
    expect(r.action).toBe("updated");
    expect(xero.updateContact.mock.calls[1][2]).toMatchObject({ ContactStatus: "ACTIVE", Name: "Jane Citizen" });
  });

  it("leaves a contact the client archived in Xero alone", async () => {
    await mockLinks.create({ tenantId: "t1", entityType: "customer", localId: "C6", xeroId: "XC6", remoteStatus: "ARCHIVED", archivedByDooit: false });
    expect((await sync.pushContact(conn, "customer", "C6", jane)).action).toBe("skipped");
    expect(xero.updateContact).not.toHaveBeenCalled();
  });

  it("only sends eligible customers when customer sync is on", async () => {
    const customers = [
      { _id: "OK", kycStatus: "verified", isActive: true, decryptForRole() { return { _id: "OK", personalKyc: { personal_form: { customer_details: { given_name: "Ann", surname: "Lee" } } } }; } },
      { _id: "PENDING", kycStatus: "pending", isActive: true },
      { _id: "SANCTIONED", kycStatus: "verified", sanction: true, isActive: true },
      { _id: "FLAGGED", kycStatus: "verified", amlStatus: "flagged", isActive: true },
      { _id: "GONE", kycStatus: "verified", status: "Offboarded", isActive: true },
    ];
    Customer.find.mockReturnValue({ cursor: () => customers });
    xero.createContact.mockResolvedValue({ ContactID: "XANN" });
    const { summary } = await sync.runOutbound({ ...conn, settings: { configuredAt: new Date(), syncCustomers: true } });
    expect(xero.createContact).toHaveBeenCalledTimes(1);
    expect(xero.createContact.mock.calls[0][1].Name).toBe("Ann Lee");
    expect(summary.contacts).toMatchObject({ created: 1, skipped: 4 });
  });
});

describe("outbound gating", () => {
  it("sends nothing until an admin has saved the Xero settings", async () => {
    const r = await sync.runOutbound({ ...conn, settings: {} });
    expect(r.billsBlocked).toBe("setup");
    expect(xero.createContact).not.toHaveBeenCalled();
  });
});
