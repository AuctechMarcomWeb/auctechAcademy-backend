import { ApiError, notFound } from "../lib/http.js";
import { computeLockStates, summarizeCourse } from "../lib/curriculum.js";
import { getCatalog } from "./catalog-cache.js";
import {
  AssignmentSubmission,
  Certificate,
  CourseProgress,
  Enrollment,
  QuizAttempt,
  getSettings,
  logActivity,
  nextSeq,
} from "../models/index.js";

const json = (docs) => docs.map((d) => d.toJSON());

/**
 * Removes answers from a quiz before it is sent to a learner. Grading is
 * done on the server, so `correctOptionId` never leaves it for students.
 */
export function sanitizeQuiz(quiz, settings) {
  const q = typeof quiz.toJSON === "function" ? quiz.toJSON() : quiz;
  return {
    ...q,
    // With retakes disabled platform-wide, a quiz without its own limit allows one attempt.
    maxAttempts: q.maxAttempts ?? (settings && settings.allowQuizRetakes === false ? 1 : undefined),
    questions: (q.questions ?? []).map((qq) => ({ id: qq.id, prompt: qq.prompt, options: qq.options })),
  };
}

/**
 * Hides paid content from people who haven't bought the course: lesson video
 * URLs and downloadable resources are blanked except on free preview lessons.
 * Titles, descriptions and durations stay visible for the course page.
 */
export function protectCourse(course, canWatch) {
  const c = typeof course.toJSON === "function" ? course.toJSON() : course;
  if (canWatch) return c;
  return {
    ...c,
    modules: (c.modules ?? []).map((m) => ({
      ...m,
      lessons: (m.lessons ?? []).map((l) => (l.isPreview ? l : { ...l, videoUrl: "", resources: (l.resources ?? []).map((r) => ({ ...r, url: "" })) })),
    })),
  };
}

export async function activeEnrollment(userId, courseId) {
  return Enrollment.findOne({ userId, courseId, status: { $ne: "refunded" } });
}

export async function requireEnrollment(userId, courseId) {
  const enrollment = await activeEnrollment(userId, courseId);
  if (!enrollment) throw new ApiError("You are not enrolled in this course.", 403, "not_enrolled");
  return enrollment;
}

/** Everything the curriculum state machine needs for one learner + course (plain objects). */
export async function loadContext(userId, courseId) {
  // Course structure comes from the in-memory catalogue; learner data from the database (one round).
  const catalog = await getCatalog();
  const course = catalog.courseById.get(courseId);
  if (!course) throw notFound("Course");
  const quizzes = catalog.quizzes.filter((q) => q.courseId === courseId);
  const assignments = catalog.assignments.filter((a) => a.courseId === courseId);
  const [progress, attempts, submissions] = await Promise.all([
    CourseProgress.findOne({ userId, courseId }),
    QuizAttempt.find({ userId, courseId }),
    AssignmentSubmission.find({ userId, assignmentId: { $in: assignments.map((a) => a.id) } }),
  ]);
  return {
    course,
    quizzes,
    assignments,
    progress: progress?.toJSON(),
    progressDoc: progress,
    attempts: json(attempts),
    submissions: json(submissions),
  };
}

export async function ensureProgress(userId, courseId) {
  let progress = await CourseProgress.findOne({ userId, courseId });
  if (!progress) {
    const now = new Date().toISOString();
    progress = await CourseProgress.create({ userId, courseId, lessons: {}, startedAt: now, updatedAt: now });
  }
  return progress;
}

export function lockStateOf(ctx, itemId) {
  return computeLockStates(ctx).get(itemId) ?? "locked";
}

export async function issueCertificate({ user, course, completedAt, finalScore }) {
  const settings = await getSettings();
  const year = new Date().getFullYear();
  const seq = await nextSeq(`certificate-${year}`, 200);
  const id = `${settings.certificatePrefix}-${course.certificateCode}-${year}-${String(seq).padStart(6, "0")}`;
  const cert = await Certificate.create({
    _id: id,
    userId: user._id ?? user.id,
    courseId: course.id ?? course._id,
    studentName: user.name,
    courseTitle: course.title,
    issuedAt: new Date().toISOString(),
    completedAt,
    status: "valid",
    finalScore,
    kind: "course",
    verificationHistory: [],
  });
  await logActivity(user._id ?? user.id, "certificate_issued", `Certificate issued: ${course.title}`, course.id ?? course._id);
  return cert;
}

/**
 * Finalises a course: re-checks every requirement on the server, marks the
 * enrollment complete and issues (or returns the existing) certificate.
 */
export async function completeCourse(user, courseId) {
  const enrollment = await requireEnrollment(user._id, courseId);
  const ctx = await loadContext(user._id, courseId);
  const summary = summarizeCourse(ctx);
  if (!summary.allRequirementsMet) {
    throw new ApiError("Not every completion requirement has been met yet.", 412, "incomplete");
  }
  const existing = await Certificate.findOne({ userId: user._id, courseId, status: "valid" });
  if (existing) return { certificate: existing, enrollment, progress: ctx.progressDoc };

  const completedAt = new Date().toISOString();
  if (ctx.progressDoc && !ctx.progressDoc.completedAt) {
    ctx.progressDoc.completedAt = completedAt;
    await ctx.progressDoc.save();
  }
  if (enrollment.status !== "completed") {
    enrollment.status = "completed";
    enrollment.completedAt = completedAt;
    await enrollment.save();
  }
  await logActivity(user._id, "course_completed", `Completed ${ctx.course.title}`, courseId);
  const certificate = await issueCertificate({
    user,
    course: ctx.course,
    completedAt,
    finalScore: summary.finalAssessmentScore ?? summary.averageQuizScore,
  });
  return { certificate, enrollment, progress: ctx.progressDoc };
}
