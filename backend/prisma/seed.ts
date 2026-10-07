// backend/prisma/seed.ts
import argon2 from 'argon2';
import { db } from '../src/lib/db.js';

export async function runPrismaSeed() {
  console.log('Running hospital appointment seed...');

  // 1. Departments
  const departmentsData = [
    { name: 'Cardiology', description: 'Comprehensive heart & cardiovascular care', icon: 'Heart' },
    { name: 'Neurology', description: 'Brain, nerve, and spine disorders', icon: 'Brain' },
    { name: 'Orthopedics', description: 'Bone, joint, and sports injury treatments', icon: 'Bone' },
    { name: 'Pediatrics', description: 'Specialized healthcare for infants and children', icon: 'Baby' },
    { name: 'Dermatology', description: 'Advanced skin, hair, and cosmetic treatments', icon: 'Sparkles' },
    { name: 'General Medicine', description: 'Primary healthcare and preventive wellness', icon: 'Stethoscope' },
  ];

  const deptMap: Record<string, string> = {};
  for (const d of departmentsData) {
    const res = await db.query(
      `INSERT INTO departments (name, description, icon, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (name) DO UPDATE SET is_active = TRUE
       RETURNING id, name`,
      [d.name, d.description, d.icon]
    );
    deptMap[d.name] = res.rows[0].id;
  }

  // 2. Admin + receptionist users
  const hash = (p: string) => argon2.hash(p);

  const adminHash = await hash('Admin@123');
  const receptHash = await hash('Recept@123');

  await db.query(
    `INSERT INTO users (role, email, password_hash)
     VALUES ('admin', 'admin@hospital.test', $1)
     ON CONFLICT (email) DO UPDATE SET password_hash = $1`,
    [adminHash]
  );

  await db.query(
    `INSERT INTO users (role, email, password_hash)
     VALUES ('receptionist', 'reception@hospital.test', $1)
     ON CONFLICT (email) DO UPDATE SET password_hash = $1`,
    [receptHash]
  );

  // 3. Doctors (12 doctors across 6 departments)
  const doctorSeed = [
    { name: 'Rajesh Menon', dept: 'Cardiology', email: 'dr.menon@hospital.test', spec: 'Senior Interventional Cardiologist' },
    { name: 'Sarah Chen', dept: 'Cardiology', email: 'dr.chen@hospital.test', spec: 'Heart Failure & Arrhythmia Specialist' },
    { name: 'Angela Davis', dept: 'Neurology', email: 'dr.davis@hospital.test', spec: 'Consultant Neurologist & Stroke Care' },
    { name: 'David Miller', dept: 'Neurology', email: 'dr.miller@hospital.test', spec: 'Spine & Peripheral Nerve Specialist' },
    { name: 'Robert Taylor', dept: 'Orthopedics', email: 'dr.taylor@hospital.test', spec: 'Orthopedic Surgeon & Joint Replacement' },
    { name: 'Priya Sharma', dept: 'Orthopedics', email: 'dr.sharma@hospital.test', spec: 'Sports Injuries & Arthroscopy Expert' },
    { name: 'Maya Patel', dept: 'Pediatrics', email: 'dr.patel@hospital.test', spec: 'Chief Pediatrician & Child Health' },
    { name: 'Kevin White', dept: 'Pediatrics', email: 'dr.white@hospital.test', spec: 'Neonatal & Adolescent Specialist' },
    { name: 'Emily Vance', dept: 'Dermatology', email: 'dr.vance@hospital.test', spec: 'Clinical Dermatologist & Laser Therapy' },
    { name: 'Aisha Khan', dept: 'Dermatology', email: 'dr.khan@hospital.test', spec: 'Cosmetic & Aesthetic Skin Consultant' },
    { name: 'James Wilson', dept: 'General Medicine', email: 'dr.wilson@hospital.test', spec: 'Senior Consultant Physician' },
    { name: 'Sunita Rao', dept: 'General Medicine', email: 'dr.rao@hospital.test', spec: 'Internal Medicine & Preventive Care' },
  ];

  const doctorHash = await hash('Doctor@123');

  for (const d of doctorSeed) {
    const userRes = await db.query(
      `INSERT INTO users (role, email, password_hash)
       VALUES ('doctor', $1, $2)
       ON CONFLICT (email) DO UPDATE SET password_hash = $2
       RETURNING id`,
      [d.email, doctorHash]
    );
    const userId = userRes.rows[0].id;
    const deptId = deptMap[d.dept];

    const docRes = await db.query(
      `INSERT INTO doctors (user_id, department_id, name, specialization, slot_minutes, overbook_limit, is_active)
       VALUES ($1, $2, $3, $4, 15, 0, TRUE)
       RETURNING id`,
      [userId, deptId, d.name, d.spec]
    );
    const doctorId = docRes.rows[0].id;

    // 4. Schedules: Mon-Fri morning + afternoon, Sat morning
    for (const weekday of [1, 2, 3, 4, 5]) {
      await db.query(
        `INSERT INTO doctor_schedules (doctor_id, weekday, start_time, end_time)
         VALUES ($1, $2, '09:00', '13:00'), ($1, $2, '14:00', '17:00')`,
        [doctorId, weekday]
      );
    }
    await db.query(
      `INSERT INTO doctor_schedules (doctor_id, weekday, start_time, end_time)
       VALUES ($1, 6, '09:00', '13:00')`,
      [doctorId]
    );
  }

  // 5. Patients
  const patientHash = await hash('Pass@123');
  for (let i = 1; i <= 5; i++) {
    const email = `patient${i}@test.com`;
    const phone = `+91900000000${i}`;
    const fullName = `Test Patient ${i}`;

    const uRes = await db.query(
      `INSERT INTO users (role, email, phone, password_hash)
       VALUES ('patient', $1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET password_hash = $3, phone = $2
       RETURNING id`,
      [email, phone, patientHash]
    );
    const uId = uRes.rows[0].id;

    await db.query(
      `INSERT INTO patients (user_id, full_name, dob, no_show_count)
       VALUES ($1, $2, '1990-01-01', 0)
       ON CONFLICT (user_id) DO UPDATE SET full_name = $2`,
      [uId, fullName]
    );
  }

  console.log('Seed complete');
}

// Auto-run if executed directly
if (process.argv[1]?.endsWith('seed.ts')) {
  runPrismaSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
