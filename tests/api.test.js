/**
 * API integration tests. Uses a separate database (MONGODB_URI_TEST or
 * mongodb://127.0.0.1:27017/auctech_academy_test), seeded fresh.
 *   npm test
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI_TEST ?? "mongodb://127.0.0.1:27017/auctech_academy_test";
process.env.UPLOAD_DIR = process.env.UPLOAD_DIR_TEST ?? "uploads-test";

const { connectDb, disconnectDb } = await import("../src/config/db.js");
const { createApp } = await import("../src/app.js");
const { seedDatabase } = await import("../src/seed/seed-data.js");
const { CourseProgress } = await import("../src/models/index.js");

let app;
let student;
let admin;

const login = async (email) => (await request(app).post("/api/auth/login").send({ email, password: "password123" }).expect(200)).body.token;
const as = (token) => ({
  get: (u) => request(app).get(u).set("Authorization", `Bearer ${token}`),
  post: (u, b = {}) => request(app).post(u).set("Authorization", `Bearer ${token}`).send(b),
  put: (u, b = {}) => request(app).put(u).set("Authorization", `Bearer ${token}`).send(b),
  patch: (u, b = {}) => request(app).patch(u).set("Authorization", `Bearer ${token}`).send(b),
  delete: (u) => request(app).delete(u).set("Authorization", `Bearer ${token}`),
});

before(async () => {
  await connectDb();
  await seedDatabase({ drop: true });
  app = createApp();
  student = as(await login("student@auctech.in"));
  admin = as(await login("admin@auctech.in"));
});
after(async () => {
  await disconnectDb();
});

describe("public", () => {
  test("health and config", async () => {
    await request(app).get("/api/health").expect(200);
    const { body } = await request(app).get("/api/config").expect(200);
    assert.equal(body.paymentMode, "demo");
  });

  test("course list filters and pagination", async () => {
    const { body } = await request(app).get("/api/courses?sort=price_asc&pageSize=3").expect(200);
    assert.equal(body.items.length, 3);
    assert.ok(body.items[0].price <= body.items[1].price);
    const py = await request(app).get("/api/courses?q=python").expect(200);
    assert.ok(py.body.items.every((c) => /python/i.test(c.title + c.subtitle + c.skills.join())));
  });

  test("anonymous sync has no private data and no quiz answers", async () => {
    const { body } = await request(app).get("/api/sync").expect(200);
    assert.equal(body.me, null);
    assert.equal(body.users.length, 0);
    assert.ok(body.quizzes.every((q) => q.questions.every((qq) => qq.correctOptionId === undefined)));
    assert.ok(body.courses.every((c) => c.status === "published"));
  });

  test("paid lesson videos are hidden from visitors (previews stay playable)", async () => {
    const { body } = await request(app).get("/api/sync").expect(200);
    const lessons = body.courses.flatMap((c) => c.modules.flatMap((m) => m.lessons));
    assert.ok(lessons.filter((l) => !l.isPreview).every((l) => l.videoUrl === ""), "no paid video URLs");
    assert.ok(lessons.some((l) => l.isPreview && l.videoUrl), "preview lessons keep their video");
    const one = await request(app).get("/api/courses/slug/full-stack-web-development").expect(200);
    assert.ok(one.body.modules[1].lessons.every((l) => l.videoUrl === ""));
  });

  test("certificate verification", async () => {
    assert.equal((await request(app).get("/api/certificates/verify/AUC-DM-2026-000124").expect(200)).body.status, "valid");
    assert.equal((await request(app).get("/api/certificates/verify/AUC-FSWD-2026-000033").expect(200)).body.status, "revoked");
    assert.equal((await request(app).get("/api/certificates/verify/AUC-XX-2026-999999").expect(200)).body.status, "not_found");
    assert.equal((await request(app).post("/api/certificates/verify").send({ id: "nope" }).expect(200)).body.status, "invalid");
  });
});

describe("auth", () => {
  test("register, duplicate email, wrong password", async () => {
    const email = `t${Date.now()}@example.com`;
    const res = await request(app).post("/api/auth/register").send({ name: "Test User", email, password: "longpassword" }).expect(201);
    assert.ok(res.body.token);
    assert.equal(res.body.user.passwordHash, undefined);
    await request(app).post("/api/auth/register").send({ name: "Test User", email, password: "longpassword" }).expect(409);
    await request(app).post("/api/auth/login").send({ email, password: "wrong" }).expect(401);
  });

  test("protected routes need a token; students cannot use admin APIs", async () => {
    await request(app).get("/api/auth/me").expect(401);
    await student.get("/api/admin/users").expect(403);
    await admin.get("/api/admin/users").expect(200);
  });

  test("password change invalidates old tokens", async () => {
    const email = `p${Date.now()}@example.com`;
    const { body } = await request(app).post("/api/auth/register").send({ name: "Pw User", email, password: "firstpassword" }).expect(201);
    const old = as(body.token);
    const changed = await old.post("/api/auth/change-password", { current: "firstpassword", next: "secondpassword" }).expect(200);
    await old.get("/api/auth/me").expect(401);
    await as(changed.body.token).get("/api/auth/me").expect(200);
  });
});

describe("learning rules are enforced on the server", () => {
  const course = "crs_python_da";

  test("enrolled students get video URLs only for their own courses", async () => {
    const { body } = await student.get("/api/sync").expect(200);
    const own = body.courses.find((c) => c.id === course);
    const other = body.courses.find((c) => c.id === "crs_aws");
    assert.ok(own.modules.every((m) => m.lessons.every((l) => l.videoUrl)), "own course playable");
    assert.ok(other.modules[1].lessons.every((l) => l.videoUrl === ""), "other courses hidden");
  });

  test("first playback report cannot claim minutes of watch time", async () => {
    const { body } = await student.post(`/api/learning/courses/crs_fullstack/playback`, { events: [{ lessonId: "crs_fullstack_m4_l3", position: 1700, delta: 600, duration: 1800 }] }).expect(200);
    assert.ok(body.progress.lessons.crs_fullstack_m4_l3.maxPosition < 60, `capped (${body.progress.lessons.crs_fullstack_m4_l3.maxPosition})`);
  });

  test("notes must belong to a lesson of the course", async () => {
    await student.post(`/api/learning/courses/${course}/notes`, { lessonId: "crs_aws_m1_l1", body: "x" }).expect(404);
  });

  test("cannot complete a locked or unwatched lesson", async () => {
    await student.post(`/api/learning/courses/${course}/lessons/${course}_m1_l3/complete`).expect(403);
    await student.post(`/api/learning/courses/${course}/lessons/${course}_m1_l2/complete`).expect(412);
  });

  test("playback cannot jump to the end", async () => {
    const { body } = await student.post(`/api/learning/courses/${course}/playback`, { events: [{ lessonId: `${course}_m1_l2`, position: 590, delta: 1, duration: 600 }] }).expect(200);
    assert.ok(body.progress.lessons[`${course}_m1_l2`].maxPosition < 30, "max position capped by elapsed time");
    await student.post(`/api/learning/courses/${course}/lessons/${course}_m1_l2/complete`).expect(412);
  });

  test("completion succeeds once the threshold is genuinely reached", async () => {
    // Simulate real viewing: a report every ~5 s (we backdate the last report instead of sleeping).
    const lessonId = `${course}_m1_l2`;
    let position = 20;
    for (let i = 0; i < 40 && position < 560; i++) {
      const p = await CourseProgress.findOne({ userId: "usr_student", courseId: course });
      p.lessons[lessonId].lastEventAt = new Date(Date.now() - 5000).toISOString();
      p.markModified("lessons");
      await p.save();
      position = Math.min(560, position + 15);
      await student.post(`/api/learning/courses/${course}/playback`, { events: [{ lessonId, position, delta: 5, duration: 600 }] }).expect(200);
    }
    const { body } = await student.post(`/api/learning/courses/${course}/lessons/${lessonId}/complete`).expect(200);
    assert.equal(body.progress.lessons[lessonId].completed, true);
  });

  test("quiz locked until lessons done, graded server-side, answers hidden until passed", async () => {
    await student.post(`/api/learning/quizzes/${course}_m1_quiz/attempts`, { answers: {} }).expect(403);
    const p = await CourseProgress.findOne({ userId: "usr_student", courseId: course });
    p.lessons[`${course}_m1_l3`] = { lessonId: `${course}_m1_l3`, maxPosition: 100, watchedSeconds: 100, lastPosition: 100, completed: true, updatedAt: new Date().toISOString() };
    p.markModified("lessons");
    await p.save();

    const fail = await student.post(`/api/learning/quizzes/${course}_m1_quiz/attempts`, { answers: {} }).expect(201);
    assert.equal(fail.body.attempt.passed, false);
    assert.ok(Object.values(fail.body.attempt.review).every((r) => r.correctOptionId === undefined), "no answers after a failed attempt");

    const { body: quizzes } = await admin.get("/api/admin/quizzes").expect(200);
    const quiz = quizzes.find((q) => q.id === `${course}_m1_quiz`);
    const answers = Object.fromEntries(quiz.questions.map((q) => [q.id, q.correctOptionId]));
    const pass = await student.post(`/api/learning/quizzes/${course}_m1_quiz/attempts`, { answers }).expect(201);
    assert.equal(pass.body.attempt.scorePercent, 100);
    assert.ok(Object.values(pass.body.attempt.review).every((r) => r.correctOptionId), "answers revealed after passing");
    await student.post(`/api/learning/quizzes/${course}_m1_quiz/attempts`, { answers }).expect(409);
  });

  test("certificate refused for an incomplete course", async () => {
    await student.post(`/api/learning/courses/${course}/complete`).expect(412);
  });

  test("not enrolled → 403", async () => {
    await student.get("/api/learning/courses/crs_aws").expect(403);
  });

  test("notes round-trip", async () => {
    const { body } = await student.post(`/api/learning/courses/${course}/notes`, { lessonId: `${course}_m1_l1`, body: "hello", timestampSeconds: 3 }).expect(201);
    await student.delete(`/api/learning/notes/${body.note.id}`).expect(200);
  });
});

describe("payments", () => {
  test("coupon validation", async () => {
    await student.post("/api/payments/coupons/validate", { code: "AUCTECH20", courseId: "crs_seo" }).expect(200);
    await student.post("/api/payments/coupons/validate", { code: "EXPIRED10", courseId: "crs_seo" }).expect(410);
    await student.post("/api/payments/coupons/validate", { code: "NOPE", courseId: "crs_seo" }).expect(404);
  });

  test("server computes the price; enrollment only after verification", async () => {
    const billing = { fullName: "Ananya Sharma", email: "student@auctech.in", phone: "+91 98201 44321" };
    const { body } = await student.post("/api/payments/orders", { courseId: "crs_seo", couponCode: "AUCTECH20", billing }).expect(201);
    assert.equal(body.order.discount, Math.round(body.order.subtotal * 0.2));
    assert.equal(body.order.status, "pending");
    let enr = (await student.get("/api/me/enrollments")).body;
    assert.ok(!enr.some((e) => e.courseId === "crs_seo"));
    await student.post(`/api/payments/orders/${body.order.id}/verify`, { outcome: "successful" }).expect(200);
    enr = (await student.get("/api/me/enrollments")).body;
    assert.ok(enr.some((e) => e.courseId === "crs_seo"));
    await student.post("/api/payments/orders", { courseId: "crs_seo", billing }).expect(409);
  });

  test("admin refund revokes access", async () => {
    const orders = (await student.get("/api/me/orders")).body;
    const paid = orders.find((o) => o.courseId === "crs_seo" && o.status === "successful");
    await admin.post(`/api/admin/orders/${paid.id}/refund`).expect(200);
    await student.get("/api/learning/courses/crs_seo").expect(403);
  });
});

describe("admin", () => {
  test("create, update, publish and delete a course with a quiz", async () => {
    const id = `crs_test_${Date.now()}`;
    const course = {
      id,
      slug: `test-course-${Date.now()}`,
      title: "Test Course",
      categoryId: "cat_web",
      instructorId: "ins_arjun",
      level: "Beginner",
      price: 999,
      certificateCode: "TST",
      status: "draft",
      modules: [{ id: `${id}_m1`, title: "Module 1", lessons: [{ id: `${id}_m1_l1`, title: "Lesson 1", videoUrl: "https://example.com/v.mp4", durationSeconds: 60 }] }],
    };
    await admin.put(`/api/admin/courses/${id}`, course).expect(200);
    const quiz = { id: `${id}_quiz`, courseId: id, moduleId: `${id}_m1`, title: "Quiz", passingScore: 70, questions: [{ id: "q1", prompt: "2+2?", options: [{ id: "a", text: "4" }, { id: "b", text: "5" }], correctOptionId: "a" }] };
    await admin.put(`/api/admin/quizzes/${quiz.id}`, quiz).expect(200);
    const anon1 = (await request(app).get("/api/sync")).body;
    assert.ok(!anon1.courses.some((c) => c.id === id), "drafts are hidden from the public");
    await admin.patch(`/api/admin/courses/${id}/status`, { status: "published" }).expect(200);
    const anon2 = (await request(app).get("/api/sync")).body;
    const published = anon2.courses.find((c) => c.id === id);
    assert.equal(published.modules[0].quizId, quiz.id, "quiz linked to its module");
    await admin.delete(`/api/admin/courses/${id}`).expect(200);
  });

  test("turning off quiz retakes limits learners to one attempt (and the UI is told)", async () => {
    await admin.put("/api/admin/settings", { allowQuizRetakes: false }).expect(200);
    const { body } = await student.get("/api/sync").expect(200);
    assert.ok(body.quizzes.filter((q) => q.courseId === "crs_fullstack").every((q) => q.maxAttempts === 1));
    await admin.put("/api/admin/settings", { allowQuizRetakes: true }).expect(200);
  });

  test("SVG avatars are rejected", async () => {
    const tok = (await request(app).post("/api/auth/login").send({ email: "student@auctech.in", password: "password123" })).body.token;
    await request(app).post("/api/uploads?kind=avatar").set("Authorization", `Bearer ${tok}`).attach("file", Buffer.from("<svg/>"), { filename: "a.svg", contentType: "image/svg+xml" }).expect(415);
  });

  test("cannot delete a course with active enrollments", async () => {
    await admin.delete("/api/admin/courses/crs_fullstack").expect(409);
  });

  test("suspending a user signs them out", async () => {
    const t = await login("rahul.iyer@example.com");
    await as(t).get("/api/auth/me").expect(200);
    await admin.patch("/api/admin/users/usr_2/status", { status: "suspended" }).expect(200);
    await as(t).get("/api/auth/me").expect(401);
    await request(app).post("/api/auth/login").send({ email: "rahul.iyer@example.com", password: "password123" }).expect(403);
    await admin.patch("/api/admin/users/usr_2/status", { status: "active" }).expect(200);
  });

  test("uploads: students may upload assignments but not videos", async () => {
    const tok = (await request(app).post("/api/auth/login").send({ email: "student@auctech.in", password: "password123" })).body.token;
    const up = (kind) => request(app).post(`/api/uploads?kind=${kind}`).set("Authorization", `Bearer ${tok}`);
    await up("video").attach("file", Buffer.from("x"), { filename: "a.mp4", contentType: "video/mp4" }).expect(403);
    const { body } = await up("assignment").attach("file", Buffer.from("hello"), { filename: "work.zip", contentType: "application/zip" }).expect(201);
    await student.get(`/api/uploads/${body.upload.id}`).expect(200);
    await request(app).get(`/api/uploads/${body.upload.id}`).expect(401);
  });

  test("admin sync includes everything", async () => {
    const { body } = await admin.get("/api/sync").expect(200);
    assert.ok(body.users.length > 10);
    assert.ok(body.quizzes.some((q) => q.questions.some((qq) => qq.correctOptionId)));
    assert.ok(Object.keys(body.learning.progress).length >= 3);
  });
});
