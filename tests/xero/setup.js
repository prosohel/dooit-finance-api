// Env for every Xero test — set BEFORE the modules under test are required.
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.NODE_ENV = "test";
process.env.XERO_CLIENT_ID = "test-client-id";
process.env.XERO_CLIENT_SECRET = "test-client-secret";
process.env.XERO_REDIRECT_URI = "https://api.example.com/api/v1/xero/callback";
process.env.XERO_WEBHOOK_KEY = "test-webhook-key";
process.env.XERO_SUPPLIER_NAME = "Dooit Pty Ltd";
process.env.XERO_SUPPLIER_EMAIL = "billing@dooit.example";
process.env.FRONTEND_URL = "https://app.example.com";
