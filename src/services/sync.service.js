import {
  Activity,
  AssignmentSubmission,
  Certificate,
  ContactMessage,
  Coupon,
  CourseProgress,
  Enrollment,
  InternshipApplication,
  Note,
  Order,
  QuizAttempt,
  User,
  getSettings,
} from "../models/index.js";
import { protectCourse, sanitizeQuiz } from "./learning.service.js";
import { getCatalog } from "./catalog-cache.js";

const json = (docs) => docs.map((d) => d.toJSON());

/** Public settings any visitor may see. */
export async function publicSettings() {
  return toPublicSettings(await getSettings());
}

function toPublicSettings(s) {
  return {
    siteName: s.siteName,
    supportEmail: s.supportEmail,
    currency: s.currency,
    gstPercent: s.gstPercent,
    defaultPassingScore: s.defaultPassingScore,
    watchThresholdPercent: s.watchThresholdPercent,
    certificatePrefix: s.certificatePrefix,
    allowQuizRetakes: s.allowQuizRetakes,
    maintenanceMode: s.maintenanceMode,
  };
}

/** Learning data for a set of users, shaped like the frontend learning store. */
function shapeLearning(progressDocs, attemptDocs, noteDocs, quizById) {
  const progress = {};
  for (const p of progressDocs) {
    const { userId, id: _id, ...rest } = p.toJSON();
    void _id;
    progress[`${userId}:${p.courseId}`] = { ...rest, lessons: stripServerFields(rest.lessons) };
  }
  // Per-question review for past attempts: right/wrong always, answers only for passed quizzes.
  const passedQuiz = new Set(attemptDocs.filter((a) => a.passed).map((a) => `${a.userId}:${a.quizId}`));
  const attempts = [];
  const attemptOwners = {};
  for (const a of attemptDocs) {
    const { userId, ...rest } = a.toJSON();
    const quiz = quizById.get(a.quizId);
    if (quiz) {
      const reveal = passedQuiz.has(`${userId}:${a.quizId}`);
      rest.review = Object.fromEntries(
        quiz.questions.map((q) => [q.id, { correct: rest.answers?.[q.id] === q.correctOptionId, ...(reveal ? { correctOptionId: q.correctOptionId, explanation: q.explanation } : {}) }]),
      );
    }
    attempts.push(rest);
    attemptOwners[rest.id] = userId;
  }
  const notes = {};
  for (const n of noteDocs) {
    const { userId, ...rest } = n.toJSON();
    (notes[`${userId}:${n.courseId}`] ??= []).push(rest);
  }
  return { progress, attempts, attemptOwners, notes };
}

function stripServerFields(lessons = {}) {
  const out = {};
  for (const [id, lp] of Object.entries(lessons)) {
    const { lastEventAt: _a, videoDuration: _b, ...rest } = lp ?? {};
    void _a;
    void _b;
    out[id] = rest;
  }
  return out;
}

/**
 * One call that returns everything the signed-in user (or an anonymous
 * visitor) is allowed to see, in the exact shape of the frontend stores.
 *
 *  - anonymous: published catalogue (quizzes without answers), internships
 *  - student:   + own profile, enrollments, orders, certificates, applications,
 *                 submissions, activity and learning progress
 *  - admin:     everything, including drafts, answers and all users
 */
export async function buildSyncPayload(user) {
  const isAdmin = user?.role === "admin";
  const uid = user?._id;

  // One parallel round: the catalogue comes from memory, user data from the database.
  const [catalog, fullSettings, own] = await Promise.all([
    getCatalog(),
    getSettings(),
    !user
      ? null
      : isAdmin
        ? Promise.all([
            User.find().sort({ joinedAt: -1 }),
            Enrollment.find().sort({ enrolledAt: -1 }),
            Order.find().sort({ createdAt: -1 }),
            Certificate.find().sort({ issuedAt: -1 }),
            InternshipApplication.find().sort({ appliedAt: -1 }),
            AssignmentSubmission.find().sort({ submittedAt: -1 }),
            Activity.find().sort({ at: -1 }).limit(300),
            Coupon.find(),
            ContactMessage.find().sort({ createdAt: -1 }).limit(200),
            CourseProgress.find(),
            QuizAttempt.find().sort({ submittedAt: -1 }),
            Promise.resolve([]),
          ])
        : Promise.all([
            Promise.resolve([user]),
            Enrollment.find({ userId: uid }).sort({ enrolledAt: -1 }),
            Order.find({ userId: uid }).sort({ createdAt: -1 }),
            Certificate.find({ userId: uid }).sort({ issuedAt: -1 }),
            InternshipApplication.find({ userId: uid }).sort({ appliedAt: -1 }),
            AssignmentSubmission.find({ userId: uid }).sort({ submittedAt: -1 }),
            Activity.find({ userId: uid }).sort({ at: -1 }).limit(100),
            Promise.resolve([]),
            Promise.resolve([]),
            CourseProgress.find({ userId: uid }),
            QuizAttempt.find({ userId: uid }).sort({ submittedAt: -1 }),
            Note.find({ userId: uid }).sort({ createdAt: -1 }),
          ]),
  ]);
  const settings = isAdmin ? fullSettings : toPublicSettings(fullSettings);
  const [users = [], enrollments = [], orders = [], certificates = [], applications = [], submissions = [], activity = [], coupons = [], contactMessages = [], progressDocs = [], attemptDocs = [], noteDocs = []] = own ?? [];

  // Learners keep access to courses they own, even if a course was later unpublished.
  const enrolledIds = new Set(isAdmin ? [] : enrollments.filter((e) => e.status !== "refunded").map((e) => e.courseId));
  const courses = isAdmin ? catalog.courses : catalog.courses.filter((c) => c.status === "published" || enrolledIds.has(c.id));
  const visible = new Set(courses.map((c) => c.id));
  const quizzes = catalog.quizzes.filter((q) => visible.has(q.courseId));

  const base = {
    serverTime: new Date().toISOString(),
    me: user ? user.toJSON() : null,
    settings,
    categories: catalog.categories,
    instructors: catalog.instructors,
    courses: isAdmin ? courses : courses.map((c) => protectCourse(c, enrolledIds.has(c.id))),
    quizzes: isAdmin ? quizzes : quizzes.map((q) => sanitizeQuiz(q, settings)),
    assignments: catalog.assignments.filter((a) => visible.has(a.courseId)),
    internships: catalog.internships,
    certificatesIssued: catalog.certificatesIssued,
  };

  return {
    ...base,
    users: json(users),
    enrollments: json(enrollments),
    orders: json(orders),
    certificates: json(certificates),
    internshipApplications: json(applications),
    assignmentSubmissions: json(submissions),
    activity: json(activity),
    coupons: json(coupons),
    ...(isAdmin ? { contactMessages: json(contactMessages) } : {}),
    learning: shapeLearning(progressDocs, attemptDocs, noteDocs, catalog.quizById),
  };
}

export { stripServerFields };
