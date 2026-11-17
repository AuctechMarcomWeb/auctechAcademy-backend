import { createApp } from "./app.js";
import { connectDb } from "./config/db.js";
import { env } from "./config/env.js";

await connectDb();
const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`[api] Auctech Academy API on ${env.API_PUBLIC_URL} (payments: ${env.paymentMode}, google: ${env.googleEnabled ? "on" : "off"})`);
  console.log(`[api] allowed apps: ${env.FRONTEND_URL} (frontend), ${env.ADMIN_URL} (admin)`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
