import { randomBytes } from "node:crypto";

/** Error type every route throws; the error middleware turns it into JSON `{ message, code }`. */
export class ApiError extends Error {
  constructor(message, status = 400, code = "bad_request", details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = "Resource") => new ApiError(`${what} not found`, 404, "not_found");

/** Short, URL-safe, prefixed ids that match the frontend's id style (e.g. `usr_k2j3h4g5f6`). */
export function uid(prefix = "id") {
  const rand = randomBytes(8).toString("base64url").replace(/[-_]/g, "").slice(0, 10).toLowerCase();
  return prefix ? `${prefix}_${Date.now().toString(36)}${rand}` : `${Date.now().toString(36)}${rand}`;
}

/** Parses a body/query with a zod schema and throws a 422 with field errors when it fails. */
export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const first = issues[0];
    throw new ApiError(first ? `${first.path ? `${first.path}: ` : ""}${first.message}` : "Invalid request", 422, "validation_error", issues);
  }
  return result.data;
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
