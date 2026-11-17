import mongoose from "mongoose";
import { Schema, baseOptions, subOptions, isoNow } from "../lib/model-helpers.js";

const verificationEventSchema = new Schema(
  {
    id: String,
    at: { type: String, default: isoNow },
    result: { type: String, enum: ["valid", "revoked", "invalid", "not_found"] },
    source: { type: String, enum: ["qr", "web", "api"], default: "web" },
  },
  subOptions,
);

const certificateSchema = new Schema(
  {
    _id: { type: String, required: true }, // e.g. AUC-DM-2026-000124
    userId: { type: String, required: true, index: true },
    courseId: { type: String, required: true, index: true },
    studentName: String,
    courseTitle: String,
    issuedAt: { type: String, default: isoNow },
    completedAt: String,
    status: { type: String, enum: ["valid", "revoked"], default: "valid" },
    revokedReason: String,
    revokedAt: String,
    finalScore: { type: Number, default: 0 },
    kind: { type: String, enum: ["course", "internship"], default: "course" },
    verificationHistory: { type: [verificationEventSchema], default: [] },
  },
  baseOptions(),
);

export const Certificate = mongoose.model("Certificate", certificateSchema);
