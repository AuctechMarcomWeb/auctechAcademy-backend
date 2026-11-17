import multer from "multer";
import { env } from "../config/env.js";
import { ApiError } from "../lib/http.js";

export function notFoundHandler(req, _res, next) {
  next(new ApiError(`No route for ${req.method} ${req.originalUrl}`, 404, "route_not_found"));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  let status = err.status ?? 500;
  let code = err.code ?? "server_error";
  let message = err.message ?? "Something went wrong";

  if (err instanceof multer.MulterError) {
    status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    code = "upload_error";
    message = err.code === "LIMIT_FILE_SIZE" ? `File is too large (max ${env.MAX_UPLOAD_MB} MB).` : err.message;
  } else if (err?.name === "ValidationError") {
    status = 422;
    code = "validation_error";
    message = Object.values(err.errors ?? {})[0]?.message ?? "Invalid data";
  } else if (err?.code === 11000) {
    status = 409;
    code = "duplicate";
    const field = Object.keys(err.keyPattern ?? err.keyValue ?? {})[0];
    message = field ? `A record with this ${field} already exists.` : "Duplicate record";
  } else if (err?.type === "entity.parse.failed") {
    status = 400;
    code = "invalid_json";
    message = "Request body is not valid JSON";
  } else if (!(err instanceof ApiError) && status === 500) {
    console.error("[error]", err);
    if (env.isProd) message = "Something went wrong. Please try again.";
  }

  res.status(status).json({ message, code, ...(err.details ? { details: err.details } : {}) });
}
