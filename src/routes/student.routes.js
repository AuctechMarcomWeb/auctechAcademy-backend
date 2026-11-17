import { Router } from "express";
import { z } from "zod";
import { ApiError, notFound, parse } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import {
  Activity,
  AssignmentSubmission,
  Certificate,
  Enrollment,
  Internship,
  InternshipApplication,
  Order,
  Upload,
} from "../models/index.js";

/** Read endpoints for the signed-in learner (`/api/me/...`) and internship applications. */
const router = Router();
const json = (docs) => docs.map((d) => d.toJSON());

router.get("/me/enrollments", requireAuth, async (req, res) => res.json(json(await Enrollment.find({ userId: req.user._id }).sort({ enrolledAt: -1 }))));
router.get("/me/orders", requireAuth, async (req, res) => res.json(json(await Order.find({ userId: req.user._id }).sort({ createdAt: -1 }))));
router.get("/me/certificates", requireAuth, async (req, res) => res.json(json(await Certificate.find({ userId: req.user._id }).sort({ issuedAt: -1 }))));
router.get("/me/activity", requireAuth, async (req, res) => res.json(json(await Activity.find({ userId: req.user._id }).sort({ at: -1 }).limit(100))));
router.get("/me/submissions", requireAuth, async (req, res) => res.json(json(await AssignmentSubmission.find({ userId: req.user._id }).sort({ submittedAt: -1 }))));
router.get("/me/applications", requireAuth, async (req, res) => res.json(json(await InternshipApplication.find({ userId: req.user._id }).sort({ appliedAt: -1 }))));

router.post("/internships/:id/apply", requireAuth, async (req, res) => {
  const body = parse(
    z.object({
      fullName: z.string().trim().min(2).max(100),
      email: z.string().trim().email(),
      phone: z.string().trim().min(6).max(20),
      college: z.string().trim().min(2).max(150),
      graduationYear: z.string().trim().min(4).max(8),
      coverLetter: z.string().trim().min(20, "Tell us a little more (at least 20 characters)").max(5000),
      portfolioUrl: z.string().trim().url().optional().or(z.literal("").transform(() => undefined)),
      resumeFileName: z.string().max(255).optional(),
      resumeUploadId: z.string().optional(),
    }),
    req.body,
  );
  if (req.user.role !== "student") throw new ApiError("Only student accounts can apply.", 403, "forbidden");
  const internship = await Internship.findById(req.params.id);
  if (!internship) throw notFound("Internship");
  if (internship.status !== "open" || (internship.applicationDeadline && new Date(internship.applicationDeadline) < new Date())) {
    throw new ApiError("Applications for this internship are closed.", 410, "closed");
  }
  if (await InternshipApplication.exists({ userId: req.user._id, internshipId: internship._id })) {
    throw new ApiError("You have already applied for this internship.", 409, "duplicate");
  }
  if (body.resumeUploadId && !(await Upload.exists({ _id: body.resumeUploadId, ownerId: req.user._id }))) {
    throw new ApiError("Uploaded résumé not found. Please upload it again.", 400, "upload_missing");
  }
  const application = await InternshipApplication.create({ ...body, internshipId: internship._id, userId: req.user._id, status: "applied", tasks: [] });
  res.status(201).json({ application: application.toJSON() });
});

/** Intern submits a task (status → submitted). Approval is done by an admin. */
router.patch("/me/applications/:id/tasks/:taskId", requireAuth, async (req, res) => {
  parse(z.object({ status: z.literal("submitted") }), req.body);
  const app = await InternshipApplication.findOne({ _id: req.params.id, userId: req.user._id });
  if (!app) throw notFound("Application");
  if (app.status !== "active") throw new ApiError("Tasks can be submitted only during an active internship.", 409, "not_active");
  const task = app.tasks.find((t) => t.id === req.params.taskId);
  if (!task) throw notFound("Task");
  if (task.status === "approved") throw new ApiError("This task is already approved.", 409, "already_approved");
  task.status = "submitted";
  task.submittedAt = new Date().toISOString();
  await app.save();
  res.json({ application: app.toJSON() });
});

export default router;
