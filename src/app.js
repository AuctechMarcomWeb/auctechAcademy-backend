import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import path from "node:path";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import publicRoutes from "./routes/public.routes.js";
import authRoutes from "./routes/auth.routes.js";
import learningRoutes from "./routes/learning.routes.js";
import paymentRoutes from "./routes/payments.routes.js";
import studentRoutes from "./routes/student.routes.js";
import uploadRoutes, { UPLOAD_ROOT } from "./routes/uploads.routes.js";
import adminRoutes from "./routes/admin.routes.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);

  const origins = new Set([env.FRONTEND_URL, env.ADMIN_URL, ...env.CORS_ORIGINS]);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, env.corsAllowAll || !origin || origins.has(origin) || (!env.isProd && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))),
      credentials: true,
      exposedHeaders: ["Content-Disposition"],
    }),
  );
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(compression());
  if (!env.isTest) app.use(morgan(env.isProd ? "combined" : "dev"));

  // Keep the raw body for Razorpay webhook signature checks.
  app.use(express.json({ limit: "2mb", verify: (req, _res, buf) => (req.originalUrl.startsWith("/api/payments/webhook") ? (req.rawBody = buf) : undefined) }));

  // Public uploads (videos, thumbnails, avatars). Private files go through /api/uploads/:id.
  app.use(
    "/uploads/public",
    express.static(path.join(UPLOAD_ROOT, "public"), {
      maxAge: "7d",
      fallthrough: false,
      // Uploaded files are content, never pages: block scripts if one is opened directly.
      setHeaders: (res) => res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox"),
    }),
  );

  app.get("/", (_req, res) => res.json({ name: "Auctech Academy API", docs: "See README.md", health: "/api/health" }));

  app.use("/api", publicRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/learning", learningRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/uploads", uploadRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api", studentRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
