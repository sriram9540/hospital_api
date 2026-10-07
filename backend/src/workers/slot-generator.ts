/**
 * Slot Generator Worker (§10)
 * Generates slots for next N days from doctor_schedules.
 * Safe to rerun: ON CONFLICT (doctor_id, starts_at) DO NOTHING
 */
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { CONFIG } from '../lib/config.js';

export async function generateSlots(daysAhead = CONFIG.SLOT_DAYS_AHEAD): Promise<{ generated: number }> {
  logger.info(`Starting slot generation for ${daysAhead} days ahead...`);

  const schedulesRes = await db.query<{
    doctorId: string;
    weekday: number;
    startTime: string;
    endTime: string;
    slotMinutes: number;
  }>(`
    SELECT s.doctor_id as "doctorId", s.weekday, s.start_time as "startTime",
           s.end_time as "endTime", d.slot_minutes as "slotMinutes"
    FROM doctor_schedules s
    JOIN doctors d ON d.id = s.doctor_id
    WHERE d.is_active = TRUE
  `);

  const schedules = schedulesRes.rows;
  let totalSlotsInserted = 0;

  const now = new Date();

  for (let offset = 0; offset <= daysAhead; offset++) {
    const targetDate = new Date(now.getTime() + offset * 86400000);
    const dayOfWeek = targetDate.getDay();

    const y = targetDate.getFullYear();
    const m = String(targetDate.getMonth() + 1).padStart(2, '0');
    const d = String(targetDate.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    const matchingSchedules = schedules.filter(s => s.weekday === dayOfWeek);

    for (const sched of matchingSchedules) {
      const [startHour, startMin] = sched.startTime.split(':').map(Number);
      const [endHour, endMin] = sched.endTime.split(':').map(Number);

      let currentMin = startHour * 60 + startMin;
      const finishMin = endHour * 60 + endMin;
      const slotStep = sched.slotMinutes || 30;

      while (currentMin + slotStep <= finishMin) {
        // Skip lunch break 13:00 to 14:00 (780 to 840)
        if (!(currentMin >= 780 && currentMin < 840)) {
          const sH = String(Math.floor(currentMin / 60)).padStart(2, '0');
          const sM = String(currentMin % 60).padStart(2, '0');
          const eH = String(Math.floor((currentMin + slotStep) / 60)).padStart(2, '0');
          const eM = String((currentMin + slotStep) % 60).padStart(2, '0');

          const startIso = `${dateStr}T${sH}:${sM}:00+05:30`;
          const endIso = `${dateStr}T${eH}:${eM}:00+05:30`;

          const res = await db.query(
            `INSERT INTO slots (doctor_id, starts_at, ends_at, status)
             VALUES ($1, $2, $3, 'open')
             ON CONFLICT (doctor_id, starts_at) DO NOTHING
             RETURNING id`,
            [sched.doctorId, startIso, endIso]
          );

          if (res.rows.length > 0) {
            totalSlotsInserted++;
          }
        }
        currentMin += slotStep;
      }
    }
  }

  logger.info(`Slot generation completed. New slots created: ${totalSlotsInserted}`);
  return { generated: totalSlotsInserted };
}
