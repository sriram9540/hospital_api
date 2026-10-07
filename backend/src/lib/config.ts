/**
 * System configuration tunables (§1, §2, §6, §7)
 */
import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  DATABASE_URL: process.env.DATABASE_URL || '',
  // Comma-separated allowed frontend origin(s) for CORS when API runs standalone on Render.
  FRONTEND_URL: process.env.FRONTEND_URL || '',
  PORT: Number(process.env.PORT || 3000),
  TIMEZONE: process.env.TIMEZONE || 'Asia/Kolkata',
  CANCEL_CUTOFF_HOURS: Number(process.env.CANCEL_CUTOFF_HOURS || 2),
  SLOT_DAYS_AHEAD: Number(process.env.SLOT_DAYS_AHEAD || 30),
  NO_SHOW_LIMIT: Number(process.env.NO_SHOW_LIMIT || 3),
  SESSION_SECRET: process.env.SESSION_SECRET || 'hospital_secure_session_secret_v1_prod_key',
  SESSION_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
  IDEMPOTENCY_EXPIRES_MS: 24 * 60 * 60 * 1000, // 24 hours
  REMINDER_POLL_INTERVAL_MS: 30000, // 30s
  MAX_REMINDER_ATTEMPTS: 5,
};
