import mongoose from "mongoose";
import { env } from "./env.js";

mongoose.set("strictQuery", true);

export async function connectDb(uri = env.MONGODB_URI) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  if (!env.isTest) console.log(`[db] connected to ${uri.replace(/\/\/[^@]*@/, "//***@")}`);
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
