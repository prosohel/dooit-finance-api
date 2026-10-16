# Connecting Dooit to Xero

*Draft help-centre article. Xero requires public support documentation for App Store apps. Publish this on the Dooit help site and link it from the Xero App Store listing.*

Connect Dooit to your Xero organisation and your Dooit invoices are added to Xero as **bills from Dooit**. They are coded to the expense account and tax rate you choose, so you don't have to key them in.

## Who can do this

A Dooit **administrator** of your company. You also need a Xero login that is allowed to connect apps to the organisation.

## Connect

1. In Dooit, open **System Settings → Xero**.
2. Choose **Connect to Xero**. You are taken to Xero to sign in and choose the organisation.
3. Allow access. You return to Dooit with the organisation name shown and the status **Connected**.

New to Dooit? Choose **Get this app** on the Xero App Store, or **Continue with Xero** on the Dooit sign-in page. Xero fills in your company details for you.

## Finish setup (required before anything is sent)

Dooit sends nothing to Xero until you save these settings.

| Setting | What it does |
|---|---|
| **Expense account** | The account each line of a Dooit bill is coded to. Only active expense accounts from your chart of accounts are listed. |
| **Tax rate** | The Xero tax rate applied to each line, for example *GST on Expenses (10%)*. Xero calculates the tax. Choose the rate that matches the GST on your Dooit invoices; a bill with a different rate is not sent. |
| **New bills are added as** | *Draft* (you review and approve in Xero), *Awaiting approval*, or *Approved*. |
| **Record payments Dooit has received** (optional) | When Dooit receives your payment, it is recorded against the bill from the account you choose, once the bill is approved in Xero. |
| **Send KYC-verified customers to Xero as contacts** (optional, off by default) | Adds verified customers' name, email, phone and address to Xero as contacts. Customers who are pending, rejected, offboarded or have a sanctions or screening flag are never sent; if a customer stops qualifying, their Xero contact is archived. Two customers with the same name get separate contacts. Changes you make in Xero never change your KYC records in Dooit. |

Missing an account or tax rate? Create it in Xero (use the **Chart of accounts in Xero** link), then choose **Refresh lists**.

## What Dooit sends, and what it doesn't

- **Sends:** a *Dooit.ai* supplier contact; each issued Dooit invoice as a bill (with a link back to the invoice in Dooit); optional payments; optional customer contacts.
- **Doesn't send:** draft invoices, refunds, or anything from other areas of Dooit (cases, alerts, screening results).
- **From Xero:** Dooit reads only your accounts, tax rates, currencies and organisation details (for the dropdowns), and the status of the bills it created. Dooit never changes anything in Xero it didn't create, and nothing you do in Xero changes your Dooit invoices or KYC records.
- **Voided invoices:** if Dooit voids an invoice, a draft bill is deleted and an approved bill is voided. A bill already paid in Xero is left alone and flagged on the Sync activity list.

Dooit checks for changes about every 15 minutes. Choose **Sync Now** to run a check straight away.

## Check what happened

**System Settings → Xero → Sync activity** lists every bill, contact and payment sent, and any errors with Xero's explanation. **Open in Xero** takes you to the organisation.

## Disconnect

Choose **Disconnect from Xero** and confirm. Dooit stops sending, and its access to the organisation is removed in Xero. Bills and contacts already in Xero stay there. You can reconnect at any time.

If you disconnect Dooit from Xero's own *Connected apps* page instead, Dooit shows **Reconnect to Xero** the next time it tries to sync. Dooit also disconnects automatically if your Dooit subscription ends or your account is closed.

## Troubleshooting

| You see | What to do |
|---|---|
| **Finish setup** | Choose an expense account and a tax rate, then save. |
| "Bills paused — the Xero mapping needs attention" | The account or tax rate you chose was archived or changed in Xero. Choose again and save. |
| "…charged 10% — choose a matching tax rate" | The Xero tax rate you chose doesn't match the GST on your Dooit invoices. |
| "…isn't enabled in your Xero organisation" | Add that currency in Xero (*Settings → Currencies*), then **Sync Now**. |
| "…supplier contact was archived in Xero" | Restore the Dooit.ai contact in Xero. |
| **Reconnect to Xero** | Access was removed in Xero, or the person who connected lost access. Connect again. |
| A payment isn't in Xero | Payments are optional, and apply only after you approve the bill in Xero. |

Still stuck? Contact Dooit support and include the time of the error shown in Sync activity.
