import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { ApiError, notFound, parse } from "../lib/http.js";
import { computeBreakdown } from "../lib/pricing.js";
import { createRazorpayOrder, verifyCheckoutSignature, verifyWebhookSignature } from "../lib/razorpay.js";
import { requireAuth } from "../middleware/auth.js";
import { Coupon, Course, Enrollment, Order, getSettings, logActivity, nextSeq } from "../models/index.js";
import { uid } from "../lib/http.js";

const router = Router();

async function findCoupon(code, price) {
  if (!code) return undefined;
  const coupon = await Coupon.findById(String(code).trim().toUpperCase());
  if (!coupon) throw new ApiError("That coupon code is not valid.", 404, "invalid_coupon");
  if (!coupon.active) throw new ApiError("This coupon has expired.", 410, "expired_coupon");
  if (coupon.minAmount && price < coupon.minAmount) {
    throw new ApiError(`This coupon needs a minimum order of ₹${coupon.minAmount.toLocaleString("en-IN")}.`, 400, "min_amount");
  }
  return coupon;
}

/**
 * Grants access. This is the ONLY place an enrollment is created from a
 * payment — called after the gateway signature (or webhook) checks out.
 */
async function markPaid(order, { paymentId, signature } = {}) {
  if (order.status === "successful") return Enrollment.findOne({ orderId: order._id });
  order.status = "successful";
  order.paidAt = new Date().toISOString();
  order.gatewayPaymentId = paymentId ?? order.gatewayPaymentId;
  order.gatewaySignature = signature;
  await order.save();
  let enrollment = await Enrollment.findOne({ userId: order.userId, courseId: order.courseId, status: { $ne: "refunded" } });
  if (enrollment && enrollment.orderId && enrollment.orderId !== order._id) {
    // Paid twice for the same course (e.g. two checkout tabs): keep access, flag the extra payment for a refund.
    order.failureReason = "duplicate_payment_refund_due";
    await order.save();
  }
  if (!enrollment) {
    enrollment = await Enrollment.create({ userId: order.userId, courseId: order.courseId, enrolledAt: order.paidAt, orderId: order._id, status: "active" });
    const course = await Course.findByIdAndUpdate(order.courseId, { $inc: { enrolledCount: 1 } }, { new: true });
    await logActivity(order.userId, "enrolled", `Enrolled in ${course?.title ?? "a course"}`, order.courseId);
  }
  return enrollment;
}

router.post("/coupons/validate", requireAuth, async (req, res) => {
  const body = parse(z.object({ code: z.string().trim().min(1, "Enter a coupon code"), courseId: z.string() }), req.body);
  const course = await Course.findOne({ _id: body.courseId, status: "published" });
  if (!course) throw notFound("Course");
  const coupon = await findCoupon(body.code, course.price);
  const settings = await getSettings();
  res.json({ coupon: coupon.toJSON(), breakdown: computeBreakdown(course.price, coupon, settings.gstPercent) });
});

/** Step 1: create a pending order (and the Razorpay order when live keys are configured). */
router.post("/orders", requireAuth, async (req, res) => {
  const body = parse(
    z.object({
      courseId: z.string(),
      couponCode: z.string().trim().optional(),
      paymentMethod: z.enum(["razorpay", "upi", "card", "netbanking"]).default("razorpay"),
      billing: z.object({
        fullName: z.string().trim().min(2).max(100),
        email: z.string().trim().email(),
        phone: z.string().trim().min(6).max(20),
        address: z.string().max(300).optional(),
        city: z.string().max(80).optional(),
        state: z.string().max(80).optional(),
        pincode: z.string().max(12).optional(),
        gstin: z.string().max(20).optional(),
      }),
    }),
    req.body,
  );
  if (req.user.role !== "student") throw new ApiError("Only student accounts can purchase courses.", 403, "forbidden");
  const course = await Course.findOne({ _id: body.courseId, status: "published" });
  if (!course) throw new ApiError("This course cannot be purchased right now.", 404, "not_found");
  if (await Enrollment.exists({ userId: req.user._id, courseId: course._id, status: { $ne: "refunded" } })) {
    throw new ApiError("You are already enrolled in this course.", 409, "already_enrolled");
  }
  const coupon = await findCoupon(body.couponCode, course.price);
  const settings = await getSettings();
  const b = computeBreakdown(course.price, coupon, settings.gstPercent);
  const seq = await nextSeq("order", 10200);

  const order = new Order({
    orderNumber: `AUC-ORD-${seq}`,
    userId: req.user._id,
    courseId: course._id,
    subtotal: b.subtotal,
    discount: b.discount,
    couponCode: coupon?._id,
    tax: b.tax,
    total: b.total,
    currency: "INR",
    status: "pending",
    paymentMethod: body.paymentMethod,
    billing: body.billing,
  });

  // Free (100% discounted) course: no gateway needed.
  if (b.total === 0) {
    order.gatewayOrderId = `free_${order._id}`;
    await order.save();
    const enrollment = await markPaid(order, { paymentId: "free" });
    return res.status(201).json({ order: order.toJSON(), enrollment: enrollment.toJSON(), checkout: null });
  }

  if (env.paymentMode === "razorpay") {
    const rp = await createRazorpayOrder({ amountPaise: b.total * 100, receipt: order.orderNumber, notes: { orderId: order._id, courseId: course._id, userId: req.user._id } });
    order.gatewayOrderId = rp.id;
  } else {
    if (!env.ALLOW_DEMO_PAYMENTS) throw new ApiError("Payments are not configured on this server.", 503, "payments_unavailable");
    order.gatewayOrderId = `order_demo_${uid("").slice(-10)}`;
  }
  await order.save();

  res.status(201).json({
    order: order.toJSON(),
    checkout: {
      mode: env.paymentMode,
      key: env.paymentMode === "razorpay" ? env.RAZORPAY_KEY_ID : "rzp_test_DEMO",
      amount: b.total * 100,
      currency: "INR",
      name: settings.siteName,
      description: course.title,
      order_id: order.gatewayOrderId,
      prefill: { name: body.billing.fullName, email: body.billing.email, contact: body.billing.phone },
      notes: { courseId: course._id, orderId: order._id },
      theme: { color: "#14213D" },
    },
  });
});

/**
 * Step 2: verify. Live mode: { razorpay_order_id, razorpay_payment_id, razorpay_signature }.
 * Demo mode (ALLOW_DEMO_PAYMENTS): { outcome: "successful" | "failed" | "cancelled" }.
 */
router.post("/orders/:id/verify", requireAuth, async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
  if (!order) throw notFound("Order");
  if (order.status !== "pending") {
    if (order.status === "successful") {
      const enrollment = await Enrollment.findOne({ orderId: order._id });
      return res.json({ order: order.toJSON(), enrollment: enrollment?.toJSON() });
    }
    throw new ApiError("Order already processed", 409, "already_processed");
  }

  if (env.paymentMode === "razorpay") {
    const body = parse(z.object({ razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() }), req.body);
    if (body.razorpay_order_id !== order.gatewayOrderId) throw new ApiError("Payment does not belong to this order.", 400, "order_mismatch");
    if (!verifyCheckoutSignature({ orderId: body.razorpay_order_id, paymentId: body.razorpay_payment_id, signature: body.razorpay_signature })) {
      order.status = "failed";
      order.failureReason = "signature_mismatch";
      await order.save();
      throw new ApiError("Payment verification failed. If money was deducted it will be refunded automatically.", 400, "signature_invalid");
    }
    const enrollment = await markPaid(order, { paymentId: body.razorpay_payment_id, signature: body.razorpay_signature });
    return res.json({ order: order.toJSON(), enrollment: enrollment.toJSON() });
  }

  if (!env.ALLOW_DEMO_PAYMENTS) throw new ApiError("Demo payments are disabled.", 403, "demo_disabled");
  const { outcome } = parse(z.object({ outcome: z.enum(["successful", "failed", "cancelled"]) }), req.body);
  if (outcome !== "successful") {
    order.status = outcome;
    await order.save();
    return res.json({ order: order.toJSON() });
  }
  const enrollment = await markPaid(order, { paymentId: `pay_demo_${uid("").slice(-8)}` });
  res.json({ order: order.toJSON(), enrollment: enrollment.toJSON() });
});

/** Learner closed the gateway or the gateway reported a failure. */
router.post("/orders/:id/cancel", requireAuth, async (req, res) => {
  const { status, reason } = parse(z.object({ status: z.enum(["failed", "cancelled"]).default("cancelled"), reason: z.string().max(300).optional() }), req.body ?? {});
  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
  if (!order) throw notFound("Order");
  if (order.status === "pending") {
    order.status = status;
    order.failureReason = reason;
    await order.save();
  }
  res.json({ order: order.toJSON() });
});

/**
 * Razorpay webhook (configure in the Razorpay dashboard → Webhooks, event
 * `payment.captured` / `order.paid`). Safety net for learners who close the
 * tab before the browser calls /verify. Needs the raw body (see app.js).
 */
router.post("/webhook", async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  if (!verifyWebhookSignature(raw, signature)) throw new ApiError("Invalid webhook signature", 400, "signature_invalid");
  const event = req.body?.event;
  const payment = req.body?.payload?.payment?.entity;
  const gatewayOrderId = payment?.order_id ?? req.body?.payload?.order?.entity?.id;
  if (gatewayOrderId && (event === "payment.captured" || event === "order.paid")) {
    const order = await Order.findOne({ gatewayOrderId });
    if (order && order.status === "pending") await markPaid(order, { paymentId: payment?.id });
  } else if (gatewayOrderId && event === "payment.failed") {
    await Order.updateOne({ gatewayOrderId, status: "pending" }, { $set: { status: "failed", failureReason: payment?.error_description } });
  }
  res.json({ ok: true });
});

export default router;
export { markPaid };
