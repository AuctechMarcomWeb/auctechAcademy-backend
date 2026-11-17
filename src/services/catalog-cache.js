import { Assignment, Category, Certificate, Course, Instructor, Internship, Quiz } from "../models/index.js";

/**
 * In-memory copy of the catalogue (categories, instructors, courses, quizzes,
 * assignments, internships) shared by every request.
 *
 * The catalogue is the same for everyone and changes only when an admin edits
 * it, so keeping it in memory removes most database round trips from page
 * loads — important when MongoDB is remote (e.g. Atlas). Admin writes clear
 * it immediately (see admin.routes.js); the short TTL keeps several server
 * instances in step and picks up counters such as enrolledCount.
 *
 * Objects returned here are shared: never mutate them — copy first.
 */

const TTL_MS = 30_000;
let cache = null;
let loadedAt = 0;
let inflight = null;
let generation = 0;

const json = (docs) => docs.map((d) => d.toJSON());

async function load() {
  const startedGeneration = generation;
  const [categories, instructors, courses, quizzes, assignments, internships, certificatesIssued] = await Promise.all([
    Category.find().sort({ name: 1 }),
    Instructor.find(),
    Course.find().sort({ createdAt: -1 }),
    Quiz.find(),
    Assignment.find(),
    Internship.find().sort({ applicationDeadline: -1 }),
    Certificate.countDocuments({ status: "valid" }),
  ]);
  const data = {
    categories: json(categories),
    instructors: json(instructors),
    courses: json(courses),
    quizzes: json(quizzes),
    assignments: json(assignments),
    internships: json(internships),
    certificatesIssued,
  };
  data.courseById = new Map(data.courses.map((c) => [c.id, c]));
  data.quizById = new Map(data.quizzes.map((q) => [q.id, q]));
  data.assignmentById = new Map(data.assignments.map((a) => [a.id, a]));
  // Don't store a result that an admin write invalidated while we were loading.
  if (startedGeneration === generation) {
    cache = data;
    loadedAt = Date.now();
  }
  return data;
}

export async function getCatalog() {
  if (cache && Date.now() - loadedAt < TTL_MS) return cache;
  inflight ??= load().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function invalidateCatalog() {
  generation += 1;
  cache = null;
}
