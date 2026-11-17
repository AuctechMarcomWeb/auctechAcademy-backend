# Auctech Academy — Backend API

REST API for the Auctech Academy platform, built with **Node.js + Express 5 + MongoDB (Mongoose)**.
It serves two separate apps:

| App | Default URL | What it is |
| --- | --- | --- |
| `frontend` | http://localhost:3000 | Public website + student portal + course player |
| `admin` | http://localhost:3001 | Admin portal |
| `backend` (this) | http://localhost:5000 | API both apps talk to |

---

## 1. Quick start

You need **Node.js 20+** and **MongoDB** (local install, `docker compose up -d` with the included file, or a free MongoDB Atlas cluster).

```bash
cp .env.example .env      # then edit MONGODB_URI (and JWT_SECRET)
npm install
npm run seed              # loads the demo catalogue, users, orders, certificates, progress
npm run dev               # http://localhost:5000  (auto-restarts on changes)
```

Check it works: open http://localhost:5000/api/health

Then start the two apps (`frontend` on 3000, `admin` on 3001). See their READMEs.

### Demo accounts (created by `npm run seed`)

| Role | Email | Password | Sign in at |
| --- | --- | --- | --- |
| Student | `student@auctech.in` | `password123` | frontend `/login` |
| Admin | `admin@auctech.in` | `password123` | admin `/login` |

Every other seeded user also has the password `password123`.

**Create your own admin** (keeps all other data):

```bash
npm run seed -- --admin you@company.com "Your Name" "YourStrongPassword"
```

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with auto-reload |
| `npm start` | Start for production |
| `npm run seed` | **Wipes the database** and loads the demo data |
| `npm test` | API integration tests (uses a separate `auctech_academy_test` database) |

---

## 2. Project structure

```
src/
  server.js              starts the HTTP server
  app.js                 Express app: CORS, security headers, routes, errors
  config/env.js          all settings (from .env)
  config/db.js           MongoDB connection
  models/                Mongoose schemas (User, Course, Quiz, Order, Certificate, …)
  routes/
    public.routes.js     /api/health, /config, /sync, catalogue, certificate verify, contact
    auth.routes.js       /api/auth/*  (register, login, profile, password reset, Google)
    learning.routes.js   /api/learning/*  (playback, lesson completion, quizzes, assignments, notes, certificate)
    payments.routes.js   /api/payments/*  (coupons, orders, Razorpay verify, webhook)
    student.routes.js    /api/me/*, internship applications
    uploads.routes.js    /api/uploads  (files)
    admin.routes.js      /api/admin/*  (everything in the admin portal)
  services/              business logic shared by routes (sync payload, course completion)
  lib/curriculum.js      the sequential-unlock rules (same as the frontend's copy)
  seed/                  demo data (JSON) + seed script
tests/api.test.js        integration tests
uploads/                 uploaded files (created automatically; git-ignored)
```

IDs are readable strings (`crs_fullstack`, `usr_student`, `AUC-DM-2026-000124`) and all dates are ISO strings, matching what the frontend and admin apps expect.

**Caching:** the catalogue (categories, instructors, courses, quizzes, assignments, internships) and platform settings are kept in memory for up to 30 s and cleared immediately when an admin changes anything. With several server instances, other instances pick up admin changes within 30 s. After running `npm run seed` while the server is running, restart it (or wait 30 s).

---

## 3. How the apps use the API

* **Auth:** `POST /api/auth/login` returns `{ token, user }`. Send `Authorization: Bearer <token>` on every request. Tokens are JWTs (7 days by default). Changing the password or suspending a user invalidates old tokens.
* **Loading data:** on start-up (and after login/logout) each app calls **`GET /api/sync`**, which returns everything the current user may see:
  * visitor → published courses (quiz answers removed), categories, instructors, internships
  * student → + own profile, enrollments, orders, certificates, applications, submissions, activity, learning progress
  * admin → everything (all users, orders, drafts, quiz answers, contact messages, all learner progress)
* **Writes** go to the specific endpoints below; the apps update their screen with the server's response.

### Rules the server enforces

* Lessons unlock in order. A lesson completes only if it's unlocked **and** the learner watched ≥ the watch threshold (default 90%, set in Admin → Settings). Watch progress is credited using the server's clock (at most 2.5× speed, and a long pause earns no extra time), so skipping to the end doesn't count.
* Quizzes open only after the module's lessons are done. **Grading happens on the server**; students never receive the correct answers until they pass (or run out of attempts).
* A certificate is issued only when every lesson, quiz and assignment is complete.
* Paid lesson videos and downloads are **hidden** (empty URL) from anyone who hasn't bought the course. Free preview lessons stay playable.
* An enrollment is created **only** after a payment is verified (Razorpay signature check, webhook, or the demo gateway when enabled). Prices, coupons and GST are recalculated on the server.
* Admin endpoints require the `admin` role; students get `403`.

---

## 4. API reference

`🔓` public · `👤` signed in · `🛡️` admin only. All bodies are JSON unless noted.

### Public
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | 🔓 status |
| GET | `/api/config` | 🔓 payment mode, Google enabled, public settings |
| GET | `/api/sync` | 🔓/👤 bootstrap data for the current user (see above) |
| GET | `/api/categories` | 🔓 with `courseCount` |
| GET | `/api/instructors` | 🔓 |
| GET | `/api/courses` | 🔓 `?q=&categories=a,b&levels=&price=all\|free\|paid\|under_2000\|2000_5000\|above_5000&duration=all\|short\|medium\|long&minRating=&sort=popular\|newest\|price_asc\|price_desc\|rating&page=&pageSize=` |
| GET | `/api/courses/featured` | 🔓 `?limit=4` |
| GET | `/api/courses/slug/:slug` · `/api/courses/:id` | 🔓 published only |
| GET | `/api/courses/:id/curriculum` | 🔓 quizzes (no answers) + assignments |
| GET | `/api/internships` · `/api/internships/:slug` | 🔓 |
| GET | `/api/certificates/verify/:id?source=qr` | 🔓 → `{ status: valid\|revoked\|invalid\|not_found, certificate? }` (logged) |
| POST | `/api/certificates/verify` | 🔓 `{ id, source }` |
| POST | `/api/contact` | 🔓 `{ name, email, topic?, message }` |

### Auth
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/register` | `{ name, email, password, phone? }` → `{ token, user }` |
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| POST | `/api/auth/logout` | 👤 `?all=1` signs out every device |
| GET / PATCH | `/api/auth/me` | 👤 profile `{ name, phone, headline, bio, location, avatarUrl }` |
| PUT | `/api/auth/me/notifications` | 👤 `{ courseUpdates, assessmentReminders, internshipAlerts, marketing }` |
| POST | `/api/auth/change-password` | 👤 `{ current, next }` → new token |
| POST | `/api/auth/forgot-password` | `{ email }` emails a reset link (or logs it without SMTP) |
| POST | `/api/auth/reset-password` | `{ email, token, password }` → `{ token, user }` |
| GET | `/api/auth/google?returnTo=<app>/auth/callback` | starts Google sign-in; returns to `returnTo#token=…` |

### Student
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/me/enrollments` · `orders` · `certificates` · `activity` · `submissions` · `applications` | 👤 |
| GET | `/api/learning/courses/:courseId` | 👤 progress, attempts, submissions, notes |
| POST | `/api/learning/courses/:courseId/playback` | 👤 `{ events: [{ lessonId, position, delta, duration }] }` |
| POST | `/api/learning/courses/:courseId/last-lesson` | 👤 `{ lessonId }` |
| POST | `/api/learning/courses/:courseId/lessons/:lessonId/complete` | 👤 403 locked · 412 not watched enough |
| POST | `/api/learning/quizzes/:quizId/attempts` | 👤 `{ answers: { questionId: optionId }, startedAt }` → graded attempt + review |
| POST | `/api/learning/assignments/:id/submissions` | 👤 `{ uploadId, fileName, fileSize, note? }` |
| POST | `/api/learning/courses/:courseId/complete` | 👤 issues the certificate (412 if incomplete) |
| POST / DELETE | `/api/learning/courses/:courseId/notes` · `/api/learning/notes/:id` | 👤 |
| POST | `/api/learning/reset` | 👤 wipe own progress (only when `ALLOW_DEMO_RESET=true`) |
| POST | `/api/internships/:id/apply` | 👤 `{ fullName, email, phone, college, graduationYear, coverLetter, portfolioUrl?, resumeUploadId? }` |
| PATCH | `/api/me/applications/:id/tasks/:taskId` | 👤 `{ status: "submitted" }` |

### Payments
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/payments/coupons/validate` | 👤 `{ code, courseId }` |
| POST | `/api/payments/orders` | 👤 `{ courseId, couponCode?, paymentMethod, billing }` → `{ order, checkout }` (Razorpay options) |
| POST | `/api/payments/orders/:id/verify` | 👤 live: `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` · demo: `{ outcome }` |
| POST | `/api/payments/orders/:id/cancel` | 👤 `{ status: cancelled\|failed }` |
| POST | `/api/payments/webhook` | Razorpay webhook (`X-Razorpay-Signature`) |

### Uploads
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/uploads?kind=…` | 👤 multipart field `file`. Kinds: `assignment`, `resume`, `avatar` (anyone signed in) · `video`, `thumbnail`, `resource` (🛡️) |
| GET | `/api/uploads/:id` | 👤 download a private file (owner or admin) |
| GET | `/uploads/public/<file>` | 🔓 public files (videos, thumbnails) |

### Admin (`/api/admin/...`, 🛡️)
| Area | Endpoints |
| --- | --- |
| Dashboard | `GET stats`, `GET learning`, `GET activity` |
| Users | `GET users?role=`, `PATCH users/:id/status { status }` |
| Categories | `POST categories`, `PUT categories/:id`, `DELETE categories/:id` |
| Instructors | `GET`, `PUT instructors/:id`, `DELETE instructors/:id` |
| Courses | `GET courses`, `POST courses`, `PUT courses/:id` (full course with modules & lessons), `PATCH courses/:id/status`, `DELETE courses/:id` |
| Quizzes | `GET quizzes`, `PUT quizzes/:id`, `DELETE quizzes/:id` |
| Assignments | `GET assignments`, `PUT assignments/:id`, `DELETE assignments/:id`, `GET submissions`, `PATCH submissions/:id/review { status, marks, grade, feedback }` |
| Enrollments & orders | `GET enrollments`, `POST enrollments { userId, courseId }` (free grant), `GET orders`, `POST orders/:id/refund` |
| Coupons | `GET coupons`, `PUT coupons/:code`, `DELETE coupons/:code` |
| Certificates | `GET certificates`, `POST certificates/:id/revoke { reason }`, `POST certificates/:id/reinstate` |
| Internships | `PUT internships/:id`, `DELETE internships/:id`, `GET applications`, `PATCH applications/:id { status, mentor, attendance, tasks, performanceScore, issueCertificate }` |
| Contact | `GET contact-messages`, `PATCH contact-messages/:id { status }` |
| Settings | `GET settings`, `PUT settings` |
| Demo | `POST reset-demo` (only when `ALLOW_DEMO_RESET=true`) |

Errors always look like `{ "message": "Readable text", "code": "machine_code" }` with a matching HTTP status.

---

## 5. Going live

1. **Database:** create a MongoDB Atlas cluster (or your own server) and set `MONGODB_URI`.
2. **Secrets:** set `NODE_ENV=production` and a random `JWT_SECRET` of at least 32 characters (`openssl rand -hex 32`). The server refuses to start in production with the placeholder or a short secret.
3. **URLs:** set `API_PUBLIC_URL`, `FRONTEND_URL`, `ADMIN_URL` to your real domains (e.g. `https://api.auctech.in`, `https://certify.auctech.in`, `https://admin.auctech.in`).
   * **No CORS restrictions:** set `CORS_ORIGINS=*` and any website can call the API. Logins use Bearer tokens (not cookies), so other sites still can't act as your users. Google sign-in only ever returns to `FRONTEND_URL` / `ADMIN_URL`.
4. **Razorpay:** set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. Add a webhook to `https://<api>/api/payments/webhook`. Set `ALLOW_DEMO_PAYMENTS=false`.
5. **Google sign-in (optional):** set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`; redirect URI `https://<api>/api/auth/google/callback`.
6. **Email (optional):** set the `SMTP_*` values so password-reset emails are delivered.
7. **Turn off demo tools:** `ALLOW_DEMO_RESET=false`. Don't run `npm run seed` on a live database. Create your admin with `npm run seed -- --admin …`.
8. **Files:** uploads are stored on disk in `UPLOAD_DIR`. Use a persistent disk or volume. For large scale, swap the storage in `routes/uploads.routes.js` for S3/Cloud Storage.
9. Run with `npm start` behind a process manager (PM2, systemd, Docker) and HTTPS (Nginx, Render, Railway, etc.).

### Known limits

* The watch-time check uses the video length the player reports. For stronger protection, store each video's real duration server-side (e.g. from your video host) and use signed video URLs.
* Refunds mark the order refunded and remove access. Issue the money refund from the Razorpay dashboard (or add a call to Razorpay's Refunds API in `admin.routes.js`).
#   a u c t e c h A c a d e m y - b a c k e n d  
 