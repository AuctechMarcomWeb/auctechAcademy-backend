import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { env } from "../config/env.js";
import { notFound, parse, uid } from "../lib/http.js";
import { optionalAuth } from "../middleware/auth.js";
import { Assignment, Category, Certificate, ContactMessage, Course, Instructor, Internship, Quiz, getSettings } from "../models/index.js";
import { protectCourse, sanitizeQuiz } from "../services/learning.service.js";
import { buildSyncPayload, publicSettings } from "../services/sync.service.js";

const router = Router();
const json = (docs) => docs.map((d) => d.toJSON());

router.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/** Feature flags the apps need before anyone signs in. */
router.get("/config", async (_req, res) => {
  res.json({
    paymentMode: env.paymentMode,
    razorpayKeyId: env.paymentMode === "razorpay" ? env.RAZORPAY_KEY_ID : null,
    demoPayments: env.ALLOW_DEMO_PAYMENTS && env.paymentMode === "demo",
    googleEnabled: env.googleEnabled,
    demoReset: env.ALLOW_DEMO_RESET,
    settings: await publicSettings(),
  });
});

/** Single bootstrap call used by both apps to fill their client-side cache. */
router.get("/sync", optionalAuth, async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await buildSyncPayload(req.user));
});

/* ---------- Catalogue ---------- */

router.get("/categories", async (_req, res) => {
  const [categories, counts] = await Promise.all([
    Category.find().sort({ name: 1 }),
    Course.aggregate([{ $match: { status: "published" } }, { $group: { _id: "$categoryId", n: { $sum: 1 } } }]),
  ]);
  const byId = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  res.json(categories.map((c) => ({ ...c.toJSON(), courseCount: byId[c._id] ?? 0 })));
});

router.get("/instructors", async (_req, res) => res.json(json(await Instructor.find())));

const courseDuration = (c) => (c.modules ?? []).reduce((acc, m) => acc + (m.lessons ?? []).reduce((a, l) => a + (l.durationSeconds ?? 0), 0), 0);

/** GET /api/courses?q=&categories=a,b&levels=Beginner&price=under_2000&duration=short&minRating=4&sort=popular&page=1&pageSize=9 */
router.get("/courses", async (req, res) => {
  const q = parse(
    z.object({
      q: z.string().optional(),
      categories: z.string().optional(),
      levels: z.string().optional(),
      price: z.enum(["all", "free", "paid", "under_2000", "2000_5000", "above_5000"]).default("all"),
      duration: z.enum(["all", "short", "medium", "long"]).default("all"),
      minRating: z.coerce.number().min(0).max(5).default(0),
      sort: z.enum(["popular", "newest", "price_asc", "price_desc", "rating"]).default("popular"),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(9),
    }),
    req.query,
  );
  const filter = { status: "published" };
  const cats = q.categories?.split(",").filter(Boolean);
  const levels = q.levels?.split(",").filter(Boolean);
  if (cats?.length) filter.categoryId = { $in: cats };
  if (levels?.length) filter.level = { $in: levels };
  if (q.minRating > 0) filter.rating = { $gte: q.minRating };
  const priceFilter = { free: { $eq: 0 }, paid: { $gt: 0 }, under_2000: { $lt: 2000 }, "2000_5000": { $gte: 2000, $lte: 5000 }, above_5000: { $gt: 5000 } }[q.price];
  if (priceFilter) filter.price = priceFilter;

  let list = (await Course.find(filter)).map((c) => protectCourse(c, false));
  if (q.q?.trim()) {
    const needle = q.q.trim().toLowerCase();
    list = list.filter((c) => c.title.toLowerCase().includes(needle) || c.subtitle.toLowerCase().includes(needle) || c.skills.some((s) => s.toLowerCase().includes(needle)));
  }
  if (q.duration !== "all") {
    list = list.filter((c) => {
      const h = courseDuration(c) / 3600;
      return q.duration === "short" ? h < 3 : q.duration === "medium" ? h >= 3 && h <= 6 : h > 6;
    });
  }
  const sorters = {
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    price_asc: (a, b) => a.price - b.price,
    price_desc: (a, b) => b.price - a.price,
    rating: (a, b) => b.rating - a.rating || b.ratingCount - a.ratingCount,
    popular: (a, b) => b.enrolledCount - a.enrolledCount,
  };
  list.sort(sorters[q.sort]);
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / q.pageSize));
  const page = Math.min(q.page, totalPages);
  res.json({ items: list.slice((page - 1) * q.pageSize, page * q.pageSize), total, page, pageSize: q.pageSize, totalPages });
});

router.get("/courses/featured", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 4, 20);
  res.json((await Course.find({ status: "published", isFeatured: true }).limit(limit)).map((c) => protectCourse(c, false)));
});

router.get("/courses/slug/:slug", async (req, res) => {
  const course = await Course.findOne({ slug: req.params.slug, status: "published" });
  if (!course) throw notFound("Course");
  res.json(protectCourse(course, false));
});

router.get("/courses/:id", async (req, res) => {
  const course = await Course.findOne({ _id: req.params.id, status: "published" });
  if (!course) throw notFound("Course");
  res.json(protectCourse(course, false));
});

/** Quizzes (without answers) and assignments for a course. */
router.get("/courses/:id/curriculum", async (req, res) => {
  const [quizzes, assignments] = await Promise.all([Quiz.find({ courseId: req.params.id }), Assignment.find({ courseId: req.params.id })]);
  const settings = await getSettings();
  res.json({ quizzes: quizzes.map((q) => sanitizeQuiz(q, settings)), assignments: json(assignments) });
});

router.get("/internships", async (_req, res) => res.json(json(await Internship.find().sort({ applicationDeadline: -1 }))));

router.get("/internships/:slug", async (req, res) => {
  const internship = await Internship.findOne({ slug: req.params.slug });
  if (!internship) throw notFound("Internship");
  res.json(internship.toJSON());
});

/* ---------- Certificate verification (public) ---------- */

const CERTIFICATE_ID_PATTERN = /^[A-Z]{2,6}-[A-Z]{2,6}-\d{4}-\d{6}$/;
const verifyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

async function verify(rawId, source) {
  const id = String(rawId ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!id) return { status: "invalid", certificateId: id, reason: "No certificate ID was provided." };
  if (!CERTIFICATE_ID_PATTERN.test(id)) {
    return { status: "invalid", certificateId: id, reason: "The ID does not match the Auctech certificate format (e.g. AUC-DM-2026-000124)." };
  }
  const cert = await Certificate.findById(id);
  if (!cert) return { status: "not_found", certificateId: id };
  const result = cert.status === "valid" ? "valid" : "revoked";
  cert.verificationHistory.unshift({ id: uid("ver"), at: new Date().toISOString(), result, source });
  if (cert.verificationHistory.length > 500) cert.verificationHistory = cert.verificationHistory.slice(0, 500);
  await cert.save();
  const { userId: _u, verificationHistory: _v, ...publicCert } = cert.toJSON();
  void _u;
  void _v;
  return { status: result, certificate: { ...publicCert, verificationHistory: [] } };
}

router.get("/certificates/verify/:id", verifyLimiter, async (req, res) => {
  const source = ["qr", "web", "api"].includes(req.query.source) ? req.query.source : "api";
  res.json(await verify(req.params.id, source));
});

router.post("/certificates/verify", verifyLimiter, async (req, res) => {
  const body = parse(z.object({ id: z.string().max(64), source: z.enum(["qr", "web", "api"]).default("web") }), req.body);
  res.json(await verify(body.id, body.source));
});

/* ---------- Contact form ---------- */

const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: env.isProd ? 10 : 500, standardHeaders: true, legacyHeaders: false });

router.post("/contact", contactLimiter, async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(80),
      email: z.string().trim().email(),
      phone: z.string().trim().max(20).optional(),
      subject: z.string().trim().max(150).optional(),
      topic: z.string().trim().max(60).optional(),
      message: z.string().trim().min(10, "Message is too short").max(5000),
    }),
    req.body,
  );
  const msg = await ContactMessage.create(body);
  res.status(201).json({ ok: true, id: msg._id });
});

export default router;
