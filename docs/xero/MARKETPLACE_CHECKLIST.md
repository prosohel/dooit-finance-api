# Xero App Store — readiness audit

Audit of "KYC Dooit" against Xero's App Store requirements, as published on developer.xero.com in **October 2026**: certification checkpoints, the certification matrix, the best-practice guides (connections, account mapping, taxes, rounding, multicurrency, error handling, branding), scopes, app listing, and the "building and growing your app" path. The developer-portal settings were read from the live app (`da1c3f90-3897-4e36-9007-20b762457eb0`) on 7 Oct 2026.

Legend: ✅ meets the requirement · 🔧 fixed in this change · ⬜ still to do (outside the code) · ⚠️ decision needed

## Verdict

**Not ready to submit yet.** The integration had three certification blockers and two financial-integrity defects. All five are fixed in code (below). What remains is configuration in the Xero developer portal, the commercial prerequisites (plan and live connections), listing material, and one end-to-end pass against a Xero demo company.

## How listing works in 2026

1. **Starter plan** (free, 5 connections). *The app is here today: 0 of 5 connections.*
2. **Core plan** (A$35/month, up to 50 connections). Needed to onboard beta customers. Xero's review prerequisites are **Sign Up with Xero** (built) and **ten active customer connections**.
3. **Certification.** From Core, choose *Manage Plan → upgrade to Plus*; certification happens as part of that upgrade. Listing on the App Store requires **Plus or higher**.
4. **Listing.** Submit through *App Store listing* in the developer portal; a Developer Evangelist reviews it.
5. **Security self-assessment.** Only required before reaching **1,000 connections** (Xero sends it at 800).
6. **Annual recertification.** Due each February.

Xero App Store Subscriptions (XASS) was **deprecated in March 2026**. Customers buy through Dooit's own billing, so no Xero billing integration is needed. Xero's certification-matrix page still lists "App Store Subscriptions — Required"; that page predates the deprecation, so confirm with the Developer Evangelist.

## Certification checkpoints

| # | Checkpoint (required for all integrations) | Status | Evidence / what changed |
|---|---|---|---|
| 1 | **Connection**: tenant name, status, connect, disconnect via `DELETE /connections` | ✅ | Settings → Xero shows organisation, status, connected date; "Connect to Xero" / "Disconnect from Xero" (`client.disconnect` calls `DELETE /connections/{id}` and wipes tokens) |
| 1 | Handle a disconnect made **from Xero's side** | 🔧 | Was: a 403 `AuthenticationUnsuccessful` left the connection "connected" and retried forever. Now the connection is marked `revoked` and the page shows **Reconnect to Xero** (`client.request`) |
| 1 | **Delete or revoke unused/expired connections** (abandoned trials, off-boarding) | 🔧 | Was: abandoned sign-ups, rejected/expired approval requests and refused sign-ups left a live connection at Xero; cancelled customers stayed connected. Now `connectionCleanup` releases them (`DELETE /connections/{id}`, guarded so a live organisation is never touched), and companies that are deactivated or whose subscriptions have all ended are disconnected hourly |
| 1 | No pop-ups or new tabs during auth; no tokens or secrets client-side | ✅ | Full-page redirect; tokens AES-256-GCM encrypted server-side, never returned |
| 1 | 1:1 or multi-organisation decision | ✅ | One organisation per Dooit company (partial-unique indexes); documented |
| 2 | **Branding & naming**: name without "Xero"; Xero buttons where possible | ✅ / ⬜ | App name "KYC Dooit" has no Xero trademark. Buttons are text-only ("Connect to Xero", "Disconnect from Xero", "Continue with Xero") with no Xero logo, which the guidelines allow. Optional: swap in the official buttons from Xero's `Xero-Connect-Buttons.zip` |
| 3 | **App Launcher** "Login URL for launcher" | ⬜ | Empty in the portal → set to `https://<web-host>/auth/login` |
| 4 | **Scopes**: minimal, explained; `offline_access` required | 🔧 | Was: requested `accounting.transactions` + `accounting.settings`. This app (granular scopes only) cannot be issued those, so **every connect would have failed**. Now: `offline_access accounting.contacts accounting.invoices accounting.payments accounting.settings.read` (+ `openid profile email` for sign-up). See the scope table below |
| 5 | **Error handling**: show the user Xero's error, a log page | ✅ 🔧 | Xero validation messages are surfaced verbatim; the new **Sync activity** card has Errors / All activity; mapping problems pause bills with an explanation |
| 6 | **Data integrity**: ACTIVE accounts, non-archived contacts, multicurrency, rounding | 🔧 | Account lists are filtered to ACTIVE, non-system accounts. Contact adoption is ACTIVE-only. Bills are only created in a currency the organisation has enabled. Cent rounding is handled with a rounding line, and each created bill's total is checked against Dooit's. Unit prices are sent to 4 dp (`unitdp=4`); an earlier bug sent 4-dp prices without it, so Xero rounded them and totals drifted |
| 7 | **Account & payment mapping**: dropdowns from the chart of accounts, filtered, never a typed code or assumed default | 🔧 | Was: env `XERO_SALES_ACCOUNT_CODE` (default **200**) and `XERO_PAYMENT_ACCOUNT_CODE` for every organisation. Now: per-organisation dropdowns (expense accounts; bank or payment-enabled accounts; tax rates that apply to expenses), refresh button and deep links to Xero, re-validated against Xero on save and before every sync |
| 8 | **Taxes**: use Xero tax rates, map them, don't post tax amounts | 🔧 | Was: `LineAmountTypes: NoTax` with Dooit's tax posted as a line amount. Now each line carries the mapped `TaxType` and Xero calculates the tax; a bill is refused if the mapped rate differs from the rate Dooit charged |

### Other items on Xero's certification matrix

| Item | Required? | Status |
|---|---|---|
| Sign Up with Xero | Required (matrix) / encouraged (checkpoints) | ✅ `/auth/xero`, including protection against a Xero login claiming an existing client |
| Sign In with Xero | Recommended | ⬜ "Continue with Xero" signs up **new** organisations. A returning user whose organisation is already linked goes through the admin-approval flow rather than a one-click sign-in |
| Webhooks | Required (matrix) | ✅ in code (HMAC, 401/200, 5 s, async). ⬜ The portal delivery URL is wrong and intent-to-receive is not yet verified (see portal table) |
| Multicurrency plan | Required | 🔧 currency check against `/Currencies`; base currency shown in Settings |
| Rounding | Required | 🔧 per-line tax rounding reconciled with a rounding line plus a post-create total check |
| Payments mapping | Required when posting payments | 🔧 opt-in; bank or payment-enabled accounts only; applied only once the client approves the bill |
| Deep linking / invoice URL | Recommended | 🔧 each bill carries a `Url` back to the Dooit invoice (https hosts only); "Open in Xero" and chart-of-accounts deep links |
| Idempotent requests | Recommended | 🔧 `Idempotency-Key` on contact, bill and payment creates |
| If-Modified-Since, paging, rate limits | Recommended | ✅ inbound uses If-Modified-Since; 429 `Retry-After` back-off |
| Invoice status choice | Recommended | 🔧 the client chooses Draft / Awaiting approval / Approved for new bills |
| Collaborators | Recommended | ⬜ add a second collaborator in the portal |

## Defects fixed beyond the checklist

These would have been found in review, or by the first real customer:

1. **Wrong side of the books (critical).** The connected organisation is the *client's* Xero. Dooit's subscription invoices were created there as **sales invoices (ACCREC) with the client as its own customer**, overstating the client's revenue. They are now **bills (ACCPAY)** from a "Dooit.ai" supplier contact, coded to the client's chosen expense account.
2. **A client could mark its own Dooit invoice paid (critical).** A payment recorded in the client's Xero created a Dooit `Payment` and reconciled the Dooit invoice. Inbound data is now **tracking only**: bill status is shown, and Dooit invoices and payments are never changed from Xero.
3. **Approval-email hijack (security).** Inbound contact edits wrote `Client.email`, the address that receives the "approve this Xero connection" emails. Anyone who could edit the contact in Xero could redirect them. Inbound contact edits no longer change Dooit data.
4. **KYC evidence overwritten (AML integrity).** Inbound contact edits overwrote verified KYC email and phone. Removed; sending customers to Xero is now **opt-in** (it shares personal data) and one-way.
5. **Sync before consent.** Syncing started the moment Xero was connected. Now nothing is sent until an admin reviews and saves the Xero settings.

## Scopes (for the reviewer)

| Scope | Why |
|---|---|
| `offline_access` | Refresh tokens: keep the connection without re-consent (required by Xero) |
| `accounting.contacts` | Create Dooit.ai as a supplier contact; optionally the client's KYC customers as contacts |
| `accounting.invoices` | Create Dooit invoices as bills; read their status; void/delete when Dooit voids |
| `accounting.payments` | Optional: apply payments Dooit received to the approved bill |
| `accounting.settings.read` | Read Accounts, TaxRates, Currencies, Organisation for the mapping screen (read-only) |
| `openid profile email` | Sign Up with Xero only |

## Developer portal — current vs required (app "KYC Dooit")

| Setting | Current (7 Oct 2026) | Required |
|---|---|---|
| Plan | Starter, 0 of 5 connections | Core to onboard 10 beta customers, then Plus through certification |
| Company or application URL | `https://sandbox.dooit.ai/` | The public product site (e.g. `https://dooit.ai`) |
| Privacy policy URL / Terms URL | empty | ⬜ Both needed for the listing |
| Redirect URIs | `https://sandbox.dooit.ai/` (web root, so authorisation fails with redirect_uri mismatch) | `https://<api-host>/api/v1/xero/callback` per environment (dev: `https://dev-api.dooit.ai/api/v1/xero/callback`); for local dev also `http://localhost:6830/api/v1/xero/callback` |
| Scopes available to the app | granular only (no `accounting.transactions`) | matches the new defaults |
| Login URL for App Launcher | empty | `https://<web-host>/auth/login` |
| Webhook delivery URL | `https://dev-api.dooit.ai/api/v1/xero` (missing `/webhook`) | `https://dev-api.dooit.ai/api/v1/xero/webhook` |
| Webhook events | Billing subscriptions, Contacts, Invoices, Credit notes, Prepayments, Overpayments | **Contacts, Invoices** (the only ones handled; XASS is deprecated) |
| Intent to receive | not sent | Send after the URL is fixed and `XERO_WEBHOOK_KEY` is deployed on that API |
| Collaborators | — | Add a second owner (recommended) |

Xero suggests separate apps per environment ("AppName-Dev"). This app points at sandbox/dev hosts; production should either get its own app, or this one should be switched to production URLs at launch.

## Environment (API)

| Variable | Value |
|---|---|
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_WEBHOOK_KEY` | From the portal (not stored in the repo) |
| `XERO_REDIRECT_URI` | must equal a portal redirect URI exactly |
| `XERO_POST_CONNECT_URL` | `<web>/dashboard/client/system-settings/xero` |
| `XERO_SIGNUP_URL` | `<web>/auth/xero` (also the App Store "purchase/sign up page URL") |
| `XERO_SUPPLIER_NAME` | `Dooit.ai`, matching the issuer on Dooit invoices |
| `XERO_SUPPLIER_TAX_NUMBER` | ⚠️ Dooit's ABN, which isn't recorded anywhere in the code |
| `FRONTEND_URL` | the https web origin; it also enables the "Go to KYC Dooit" button on bills |

Local `config/config.env` now has this block with the three secrets left blank.

## Listing material

| Field | Status |
|---|---|
| Logo SVG + background colour | ⬜ |
| Short description (≤ 300 chars) | Draft (260 chars, ⚠️ marketing to confirm): *"Dooit helps Australian reporting entities meet AML/CTF obligations: KYC and KYB onboarding, sanctions and PEP screening, transaction monitoring and case management. Connect Xero and your Dooit invoices arrive as bills, coded to your own accounts and tax rates."* |
| Industries / functions / regions | ⬜ (AU) |
| Purchase / sign-up page URL | `https://<web-host>/auth/xero` |
| Screenshots, pricing information | ⬜ |
| Public support documentation | Draft: [SUPPORT_ARTICLE.md](./SUPPORT_ARTICLE.md). Publish it on the help site |
| Support contact | ⬜ |

## Data use and retention (for the review and the privacy policy)

- Xero data is used only to create Dooit's bills, the supplier contact, opted-in customer contacts and opted-in payments in the client's own organisation, and to show their status. It is not sent to AI services or used for training. Xero's developer terms restrict that, so keep it this way.
- Kept in Dooit: Xero ids and statuses (`xeroentitylinks`), audit/sync log for **1 year**, jobs for **30 days**, sign-up bridge **1 hour**, approval requests **30 days**. Tokens are encrypted and deleted on disconnect.

## Before submitting: demo-company pass

1. Apply the portal changes above; deploy the API with the env set; send intent-to-receive.
2. Connect a Xero demo company (AU) from Settings → Xero. It should land on **Finish setup** and send nothing yet.
3. Map: expense account, *GST on Expenses*, Draft; save. A full sync runs and the Dooit.ai contact and bills appear as drafts, with tax computed by Xero and totals equal to the Dooit PDFs.
4. Approve a bill in Xero. Within a sync, Settings → Sync activity shows "from Xero · status authorised". Turn payments on, record a Dooit payment, and confirm it lands on the bill.
5. Archive the mapped expense account in Xero, then Sync Now. Bills pause with the explanation; pick a new account and they resume.
6. Void a Dooit invoice: its draft bill is deleted; void another after approval and it is voided.
7. Disconnect the app from **Xero's** Connected Apps page, then Sync Now. The page shows Reconnect.
8. Start a Sign Up with Xero and abandon it. About 35 minutes later the connection disappears from the portal's Connection management.
9. Record a short video of steps 2–7 for the reviewer.

## Decisions for you

- ⚠️ Dooit's legal name and ABN as the supplier on bills (`XERO_SUPPLIER_*`).
- ⚠️ Privacy policy and terms URLs.
- ⚠️ Whether the listing's go-to-market name is "KYC Dooit" or "Dooit". The portal app name must match the product name.
- ⚠️ Whether to offer KYC customers → Xero contacts at all. It is opt-in now; reviewers will ask why an AML tool exports personal data.
- Sign In with Xero for existing users (recommended, not required).

## Known limitations

- One Xero organisation per Dooit company.
- Refunds (credit notes) are not sent; a bill already paid in Xero is flagged, not voided, when Dooit voids the invoice.
- A signed-out client admin who follows the approval email must sign in and then reopen the link.
- The worker and queue are in-process (Mongo-backed); scale-out safe, no external broker.
