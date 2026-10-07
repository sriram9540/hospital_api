/**
 * Notification Provider Interface & Adapters (§2, §6, §8)
 */
import { logger } from './logger.js';

export interface NotificationPayload {
  doctorName: string;
  departmentName?: string;
  startsAt: string;
  hospitalPhone?: string;
  cancelUrl?: string;
  rescheduleUrl?: string;
}

export interface NotificationJob {
  id: string;
  appointmentId: string;
  kind: 'confirm' | 'remind_24h' | 'remind_2h' | 'cancel_notice';
  channel: 'sms' | 'email' | 'whatsapp';
  recipient: string;
  payload: NotificationPayload;
}

export interface NotificationProvider {
  send(job: NotificationJob): Promise<{ success: boolean; externalId?: string; error?: string }>;
}

export class ConsoleNotificationProvider implements NotificationProvider {
  async send(job: NotificationJob): Promise<{ success: boolean; externalId?: string }> {
    const { kind, channel, recipient, payload, appointmentId } = job;
    const dateFormatted = new Date(payload.startsAt).toLocaleString('en-US', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    let messageText = '';
    switch (kind) {
      case 'confirm':
        messageText = `[Hospital App] Appointment confirmed with Dr. ${payload.doctorName} on ${dateFormatted}. Cancel/Reschedule: ${payload.cancelUrl || 'via portal'}. Help: +91 40 2345 6789`;
        break;
      case 'remind_24h':
        messageText = `[Hospital App] Reminder: Upcoming appointment tomorrow with Dr. ${payload.doctorName} at ${dateFormatted}. Help: +91 40 2345 6789`;
        break;
      case 'remind_2h':
        messageText = `[Hospital App] Reminder: Doctor appointment in 2 hours with Dr. ${payload.doctorName} at ${dateFormatted}.`;
        break;
      case 'cancel_notice':
        messageText = `[Hospital App] Your appointment with Dr. ${payload.doctorName} for ${dateFormatted} has been cancelled.`;
        break;
    }

    // Explicit privacy rule: never include diagnosis in logs or notification
    logger.info(`Notification sent`, {
      jobId: job.id,
      appointmentId,
      kind,
      channel,
      recipientMasked: recipient.replace(/(.{2})(.*)(.{2})/, '$1***$3'),
    });
    console.log(`\n📨 [${channel.toUpperCase()}] To: ${recipient}\n   ${messageText}\n`);

    return {
      success: true,
      externalId: `mock-${Date.now()}-${job.id.slice(0, 8)}`,
    };
  }
}

export const notificationProvider: NotificationProvider = new ConsoleNotificationProvider();
