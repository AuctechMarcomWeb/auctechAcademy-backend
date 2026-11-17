import mongoose from "mongoose";
import { Schema, baseOptions, idField, subOptions, isoNow } from "../lib/model-helpers.js";

const internshipSchema = new Schema(
  {
    _id: idField("int"),
    slug: { type: String, required: true },
    title: { type: String, required: true },
    department: { type: String, default: "" },
    description: { type: String, default: "" },
    durationWeeks: { type: Number, default: 8 },
    workMode: { type: String, enum: ["Remote", "Hybrid", "On-site"], default: "Remote" },
    eligibility: { type: [String], default: [] },
    skillsRequired: { type: [String], default: [] },
    learningOutcomes: { type: [String], default: [] },
    stipend: { type: String, enum: ["Paid", "Unpaid", "Performance-based"], default: "Unpaid" },
    stipendAmount: Number,
    applicationDeadline: String,
    openings: { type: Number, default: 1 },
    mentorName: { type: String, default: "" },
    mentorTitle: { type: String, default: "" },
    status: { type: String, enum: ["open", "closed"], default: "open" },
    startDate: String,
    thumbnail: { type: String, default: "" },
  },
  baseOptions(),
);
internshipSchema.index({ slug: 1 }, { unique: true });
export const Internship = mongoose.model("Internship", internshipSchema);

const taskSchema = new Schema(
  {
    id: { type: String, required: true },
    title: String,
    dueDate: String,
    status: { type: String, enum: ["todo", "in_progress", "submitted", "approved"], default: "todo" },
    submittedAt: String,
    feedback: String,
  },
  subOptions,
);

const applicationSchema = new Schema(
  {
    _id: idField("app"),
    internshipId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    appliedAt: { type: String, default: isoNow },
    status: {
      type: String,
      enum: ["applied", "shortlisted", "interview", "selected", "rejected", "active", "completed"],
      default: "applied",
    },
    fullName: String,
    email: String,
    phone: String,
    college: String,
    graduationYear: String,
    resumeFileName: String,
    resumeUploadId: String,
    coverLetter: String,
    portfolioUrl: String,
    mentor: String,
    attendance: { present: Number, total: Number },
    tasks: { type: [taskSchema], default: [] },
    performanceScore: Number,
    certificateId: String,
  },
  baseOptions(),
);
applicationSchema.index({ userId: 1, internshipId: 1 }, { unique: true });
export const InternshipApplication = mongoose.model("InternshipApplication", applicationSchema);
