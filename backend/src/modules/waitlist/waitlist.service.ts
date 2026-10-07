import { db } from '../../lib/db.js';
import { notFound, AppError } from '../../lib/errors.js';

export class WaitlistService {
  async joinWaitlist(patientId: string, doctorId: string, desiredDate: string) {
    const existing = await db.query(
      `SELECT id FROM waitlist
       WHERE patient_id = $1 AND doctor_id = $2 AND desired_date = $3 AND status = 'waiting'`,
      [patientId, doctorId, desiredDate]
    );

    if (existing.rows.length > 0) {
      return { id: existing.rows[0].id, status: 'waiting', alreadyRegistered: true };
    }

    const res = await db.query(
      `INSERT INTO waitlist (patient_id, doctor_id, desired_date, status)
       VALUES ($1, $2, $3, 'waiting')
       RETURNING id, patient_id as "patientId", doctor_id as "doctorId",
                 desired_date as "desiredDate", status, created_at as "createdAt"`,
      [patientId, doctorId, desiredDate]
    );

    return res.rows[0];
  }

  async getMyWaitlist(patientId: string) {
    const res = await db.query(
      `SELECT w.id, w.desired_date as "desiredDate", w.status, w.created_at as "createdAt",
              doc.name as "doctorName", d.name as "departmentName"
       FROM waitlist w
       JOIN doctors doc ON doc.id = w.doctor_id
       JOIN departments d ON d.id = doc.department_id
       WHERE w.patient_id = $1
       ORDER BY w.desired_date ASC`,
      [patientId]
    );
    return res.rows;
  }
}

export const waitlistService = new WaitlistService();
