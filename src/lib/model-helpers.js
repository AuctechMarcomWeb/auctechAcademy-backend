import { Schema } from "mongoose";
import { uid } from "./http.js";

/**
 * Every collection uses string ids (`crs_fullstack`, `usr_student`, `AUC-DM-2026-000124`)
 * so documents match the frontend's types one-to-one. JSON output renames
 * `_id` → `id` and drops internal fields.
 */
export function baseOptions(hidden = []) {
  const transform = (_doc, ret) => {
    if (ret._id !== undefined) {
      ret.id = ret._id;
      delete ret._id;
    }
    delete ret.__v;
    for (const h of hidden) delete ret[h];
    // Mongoose returns Dates; the frontend expects ISO strings.
    for (const [k, v] of Object.entries(ret)) if (v instanceof Date) ret[k] = v.toISOString();
    return ret;
  };
  return {
    versionKey: false,
    minimize: false,
    toJSON: { virtuals: false, transform },
    toObject: { virtuals: false, transform },
  };
}

export const idField = (prefix) => ({ type: String, default: () => uid(prefix) });

/** Sub-document options: no automatic ObjectId, ids are explicit `id` strings. */
export const subOptions = { _id: false, versionKey: false, minimize: false };

export const isoNow = () => new Date().toISOString();

export { Schema };
