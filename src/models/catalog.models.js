import mongoose from "mongoose";
import { Schema, baseOptions, idField, subOptions, isoNow } from "../lib/model-helpers.js";

/* ---------- Category & Instructor ---------- */

const categorySchema = new Schema(
  {
    _id: idField("cat"),
    slug: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    icon: { type: String, default: "BookOpen" },
  },
  baseOptions(),
);
categorySchema.index({ slug: 1 }, { unique: true });
export const Category = mongoose.model("Category", categorySchema);

const instructorSchema = new Schema(
  {
    _id: idField("ins"),
    name: { type: String, required: true },
    title: { type: String, default: "" },
    bio: { type: String, default: "" },
    avatarUrl: String,
    rating: { type: Number, default: 0 },
    students: { type: Number, default: 0 },
    courses: { type: Number, default: 0 },
  },
  baseOptions(),
);
export const Instructor = mongoose.model("Instructor", instructorSchema);

/* ---------- Course (modules and lessons are embedded) ---------- */

const resourceSchema = new Schema(
  {
    id: { type: String, required: true },
    title: String,
    type: { type: String, enum: ["pdf", "link", "zip", "code"], default: "link" },
    url: String,
    size: String,
  },
  subOptions,
);

const lessonSchema = new Schema(
  {
    id: { type: String, required: true },
    moduleId: String,
    title: { type: String, required: true },
    description: { type: String, default: "" },
    videoUrl: { type: String, default: "" },
    durationSeconds: { type: Number, default: 0 },
    order: { type: Number, default: 0 },
    isPreview: Boolean,
    resources: { type: [resourceSchema], default: [] },
  },
  subOptions,
);

const moduleSchema = new Schema(
  {
    id: { type: String, required: true },
    courseId: String,
    title: { type: String, required: true },
    description: { type: String, default: "" },
    order: { type: Number, default: 0 },
    lessons: { type: [lessonSchema], default: [] },
    quizId: String,
    assignmentId: String,
    isFinalAssessment: Boolean,
  },
  subOptions,
);

const faqSchema = new Schema({ question: String, answer: String }, subOptions);

const courseSchema = new Schema(
  {
    _id: idField("crs"),
    slug: { type: String, required: true },
    title: { type: String, required: true },
    subtitle: { type: String, default: "" },
    description: { type: String, default: "" },
    categoryId: { type: String, index: true },
    instructorId: { type: String, index: true },
    thumbnail: { type: String, default: "" },
    level: { type: String, enum: ["Beginner", "Intermediate", "Advanced"], default: "Beginner" },
    language: { type: String, default: "English" },
    price: { type: Number, default: 0, min: 0 },
    originalPrice: { type: Number, default: 0, min: 0 },
    rating: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    enrolledCount: { type: Number, default: 0 },
    modules: { type: [moduleSchema], default: [] },
    outcomes: { type: [String], default: [] },
    skills: { type: [String], default: [] },
    prerequisites: { type: [String], default: [] },
    faqs: { type: [faqSchema], default: [] },
    certificateCode: { type: String, required: true, uppercase: true },
    status: { type: String, enum: ["published", "draft", "archived"], default: "draft", index: true },
    isFeatured: Boolean,
    createdAt: { type: String, default: isoNow },
    updatedAt: { type: String, default: isoNow },
  },
  baseOptions(),
);
courseSchema.index({ slug: 1 }, { unique: true });
export const Course = mongoose.model("Course", courseSchema);

/* ---------- Quiz ---------- */

const optionSchema = new Schema({ id: { type: String, required: true }, text: String }, subOptions);
const questionSchema = new Schema(
  {
    id: { type: String, required: true },
    prompt: String,
    options: { type: [optionSchema], default: [] },
    correctOptionId: String,
    explanation: String,
  },
  subOptions,
);

const quizSchema = new Schema(
  {
    _id: idField("quiz"),
    courseId: { type: String, index: true },
    moduleId: String,
    title: { type: String, required: true },
    description: String,
    passingScore: { type: Number, default: 70, min: 0, max: 100 },
    timeLimitSeconds: Number,
    maxAttempts: Number,
    questions: { type: [questionSchema], default: [] },
  },
  baseOptions(),
);
export const Quiz = mongoose.model("Quiz", quizSchema);

/* ---------- Assignment ---------- */

const assignmentSchema = new Schema(
  {
    _id: idField("asg"),
    courseId: { type: String, index: true },
    moduleId: String,
    title: { type: String, required: true },
    instructions: { type: String, default: "" },
    deadline: String,
    maxMarks: { type: Number, default: 100 },
    allowResubmission: { type: Boolean, default: true },
  },
  baseOptions(),
);
export const Assignment = mongoose.model("Assignment", assignmentSchema);
