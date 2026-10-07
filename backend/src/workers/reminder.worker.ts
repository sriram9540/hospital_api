/**
 * Reminder Worker Engine (§6, §8)
 * Outbox pattern processor.
 * Re-checks appointment status before sending. Cancelled/rescheduled appts get no reminders.
 */
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { notificationProvider, NotificationJob } from '../lib/notify.js';
import { CONFIG } from '../lib/config.js';

export class ReminderWorker {
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  async processDueJobs(limit = 20): Promise<{ processed: number; sent: number; skipped: number; failed: number }> {
    if (this.isProcessing) {
      return { processed: 0, sent: 0, skipped: 0, failed: 0 };
    }
    this.isProcessing = true;

    let processed = 0;
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    try {
      // Pick due jobs (Outbox queue §6, §8)
      const jobsRes = await db.query<any>(
        `SELECT id, appointment_id as "appointmentId", kind, channel,
                recipient, payload, run_at as "runAt", status, attempts
         FROM notification_jobs
         WHERE status = 'pending' AND run_at <= NOW()
         ORDER BY run_at ASC
         LIMIT $1`,
        [limit]
      );

      const jobs = jobsRes.rows;
      processed = jobs.length;

      for (const job of jobs) {
        // Re-check appointment status before sending (§6, §8)
        const apptRes = await db.query<{ status: string }>(
          `SELECT status FROM appointments WHERE id = $1`,
          [job.appointmentId]
        );

        if (apptRes.rows.length === 0) {
          await db.query(`UPDATE notification_jobs SET status = 'cancelled' WHERE id = $1`, [job.id]);
          skipped++;
          continue;
        }

        const apptStatus = apptRes.rows[0].status;

        // If appointment is cancelled or rescheduled, suppress reminders (except cancel_notice)
        if (apptStatus !== 'booked' && job.kind !== 'cancel_notice') {
          await db.query(
            `UPDATE notification_jobs SET status = 'cancelled' WHERE id = $1`,
            [job.id]
          );
          skipped++;
          continue;
        }

        const payloadObj = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
        const notificationJob: NotificationJob = {
          id: job.id,
          appointmentId: job.appointmentId,
          kind: job.kind,
          channel: job.channel,
          recipient: job.recipient,
          payload: payloadObj,
        };

        try {
          const result = await notificationProvider.send(notificationJob);

          if (result.success) {
            await db.query(
              `UPDATE notification_jobs
               SET status = 'sent', attempts = attempts + 1
               WHERE id = $1`,
              [job.id]
            );
            sent++;
          } else {
            const nextAttempts = job.attempts + 1;
            const newStatus = nextAttempts >= CONFIG.MAX_REMINDER_ATTEMPTS ? 'failed' : 'pending';
            // Exponential backoff
            const delaySec = Math.pow(2, nextAttempts) * 30;
            await db.query(
              `UPDATE notification_jobs
               SET status = $1, attempts = $2, last_error = $3,
                   run_at = NOW() + ($4 || ' seconds')::INTERVAL
               WHERE id = $5`,
              [newStatus, nextAttempts, result.error || 'Provider failure', delaySec, job.id]
            );
            failed++;
          }
        } catch (err: any) {
          const nextAttempts = job.attempts + 1;
          const newStatus = nextAttempts >= CONFIG.MAX_REMINDER_ATTEMPTS ? 'failed' : 'pending';
          await db.query(
            `UPDATE notification_jobs
             SET status = $1, attempts = $2, last_error = $3,
                 run_at = NOW() + INTERVAL '60 seconds'
             WHERE id = $4`,
            [newStatus, nextAttempts, err.message, job.id]
          );
          failed++;
        }
      }
    } catch (err) {
      logger.error('Error in ReminderWorker processing cycle', err);
    } finally {
      this.isProcessing = false;
    }

    return { processed, sent, skipped, failed };
  }

  start(intervalMs = CONFIG.REMINDER_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    logger.info(`Starting reminder worker with ${intervalMs}ms poll interval`);
    // Run initial pass after 2 seconds
    setTimeout(() => this.processDueJobs().catch(() => {}), 2000);
    this.timer = setInterval(() => {
      this.processDueJobs().catch(err => logger.error('Worker loop error', err));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const reminderWorker = new ReminderWorker();
