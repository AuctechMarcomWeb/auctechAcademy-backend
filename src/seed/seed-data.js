import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import {
  Activity,
  Assignment,
  AssignmentSubmission,
  Category,
  Certificate,
  Coupon,
  Counter,
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
  DEFAULT_SETTINGS,
  invalidateSettings,
} from "../models/index.js";
import { invalidateCatalog } from "../services/catalog-cache.js";

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(here, "data", `${name}.json`), "utf8"));
const withId = (list) => list.map(({ id, ...rest }) => ({ _id: id, ...rest }));
const daysFromNow = (d) => new Date(Date.now() + d * 86400000).toISOString();

export const DEMO_PASSWORD = "password123";

/**
 * Loads the demo dataset (the same catalogue, users, orders, certificates,
 * internships and learner progress the frontend shipped with).
 * `drop: true` wipes every collection first.
 */
export async function seedDatabase({ drop = true, log = () => {} } = {}) {
  invalidateCatalog();
  invalidateSettings();
  if (drop) {
    const collections = await mongoose.connection.db.listCollections().toArray();
    for (const c of collections) await mongoose.connection.db.collection(c.name).deleteMany({});
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const users = withId(load("users")).map((u) => ({ ...u, passwordHash }));

  const assignments = withId(load("assignments")).map(({ _deadlineOffsetDays, ...a }) => ({ ...a, deadline: _deadlineOffsetDays !== undefined ? daysFromNow(_deadlineOffsetDays) : a.deadline }));
  const internships = withId(load("internships")).map(({ _deadlineOffsetDays, _startOffsetDays, ...i }) => ({
    ...i,
    applicationDeadline: _deadlineOffsetDays !== undefined ? daysFromNow(_deadlineOffsetDays) : i.applicationDeadline,
    startDate: _startOffsetDays !== undefined ? daysFromNow(_startOffsetDays) : i.startDate,
  }));
  const coupons = load("coupons").map(({ code, ...c }) => ({ _id: code, ...c }));

  const steps = [
    [Category, withId(load("categories"))],
    [Instructor, withId(load("instructors"))],
    [Course, withId(load("courses"))],
    [Quiz, withId(load("quizzes"))],
    [Assignment, assignments],
    [User, users],
    [Coupon, coupons],
    [Order, withId(load("orders"))],
    [Enrollment, withId(load("enrollments"))],
    [Certificate, withId(load("certificates"))],
    [Internship, internships],
    [InternshipApplication, withId(load("internshipApplications"))],
    [AssignmentSubmission, withId(load("assignmentSubmissions"))],
    [Activity, withId(load("activity"))],
  ];
  for (const [Model, docs] of steps) {
    await Model.insertMany(docs, { ordered: true });
    log(`  ${Model.modelName.padEnd(22)} ${docs.length}`);
  }

  // Learner progress for the demo student (mid-way through Full Stack, Digital Marketing complete).
  const demo = load("demoProgress");
  let progressCount = 0;
  let attemptCount = 0;
  for (const [userId, perCourse] of Object.entries(demo)) {
    for (const [courseId, data] of Object.entries(perCourse)) {
      const { attempts = [], ...progress } = data;
      const now = new Date().toISOString();
      const lastActivity = [progress.startedAt, ...Object.values(progress.lessons ?? {}).map((l) => l.updatedAt), ...attempts.map((a) => a.submittedAt)].filter(Boolean).sort().at(-1);
      await CourseProgress.create({ userId, courseId, lessons: progress.lessons ?? {}, lastLessonId: progress.lastLessonId, startedAt: progress.startedAt ?? now, updatedAt: progress.updatedAt ?? lastActivity ?? now, completedAt: progress.completedAt });
      progressCount++;
      if (attempts.length) {
        await QuizAttempt.insertMany(attempts.map((a) => ({ ...a, userId })));
        attemptCount += attempts.length;
      }
    }
  }
  log(`  ${"CourseProgress".padEnd(22)} ${progressCount}`);
  log(`  ${"QuizAttempt".padEnd(22)} ${attemptCount}`);

  await Settings.create({ _id: "platform", ...DEFAULT_SETTINGS });
  await Counter.insertMany([
    { _id: "order", seq: 10200 },
    { _id: `certificate-${new Date().getFullYear()}`, seq: 200 },
  ]);
  invalidateCatalog();
  invalidateSettings();
}
