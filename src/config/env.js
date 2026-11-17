/**
 * Central configuration. Every value comes from environment variables
 * (see .env.example) with safe development defaults.
 */

const bool = (v, fallback = false) => (v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(String(v).toLowerCase()));
const list = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);

const NODE_ENV = process.env.NODE_ENV ?? "development";
const PORT = Number(process.env.PORT ?? 5000);

export const env = {
  NODE_ENV,
  isProd: NODE_ENV === "production",
  isTest: NODE_ENV === "test",
  PORT,

  MONGODB_URI: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/auctech_academy",

  /** Public URL of this API (used to build absolute upload URLs and the Google OAuth callback). */
  API_PUBLIC_URL: (process.env.API_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, ""),
  /** Student-facing website (frontend app). */
  FRONTEND_URL: (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  /** Admin portal (admin app). */
  ADMIN_URL: (process.env.ADMIN_URL ?? "http://localhost:3001").replace(/\/$/, ""),
  /** Extra origins allowed by CORS, comma separated. Use "*" to allow requests from any website. */
  CORS_ORIGINS: list(process.env.CORS_ORIGINS),

  JWT_SECRET: process.env.JWT_SECRET ?? "dev-only-change-me-please-0123456789",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? "7d",

  /** "razorpay" when RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET are set, otherwise "demo" (simulated gateway). */
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID ?? "",
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET ?? "",
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",
  /** Allow the simulated payment dialog. Never enable in production with real money. */
  ALLOW_DEMO_PAYMENTS: bool(process.env.ALLOW_DEMO_PAYMENTS, NODE_ENV !== "production"),

  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "",

  SMTP_HOST: process.env.SMTP_HOST ?? "",
  SMTP_PORT: Number(process.env.SMTP_PORT ?? 587),
  SMTP_USER: process.env.SMTP_USER ?? "",
  SMTP_PASS: process.env.SMTP_PASS ?? "",
  SMTP_FROM: process.env.SMTP_FROM ?? "Auctech Academy <academy@auctech.in>",

  UPLOAD_DIR: process.env.UPLOAD_DIR ?? "uploads",
  MAX_UPLOAD_MB: Number(process.env.MAX_UPLOAD_MB ?? 200),

  /** Lets an admin wipe and re-seed the database from Admin → Settings. Turn off in production. */
  ALLOW_DEMO_RESET: bool(process.env.ALLOW_DEMO_RESET, NODE_ENV !== "production"),
};

/** CORS_ORIGINS=* → accept browser requests from any origin (auth uses Bearer tokens, not cookies). */
env.corsAllowAll = env.CORS_ORIGINS.includes("*");

env.paymentMode = env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? "razorpay" : "demo";
env.googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

if (env.isProd && (env.JWT_SECRET.startsWith("dev-only") || env.JWT_SECRET.startsWith("change-me") || env.JWT_SECRET.length < 32)) {
  throw new Error("JWT_SECRET must be set to a random string of at least 32 characters in production (e.g. `openssl rand -hex 32`).");
}
