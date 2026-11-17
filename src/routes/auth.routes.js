import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { env } from "../config/env.js";
import { ApiError, parse } from "../lib/http.js";
import { sendMail } from "../lib/mailer.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import { User } from "../models/index.js";

const router = Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: env.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false, message: { message: "Too many attempts. Please wait a few minutes and try again.", code: "rate_limited" } });

const email = z.string().trim().toLowerCase().email("Enter a valid email address");
const password = z.string().min(8, "Password must be at least 8 characters").max(128);

const session = (user) => ({ token: signToken(user), user: user.toJSON() });

router.post("/register", authLimiter, async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2, "Enter your full name").max(80), email, password, phone: z.string().trim().max(20).optional() }), req.body);
  if (await User.exists({ email: body.email })) {
    throw new ApiError("An account with this email already exists. Try logging in.", 409, "email_taken");
  }
  const user = await User.create({
    name: body.name,
    email: body.email,
    phone: body.phone || undefined,
    role: "student",
    passwordHash: await bcrypt.hash(body.password, 10),
    lastActiveAt: new Date().toISOString(),
  });
  res.status(201).json(session(user));
});

router.post("/login", authLimiter, async (req, res) => {
  const body = parse(z.object({ email, password: z.string().min(1, "Enter your password") }), req.body);
  const user = await User.findOne({ email: body.email });
  if (!user) throw new ApiError("No account found with that email address.", 401, "invalid_credentials");
  if (!user.passwordHash) throw new ApiError("This account uses Google sign-in. Continue with Google instead.", 401, "use_google");
  if (!(await bcrypt.compare(body.password, user.passwordHash))) throw new ApiError("Incorrect password. Please try again.", 401, "invalid_credentials");
  if (user.status === "suspended") throw new ApiError("This account has been suspended. Contact support.", 403, "suspended");
  user.lastActiveAt = new Date().toISOString();
  await user.save();
  res.json(session(user));
});

/** Tokens are stateless; logout is client-side. `?all=1` signs out every device. */
router.post("/logout", requireAuth, async (req, res) => {
  if (req.query.all) await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => res.json({ user: req.user.toJSON() }));

router.patch("/me", requireAuth, async (req, res) => {
  const opt = (max) => z.string().trim().max(max).optional().or(z.literal("").transform(() => undefined));
  const body = parse(
    z.object({ name: z.string().trim().min(2).max(80).optional(), phone: opt(20), headline: opt(120), bio: opt(1000), location: opt(80), avatarUrl: opt(500) }),
    req.body,
  );
  for (const [k, v] of Object.entries(body)) req.user[k] = v;
  await req.user.save();
  res.json({ user: req.user.toJSON() });
});

router.put("/me/notifications", requireAuth, async (req, res) => {
  const body = parse(z.object({ courseUpdates: z.boolean(), assessmentReminders: z.boolean(), internshipAlerts: z.boolean(), marketing: z.boolean() }).partial(), req.body);
  req.user.notificationPrefs = { ...(req.user.notificationPrefs?.toObject?.() ?? req.user.notificationPrefs ?? {}), ...body };
  await req.user.save();
  res.json({ user: req.user.toJSON() });
});

router.post("/change-password", requireAuth, async (req, res) => {
  const body = parse(z.object({ current: z.string().min(1), next: password }), req.body);
  const user = req.user;
  if (user.passwordHash && !(await bcrypt.compare(body.current, user.passwordHash))) {
    throw new ApiError("Current password is incorrect.", 400, "invalid_password");
  }
  user.passwordHash = await bcrypt.hash(body.next, 10);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  res.json({ ok: true, ...session(user) });
});

router.post("/forgot-password", authLimiter, async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  const user = await User.findOne({ email: body.email });
  if (user) {
    const raw = randomBytes(32).toString("hex");
    user.passwordReset = { tokenHash: createHash("sha256").update(raw).digest("hex"), expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
    await user.save();
    const link = `${user.role === "admin" ? env.ADMIN_URL : env.FRONTEND_URL}/reset-password?token=${raw}&email=${encodeURIComponent(user.email)}`;
    await sendMail({
      to: user.email,
      subject: "Reset your Auctech Academy password",
      text: `Hi ${user.name},\n\nUse this link to choose a new password (valid for 1 hour):\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
    });
  }
  // Always succeed so the response does not reveal which emails exist.
  res.json({ ok: true });
});

router.post("/reset-password", authLimiter, async (req, res) => {
  const body = parse(z.object({ email, token: z.string().min(10), password }), req.body);
  const user = await User.findOne({ email: body.email });
  const hash = createHash("sha256").update(body.token).digest("hex");
  if (!user || user.passwordReset?.tokenHash !== hash || !user.passwordReset?.expiresAt || user.passwordReset.expiresAt < new Date()) {
    throw new ApiError("This reset link is invalid or has expired. Request a new one.", 400, "invalid_reset_token");
  }
  user.passwordHash = await bcrypt.hash(body.password, 10);
  user.passwordReset = undefined;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  res.json(session(user));
});

/* ---------- Google OAuth (authorization-code flow) ---------- */

const GOOGLE_CALLBACK = () => `${env.API_PUBLIC_URL}/api/auth/google/callback`;
// Only our own apps may receive a sign-in token (a "*" in CORS_ORIGINS does not apply here).
const allowedReturn = (url) => [env.FRONTEND_URL, env.ADMIN_URL, ...env.CORS_ORIGINS.filter((o) => o !== "*")].some((o) => url === o || url.startsWith(`${o}/`));

router.get("/google", (req, res) => {
  if (!env.googleEnabled) throw new ApiError("Google sign-in is not configured on the server.", 501, "oauth_not_configured");
  const returnTo = typeof req.query.returnTo === "string" && allowedReturn(req.query.returnTo) ? req.query.returnTo : `${env.FRONTEND_URL}/auth/callback`;
  const state = jwt.sign({ returnTo, nonce: randomBytes(8).toString("hex") }, env.JWT_SECRET, { expiresIn: "10m" });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_CALLBACK(),
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get("/google/callback", async (req, res) => {
  let returnTo = `${env.FRONTEND_URL}/auth/callback`;
  const fail = (msg) => res.redirect(`${returnTo}#error=${encodeURIComponent(msg)}`);
  try {
    const state = jwt.verify(String(req.query.state ?? ""), env.JWT_SECRET);
    returnTo = state.returnTo;
  } catch {
    return fail("Sign-in session expired. Please try again.");
  }
  if (req.query.error || !req.query.code) return fail("Google sign-in was cancelled.");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: String(req.query.code), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_CALLBACK(), grant_type: "authorization_code" }),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.access_token) return fail("Google did not accept the sign-in request.");

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const info = await infoRes.json().catch(() => ({}));
  if (!info.email || info.email_verified === false) return fail("Your Google account email is not verified.");

  let user = await User.findOne({ $or: [{ googleId: info.sub }, { email: info.email.toLowerCase() }] });
  if (!user) {
    user = await User.create({ name: info.name || info.email.split("@")[0], email: info.email.toLowerCase(), googleId: info.sub, avatarUrl: info.picture, role: "student" });
  } else if (!user.googleId) {
    user.googleId = info.sub;
    if (!user.avatarUrl && info.picture) user.avatarUrl = info.picture;
  }
  if (user.status === "suspended") return fail("This account has been suspended. Contact support.");
  user.lastActiveAt = new Date().toISOString();
  await user.save();
  res.redirect(`${returnTo}#token=${encodeURIComponent(signToken(user))}`);
});

export default router;
