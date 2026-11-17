import nodemailer from "nodemailer";
import { env } from "../config/env.js";

let transport;

/** Sends mail through SMTP when configured; otherwise logs the message (development). */
export async function sendMail({ to, subject, text, html }) {
  if (!env.SMTP_HOST) {
    if (!env.isTest) console.log(`[mail] (SMTP not configured) to=${to} subject="${subject}"\n${text}`);
    return { logged: true };
  }
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transport.sendMail({ from: env.SMTP_FROM, to, subject, text, html });
}
