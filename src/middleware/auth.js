import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { ApiError } from "../lib/http.js";
import { User } from "../models/index.js";

export function signToken(user) {
  return jwt.sign({ sub: user._id ?? user.id, role: user.role, v: user.tokenVersion ?? 0 }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}

function readToken(req) {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

async function resolveUser(req) {
  const token = readToken(req);
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch {
    throw new ApiError("Your session has expired. Please sign in again.", 401, "invalid_token");
  }
  const user = await User.findById(payload.sub);
  if (!user || (user.tokenVersion ?? 0) !== (payload.v ?? 0)) {
    throw new ApiError("Your session has expired. Please sign in again.", 401, "invalid_token");
  }
  if (user.status === "suspended") throw new ApiError("This account has been suspended. Contact support.", 403, "suspended");
  return user;
}

/** Attaches req.user when a valid token is present; never rejects anonymous requests. */
export async function optionalAuth(req, _res, next) {
  try {
    req.user = await resolveUser(req);
  } catch {
    req.user = null;
  }
  next();
}

export async function requireAuth(req, _res, next) {
  const user = await resolveUser(req);
  if (!user) throw new ApiError("Please sign in to continue.", 401, "unauthenticated");
  req.user = user;
  // Cheap activity tracking (at most once per 10 minutes).
  const last = user.lastActiveAt ? Date.parse(user.lastActiveAt) : 0;
  if (Date.now() - last > 10 * 60 * 1000) {
    User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date().toISOString() } }).catch(() => {});
  }
  next();
}

export const requireRole = (role) => (req, _res, next) => {
  if (!req.user) throw new ApiError("Please sign in to continue.", 401, "unauthenticated");
  if (req.user.role !== role) throw new ApiError("You do not have permission to do that.", 403, "forbidden");
  next();
};
