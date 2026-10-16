"use strict";

// config/xero.js
//
// Single reader of the XERO_* environment. Everything else asks this module
// rather than touching process.env, so tests can change the environment and
// the startup check has one place to look.

// Minimal granular scopes (Xero no longer issues the broad `accounting.transactions`
// to apps created after 2 March 2026). Each one is used:
//   accounting.contacts      — Dooit as a supplier contact; KYC customers as contacts
//   accounting.invoices      — Dooit invoices as bills (ACCPAY)
//   accounting.payments      — payments Dooit received, applied to those bills
//   accounting.settings.read — Accounts / TaxRates / Currencies for mapping, Organisation
const DEFAULT_SCOPES = [
  "offline_access",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.payments",
  "accounting.settings.read",
];

// Broad scopes Xero has deprecated (removed September 2027; never issued to new apps).
const DEPRECATED_SCOPES = ["accounting.transactions", "accounting.transactions.read", "accounting.reports.read"];

// OpenID Connect scopes added for "Sign up with Xero" (identity + email).
const SIGNUP_IDENTITY_SCOPES = ["openid", "profile", "email"];

const REQUIRED = ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "XERO_REDIRECT_URI"];

const env = () => process.env;

const originOf = (url) => {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
};

const getConfig = () => {
  const e = env();
  const scopes = (e.XERO_SCOPES || "")
    .split(/[\s,]+/)
    .filter(Boolean);
  // offline_access is what makes Xero issue a refresh token — never optional.
  const finalScopes = scopes.length ? scopes : [...DEFAULT_SCOPES];
  if (!finalScopes.includes("offline_access")) finalScopes.unshift("offline_access");

  return {
    clientId: e.XERO_CLIENT_ID || "",
    clientSecret: e.XERO_CLIENT_SECRET || "",
    redirectUri: e.XERO_REDIRECT_URI || "",
    webhookKey: e.XERO_WEBHOOK_KEY || "",
    scopes: finalScopes,
    // Where the browser lands after the OAuth callback (the Settings page).
    postConnectUrl: e.XERO_POST_CONNECT_URL || "",
    // Web page that finishes "Sign up with Xero" (receives ?ticket / ?loginCode / ?error).
    signupUrl: e.XERO_SIGNUP_URL || "",
    // Base URL of the web app, used for links in approval emails.
    webBaseUrl: (e.FRONTEND_URL || originOf(e.XERO_SIGNUP_URL) || "").replace(/\/+$/, ""),
    // How long a client has to approve a Xero connection request.
    connectionRequestTtlMs: (Number(e.XERO_CONNECTION_REQUEST_TTL_MIN) || 30) * 60 * 1000,
    // Dooit as it appears in the CLIENT's Xero: the supplier on the bills we send.
    // Account codes, tax rates and the payment account are NOT configured here —
    // each organisation maps its own chart of accounts (XeroConnection.settings).
    supplier: {
      name: (e.XERO_SUPPLIER_NAME || "Dooit").trim(),
      email: (e.XERO_SUPPLIER_EMAIL || e.SUPPORT_EMAIL || "").trim(),
      taxNumber: (e.XERO_SUPPLIER_TAX_NUMBER || "").trim(),
      website: (e.XERO_SUPPLIER_WEBSITE || "").trim(),
    },
    syncIntervalMs: (Number(e.XERO_SYNC_INTERVAL_MIN) || 15) * 60 * 1000,
    maxJobAttempts: Number(e.XERO_JOB_MAX_ATTEMPTS) || 5,
    identityUrl: e.XERO_IDENTITY_URL || "https://identity.xero.com",
    loginUrl: e.XERO_LOGIN_URL || "https://login.xero.com",
    apiUrl: e.XERO_API_URL || "https://api.xero.com",
  };
};

/**
 * Validate the configuration. Never throws: a half-configured optional
 * integration must not take the whole API down, it must disable itself loudly.
 *
 * @returns {{ enabled: boolean, errors: string[], warnings: string[] }}
 */
const validateXeroConfig = () => {
  const e = env();
  const present = REQUIRED.filter((k) => e[k]);
  const errors = [];
  const warnings = [];

  if (present.length === 0 && !e.XERO_WEBHOOK_KEY) {
    return { enabled: false, errors, warnings: ["Xero integration disabled (no XERO_* variables set)"] };
  }

  REQUIRED.filter((k) => !e[k]).forEach((k) => errors.push(`${k} is required`));

  if (e.XERO_REDIRECT_URI) {
    try {
      const u = new URL(e.XERO_REDIRECT_URI);
      const local = ["localhost", "127.0.0.1"].includes(u.hostname);
      if (u.protocol !== "https:" && !local) {
        errors.push("XERO_REDIRECT_URI must use https (http is only allowed for localhost)");
      }
    } catch {
      errors.push("XERO_REDIRECT_URI is not a valid URL");
    }
  }

  if (!e.ENCRYPTION_KEY || !/^[0-9a-fA-F]{64}$/.test(e.ENCRYPTION_KEY)) {
    errors.push("ENCRYPTION_KEY (64 hex chars) is required to encrypt Xero refresh tokens");
  }

  if (!e.XERO_WEBHOOK_KEY) {
    warnings.push("XERO_WEBHOOK_KEY not set — POST /xero/webhook will reject all deliveries");
  }
  if (!e.FRONTEND_URL && !originOf(e.XERO_SIGNUP_URL)) {
    warnings.push("FRONTEND_URL (or XERO_SIGNUP_URL) not set — Xero connection approval emails will have no usable link");
  }
  const requested = (e.XERO_SCOPES || "").split(/[s,]+/).filter(Boolean);
  const deprecated = requested.filter((s) => DEPRECATED_SCOPES.includes(s));
  if (deprecated.length) {
    warnings.push(`XERO_SCOPES uses deprecated broad scope(s) ${deprecated.join(", ")} — apps created after 2 March 2026 cannot request them; use the granular scopes`);
  }
  if (!e.XERO_SUPPLIER_NAME) {
    warnings.push('XERO_SUPPLIER_NAME not set — bills will name the supplier "Dooit"; set it to the name on your invoices');
  }
  if (e.XERO_SALES_ACCOUNT_CODE || e.XERO_PAYMENT_ACCOUNT_CODE) {
    warnings.push("XERO_SALES_ACCOUNT_CODE / XERO_PAYMENT_ACCOUNT_CODE are ignored — each organisation maps its accounts in Settings → Xero");
  }

  return { enabled: errors.length === 0, errors, warnings };
};

const isXeroEnabled = () => validateXeroConfig().enabled;

module.exports = { SIGNUP_IDENTITY_SCOPES, getConfig, validateXeroConfig, isXeroEnabled, DEFAULT_SCOPES, DEPRECATED_SCOPES };
