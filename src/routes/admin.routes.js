import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { ApiError, notFound, parse, uid } from "../lib/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  Activity,
  Assignment,
  AssignmentSubmission,
  Category,
  Certificate,
  ContactMessage,
  Coupon,
  Course,
  CourseProgress,
  Enrollment,
  Instructor,
  Internship,
  InternshipApplication,
  Order,
  Quiz,
  QuizAttempt,
  Settings,
  User,
  getSettings,
  invalidateSettings,
  nextSeq,
} from "../models/index.js";
import { invalidateCatalog } from "../services/catalog-cache.js";
import { seedDatabase } from "../seed/seed-data.js";

const router = Router();
router.use(requireAuth, requireRole("admin"));

// Any admin change may touch the catalogue or settings: refresh the in-memory copies.
router.use((req, res, next) => {
  if (req.method !== "GET") {
    res.on("finish", () => {
      invalidateCatalog();
      invalidateSettings();
    });
  }
  next();
});
const json = (docs) => docs.map((d) => d.toJSON());

/** Upsert helper: client sends the full object with `id`; we store it as `_id`. */
async function upsert(Model, id, data) {
  const { id: _ignored, _id: _ignored2, ...rest } = data;
  void _ignored;
  void _ignored2;
  const existing = await Model.findById(id);
  if (existing) {
    existing.overwrite({ _id: id, ...rest });
    await existing.save();
    return existing;
  }
  return Model.create({ _id: id, ...rest });
}

/** Sets/clears a module's quizId or assignmentId (done in JS so it works on any MongoDB-compatible server). */
async function linkModule(courseId, moduleId, field, value) {
  const course = await Course.findById(courseId);
  if (!course) return;
  let changed = false;
  for (const m of course.modules) {
    if ((moduleId && m.id === moduleId) || (!moduleId && m[field] === value)) {
      m[field] = moduleId ? value : undefined;
      changed = true;
    }
  }
  if (changed) {
    course.markModified("modules");
    await course.save();
  }
}

/* ---------- Dashboard stats ---------- */

router.get("/stats", async (_req, res) => {
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const [totalStudents, totalCourses, revenueAgg, activeEnr, completed, activeStudents, certificatesIssued] = await Promise.all([
    User.countDocuments({ role: "student" }),
    Course.countDocuments({ status: "published" }),
    Order.aggregate([{ $match: { status: "successful" } }, { $group: { _id: null, total: { $sum: "$total" } } }]),
    Enrollment.countDocuments({ status: { $ne: "refunded" } }),
    Enrollment.countDocuments({ status: "completed" }),
    User.countDocuments({ role: "student", lastActiveAt: { $gt: cutoff } }),
    Certificate.countDocuments({ status: "valid" }),
  ]);
  res.json({
    totalStudents,
    totalCourses,
    totalRevenue: revenueAgg[0]?.total ?? 0,
    totalEnrollments: activeEnr,
    activeStudents,
    completionRate: activeEnr ? Math.round((completed / activeEnr) * 100) : 0,
    certificatesIssued,
  });
});

/* ---------- Users ---------- */

router.get("/users", async (req, res) => {
  const filter = req.query.role ? { role: req.query.role } : {};
  res.json(json(await User.find(filter).sort({ joinedAt: -1 })));
});

router.patch("/users/:id/status", async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(["active", "suspended"]) }), req.body);
  if (req.params.id === req.user._id) throw new ApiError("You cannot change your own status.", 400, "self");
  const user = await User.findById(req.params.id);
  if (!user) throw notFound("User");
  user.status = status;
  if (status === "suspended") user.tokenVersion = (user.tokenVersion ?? 0) + 1; // sign them out everywhere
  await user.save();
  res.json({ user: user.toJSON() });
});

/* ---------- Categories & instructors ---------- */

const categorySchema = z.object({ id: z.string().optional(), slug: z.string().trim().min(1), name: z.string().trim().min(1), description: z.string().default(""), icon: z.string().default("BookOpen") });

router.put("/categories/:id", async (req, res) => {
  const body = parse(categorySchema, req.body);
  res.json({ category: (await upsert(Category, req.params.id, body)).toJSON() });
});
router.post("/categories", async (req, res) => {
  const body = parse(categorySchema, req.body);
  res.status(201).json({ category: (await Category.create({ ...body, _id: body.id ?? uid("cat") })).toJSON() });
});
router.delete("/categories/:id", async (req, res) => {
  if (await Course.exists({ categoryId: req.params.id })) throw new ApiError("Move or delete the courses in this category first.", 409, "in_use");
  await Category.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
});

const instructorSchema = z.object({ id: z.string().optional(), name: z.string().min(1), title: z.string().default(""), bio: z.string().default(""), avatarUrl: z.string().optional(), rating: z.number().default(0), students: z.number().default(0), courses: z.number().default(0) });
router.get("/instructors", async (_req, res) => res.json(json(await Instructor.find())));
router.put("/instructors/:id", async (req, res) => res.json({ instructor: (await upsert(Instructor, req.params.id, parse(instructorSchema, req.body))).toJSON() }));
router.delete("/instructors/:id", async (req, res) => {
  if (await Course.exists({ instructorId: req.params.id })) throw new ApiError("This instructor still teaches courses.", 409, "in_use");
  await Instructor.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
});

/* ---------- Courses ---------- */

router.get("/courses", async (_req, res) => res.json(json(await Course.find().sort({ createdAt: -1 }))));

const lessonSchema = z.object({
  id: z.string(),
  moduleId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().default(""),
  videoUrl: z.string().default(""),
  durationSeconds: z.number().min(0).default(0),
  order: z.number().default(0),
  isPreview: z.boolean().optional(),
  resources: z.array(z.object({ id: z.string(), title: z.string(), type: z.enum(["pdf", "link", "zip", "code"]), url: z.string(), size: z.string().optional() })).default([]),
});
const courseSchema = z.object({
  id: z.string().optional(),
  slug: z.string().trim().min(1).regex(/^[a-z0-9-]+$/, "Slug can contain lowercase letters, numbers and dashes"),
  title: z.string().trim().min(3),
  subtitle: z.string().default(""),
  description: z.string().default(""),
  categoryId: z.string(),
  instructorId: z.string(),
  thumbnail: z.string().default(""),
  level: z.enum(["Beginner", "Intermediate", "Advanced"]),
  language: z.string().default("English"),
  price: z.number().min(0),
  originalPrice: z.number().min(0).default(0),
  rating: z.number().default(0),
  ratingCount: z.number().default(0),
  enrolledCount: z.number().default(0),
  modules: z.array(
    z.object({
      id: z.string(),
      courseId: z.string().optional(),
      title: z.string().min(1),
      description: z.string().default(""),
      order: z.number().default(0),
      lessons: z.array(lessonSchema).default([]),
      quizId: z.string().optional().nullable(),
      assignmentId: z.string().optional().nullable(),
      isFinalAssessment: z.boolean().optional().nullable(),
    }),
  ),
  outcomes: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  certificateCode: z.string().trim().min(2).max(6).regex(/^[A-Za-z]+$/, "Certificate code must be 2–6 letters"),
  status: z.enum(["published", "draft", "archived"]),
  isFeatured: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

function normaliseCourse(id, body) {
  const now = new Date().toISOString();
  return {
    ...body,
    certificateCode: body.certificateCode.toUpperCase(),
    modules: body.modules.map((m, mi) => ({
      ...m,
      courseId: id,
      order: m.order || mi + 1,
      quizId: m.quizId ?? undefined,
      assignmentId: m.assignmentId ?? undefined,
      isFinalAssessment: m.isFinalAssessment ?? undefined,
      lessons: m.lessons.map((l, li) => ({ ...l, moduleId: m.id, order: l.order || li + 1 })),
    })),
    createdAt: body.createdAt ?? now,
    updatedAt: now,
  };
}

router.post("/courses", async (req, res) => {
  const body = parse(courseSchema, req.body);
  const id = body.id ?? uid("crs");
  const course = await Course.create({ _id: id, ...normaliseCourse(id, body) });
  res.status(201).json({ course: course.toJSON() });
});

router.put("/courses/:id", async (req, res) => {
  const body = parse(courseSchema, req.body);
  const existing = await Course.findById(req.params.id);
  const data = normaliseCourse(req.params.id, { ...body, createdAt: existing?.createdAt ?? body.createdAt });
  // Learner counters are not editable from the form.
  if (existing) Object.assign(data, { enrolledCount: existing.enrolledCount, rating: existing.rating, ratingCount: existing.ratingCount });
  const course = await upsert(Course, req.params.id, data);
  res.json({ course: course.toJSON() });
});

router.patch("/courses/:id/status", async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(["published", "draft", "archived"]) }), req.body);
  const course = await Course.findById(req.params.id);
  if (!course) throw notFound("Course");
  course.status = status;
  course.updatedAt = new Date().toISOString();
  await course.save();
  res.json({ course: course.toJSON() });
});

router.delete("/courses/:id", async (req, res) => {
  if (await Enrollment.exists({ courseId: req.params.id, status: "active" })) {
    throw new ApiError("This course has active enrollments. Unpublish or archive it instead of deleting.", 409, "has_enrollments");
  }
  await Promise.all([Course.deleteOne({ _id: req.params.id }), Quiz.deleteMany({ courseId: req.params.id }), Assignment.deleteMany({ courseId: req.params.id })]);
  res.json({ ok: true });
});

/* ---------- Quizzes ---------- */

const quizSchema = z.object({
  id: z.string().optional(),
  courseId: z.string(),
  moduleId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  passingScore: z.number().min(0).max(100),
  timeLimitSeconds: z.number().min(0).optional().nullable(),
  maxAttempts: z.number().int().min(1).optional().nullable(),
  questions: z.array(
    z.object({ id: z.string(), prompt: z.string().min(1), options: z.array(z.object({ id: z.string(), text: z.string() })).min(2), correctOptionId: z.string(), explanation: z.string().optional() }),
  ),
});

router.get("/quizzes", async (_req, res) => res.json(json(await Quiz.find())));
router.put("/quizzes/:id", async (req, res) => {
  const body = parse(quizSchema, req.body);
  for (const q of body.questions) {
    if (!q.options.some((o) => o.id === q.correctOptionId)) throw new ApiError(`Question "${q.prompt}" has no valid correct answer.`, 422, "validation_error");
  }
  const quiz = await upsert(Quiz, req.params.id, { ...body, timeLimitSeconds: body.timeLimitSeconds ?? undefined, maxAttempts: body.maxAttempts ?? undefined });
  // Keep the module → quiz link in sync.
  await linkModule(body.courseId, body.moduleId, "quizId", quiz._id);
  res.json({ quiz: quiz.toJSON() });
});
router.delete("/quizzes/:id", async (req, res) => {
  const quiz = await Quiz.findById(req.params.id);
  if (!quiz) throw notFound("Quiz");
  await Quiz.deleteOne({ _id: quiz._id });
  await linkModule(quiz.courseId, null, "quizId", quiz._id);
  res.json({ ok: true });
});

/* ---------- Assignments & submissions ---------- */

const assignmentSchema = z.object({ id: z.string().optional(), courseId: z.string(), moduleId: z.string(), title: z.string().min(1), instructions: z.string().default(""), deadline: z.string(), maxMarks: z.number().min(1).default(100), allowResubmission: z.boolean().default(true) });

router.get("/assignments", async (_req, res) => res.json(json(await Assignment.find())));
router.put("/assignments/:id", async (req, res) => {
  const body = parse(assignmentSchema, req.body);
  const assignment = await upsert(Assignment, req.params.id, body);
  await linkModule(body.courseId, body.moduleId, "assignmentId", assignment._id);
  res.json({ assignment: assignment.toJSON() });
});
router.delete("/assignments/:id", async (req, res) => {
  const a = await Assignment.findById(req.params.id);
  if (!a) throw notFound("Assignment");
  await Assignment.deleteOne({ _id: a._id });
  await linkModule(a.courseId, null, "assignmentId", a._id);
  res.json({ ok: true });
});

router.get("/submissions", async (_req, res) => res.json(json(await AssignmentSubmission.find().sort({ submittedAt: -1 }))));
router.patch("/submissions/:id/review", async (req, res) => {
  const body = parse(z.object({ status: z.enum(["approved", "rejected", "under_review"]), feedback: z.string().max(5000).optional(), marks: z.number().min(0).optional(), grade: z.string().max(4).optional() }), req.body);
  const sub = await AssignmentSubmission.findById(req.params.id);
  if (!sub) throw notFound("Submission");
  Object.assign(sub, body, { reviewedAt: new Date().toISOString() });
  await sub.save();
  res.json({ submission: sub.toJSON() });
});

/* ---------- Enrollments & orders ---------- */

router.get("/enrollments", async (_req, res) => res.json(json(await Enrollment.find().sort({ enrolledAt: -1 }))));
router.get("/orders", async (_req, res) => res.json(json(await Order.find().sort({ createdAt: -1 }))));

/**
 * Marks an order refunded and revokes access. Issue the actual money refund
 * from the Razorpay dashboard (or call the Refunds API here).
 */
router.post("/orders/:id/refund", async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order || order.status !== "successful") throw new ApiError("Only successful payments can be refunded.", 400, "not_refundable");
  order.status = "refunded";
  order.refundedAt = new Date().toISOString();
  await order.save();
  const enrollment = await Enrollment.findOne({ orderId: order._id });
  if (enrollment) {
    enrollment.status = "refunded";
    await enrollment.save();
    await Course.updateOne({ _id: order.courseId, enrolledCount: { $gt: 0 } }, { $inc: { enrolledCount: -1 } });
  }
  res.json({ order: order.toJSON(), enrollment: enrollment?.toJSON() });
});

/** Grant a course without payment (scholarships, corporate batches). */
router.post("/enrollments", async (req, res) => {
  const { userId, courseId } = parse(z.object({ userId: z.string(), courseId: z.string() }), req.body);
  if (!(await User.exists({ _id: userId }))) throw notFound("User");
  if (!(await Course.exists({ _id: courseId }))) throw notFound("Course");
  if (await Enrollment.exists({ userId, courseId, status: { $ne: "refunded" } })) throw new ApiError("Already enrolled.", 409, "already_enrolled");
  const enrollment = await Enrollment.create({ userId, courseId, status: "active" });
  res.status(201).json({ enrollment: enrollment.toJSON() });
});

/* ---------- Coupons ---------- */

const couponSchema = z.object({ code: z.string().trim().min(3).max(30), type: z.enum(["percent", "flat"]), value: z.number().min(0), minAmount: z.number().min(0).optional(), description: z.string().default(""), active: z.boolean().default(true) });
router.get("/coupons", async (_req, res) => res.json(json(await Coupon.find())));
router.put("/coupons/:code", async (req, res) => {
  const body = parse(couponSchema, { ...req.body, code: req.params.code });
  if (body.type === "percent" && body.value > 100) throw new ApiError("Percentage discount cannot exceed 100.", 422, "validation_error");
  const { code, ...rest } = body;
  const coupon = await upsert(Coupon, code.toUpperCase(), rest);
  res.json({ coupon: coupon.toJSON() });
});
router.delete("/coupons/:code", async (req, res) => {
  await Coupon.deleteOne({ _id: req.params.code.toUpperCase() });
  res.json({ ok: true });
});

/* ---------- Certificates ---------- */

router.get("/certificates", async (_req, res) => res.json(json(await Certificate.find().sort({ issuedAt: -1 }))));
router.post("/certificates/:id/revoke", async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(3, "Give a reason").max(500) }), req.body);
  const cert = await Certificate.findById(req.params.id);
  if (!cert) throw notFound("Certificate");
  if (cert.status === "revoked") throw new ApiError("Certificate is already revoked", 409, "already_revoked");
  Object.assign(cert, { status: "revoked", revokedReason: reason, revokedAt: new Date().toISOString() });
  await cert.save();
  res.json({ certificate: cert.toJSON() });
});
router.post("/certificates/:id/reinstate", async (req, res) => {
  const cert = await Certificate.findById(req.params.id);
  if (!cert) throw notFound("Certificate");
  cert.status = "valid";
  cert.revokedReason = undefined;
  cert.revokedAt = undefined;
  await cert.save();
  res.json({ certificate: cert.toJSON() });
});

/* ---------- Internships & applications ---------- */

const internshipSchema = z.object({
  id: z.string().optional(),
  slug: z.string().trim().min(1),
  title: z.string().trim().min(3),
  department: z.string().default(""),
  description: z.string().default(""),
  durationWeeks: z.number().int().min(1),
  workMode: z.enum(["Remote", "Hybrid", "On-site"]),
  eligibility: z.array(z.string()).default([]),
  skillsRequired: z.array(z.string()).default([]),
  learningOutcomes: z.array(z.string()).default([]),
  stipend: z.enum(["Paid", "Unpaid", "Performance-based"]),
  stipendAmount: z.number().min(0).optional().nullable(),
  applicationDeadline: z.string(),
  openings: z.number().int().min(1),
  mentorName: z.string().default(""),
  mentorTitle: z.string().default(""),
  status: z.enum(["open", "closed"]),
  startDate: z.string(),
  thumbnail: z.string().default(""),
});

router.put("/internships/:id", async (req, res) => {
  const body = parse(internshipSchema, req.body);
  res.json({ internship: (await upsert(Internship, req.params.id, { ...body, stipendAmount: body.stipendAmount ?? undefined })).toJSON() });
});
router.delete("/internships/:id", async (req, res) => {
  if (await InternshipApplication.exists({ internshipId: req.params.id, status: { $in: ["active", "selected"] } })) {
    throw new ApiError("This internship has active interns. Close it instead of deleting.", 409, "in_use");
  }
  await Internship.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
});

router.get("/applications", async (_req, res) => res.json(json(await InternshipApplication.find().sort({ appliedAt: -1 }))));

const statusEnum = z.enum(["applied", "shortlisted", "interview", "selected", "rejected", "active", "completed"]);
router.patch("/applications/:id", async (req, res) => {
  const body = parse(
    z.object({
      status: statusEnum.optional(),
      mentor: z.string().optional(),
      attendance: z.object({ present: z.number().min(0), total: z.number().min(0) }).optional(),
      performanceScore: z.number().min(0).max(100).optional(),
      tasks: z.array(z.object({ id: z.string(), title: z.string(), dueDate: z.string(), status: z.enum(["todo", "in_progress", "submitted", "approved"]), submittedAt: z.string().optional(), feedback: z.string().optional() })).optional(),
      issueCertificate: z.boolean().optional(),
    }),
    req.body,
  );
  const app = await InternshipApplication.findById(req.params.id);
  if (!app) throw notFound("Application");
  const { issueCertificate, ...patch } = body;
  Object.assign(app, patch);

  // Completing an internship can issue an internship certificate.
  if (issueCertificate && app.status === "completed" && !app.certificateId) {
    const [internship, user, settings] = await Promise.all([Internship.findById(app.internshipId), User.findById(app.userId), getSettings()]);
    const year = new Date().getFullYear();
    const seq = await nextSeq(`certificate-${year}`, 200);
    const cert = await Certificate.create({
      _id: `${settings.certificatePrefix}-INT-${year}-${String(seq).padStart(6, "0")}`,
      userId: app.userId,
      courseId: app.internshipId,
      studentName: user?.name ?? app.fullName,
      courseTitle: internship?.title ?? "Internship",
      completedAt: new Date().toISOString(),
      finalScore: app.performanceScore ?? 0,
      kind: "internship",
    });
    app.certificateId = cert._id;
  }
  await app.save();
  res.json({ application: app.toJSON() });
});

/* ---------- Contact messages ---------- */

router.get("/contact-messages", async (_req, res) => res.json(json(await ContactMessage.find().sort({ createdAt: -1 }))));
router.patch("/contact-messages/:id", async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(["new", "read", "resolved"]) }), req.body);
  const msg = await ContactMessage.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!msg) throw notFound("Message");
  res.json({ message: msg.toJSON() });
});

/* ---------- Learning analytics ---------- */

router.get("/learning", async (_req, res) => {
  const [progress, attempts] = await Promise.all([CourseProgress.find(), QuizAttempt.find()]);
  res.json({ progress: json(progress), attempts: json(attempts) });
});

router.get("/activity", async (_req, res) => res.json(json(await Activity.find().sort({ at: -1 }).limit(300))));

/* ---------- Settings ---------- */

router.get("/settings", async (_req, res) => res.json(await getSettings()));
router.put("/settings", async (req, res) => {
  const body = parse(
    z.object({
      siteName: z.string().min(1),
      supportEmail: z.string().email(),
      gstPercent: z.number().min(0).max(50),
      defaultPassingScore: z.number().min(0).max(100),
      watchThresholdPercent: z.number().min(10).max(100),
      certificatePrefix: z.string().regex(/^[A-Z]{2,6}$/, "2–6 capital letters"),
      allowQuizRetakes: z.boolean(),
      maintenanceMode: z.boolean(),
    }).partial(),
    req.body,
  );
  await Settings.updateOne({ _id: "platform" }, { $set: body }, { upsert: true });
  res.json(await getSettings());
});

/** Wipes and re-seeds the database with the demo dataset (only when ALLOW_DEMO_RESET=true). */
router.post("/reset-demo", async (_req, res) => {
  if (!env.ALLOW_DEMO_RESET) throw new ApiError("Demo reset is disabled on this server.", 403, "disabled");
  await seedDatabase({ drop: true });
  res.json({ ok: true });
});

export default router;
