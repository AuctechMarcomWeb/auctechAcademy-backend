import mongoose from "mongoose";
import { Schema, baseOptions, idField, isoNow } from "../lib/model-helpers.js";

export const DEFAULT_SETTINGS = {
  siteName: "Auctech Academy",
  supportEmail: "academy@auctech.in",
  currency: "INR",
  gstPercent: 18,
  defaultPassingScore: 70,
  watchThresholdPercent: 90,
  certificatePrefix: "AUC",
  allowQuizRetakes: true,
  maintenanceMode: false,
};

/** Single document `_id: "platform"`. */
const settingsSchema = new Schema(
  {
    _id: { type: String, default: "platform" },
    siteName: String,
    supportEmail: String,
    currency: { type: String, default: "INR" },
    gstPercent: Number,
    defaultPassingScore: Number,
    watchThresholdPercent: Number,
    certificatePrefix: String,
    allowQuizRetakes: Boolean,
    maintenanceMode: Boolean,
  },
  baseOptions(),
);
export const Settings = mongoose.model("Settings", settingsSchema);

/* Settings are read on almost every request, so they are cached briefly in memory. */
const SETTINGS_TTL_MS = 30_000;
let settingsCache = null;
let settingsLoadedAt = 0;

export async function getSettings() {
  if (settingsCache && Date.now() - settingsLoadedAt < SETTINGS_TTL_MS) return { ...settingsCache };
  const doc = await Settings.findById("platform").lean();
  const { _id, ...rest } = doc ?? {};
  void _id;
  settingsCache = { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null)) };
  settingsLoadedAt = Date.now();
  return { ...settingsCache };
}

export function invalidateSettings() {
  settingsCache = null;
}

const contactSchema = new Schema(
  {
    _id: idField("msg"),
    name: String,
    email: String,
    phone: String,
    subject: String,
    topic: String,
    message: String,
    status: { type: String, enum: ["new", "read", "resolved"], default: "new" },
    createdAt: { type: String, default: isoNow },
  },
  baseOptions(),
);
export const ContactMessage = mongoose.model("ContactMessage", contactSchema);

const uploadSchema = new Schema(
  {
    _id: idField("upl"),
    ownerId: { type: String, index: true },
    kind: { type: String, enum: ["video", "thumbnail", "avatar", "assignment", "resume", "resource"], required: true },
    visibility: { type: String, enum: ["public", "private"], default: "private" },
    originalName: String,
    storedName: String,
    mimeType: String,
    size: Number,
    url: String,
    createdAt: { type: String, default: isoNow },
  },
  baseOptions(["storedName"]),
);
export const Upload = mongoose.model("Upload", uploadSchema);
