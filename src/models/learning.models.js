import mongoose from "mongoose";
import { Schema, baseOptions, idField, isoNow } from "../lib/model-helpers.js";

/**
 * One document per (user, course). `lessons` is a map lessonId → LessonProgress,
 * mirroring the frontend's CourseProgress type. Server-only bookkeeping
 * (`lastEventAt`, `videoDuration`) is used to sanity-check playback reports.
 */
const courseProgressSchema = new Schema(
  {
    _id: idField("prg"),
    userId: { type: String, required: true },
    courseId: { type: String, required: true },
    lessons: { type: Schema.Types.Mixed, default: {} },
    lastLessonId: String,
    startedAt: { type: String, default: isoNow },
    updatedAt: { type: String, default: isoNow },
    completedAt: String,
  },
  baseOptions(),
);
courseProgressSchema.index({ userId: 1, courseId: 1 }, { unique: true });
export const CourseProgress = mongoose.model("CourseProgress", courseProgressSchema);

const quizAttemptSchema = new Schema(
  {
    _id: idField("att"),
    userId: { type: String, required: true, index: true },
    quizId: { type: String, required: true, index: true },
    courseId: { type: String, required: true, index: true },
    startedAt: String,
    submittedAt: { type: String, default: isoNow },
    answers: { type: Schema.Types.Mixed, default: {} },
    correct: Number,
    total: Number,
    scorePercent: Number,
    passed: Boolean,
    timeTakenSeconds: Number,
  },
  baseOptions(),
);
export const QuizAttempt = mongoose.model("QuizAttempt", quizAttemptSchema);

const noteSchema = new Schema(
  {
    _id: idField("note"),
    userId: { type: String, required: true, index: true },
    courseId: { type: String, required: true, index: true },
    lessonId: String,
    body: { type: String, required: true },
    timestampSeconds: Number,
    createdAt: { type: String, default: isoNow },
  },
  baseOptions(),
);
export const Note = mongoose.model("Note", noteSchema);

const submissionSchema = new Schema(
  {
    _id: idField("sub"),
    assignmentId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    status: { type: String, enum: ["pending", "submitted", "under_review", "approved", "rejected"], default: "submitted" },
    submittedAt: String,
    fileName: String,
    fileSize: Number,
    uploadId: String,
    fileUrl: String,
    note: String,
    feedback: String,
    marks: Number,
    grade: String,
    reviewedAt: String,
    attempt: { type: Number, default: 1 },
  },
  baseOptions(),
);
export const AssignmentSubmission = mongoose.model("AssignmentSubmission", submissionSchema);

const activitySchema = new Schema(
  {
    _id: idField("act"),
    userId: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: ["lesson_completed", "quiz_passed", "quiz_failed", "enrolled", "certificate_issued", "assignment_submitted", "course_completed"],
    },
    title: String,
    courseId: String,
    at: { type: String, default: isoNow },
  },
  baseOptions(),
);
export const Activity = mongoose.model("Activity", activitySchema);

export function logActivity(userId, type, title, courseId) {
  return Activity.create({ userId, type, title, courseId });
}
