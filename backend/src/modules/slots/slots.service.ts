import { db } from '../../lib/db.js';
import { notFound, AppError } from '../../lib/errors.js';

export interface Slot {
  id: string;
  doctorId: string;
  startsAt: string;
  endsAt: string;
  status: 'open' | 'held' | 'booked' | 'blocked';
}

export class SlotsService {
  async getDoctorSlots(doctorId: string, dateStr: string): Promise<Slot[]> {
    // Start and end of the specified date in Asia/Kolkata (+05:30)
    const dayStart = `${dateStr}T00:00:00+05:30`;
    const dayEnd = `${dateStr}T23:59:59+05:30`;

    // Only return 'open' slots that are not in the past (§4, §7, §10)
    const res = await db.query(
      `SELECT id, doctor_id as "doctorId", starts_at as "startsAt",
              ends_at as "endsAt", status
       FROM slots
       WHERE doctor_id = $1
         AND starts_at >= $2
         AND starts_at <= $3
         AND status = 'open'
         AND starts_at > NOW()
       ORDER BY starts_at ASC`,
      [doctorId, dayStart, dayEnd]
    );

    return res.rows;
  }

  async getAllDoctorSlots(doctorId: string, dateStr: string): Promise<Slot[]> {
    const dayStart = `${dateStr}T00:00:00+05:30`;
    const dayEnd = `${dateStr}T23:59:59+05:30`;

    const res = await db.query(
      `SELECT id, doctor_id as "doctorId", starts_at as "startsAt",
              ends_at as "endsAt", status
       FROM slots
       WHERE doctor_id = $1
         AND starts_at >= $2
         AND starts_at <= $3
       ORDER BY starts_at ASC`,
      [doctorId, dayStart, dayEnd]
    );

    return res.rows;
  }

  async getSlotById(slotId: string, client?: any): Promise<Slot> {
    const runner = client || db;
    const res = await runner.query(
      `SELECT id, doctor_id as "doctorId", starts_at as "startsAt",
              ends_at as "endsAt", status
       FROM slots
       WHERE id = $1`,
      [slotId]
    );

    if (res.rows.length === 0) {
      notFound('Slot not found');
    }
    return res.rows[0];
  }

  async blockSlotsForLeave(doctorId: string, startDate: string, endDate: string, reason = 'Doctor unavailable'): Promise<number> {
    const dayStart = `${startDate}T00:00:00+05:30`;
    const dayEnd = `${endDate}T23:59:59+05:30`;

    const res = await db.query(
      `UPDATE slots
       SET status = 'blocked'
       WHERE doctor_id = $1
         AND starts_at >= $2
         AND starts_at <= $3
         AND status = 'open'
       RETURNING id`,
      [doctorId, dayStart, dayEnd]
    );

    return res.affectedRows || res.rows.length;
  }
}

export const slotsService = new SlotsService();
