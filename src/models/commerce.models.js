import mongoose from "mongoose";
import { Schema, baseOptions, idField, isoNow } from "../lib/model-helpers.js";

const couponSchema = new Schema(
  {
    _id: { type: String, uppercase: true, trim: true }, // the code itself
    type: { type: String, enum: ["percent", "flat"], required: true },
    value: { type: Number, required: true, min: 0 },
    minAmount: Number,
    description: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  {
    ...baseOptions(),
    toJSON: {
      transform: (_d, ret) => {
        ret.code = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);
export const Coupon = mongoose.model("Coupon", couponSchema);

const billingSchema = new Schema(
  { fullName: String, email: String, phone: String, address: String, city: String, state: String, pincode: String, gstin: String },
  { _id: false },
);

const orderSchema = new Schema(
  {
    _id: idField("ord"),
    orderNumber: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    courseId: { type: String, required: true, index: true },
    subtotal: Number,
    discount: { type: Number, default: 0 },
    couponCode: String,
    tax: Number,
    total: Number,
    currency: { type: String, default: "INR" },
    status: { type: String, enum: ["pending", "successful", "failed", "cancelled", "refunded"], default: "pending", index: true },
    paymentMethod: { type: String, enum: ["razorpay", "upi", "card", "netbanking"], default: "razorpay" },
    gatewayOrderId: String,
    gatewayPaymentId: String,
    gatewaySignature: String,
    billing: billingSchema,
    failureReason: String,
    createdAt: { type: String, default: isoNow },
    paidAt: String,
    refundedAt: String,
  },
  baseOptions(["gatewaySignature"]),
);
orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ gatewayOrderId: 1 });
export const Order = mongoose.model("Order", orderSchema);

const enrollmentSchema = new Schema(
  {
    _id: idField("enr"),
    userId: { type: String, required: true, index: true },
    courseId: { type: String, required: true, index: true },
    enrolledAt: { type: String, default: isoNow },
    orderId: String,
    completedAt: String,
    status: { type: String, enum: ["active", "completed", "refunded"], default: "active" },
  },
  baseOptions(),
);
export const Enrollment = mongoose.model("Enrollment", enrollmentSchema);

/** Monotonic counters (order numbers, certificate serials). */
const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });
export const Counter = mongoose.model("Counter", counterSchema);

export async function nextSeq(name, start = 0) {
  const doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  if (doc.seq < start) {
    const fixed = await Counter.findOneAndUpdate({ _id: name }, { $set: { seq: start } }, { new: true });
    return fixed.seq;
  }
  return doc.seq;
}
