import { db } from '../../lib/db.js';
import { reminderWorker } from '../../workers/reminder.worker.js';

export class RemindersService {
  async getRecentJobs(appointmentId?: string) {
    let sql = `
      SELECT id, appointment_id as "appointmentId", kind, channel,
             recipient, payload, run_at as "runAt", status, attempts, last_error as "lastError",
             created_at as "createdAt"
      FROM notification_jobs
    `;
    const params: any[] = [];
    if (appointmentId) {
      sql += ` WHERE appointment_id = $1`;
      params.push(appointmentId);
    }
    sql += ` ORDER BY created_at DESC LIMIT 50`;

    const res = await db.query(sql, params);
    return res.rows;
  }

  async runWorkerCycle(limit = 20) {
    return await reminderWorker.processDueJobs(limit);
  }
}

export const remindersService = new RemindersService();
