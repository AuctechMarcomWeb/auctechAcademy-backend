/**
 * npm run seed            → wipe the database and load the demo dataset
 * npm run seed -- --admin you@company.com "Your Name" "StrongPassword"
 *                          → create (or reset) an admin account without touching other data
 */
import bcrypt from "bcryptjs";
import { connectDb, disconnectDb } from "../config/db.js";
import { User } from "../models/index.js";
import { DEMO_PASSWORD, seedDatabase } from "./seed-data.js";

const args = process.argv.slice(2);

async function main() {
  await connectDb();
  if (args[0] === "--admin") {
    const [, email, name = "Administrator", password] = args;
    if (!email || !password || password.length < 8) {
      console.error('Usage: npm run seed -- --admin <email> "<name>" <password (8+ chars)>');
      process.exitCode = 1;
      return;
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.findOneAndUpdate(
      { email: email.toLowerCase() },
      { $set: { name, role: "admin", status: "active", passwordHash }, $setOnInsert: { email: email.toLowerCase(), joinedAt: new Date().toISOString() } },
      { upsert: true, new: true },
    );
    console.log(`Admin ready: ${user.email}`);
    return;
  }
  console.log("Seeding demo data (all existing data will be removed)…");
  await seedDatabase({ drop: true, log: console.log });
  console.log(`\nDone. Demo logins (password "${DEMO_PASSWORD}"):\n  student@auctech.in  (student)\n  admin@auctech.in    (admin)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
