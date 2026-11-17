import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { ApiError, notFound, parse } from "../lib/http.js";
import { findLesson } from "../lib/curriculum.js";
import { requireAuth } from "../middleware/auth.js";
import {
  Assignment,
  AssignmentSubmission,
  Course,
  CourseProgress,
  Note,
  Quiz,
  QuizAttempt,
  Upload,
  getSettings,
  logActivity,
} from "../models/index.js";
import { completeCourse, ensureProgress, loadContext, lockStateOf, requireEnrollment } from "../services/learning.service.js";
import { stripServerFields } from "../services/sync.service.js";

const router = Router();
router.use(requireAuth);

/** Forward-seek tolerance and the max playback speed we accept when checking reported positions. */
const SEEK_TOLERANCE_SECONDS = 1.5;
const MAX_PLAYBACK_RATE = 2.5;
const BATCH_SLACK_SECONDS = 6;
/** Longest gap between two reports that still earns watch time (the player reports every ~5 s). */
const MAX_CREDITED_GAP_SECONDS = 30;

const progressOut = (doc) => {
  if (!doc) return undefined;
  const { userId: _u, id: _i, ...rest } = doc.toJSON();
  void _u;
  void _i;
  return { ...rest, lessons: stripServerFields(rest.lessons) };
};

/** Full learning state for one course: progress, attempts, notes and submissions. */
router.get("/courses/:courseId", async (req, res) => {
  await requireEnrollment(req.user._id, req.params.courseId);
  const ctx = await loadContext(req.user._id, req.params.courseId);
  const notes = await Note.find({ userId: req.user._id, courseId: req.params.courseId }).sort({ createdAt: -1 });
  res.json({ progress: progressOut(ctx.progressDoc), attempts: ctx.attempts, submissions: ctx.submissions, notes: notes.map((n) => n.toJSON()) });
});

/**
 * Playback telemetry, batched by the player every few seconds:
 *   { events: [{ lessonId, position, delta, duration }] }
 * The server only lets `maxPosition` grow as fast as real time allows
 * (plus a small slack), so jumping straight to the end is not accepted.
 */
router.post("/courses/:courseId/playback", async (req, res) => {
  const { courseId } = req.params;
  const body = parse(
    z.object({
      events: z.array(z.object({ lessonId: z.string(), position: z.number().min(0), delta: z.number().min(0).max(600), duration: z.number().min(0).max(86400) })).min(1).max(200),
    }),
    req.body,
  );
  await requireEnrollment(req.user._id, courseId);
  const ctx = await loadContext(req.user._id, courseId);
  const progress = ctx.progressDoc ?? (await ensureProgress(req.user._id, courseId));
  const lessons = { ...(progress.lessons ?? {}) };
  const now = new Date();
  const nowIso = now.toISOString();

  for (const ev of body.events) {
    if (!findLesson(ctx.course, ev.lessonId)) continue;
    const state = lockStateOf({ ...ctx, progress: { lessons } }, ev.lessonId);
    if (state === "locked") continue; // ignore telemetry for locked content
    const prev = lessons[ev.lessonId] ?? { lessonId: ev.lessonId, maxPosition: 0, watchedSeconds: 0, lastPosition: 0, completed: false, updatedAt: nowIso };
    // The first duration reported for a lesson is kept, so it can't be shrunk later to fake completion.
    const duration = prev.videoDuration || ev.duration || 0;
    const position = Math.max(0, duration ? Math.min(ev.position, duration) : ev.position);
    // Credit is based on server time between reports, never on what the browser claims,
    // and a long gap (paused, tab closed) earns at most MAX_CREDITED_GAP_SECONDS.
    const sinceLast = prev.lastEventAt ? Math.max(0, (now - new Date(prev.lastEventAt)) / 1000) : 0;
    const elapsed = Math.min(prev.lastEventAt ? sinceLast : Math.min(ev.delta, 10), MAX_CREDITED_GAP_SECONDS);
    const allowedGrowth = elapsed * MAX_PLAYBACK_RATE + BATCH_SLACK_SECONDS + SEEK_TOLERANCE_SECONDS;
    const maxPosition = prev.completed ? Math.max(prev.maxPosition, position) : Math.max(prev.maxPosition, Math.min(position, prev.maxPosition + allowedGrowth));
    const deltaCap = Math.min(ev.delta, elapsed * MAX_PLAYBACK_RATE + BATCH_SLACK_SECONDS);
    lessons[ev.lessonId] = {
      ...prev,
      lastPosition: position,
      maxPosition,
      watchedSeconds: Math.min((prev.watchedSeconds ?? 0) + Math.max(0, deltaCap), duration ? duration * 1.05 : Number.MAX_SAFE_INTEGER),
      videoDuration: duration || undefined,
      lastEventAt: nowIso,
      updatedAt: nowIso,
    };
    progress.lastLessonId = ev.lessonId;
  }
  progress.lessons = lessons;
  progress.updatedAt = nowIso;
  progress.markModified("lessons");
  await progress.save();
  res.json({ progress: progressOut(progress) });
});

router.post("/courses/:courseId/last-lesson", async (req, res) => {
  const { lessonId } = parse(z.object({ lessonId: z.string() }), req.body);
  await requireEnrollment(req.user._id, req.params.courseId);
  const progress = await ensureProgress(req.user._id, req.params.courseId);
  if (progress.lastLessonId !== lessonId) {
    progress.lastLessonId = lessonId;
    await progress.save();
  }
  res.json({ progress: progressOut(progress) });
});

/** Marks a lesson complete only if it is unlocked and enough of the video was watched. */
router.post("/courses/:courseId/lessons/:lessonId/complete", async (req, res) => {
  const { courseId, lessonId } = req.params;
  await requireEnrollment(req.user._id, courseId);
  const ctx = await loadContext(req.user._id, courseId);
  const found = findLesson(ctx.course, lessonId);
  if (!found) throw notFound("Lesson");
  const progress = ctx.progressDoc ?? (await ensureProgress(req.user._id, courseId));
  const lp = progress.lessons?.[lessonId];
  if (lp?.completed) return res.json({ progress: progressOut(progress) });

  const state = lockStateOf(ctx, lessonId);
  if (state === "locked") throw new ApiError("Finish the previous steps before completing this lesson.", 403, "locked");

  const settings = await getSettings();
  const threshold = (settings.watchThresholdPercent ?? 90) / 100;
  const duration = lp?.videoDuration || found.lesson.durationSeconds || 0;
  if (!lp || !duration || lp.maxPosition / duration < threshold - 0.005) {
    throw new ApiError(`Watch at least ${Math.round(threshold * 100)}% of the video before marking it complete.`, 412, "watch_threshold");
  }
  const now = new Date().toISOString();
  progress.lessons = { ...progress.lessons, [lessonId]: { ...lp, completed: true, completedAt: now, updatedAt: now } };
  progress.updatedAt = now;
  progress.markModified("lessons");
  await progress.save();
  await logActivity(req.user._id, "lesson_completed", `Completed ${found.lesson.title}`, courseId);
  res.json({ progress: progressOut(progress) });
});

/** Server-side quiz grading. Answers never reach students before they pass (or run out of attempts). */
router.post("/quizzes/:quizId/attempts", async (req, res) => {
  const body = parse(z.object({ answers: z.record(z.string(), z.string()), startedAt: z.string().optional() }), req.body);
  const quiz = await Quiz.findById(req.params.quizId);
  if (!quiz) throw notFound("Quiz");
  await requireEnrollment(req.user._id, quiz.courseId);
  const ctx = await loadContext(req.user._id, quiz.courseId);
  if (lockStateOf(ctx, quiz._id) === "locked") throw new ApiError("Complete the module's lessons before taking this quiz.", 403, "locked");

  const settings = await getSettings();
  const prior = ctx.attempts.filter((a) => a.quizId === quiz._id);
  if (prior.some((a) => a.passed)) throw new ApiError("You have already passed this quiz.", 409, "already_passed");
  const maxAttempts = quiz.maxAttempts ?? (settings.allowQuizRetakes ? undefined : 1);
  if (maxAttempts !== undefined && prior.length >= maxAttempts) throw new ApiError("No attempts remaining for this quiz.", 403, "no_attempts");
  if (!quiz.questions.length) throw new ApiError("This quiz has no questions yet.", 409, "empty_quiz");

  const total = quiz.questions.length;
  const correct = quiz.questions.filter((q) => body.answers[q.id] === q.correctOptionId).length;
  const scorePercent = Math.round((correct / total) * 100);
  const passed = scorePercent >= quiz.passingScore;
  const submittedAt = new Date().toISOString();
  const started = body.startedAt && !Number.isNaN(Date.parse(body.startedAt)) ? body.startedAt : submittedAt;
  const timeTakenSeconds = Math.max(1, Math.round((Date.parse(submittedAt) - Date.parse(started)) / 1000));
  const attempt = await QuizAttempt.create({
    userId: req.user._id,
    quizId: quiz._id,
    courseId: quiz.courseId,
    startedAt: started,
    submittedAt,
    answers: Object.fromEntries(quiz.questions.map((q) => [q.id, body.answers[q.id]]).filter(([, v]) => v)),
    correct,
    total,
    scorePercent,
    passed,
    timeTakenSeconds,
  });
  await logActivity(req.user._id, passed ? "quiz_passed" : "quiz_failed", `${passed ? "Passed" : "Did not pass"} ${quiz.title} with ${scorePercent}%`, quiz.courseId);

  // Per-question review. Correct answers are revealed only once the quiz is
  // passed or no attempts remain, so failed attempts can't be used as an answer key.
  const outOfAttempts = maxAttempts !== undefined && prior.length + 1 >= maxAttempts;
  const reveal = passed || outOfAttempts;
  const review = Object.fromEntries(
    quiz.questions.map((q) => [
      q.id,
      { correct: body.answers[q.id] === q.correctOptionId, ...(reveal ? { correctOptionId: q.correctOptionId, explanation: q.explanation } : {}) },
    ]),
  );
  const { userId: _u, ...out } = attempt.toJSON();
  void _u;
  res.status(201).json({ attempt: { ...out, review } });
});

/** Assignment submission. Upload the file first via POST /api/uploads (kind=assignment) and pass its id. */
router.post("/assignments/:assignmentId/submissions", async (req, res) => {
  const body = parse(
    z.object({ uploadId: z.string().optional(), fileName: z.string().min(1).max(255), fileSize: z.number().min(0), note: z.string().max(2000).optional() }),
    req.body,
  );
  const assignment = await Assignment.findById(req.params.assignmentId);
  if (!assignment) throw notFound("Assignment");
  await requireEnrollment(req.user._id, assignment.courseId);
  const ctx = await loadContext(req.user._id, assignment.courseId);
  if (lockStateOf(ctx, assignment._id) === "locked") throw new ApiError("Complete the module's lessons before submitting this assignment.", 403, "locked");

  const existing = await AssignmentSubmission.findOne({ assignmentId: assignment._id, userId: req.user._id });
  if (existing && existing.status !== "rejected" && existing.status !== "pending") {
    throw new ApiError("This assignment has already been submitted and is awaiting review.", 409, "already_submitted");
  }
  if (existing?.status === "rejected" && !assignment.allowResubmission) throw new ApiError("Resubmission is not allowed for this assignment.", 403, "no_resubmission");

  let fileUrl;
  if (body.uploadId) {
    const upload = await Upload.findOne({ _id: body.uploadId, ownerId: req.user._id });
    if (!upload) throw new ApiError("Uploaded file not found. Please upload it again.", 400, "upload_missing");
    fileUrl = upload.url;
  }
  const data = {
    assignmentId: assignment._id,
    userId: req.user._id,
    status: "submitted",
    submittedAt: new Date().toISOString(),
    fileName: body.fileName,
    fileSize: body.fileSize,
    uploadId: body.uploadId,
    fileUrl,
    note: body.note,
    feedback: undefined,
    marks: undefined,
    grade: undefined,
    reviewedAt: undefined,
    attempt: (existing?.attempt ?? 0) + 1,
  };
  const submission = existing ? Object.assign(existing, data) : new AssignmentSubmission(data);
  await submission.save();
  await logActivity(req.user._id, "assignment_submitted", `Submitted ${assignment.title}`, assignment.courseId);
  res.status(201).json({ submission: submission.toJSON() });
});

/** Re-checks every requirement and issues the certificate. */
router.post("/courses/:courseId/complete", async (req, res) => {
  const { certificate, enrollment, progress } = await completeCourse(req.user, req.params.courseId);
  res.json({ certificate: certificate.toJSON(), enrollment: enrollment.toJSON(), progress: progressOut(progress) });
});

/* ---------- Notes ---------- */

router.post("/courses/:courseId/notes", async (req, res) => {
  const body = parse(z.object({ lessonId: z.string(), body: z.string().trim().min(1).max(5000), timestampSeconds: z.number().min(0).optional() }), req.body);
  await requireEnrollment(req.user._id, req.params.courseId);
  const course = await Course.findById(req.params.courseId);
  if (!course || !findLesson(course.toJSON(), body.lessonId)) throw notFound("Lesson");
  const note = await Note.create({ ...body, userId: req.user._id, courseId: req.params.courseId });
  const { userId: _u, ...out } = note.toJSON();
  void _u;
  res.status(201).json({ note: out });
});

router.delete("/notes/:noteId", async (req, res) => {
  const result = await Note.deleteOne({ _id: req.params.noteId, userId: req.user._id });
  if (!result.deletedCount) throw notFound("Note");
  res.json({ ok: true });
});

/** Demo control: wipes this learner's own progress, attempts and notes. */
router.post("/reset", async (req, res) => {
  if (!env.ALLOW_DEMO_RESET) throw new ApiError("Progress reset is disabled on this server.", 403, "disabled");
  await Promise.all([
    CourseProgress.deleteMany({ userId: req.user._id }),
    QuizAttempt.deleteMany({ userId: req.user._id }),
    Note.deleteMany({ userId: req.user._id }),
  ]);
  res.json({ ok: true });
});

export default router;
