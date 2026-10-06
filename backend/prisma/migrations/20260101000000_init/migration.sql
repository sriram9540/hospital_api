-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enums
CREATE TYPE "UserRole" AS ENUM ('patient', 'doctor', 'admin', 'receptionist');
CREATE TYPE "SlotStatus" AS ENUM ('open', 'held', 'booked', 'blocked');
CREATE TYPE "AppointmentStatus" AS ENUM ('booked', 'cancelled', 'completed', 'no_show', 'rescheduled');
CREATE TYPE "NotificationKind" AS ENUM ('confirm', 'remind_24h', 'remind_2h', 'cancel_notice');
CREATE TYPE "NotificationChannel" AS ENUM ('sms', 'whatsapp', 'email', 'console');
CREATE TYPE "NotificationJobStatus" AS ENUM ('pending', 'sent', 'failed', 'cancelled');
CREATE TYPE "WaitlistStatus" AS ENUM ('waiting', 'offered', 'claimed', 'expired', 'cancelled');
CREATE TYPE "Weekday" AS ENUM ('sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat');

-- Tables
CREATE TABLE "users" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "role" "UserRole" NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "password_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

CREATE TABLE "patients" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL UNIQUE,
  "full_name" TEXT NOT NULL,
  "dob" DATE,
  "no_show_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "patients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "patients_user_id_idx" ON "patients"("user_id");

CREATE TABLE "departments" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL UNIQUE,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "departments_is_active_idx" ON "departments"("is_active");

CREATE TABLE "doctors" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL UNIQUE,
  "department_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "slot_minutes" INTEGER NOT NULL DEFAULT 15,
  "overbook_limit" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "doctors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "doctors_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT
);
CREATE INDEX "doctors_department_id_idx" ON "doctors"("department_id");

CREATE TABLE "doctor_schedules" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "doctor_id" UUID NOT NULL,
  "weekday" "Weekday" NOT NULL,
  "start_time" TEXT NOT NULL,
  "end_time" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "doctor_schedules_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE CASCADE,
  CONSTRAINT "doctor_schedules_time_chk" CHECK (end_time > start_time)
);
CREATE INDEX "doctor_schedules_doctor_id_idx" ON "doctor_schedules"("doctor_id");
CREATE INDEX "doctor_schedules_doctor_id_weekday_idx" ON "doctor_schedules"("doctor_id", "weekday");

CREATE TABLE "slots" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "doctor_id" UUID NOT NULL,
  "starts_at" TIMESTAMPTZ NOT NULL,
  "ends_at" TIMESTAMPTZ NOT NULL,
  "status" "SlotStatus" NOT NULL DEFAULT 'open',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "slots_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE CASCADE,
  CONSTRAINT "slots_time_chk" CHECK (ends_at > starts_at)
);
CREATE UNIQUE INDEX "slots_doctor_id_starts_at_key" ON "slots"("doctor_id", "starts_at");
CREATE INDEX "slots_doctor_id_starts_at_idx" ON "slots"("doctor_id", "starts_at");
CREATE INDEX "slots_status_starts_at_idx" ON "slots"("status", "starts_at");

CREATE TABLE "appointments" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" UUID NOT NULL,
  "slot_id" UUID NOT NULL,
  "status" "AppointmentStatus" NOT NULL DEFAULT 'booked',
  "reschedule_of" UUID,
  "cancelled_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT,
  CONSTRAINT "appointments_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "slots"("id") ON DELETE RESTRICT,
  CONSTRAINT "appointments_reschedule_of_fkey" FOREIGN KEY ("reschedule_of") REFERENCES "appointments"("id") ON DELETE SET NULL
);
CREATE INDEX "appointments_patient_id_idx" ON "appointments"("patient_id");
CREATE INDEX "appointments_slot_id_idx" ON "appointments"("slot_id");
CREATE INDEX "appointments_status_idx" ON "appointments"("status");
CREATE INDEX "appointments_reschedule_of_idx" ON "appointments"("reschedule_of");

-- Mandatory double-booking guard: exactly one active booking per slot
CREATE UNIQUE INDEX "one_active_appointment_per_slot"
  ON "appointments"("slot_id") WHERE "status" = 'booked';

CREATE TABLE "notification_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "appointment_id" UUID NOT NULL,
  "kind" "NotificationKind" NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "run_at" TIMESTAMPTZ NOT NULL,
  "status" "NotificationJobStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "sent_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "notification_jobs_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "notification_jobs_appointment_id_kind_channel_key"
  ON "notification_jobs"("appointment_id", "kind", "channel");
CREATE INDEX "notification_jobs_status_run_at_idx" ON "notification_jobs"("status", "run_at");
CREATE INDEX "notification_jobs_appointment_id_idx" ON "notification_jobs"("appointment_id");

CREATE TABLE "idempotency_keys" (
  "key" TEXT PRIMARY KEY,
  "request_hash" TEXT NOT NULL,
  "response" JSONB NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

CREATE TABLE "waitlist" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" UUID NOT NULL,
  "doctor_id" UUID NOT NULL,
  "date" DATE NOT NULL,
  "status" "WaitlistStatus" NOT NULL DEFAULT 'waiting',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "waitlist_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE,
  CONSTRAINT "waitlist_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE CASCADE
);
CREATE INDEX "waitlist_patient_id_idx" ON "waitlist"("patient_id");
CREATE INDEX "waitlist_doctor_id_date_status_idx" ON "waitlist"("doctor_id", "date", "status");
CREATE INDEX "waitlist_status_created_at_idx" ON "waitlist"("status", "created_at");

CREATE TABLE "audit_log" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_id" UUID,
  "action" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "entity_id" UUID,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "audit_log_actor_id_idx" ON "audit_log"("actor_id");
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");
