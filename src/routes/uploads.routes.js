import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { env } from "../config/env.js";
import { ApiError, notFound, uid } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { Upload } from "../models/index.js";

/**
 * File uploads stored on local disk under UPLOAD_DIR:
 *   public/  → videos, thumbnails, avatars, lesson resources (served at /uploads/public/...)
 *   private/ → assignment files and résumés (download via GET /api/uploads/:id, owner or admin only)
 * Swap the storage engine for S3/GCS in production; the API stays the same.
 */

export const UPLOAD_ROOT = path.resolve(env.UPLOAD_DIR);
const PUBLIC_DIR = path.join(UPLOAD_ROOT, "public");
const PRIVATE_DIR = path.join(UPLOAD_ROOT, "private");
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

const KINDS = {
  video: { visibility: "public", admin: true, types: /^video\// },
  thumbnail: { visibility: "public", admin: true, types: /^image\/(png|jpe?g|webp|gif|avif)$/ },
  resource: { visibility: "public", admin: true, types: /./ },
  avatar: { visibility: "public", admin: false, types: /^image\/(png|jpe?g|webp|gif|avif)$/ },
  assignment: { visibility: "private", admin: false, types: /./ },
  resume: { visibility: "private", admin: false, types: /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/ },
};

const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, KINDS[req.query.kind]?.visibility === "public" ? PUBLIC_DIR : PRIVATE_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
    cb(null, `${uid("f")}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const kind = KINDS[req.query.kind];
    if (!kind) return cb(new ApiError("Unknown upload kind. Use ?kind=video|thumbnail|resource|avatar|assignment|resume", 400, "bad_kind"));
    if (kind.admin && req.user?.role !== "admin") return cb(new ApiError("Only admins can upload this kind of file.", 403, "forbidden"));
    if (!kind.types.test(file.mimetype)) return cb(new ApiError(`This file type (${file.mimetype}) is not allowed here.`, 415, "bad_type"));
    cb(null, true);
  },
});

const router = Router();

/** POST /api/uploads?kind=assignment   (multipart/form-data, field "file") */
router.post("/", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) throw new ApiError("No file received (use the form field name 'file').", 400, "no_file");
  const kind = req.query.kind;
  const visibility = KINDS[kind].visibility;
  const doc = new Upload({
    ownerId: req.user._id,
    kind,
    visibility,
    originalName: req.file.originalname,
    storedName: req.file.filename,
    mimeType: req.file.mimetype,
    size: req.file.size,
  });
  doc.url = visibility === "public" ? `${env.API_PUBLIC_URL}/uploads/public/${req.file.filename}` : `${env.API_PUBLIC_URL}/api/uploads/${doc._id}`;
  await doc.save();
  res.status(201).json({ upload: doc.toJSON() });
});

/** Authenticated download for private files (owner or admin). */
router.get("/:id", requireAuth, async (req, res) => {
  const doc = await Upload.findById(req.params.id);
  if (!doc) throw notFound("File");
  if (doc.visibility === "private" && doc.ownerId !== req.user._id && req.user.role !== "admin") throw new ApiError("You cannot access this file.", 403, "forbidden");
  const dir = doc.visibility === "public" ? PUBLIC_DIR : PRIVATE_DIR;
  res.download(path.join(dir, doc.storedName), doc.originalName);
});

export default router;
