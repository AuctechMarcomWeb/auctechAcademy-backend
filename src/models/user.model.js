import mongoose from "mongoose";
import { Schema, baseOptions, idField } from "../lib/model-helpers.js";

const notificationPrefsSchema = new Schema(
  {
    courseUpdates: { type: Boolean, default: true },
    assessmentReminders: { type: Boolean, default: true },
    internshipAlerts: { type: Boolean, default: true },
    marketing: { type: Boolean, default: false },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    _id: idField("usr"),
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ["student", "admin"], default: "student", index: true },
    passwordHash: { type: String },
    googleId: { type: String, index: true, sparse: true },
    avatarUrl: String,
    phone: String,
    headline: String,
    bio: String,
    location: String,
    joinedAt: { type: String, default: () => new Date().toISOString() },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    lastActiveAt: String,
    notificationPrefs: { type: notificationPrefsSchema, default: () => ({}) },
    /** Bumped on password change / logout-everywhere to invalidate older JWTs. */
    tokenVersion: { type: Number, default: 0 },
    passwordReset: {
      tokenHash: String,
      expiresAt: Date,
    },
  },
  baseOptions(["passwordHash", "passwordReset", "tokenVersion", "googleId"]),
);

userSchema.index({ email: 1 }, { unique: true });

export const User = mongoose.model("User", userSchema);
