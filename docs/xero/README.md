# Xero integration

Backend implementation (Express + Mongoose). Code map:

| Concern | Location |
|---|---|
| Config + startup validation | `config/xero.js` |
| Models | `models/Xero{Connection,SyncLog,EntityLink,Job,OAuthState,Signup,ConnectionRequest}.js` |
| OAuth / tokens / API client | `services/xero/{oauth,tokenService,client}.js` |
| Mapping / sync / queue / webhook | `services/xero/{mappers,syncService,jobQueue,webhook,signupService,connectionRequestService,loginCode}.js` |
| HTTP surface | `controllers/xeroController.js`, `routes/xero.js` |
| Tests | `tests/xero/` — `npm run test:xero` (no MongoDB needed) |

> The service layer lives in `services/xero/` (matching `services/billing/`) rather than a new `lib/` folder, because this repo has no `lib/`.

## 1. Setup

1. Create an app at <https://developer.xero.com/app/manage> (type: *Web app*).
2. Add the redirect URI — it must match `XERO_REDIRECT_URI` exactly:
   `https://<api-host>/api/v1/xero/callback` (`/api/xero/callback` also works; the router is mounted at both).
3. Under *Webhooks*, set the delivery URL to `https://<api-host>/api/v1/xero/webhook`, subscribe to **Contacts** and **Invoices**, and copy the signing key into `XERO_WEBHOOK_KEY`. Xero sends an *intent to receive* check on save; the endpoint passes it only if the key is correct.
4. Set the environment variables below and restart. Startup logs `[xero] background worker started` when the config is valid.
5. In Dooit: Settings → Xero → **Connect to Xero** (admin users only), then **Finish setup** (expense account, tax rate, optional payments/customers). Nothing is sent until that is saved.

## 2. Environment variables

| Variable | Required | Notes |
|---|---|---|
| `XERO_CLIENT_ID` | yes | |
| `XERO_CLIENT_SECRET` | yes | |
| `XERO_REDIRECT_URI` | yes | `https` required (plain `http` only for localhost) |
| `XERO_WEBHOOK_KEY` | for webhooks | Without it every webhook delivery is rejected (401) |
| `ENCRYPTION_KEY` | yes | Existing 64-hex key; encrypts refresh tokens (AES-256-GCM) |
| `XERO_POST_CONNECT_URL` | recommended | Settings page URL the callback redirects to (`?xero=connected\|denied\|invalid_state\|error`). If unset the callback answers JSON |
| `FRONTEND_URL` | for approval emails | Web base URL used in the emailed approval link (already used elsewhere in the API). Falls back to the origin of `XERO_SIGNUP_URL` |
| `XERO_CONNECTION_REQUEST_TTL_MIN` | no | Minutes a client has to approve (default 30) |
| `XERO_SIGNUP_URL` | for Sign up with Xero | Web page that finishes signup, e.g. `https://<web-host>/auth/xero`. The API callback redirects there with `?ticket=` / `?pending=` / `?loginCode=` / `?error=` |
| `XERO_SCOPES` | no | Space/comma list. Default (minimal, granular) `offline_access accounting.contacts accounting.invoices accounting.payments accounting.settings.read`. `offline_access` is always enforced. The broad `accounting.transactions` is deprecated and is not issued to apps created after 2 March 2026 (a startup warning flags it) |
| `XERO_SUPPLIER_NAME` | recommended | How Dooit appears as the supplier on bills in the client's Xero — must match the name on Dooit invoices (`Dooit.ai`). Default `Dooit` |
| `XERO_SUPPLIER_EMAIL` / `XERO_SUPPLIER_WEBSITE` / `XERO_SUPPLIER_TAX_NUMBER` | no | Supplier contact details (email falls back to `SUPPORT_EMAIL`). Set the tax number only once Dooit's ABN is confirmed |
| `XERO_SYNC_INTERVAL_MIN` | no | Incremental sync cadence (default 15) |
| `XERO_JOB_MAX_ATTEMPTS` | no | Retries before a job is parked as `dead` (default 5) |

Account codes, the tax rate and the payment account are **not** environment settings: each organisation chooses them from its own chart of accounts in Settings → Xero (Xero certification). `XERO_SALES_ACCOUNT_CODE` / `XERO_PAYMENT_ACCOUNT_CODE` are ignored (startup warning).

Validation (`validateXeroConfig`) runs at startup. No `XERO_*` set ⇒ integration disabled quietly. Partial/invalid config ⇒ errors logged, integration disabled, **API keeps running**.

## 3. OAuth flow

```
Settings ─GET /xero/auth──────────────▶ API  creates one-time state (hash stored, 10 min TTL,
   │                                         bound to user + company) → returns { url }
   ├─ browser → login.xero.com (consent) ─▶ Xero
   │                                  ◀──── redirect /xero/callback?code&state
   └─ API: consume state (single use) → exchange code → GET /connections
          → pick org → store encrypted refresh token + expiry → redirect to Settings
```

* State is random 256-bit, stored hashed, consumed atomically (replay → rejected), and is the *only* source of user/company identity in the public callback (CSRF-safe; no cookies).
* Refresh tokens are **single-use** at Xero. `tokenService` serialises refreshes per connection (in-process promise + compare-and-swap on the stored ciphertext), rotates and re-encrypts the token, recalculates expiry, and caches the access token (memory + encrypted in DB).
* On any API `401` the client refreshes once and retries once. `invalid_grant` ⇒ connection marked `revoked` ⇒ UI shows *Reconnect*.
* `429` honours `Retry-After` (≤60 s, 2 retries); network errors / 5xx retry with back-off, then surface a 503/502.

| Route (under `/api/v1/xero`) | Auth | Purpose |
|---|---|---|
| `GET /auth` | admin | Returns `{ data: { url } }` (`?redirect=true` → 302) |
| `GET /callback` | public (state) | OAuth redirect target (connect and signup) |
| `GET /signup/start`, `GET /signup/prefill`, `POST /signup/complete`, `POST /signup/session` | public (one-time secrets) | Sign up with Xero |
| `GET /signup/pending?token`, `POST /signup/pending/continue` | public (requester handle) | Requester polls approval / continues once approved |
| `GET /connection-requests/:token` | public (emailed token) | Approval page data (organisation + requester only) |
| `POST /connection-requests/:token/approve` | emailed token **+** signed-in client admin | Approve and link the organisation |
| `POST /connection-requests/:token/reject` | emailed token | Reject the request |
| `POST /refresh` | admin | Force a token refresh |
| `POST /disconnect` | admin | Revoke at Xero, wipe tokens locally |
| `GET /status` | admin | Org name, connected date, last sync, status, error |
| `POST /sync` | admin | "Sync Now" — enqueues a full sync (202) |
| `GET /logs` | admin | Recent sync log (`?status=failed&limit=50`) |
| `GET /settings` | admin | Saved mapping + the organisation's live accounts, tax rates, payment accounts, currencies, deep links, problems |
| `PUT /settings` | admin | Save the mapping (every code re-validated against Xero); queues a full sync |
| `POST /webhook` | public (HMAC) | Xero webhook intake |

RBAC: `protect` + `authorizeUserType(client, branch, dooit)` + `authorize("admin")`. Client/branch users act on their own company; dooit staff pass `?companyId=`. Tokens are never serialised (`select:false` + `toJSON` strip). All responses are `Cache-Control: no-store`; `helmet` is global.

### Sign up with Xero

A client can start from Xero (the App Store "Get this app" link → web `/auth/xero`) instead of filling the registration form by hand. What happens depends on whether the Xero **organisation** already belongs to a Dooit client.

```
/auth/xero ─▶ GET /xero/signup/start ─▶ consent at Xero (openid profile email + accounting scopes)
   ◀─ /xero/callback: verify id_token → org → GET /Organisation
        │
        ├─ organisation NOT known ─▶ /auth/xero?ticket=…  (nothing created yet)
        │     GET  /signup/prefill   → org details + entity types (pre-filled form)
        │     POST /signup/complete  → User + Client + UserType(client/admin) + XeroConnection
        │     → one-time loginCode → web signIn("xero") → dashboard
        │
        └─ organisation ALREADY belongs to a client ─▶ /auth/xero?pending=…
              approval request created, email sent to the client's REGISTERED address
              ── admin approves ──▶ Xero org linked to that client ─▶ requester continues
              ── admin rejects / link expires ──▶ nothing connected
```

**Security rule:** a Xero email, or an organisation name, can never claim an existing client. Only the client's own administrator approving a request does.

* **How an existing client is detected** (`findExistingClient`): (1) the Xero `tenantId` — any `XeroConnection` row, even revoked; (2) ABN/registration number; (3) exact organisation name. (2) and (3) only ever lead to an approval *email*, never to access.
* **Approval request** (`XeroConnectionRequest`): status `PENDING_CONFIRMATION → APPROVED | REJECTED | EXPIRED`, expires after `XERO_CONNECTION_REQUEST_TTL_MIN` (default 30). One live request per client + organisation; the same person retrying within 5 minutes reuses it (no second email), anyone else supersedes it.
* **The email** goes to `Client.email` (else the owning user's email) with *Approve Xero Connection* / *Reject Request* links to `<FRONTEND_URL>/auth/xero/confirm/<token>`. Token: random 256-bit, stored only as SHA-256, single-use, expiring, never in the audit log. Opening the link changes nothing (GET is read-only).
* **Approve** needs **both** the emailed token **and** a signed-in administrator of that client (`userType client` + `role admin` + that `clientId`). On approval the API re-verifies the Xero authorisation (refresh token still valid, tenant still authorised), links the organisation with fresh tokens, and emails the requester. **Reject** needs only the token (the safe direction).
* **What the requester gets after approval:** the *organisation* is linked — the requester is **not** made an admin or anything else. They continue into the app only if their email already belongs to a Dooit user with an active membership on that client, and then with exactly that membership (once, within 30 min). Otherwise they are sent to sign in / ask their administrator for access.
* **Requester screen** shows the masked registered address (`a***@abc.com`), never the full one; the approval page shows only the organisation and who asked, nothing about the client.
* **Brand-new organisations** keep the original flow: identity trusted, account activated immediately, email always the Xero one, whitelisted form fields only, client `status` left at `Pending`. If the Xero email already belongs to a Dooit user (and the org is new) signup is refused (409) — it never signs them in.
* Public endpoints are rate-limited (60 / 15 min for OAuth/signup, 30 / 15 min for the token-in-URL approval endpoints).
* **Audit** (`XeroSyncLog.action`): `XERO_CONNECTION_REQUEST_CREATED / _EMAIL_SENT / _APPROVED / _REJECTED / _EXPIRED`, `XERO_TENANT_LINKED`, with request id, client id, tenant id, requester email, masked target and actor in `meta`.
* **Xero app settings:** add `openid profile email` to the app's scopes; set the App Store "Get this app"/sign-up URL to the web `/auth/xero`. The redirect URI is unchanged.

## 4. Sync behaviour

| Dooit | Xero | Direction |
|---|---|---|
| Dooit (`XERO_SUPPLIER_*`) | Supplier contact | out |
| Customer (individual KYC) | Contact | out, **opt-in** per organisation; **KYC-verified only** — never pending/rejected, sanctioned, AML-flagged, offboarded or inactive. A synced customer who stops qualifying has their contact **archived**; restored if they qualify again. Same-name customers get separate contacts (`Name (DOOIT-C-xxxx)`), never merged |
| Invoice (issued) | **Bill (ACCPAY)** from Dooit, coded to the mapped account + tax rate | out; bill status tracked in |
| Invoice voided | Bill deleted (unapproved) / voided (approved) | out |
| Payment (`paid`, type `payment`) | Payment on the approved bill, from the mapped account | out, **opt-in** |

The connected organisation is the **client's own** Xero, so Dooit is their supplier: Dooit invoices are bills in their books, never sales invoices. Inbound changes are **tracked, never applied** — a payment recorded in the client's Xero does not mark a Dooit invoice paid, and contact edits in Xero never change KYC records.

* **Setup first:** nothing is sent until an admin saves the mapping (Settings → Xero). Before each sync the mapped account and tax rate are re-checked in Xero; if one was archived, bills pause with a clear message and the outbound cursor is held so nothing is skipped once fixed.
* **Tax:** each line carries the mapped `TaxType` (`LineAmountTypes: Exclusive`) and Xero computes the tax; Dooit's tax amount is never posted. A bill is refused if the mapped rate differs from the rate on the Dooit invoice. Xero rounds tax per line, so a cent-level difference is posted as a rounding line to the organisation's ROUNDING account, and the created bill's total is checked against Dooit's.
* **Idempotent:** `XeroEntityLink` stores the Xero id per (tenant, entity) with unique indexes. A SHA-256 of the mapped payload means unchanged entities make **no API call**; creates carry an `Idempotency-Key`. A duplicate-name error adopts the existing **active** contact.
* **Order:** supplier contact → bills → payments. Payments wait until the client approves the bill in Xero.
* **Multicurrency:** a bill is only created in a currency the organisation has enabled (`/Currencies`); otherwise the log says which currency to add.
* **Not synced by design:** draft invoices; refunds (credit notes); a bill already paid in Xero is never force-voided (flagged instead).
* **PII safety:** customers are opt-in; masked (`***`) or ciphertext values are never sent to Xero.
* **Queue:** `XeroJob` (Mongo). Atomic claim, exponential back-off (30 s·2ⁿ), parked `dead` after max attempts or on auth errors, stale-lock recovery, deduplicated by key. A scheduled incremental sync runs per connection each `XERO_SYNC_INTERVAL_MIN`. "Sync Now" is a full sync; duplicate clicks collapse into one job and a running sync returns `alreadyRunning`.
* **Audit:** every connect/refresh/disconnect/sync/webhook event is a `XeroSyncLog` row (actor, status, payload hash — never tokens or bodies; 1-year TTL).

## 5. Webhooks

* Signature: `x-xero-signature` = base64(HMAC-SHA256(raw body, `XERO_WEBHOOK_KEY`)), compared in constant time over the **raw** bytes (`express.raw` on this route only).
* Invalid/missing signature ⇒ `401`, empty body, nothing processed. Valid ⇒ `200` empty body.
* Intake only writes small queue rows (Xero's 5-second budget); events are processed by the worker. Redeliveries collapse via `dedupeKey`.
* Handled: `CONTACT`, `INVOICE`, `PAYMENT` (Xero currently emits Contacts/Invoices; payments arrive via invoice events). Others, and unknown tenants, are logged as skipped.

## 6. Troubleshooting

| Symptom | Likely cause / action |
|---|---|
| Connect returns 503 "not configured" | Missing/invalid `XERO_*` or `ENCRYPTION_KEY`; see startup log |
| Xero error "redirect_uri mismatch" | `XERO_REDIRECT_URI` ≠ the URI registered in the Xero app (scheme, host, path, trailing slash) |
| `?xero=invalid_state` | State expired (10 min), reused, or the flow was started on another server instance with a different DB |
| Status `revoked` / "please reconnect" | Refresh token expired (60 days unused) or user removed the app in Xero → Connect again |
| Requester stuck on "Waiting for confirmation" | The client admin hasn't approved; the email goes to the client's *registered* address (`Client.email`). It expires after `XERO_CONNECTION_REQUEST_TTL_MIN`; the requester can start again. Check `xeroconnectionrequests` and the `XERO_CONNECTION_REQUEST_*` rows in `xerosynclogs` |
| Approval email not received | `XERO_CONNECTION_REQUEST_EMAIL_SENT` with status `failed` in the sync log (SMTP). The request is closed so a retry works |
| "already connected to another company" | That Xero org is bound to a different Dooit company; disconnect there first |
| Webhook intent-to-receive fails | Wrong `XERO_WEBHOOK_KEY`, or a proxy altering the body/dropping `x-xero-signature` |
| Nothing is sent to Xero | Mapping not saved yet (Settings → Xero → Finish setup) |
| "Bills paused — the Xero mapping needs attention" | The mapped account/tax rate was archived or changed in Xero → choose again in Settings → Xero |
| "…charged 10% — choose a matching tax rate" | The mapped Xero tax rate's rate differs from the GST on the Dooit invoice |
| "…isn't enabled in your Xero organisation" | Add the invoice currency in Xero (Settings → Currencies), then Sync Now |
| Payments never appear in Xero | Payments are opt-in, and only apply once the bill is approved in Xero |
| Connection shows Reconnect though nobody disconnected in Dooit | The app was disconnected in Xero (Connected apps) or the connecting user lost access — Xero answered 403 `AuthenticationUnsuccessful` |
| Invoice update rejected | Xero locks authorised invoices that have payments; only status can change |
| Sync stuck "running" | Auto-clears after 30 min (crashed worker); `XeroJob` rows with `status: dead` hold the last error |
| 429s | Xero limits: 60 calls/min/org, 5000/day — the client backs off; lower `XERO_SYNC_INTERVAL_MIN` frequency if persistent |

## 7. Frontend contract (Next.js app — not in this repo)

Settings → Xero card: `GET /xero/status` (poll every 2–3 s while `syncing`), **Connect** → `GET /xero/auth` then `window.location = data.url`, **Sync Now** → `POST /xero/sync` (disable while `syncing`), **Disconnect** → `POST /xero/disconnect`. Show `tenantName`, `connectedAt`, `lastSyncAt`, `lastSyncStatus`, `lastSyncError`, `lastSyncSummary`; on `status: "revoked"` show *Reconnect*. Handle `?xero=` on return from the callback. Mapping card: `GET /xero/settings` (dropdown data — never free-text codes) → `PUT /xero/settings`; show `problems` and `setupComplete` from status.

Developer deep-dive (architecture, recipes, runbook): [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md).

Marketplace readiness: see [MARKETPLACE_CHECKLIST.md](./MARKETPLACE_CHECKLIST.md).
