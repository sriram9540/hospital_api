/**
 * Database client for Neon Postgres (§1, §2, §5)
 * Uses `pg` Pool with DATABASE_URL. Same `db.query` / `db.transaction`
 * interface as before so services need no changes.
 */
import { Pool, PoolClient } from 'pg';
import argon2 from 'argon2';
import { CONFIG } from './config.js';
import { logger } from './logger.js';

let poolInstance: Pool | null = null;

export async function getPool(): Promise<Pool> {
  if (!poolInstance) {
    if (!CONFIG.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set. Add it to .env (see .env.example).');
    }
    poolInstance = new Pool({
      connectionString: CONFIG.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    poolInstance.on('error', (err) => logger.error('Neon pool idle client error', err));
    await initDatabase(poolInstance);
  }
  return poolInstance;
}

// Kept for compat (system.test.ts + server.ts call getDb())
export async function getDb(): Promise<Pool> {
  return getPool();
}

export async function closeDb(): Promise<void> {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
  }
}

export interface DbClient {
  query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[]; affectedRows?: number }>;
}

type QueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export const db = {
  async query<T = any>(sql: string, params: any[] = []): Promise<{ rows: T[]; affectedRows?: number }> {
    const pool = await getPool();
    const res = await pool.query(sql, params);
    return { rows: (res.rows || []) as T[], affectedRows: res.rowCount ?? 0 };
  },

  async transaction<T>(callback: (tx: DbClient) => Promise<T>): Promise<T> {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const wrapped: DbClient = {
        query: async <R = any>(sql: string, params?: any[]) => {
          const r = await client.query(sql, params);
          return { rows: (r.rows || []) as R[], affectedRows: r.rowCount ?? 0 };
        },
      };
      const result = await callback(wrapped);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors, preserve original
      }
      throw err;
    } finally {
      client.release();
    }
  },
};

export async function initDatabase(pool: Pool): Promise<void> {
  logger.info('Initializing Neon Postgres schema and tables...');

  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

  await pool.query(`
    -- Users Table
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role TEXT NOT NULL CHECK (role IN ('patient', 'doctor', 'admin', 'receptionist')),
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Patients Table
    CREATE TABLE IF NOT EXISTS patients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL,
      dob DATE,
      no_show_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_patients_user_id ON patients(user_id);

    -- Departments Table
    CREATE TABLE IF NOT EXISTS departments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      icon TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Doctors Table
    CREATE TABLE IF NOT EXISTS doctors (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,
      department_id UUID NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      specialization TEXT NOT NULL,
      slot_minutes INT NOT NULL DEFAULT 30,
      overbook_limit INT NOT NULL DEFAULT 0,
      image_url TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_doctors_department_id ON doctors(department_id);

    -- Doctor Schedules Table
    CREATE TABLE IF NOT EXISTS doctor_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      doctor_id UUID NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      weekday INT NOT NULL CHECK (weekday >= 0 AND weekday <= 6),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      CHECK (end_time > start_time)
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_doctor_id ON doctor_schedules(doctor_id);

    -- Slots Table (§2, §5)
    CREATE TABLE IF NOT EXISTS slots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      doctor_id UUID NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'held', 'booked', 'blocked')),
      CHECK (ends_at > starts_at),
      CONSTRAINT uq_doctor_slot UNIQUE (doctor_id, starts_at)
    );
    CREATE INDEX IF NOT EXISTS idx_slots_doctor_starts_status ON slots(doctor_id, starts_at, status);

    -- Appointments Table (§2, §5, §6)
    CREATE TABLE IF NOT EXISTS appointments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      slot_id UUID NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled', 'completed', 'no_show', 'rescheduled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cancelled_at TIMESTAMPTZ,
      reschedule_of UUID REFERENCES appointments(id) ON DELETE SET NULL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_appointments_patient_id ON appointments(patient_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_slot_id ON appointments(slot_id);

    -- DOUBLE-BOOKING GUARD (§5, §6) Raw SQL index
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_appointment_per_slot
      ON appointments (slot_id) WHERE status = 'booked';

    -- Notification Jobs Table (Outbox Pattern §6, §8)
    CREATE TABLE IF NOT EXISTS notification_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('confirm', 'remind_24h', 'remind_2h', 'cancel_notice')),
      channel TEXT NOT NULL CHECK (channel IN ('sms', 'email', 'whatsapp')),
      recipient TEXT NOT NULL,
      payload JSONB NOT NULL,
      run_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_appt_job UNIQUE (appointment_id, kind, channel)
    );
    CREATE INDEX IF NOT EXISTS idx_notification_jobs_status_run ON notification_jobs(status, run_at);

    -- Idempotency Keys Table (§4, §6, §7)
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      response TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Waitlist Table (§7)
    CREATE TABLE IF NOT EXISTS waitlist (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id UUID NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      desired_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'notified', 'booked', 'expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_waitlist_doc_date ON waitlist(doctor_id, desired_date, status);

    -- Audit Log Table (§5, §9)
    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id TEXT,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  logger.info('Database schema initialized. Seeding catalog data...');
  const queryFn: QueryFn = (sql, params) => pool.query(sql, params);
  await seedInitialData(queryFn);
}

async function seedInitialData(query: QueryFn): Promise<void> {
  const existingUsers = await query(`SELECT id FROM users LIMIT 1`);
  if (existingUsers.rows && existingUsers.rows.length > 0) {
    return;
  }

  const hash = async (p: string) => argon2.hash(p);
  const defaultHash = 'b109f3bbbc244eb82441917ed06d618b9008dd09b3befd1b5e07394c706a8bb980b1d7785e5976ec049b46df5f1326bb5b2de39c55f018ac1ebd43714b30e16b';

  const deptData = [
    { name: 'Cardiology', description: 'Comprehensive heart & cardiovascular care', icon: 'Heart' },
    { name: 'Neurology', description: 'Brain, nerve, and spine disorders', icon: 'Brain' },
    { name: 'Orthopedics', description: 'Bone, joint, and sports injury treatments', icon: 'Bone' },
    { name: 'Pediatrics', description: 'Specialized healthcare for infants and children', icon: 'Baby' },
    { name: 'Dermatology', description: 'Advanced skin, hair, and cosmetic treatments', icon: 'Sparkles' },
    { name: 'General Medicine', description: 'Primary healthcare and preventive wellness', icon: 'Stethoscope' },
  ];

  const deptIds: Record<string, string> = {};
  for (const d of deptData) {
    const res = await query(
      `INSERT INTO departments (name, description, icon, is_active) VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [d.name, d.description, d.icon]
    );
    deptIds[d.name] = (res.rows[0] as any).id;
  }

  const adminHash = await hash('Admin@123');
  const receptHash = await hash('Recept@123');

  await query(
    `INSERT INTO users (role, email, phone, password_hash) VALUES ('admin', 'admin@hospital.test', '+91 98765 99999', $1)`,
    [adminHash]
  );

  await query(
    `INSERT INTO users (role, email, phone, password_hash) VALUES ('receptionist', 'reception@hospital.test', '+91 98765 11111', $1)`,
    [receptHash]
  );

  const patientUser = await query(
    `INSERT INTO users (role, email, phone, password_hash)
     VALUES ('patient', 'patient@hospital.com', '+91 98765 43210', $1)
     RETURNING id`,
    [defaultHash]
  );
  const patientUserId = (patientUser.rows[0] as any).id;
  await query(
    `INSERT INTO patients (user_id, full_name, dob, no_show_count) VALUES ($1, 'Alex Sharma', '1990-05-15', 0)`,
    [patientUserId]
  );

  const doctorSeed = [
    { name: 'Dr. Rajesh Menon', dept: 'Cardiology', email: 'dr.menon@hospital.test', spec: 'Senior Interventional Cardiologist' },
    { name: 'Dr. Sarah Chen', dept: 'Cardiology', email: 'dr.chen@hospital.test', spec: 'Heart Failure & Arrhythmia Specialist' },
    { name: 'Dr. Angela Davis', dept: 'Neurology', email: 'dr.davis@hospital.test', spec: 'Consultant Neurologist & Stroke Care' },
    { name: 'Dr. David Miller', dept: 'Neurology', email: 'dr.miller@hospital.test', spec: 'Spine & Peripheral Nerve Specialist' },
    { name: 'Dr. Robert Taylor', dept: 'Orthopedics', email: 'dr.taylor@hospital.test', spec: 'Orthopedic Surgeon & Joint Replacement' },
    { name: 'Dr. Priya Sharma', dept: 'Orthopedics', email: 'dr.sharma@hospital.test', spec: 'Sports Injuries & Arthroscopy Expert' },
    { name: 'Dr. Maya Patel', dept: 'Pediatrics', email: 'dr.patel@hospital.test', spec: 'Chief Pediatrician & Child Health' },
    { name: 'Dr. Kevin White', dept: 'Pediatrics', email: 'dr.white@hospital.test', spec: 'Neonatal & Adolescent Specialist' },
    { name: 'Dr. Emily Vance', dept: 'Dermatology', email: 'dr.vance@hospital.test', spec: 'Clinical Dermatologist & Laser Therapy' },
    { name: 'Dr. Aisha Khan', dept: 'Dermatology', email: 'dr.khan@hospital.test', spec: 'Cosmetic & Aesthetic Skin Consultant' },
    { name: 'Dr. James Wilson', dept: 'General Medicine', email: 'dr.wilson@hospital.test', spec: 'Senior Consultant Physician' },
    { name: 'Dr. Sunita Rao', dept: 'General Medicine', email: 'dr.rao@hospital.test', spec: 'Internal Medicine & Preventive Care' },
  ];

  const doctorHash = await hash('Doctor@123');
  const doctorIds: string[] = [];

  for (const doc of doctorSeed) {
    const userRes = await query(
      `INSERT INTO users (role, email, password_hash) VALUES ('doctor', $1, $2) RETURNING id`,
      [doc.email, doctorHash]
    );
    const docUserId = (userRes.rows[0] as any).id;
    const docRes = await query(
      `INSERT INTO doctors (user_id, department_id, name, specialization, slot_minutes, overbook_limit, is_active)
       VALUES ($1, $2, $3, $4, 15, 0, TRUE) RETURNING id`,
      [docUserId, deptIds[doc.dept], doc.name, doc.spec]
    );
    const docId = (docRes.rows[0] as any).id;
    doctorIds.push(docId);

    for (const weekday of [1, 2, 3, 4, 5]) {
      await query(
        `INSERT INTO doctor_schedules (doctor_id, weekday, start_time, end_time)
         VALUES ($1, $2, '09:00', '13:00'), ($1, $2, '14:00', '17:00')`,
        [docId, weekday]
      );
    }
    await query(
      `INSERT INTO doctor_schedules (doctor_id, weekday, start_time, end_time)
       VALUES ($1, 6, '09:00', '13:00')`,
      [docId]
    );
  }

  const patientHash = await hash('Pass@123');
  for (let i = 1; i <= 5; i++) {
    const email = `patient${i}@test.com`;
    const phone = `+91900000000${i}`;
    const fullName = `Test Patient ${i}`;

    const uRes = await query(
      `INSERT INTO users (role, email, phone, password_hash)
       VALUES ('patient', $1, $2, $3)
       RETURNING id`,
      [email, phone, patientHash]
    );
    const uId = (uRes.rows[0] as any).id;

    await query(
      `INSERT INTO patients (user_id, full_name, dob, no_show_count)
       VALUES ($1, $2, '1990-01-01', 0)`,
      [uId, fullName]
    );
  }

  // Batched slot insert: ~4000 rows in chunks of 500 (fast over Neon latency)
  const slotRows: [string, string, string][] = [];
  const now = new Date();
  for (let offset = 0; offset <= 14; offset++) {
    const targetDate = new Date(now.getTime() + offset * 86400000);
    const dayOfWeek = targetDate.getDay();
    if (dayOfWeek === 0) continue;

    const y = targetDate.getFullYear();
    const m = String(targetDate.getMonth() + 1).padStart(2, '0');
    const d = String(targetDate.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    const timeBlocks = dayOfWeek === 6
      ? [{ start: 9 * 60, end: 13 * 60 }]
      : [{ start: 9 * 60, end: 13 * 60 }, { start: 14 * 60, end: 17 * 60 }];

    for (const docId of doctorIds) {
      for (const block of timeBlocks) {
        for (let min = block.start; min < block.end; min += 15) {
          const sH = String(Math.floor(min / 60)).padStart(2, '0');
          const sM = String(min % 60).padStart(2, '0');
          const eH = String(Math.floor((min + 15) / 60)).padStart(2, '0');
          const eM = String((min + 15) % 60).padStart(2, '0');

          slotRows.push([docId, `${dateStr}T${sH}:${sM}:00+05:30`, `${dateStr}T${eH}:${eM}:00+05:30`]);
        }
      }
    }
  }

  for (let i = 0; i < slotRows.length; i += 500) {
    const chunk = slotRows.slice(i, i + 500);
    const values: string[] = [];
    const params: string[] = [];
    chunk.forEach(([docId, startIso, endIso], idx) => {
      const base = idx * 3;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, 'open')`);
      params.push(docId, startIso, endIso);
    });
    await query(
      `INSERT INTO slots (doctor_id, starts_at, ends_at, status)
       VALUES ${values.join(', ')}
       ON CONFLICT (doctor_id, starts_at) DO NOTHING`,
      params
    );
  }

  logger.info('Database seeded successfully with users, departments, doctors, schedules, and live slots.');
}

// Re-export type for callers that typed against PGlite before
export type { PoolClient };
