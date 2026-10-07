/**
 * Appointments Service (§5, §6, §7, §8, §9)
 * High-reliability atomic transactions with double-booking prevention.
 */
import { db } from '../../lib/db.js';
import { CONFIG } from '../../lib/config.js';
import {
  slotTaken,
  slotInPast,
  notFound,
  forbidden,
  cutoffPassed,
  invalidState,
  AppError,
} from '../../lib/errors.js';
import { storeIdempotency } from '../../lib/idempotency.js';
import { AuthSession } from '../auth/auth.service.js';

export interface AppointmentRecord {
  id: string;
  patientId: string;
  patientName?: string;
  patientPhone?: string;
  patientEmail?: string;
  slotId: string;
  doctorId: string;
  doctorName?: string;
  departmentName?: string;
  startsAt: string;
  endsAt: string;
  status: 'booked' | 'cancelled' | 'completed' | 'no_show' | 'rescheduled';
  createdAt: string;
  cancelledAt?: string;
  rescheduleOf?: string;
  reason?: string;
}

export class AppointmentsService {
  async bookAppointment(params: {
    patientId: string;
    slotId: string;
    reason?: string;
    idempotencyKey?: string;
    idempotencyHash?: string;
    actorId?: string;
  }): Promise<AppointmentRecord> {
    const { patientId, slotId, reason, idempotencyKey, idempotencyHash, actorId } = params;

    // Check patient no-show threshold (§7)
    const patientRes = await db.query<{ id: string; no_show_count: number; phone: string; email: string; full_name: string }>(
      `SELECT p.id, p.no_show_count, p.full_name, u.phone, u.email
       FROM patients p
       JOIN users u ON u.id = p.user_id
       WHERE p.id = $1`,
      [patientId]
    );

    if (patientRes.rows.length === 0) {
      notFound('Patient record not found');
    }
    const patient = patientRes.rows[0];

    if (patient.no_show_count >= CONFIG.NO_SHOW_LIMIT) {
      throw new AppError(
        'FORBIDDEN',
        `Online booking locked due to ${patient.no_show_count} previous no-shows. Please contact reception to book.`,
        403
      );
    }

    // Execute atomic booking transaction (§6)
    return await db.transaction(async (tx) => {
      // Step 1: Claim the slot atomically. Zero rows -> throw SLOT_TAKEN
      const claimRes = await tx.query<{
        id: string;
        doctor_id: string;
        starts_at: string;
        ends_at: string;
      }>(
        `UPDATE slots
         SET status = 'booked'
         WHERE id = $1 AND status = 'open'
         RETURNING id, doctor_id, starts_at, ends_at`,
        [slotId]
      );

      if (claimRes.rows.length === 0) {
        slotTaken('The selected slot was just booked by another patient or is no longer available');
      }

      const slot = claimRes.rows[0];
      const slotStartTime = new Date(slot.starts_at).getTime();
      const nowTime = Date.now();

      // Rule: Past slots cannot be booked (§3, §6)
      if (slotStartTime <= nowTime) {
        slotInPast('Cannot book an appointment slot that has already started');
      }

      // Rule: Patient cannot hold two booked appointments overlapping at the same time (§6)
      const overlapRes = await tx.query(
        `SELECT a.id
         FROM appointments a
         JOIN slots s ON s.id = a.slot_id
         WHERE a.patient_id = $1
           AND a.status = 'booked'
           AND s.starts_at < $2
           AND s.ends_at > $3`,
        [patientId, slot.ends_at, slot.starts_at]
      );

      if (overlapRes.rows.length > 0) {
        throw new AppError(
          'INVALID_STATE',
          'You already have an active appointment booked during this time window',
          400
        );
      }

      // Step 2: Insert Appointment record
      const apptRes = await tx.query<{
        id: string;
        patient_id: string;
        slot_id: string;
        status: 'booked';
        created_at: string;
        reason?: string;
      }>(
        `INSERT INTO appointments (patient_id, slot_id, status, reason)
         VALUES ($1, $2, 'booked', $3)
         RETURNING id, patient_id, slot_id, status, created_at, reason`,
        [patientId, slot.id, reason || null]
      );

      const appointment = apptRes.rows[0];

      // Retrieve doctor & department details for notification payloads
      const docRes = await tx.query<{ name: string; dept_name: string }>(
        `SELECT doc.name, d.name as dept_name
         FROM doctors doc
         JOIN departments d ON d.id = doc.department_id
         WHERE doc.id = $1`,
        [slot.doctor_id]
      );
      const doctor = docRes.rows[0];

      const notifPayload = {
        doctorName: doctor?.name || 'Doctor',
        departmentName: doctor?.dept_name || 'Department',
        startsAt: slot.starts_at,
        hospitalPhone: '+91 40 2345 6789',
        cancelUrl: `/appointments/${appointment.id}/cancel`,
      };

      // Step 3: Insert notification jobs (Outbox Pattern §6, §8)
      // 1. Confirm job (immediate)
      await tx.query(
        `INSERT INTO notification_jobs (appointment_id, kind, channel, recipient, payload, run_at, status)
         VALUES ($1, 'confirm', 'sms', $2, $3, NOW(), 'pending')
         ON CONFLICT (appointment_id, kind, channel) DO NOTHING`,
        [appointment.id, patient.phone || patient.email, JSON.stringify(notifPayload)]
      );

      // 2. 24h Reminder job
      const remind24hTime = new Date(slotStartTime - 24 * 60 * 60 * 1000);
      if (remind24hTime.getTime() > nowTime) {
        await tx.query(
          `INSERT INTO notification_jobs (appointment_id, kind, channel, recipient, payload, run_at, status)
           VALUES ($1, 'remind_24h', 'sms', $2, $3, $4, 'pending')
           ON CONFLICT (appointment_id, kind, channel) DO NOTHING`,
          [appointment.id, patient.phone || patient.email, JSON.stringify(notifPayload), remind24hTime.toISOString()]
        );
      }

      // 3. 2h Reminder job
      const remind2hTime = new Date(slotStartTime - 2 * 60 * 60 * 1000);
      if (remind2hTime.getTime() > nowTime) {
        await tx.query(
          `INSERT INTO notification_jobs (appointment_id, kind, channel, recipient, payload, run_at, status)
           VALUES ($1, 'remind_2h', 'sms', $2, $3, $4, 'pending')
           ON CONFLICT (appointment_id, kind, channel) DO NOTHING`,
          [appointment.id, patient.phone || patient.email, JSON.stringify(notifPayload), remind2hTime.toISOString()]
        );
      }

      // Step 4: Audit log (§9)
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, details)
         VALUES ($1, 'APPOINTMENT_BOOKED', 'appointment', $2, $3)`,
        [actorId || patientId, appointment.id, JSON.stringify({ slotId: slot.id, doctorId: slot.doctor_id })]
      );

      const responseRecord: AppointmentRecord = {
        id: appointment.id,
        patientId: appointment.patient_id,
        patientName: patient.full_name,
        patientPhone: patient.phone,
        slotId: slot.id,
        doctorId: slot.doctor_id,
        doctorName: doctor?.name,
        departmentName: doctor?.dept_name,
        startsAt: slot.starts_at,
        endsAt: slot.ends_at,
        status: 'booked',
        createdAt: appointment.created_at,
        reason: appointment.reason,
      };

      // Store Idempotency key if supplied
      if (idempotencyKey && idempotencyHash) {
        await storeIdempotency(idempotencyKey, idempotencyHash, responseRecord as any, tx);
      }

      return responseRecord;
    });
  }

  async getMyAppointments(patientId: string): Promise<AppointmentRecord[]> {
    const res = await db.query<any>(
      `SELECT a.id, a.patient_id as "patientId", a.slot_id as "slotId", a.status,
              a.created_at as "createdAt", a.cancelled_at as "cancelledAt",
              a.reschedule_of as "rescheduleOf", a.reason,
              s.starts_at as "startsAt", s.ends_at as "endsAt", s.doctor_id as "doctorId",
              doc.name as "doctorName", d.name as "departmentName"
       FROM appointments a
       JOIN slots s ON s.id = a.slot_id
       JOIN doctors doc ON doc.id = s.doctor_id
       JOIN departments d ON d.id = doc.department_id
       WHERE a.patient_id = $1
       ORDER BY s.starts_at DESC`,
      [patientId]
    );
    return res.rows;
  }

  async getAppointmentById(id: string): Promise<AppointmentRecord> {
    const res = await db.query<any>(
      `SELECT a.id, a.patient_id as "patientId", a.slot_id as "slotId", a.status,
              a.created_at as "createdAt", a.cancelled_at as "cancelledAt",
              a.reschedule_of as "rescheduleOf", a.reason,
              s.starts_at as "startsAt", s.ends_at as "endsAt", s.doctor_id as "doctorId",
              doc.name as "doctorName", d.name as "departmentName",
              p.full_name as "patientName"
       FROM appointments a
       JOIN slots s ON s.id = a.slot_id
       JOIN doctors doc ON doc.id = s.doctor_id
       JOIN departments d ON d.id = doc.department_id
       JOIN patients p ON p.id = a.patient_id
       WHERE a.id = $1`,
      [id]
    );

    if (res.rows.length === 0) {
      notFound('Appointment not found');
    }
    return res.rows[0];
  }

  async cancelAppointment(appointmentId: string, actor: AuthSession): Promise<AppointmentRecord> {
    const appt = await this.getAppointmentById(appointmentId);

    // AuthZ: Patient can only cancel their own appointment (§8, §9)
    if (actor.role === 'patient' && appt.patientId !== actor.patientId) {
      forbidden('You are not authorized to cancel this appointment');
    }

    if (appt.status !== 'booked') {
      invalidState(`Cannot cancel an appointment with status '${appt.status}'`);
    }

    // Cutoff check: CANCEL_CUTOFF_HOURS (default 2 hours before start) (§3, §6)
    const startsAtMs = new Date(appt.startsAt).getTime();
    const cutoffMs = startsAtMs - CONFIG.CANCEL_CUTOFF_HOURS * 60 * 60 * 1000;
    if (Date.now() > cutoffMs && actor.role === 'patient') {
      cutoffPassed(
        `Appointments cannot be cancelled within ${CONFIG.CANCEL_CUTOFF_HOURS} hours of the scheduled time. Please call the hospital.`
      );
    }

    // Execute atomic cancellation transaction (§6)
    return await db.transaction(async (tx) => {
      // 1. Mark appointment cancelled
      await tx.query(
        `UPDATE appointments
         SET status = 'cancelled', cancelled_at = NOW()
         WHERE id = $1`,
        [appointmentId]
      );

      // 2. Free the slot back to 'open'
      await tx.query(
        `UPDATE slots
         SET status = 'open'
         WHERE id = $1`,
        [appt.slotId]
      );

      // 3. Cancel pending notification jobs for this appointment
      await tx.query(
        `UPDATE notification_jobs
         SET status = 'cancelled'
         WHERE appointment_id = $1 AND status = 'pending'`,
        [appointmentId]
      );

      // 4. Insert cancel_notice job
      const notifPayload = {
        doctorName: appt.doctorName || 'Doctor',
        startsAt: appt.startsAt,
        hospitalPhone: '+91 40 2345 6789',
      };
      await tx.query(
        `INSERT INTO notification_jobs (appointment_id, kind, channel, recipient, payload, run_at, status)
         VALUES ($1, 'cancel_notice', 'sms', 'patient', $2, NOW(), 'pending')
         ON CONFLICT (appointment_id, kind, channel) DO NOTHING`,
        [appointmentId, JSON.stringify(notifPayload)]
      );

      // 5. Offer freed slot to waitlist (§7)
      const slotDate = new Date(appt.startsAt).toISOString().substring(0, 10);
      const waitlistRes = await tx.query<{ id: string; patient_id: string }>(
        `SELECT id, patient_id
         FROM waitlist
         WHERE doctor_id = $1 AND desired_date = $2 AND status = 'waiting'
         ORDER BY created_at ASC
         LIMIT 1`,
        [appt.doctorId, slotDate]
      );

      if (waitlistRes.rows.length > 0) {
        await tx.query(
          `UPDATE waitlist SET status = 'notified' WHERE id = $1`,
          [waitlistRes.rows[0].id]
        );
      }

      // 6. Audit log (§9)
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, details)
         VALUES ($1, 'APPOINTMENT_CANCELLED', 'appointment', $2, $3)`,
        [actor.userId, appointmentId, JSON.stringify({ slotId: appt.slotId })]
      );

      return {
        ...appt,
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
      };
    });
  }

  async rescheduleAppointment(params: {
    appointmentId: string;
    newSlotId: string;
    actor: AuthSession;
    reason?: string;
    idempotencyKey?: string;
    idempotencyHash?: string;
  }): Promise<AppointmentRecord> {
    const { appointmentId, newSlotId, actor, reason, idempotencyKey, idempotencyHash } = params;
    const oldAppt = await this.getAppointmentById(appointmentId);

    // AuthZ check
    if (actor.role === 'patient' && oldAppt.patientId !== actor.patientId) {
      forbidden('You are not authorized to reschedule this appointment');
    }

    if (oldAppt.status !== 'booked') {
      invalidState(`Cannot reschedule an appointment with status '${oldAppt.status}'`);
    }

    // Cutoff check on old appointment
    const startsAtMs = new Date(oldAppt.startsAt).getTime();
    const cutoffMs = startsAtMs - CONFIG.CANCEL_CUTOFF_HOURS * 60 * 60 * 1000;
    if (Date.now() > cutoffMs && actor.role === 'patient') {
      cutoffPassed(
        `Appointments cannot be rescheduled within ${CONFIG.CANCEL_CUTOFF_HOURS} hours of start time.`
      );
    }

    // Atomic Reschedule Transaction (§6)
    return await db.transaction(async (tx) => {
      // 1. Claim new slot: zero rows -> throw SLOT_TAKEN
      const claimRes = await tx.query<{
        id: string;
        doctor_id: string;
        starts_at: string;
        ends_at: string;
      }>(
        `UPDATE slots
         SET status = 'booked'
         WHERE id = $1 AND status = 'open'
         RETURNING id, doctor_id, starts_at, ends_at`,
        [newSlotId]
      );

      if (claimRes.rows.length === 0) {
        slotTaken('New requested slot is already taken or unavailable');
      }

      const newSlot = claimRes.rows[0];
      const newSlotStartTime = new Date(newSlot.starts_at).getTime();
      if (newSlotStartTime <= Date.now()) {
        slotInPast('Cannot reschedule to a slot in the past');
      }

      // 2. Mark old appointment as rescheduled
      await tx.query(
        `UPDATE appointments
         SET status = 'rescheduled'
         WHERE id = $1`,
        [appointmentId]
      );

      // 3. Free old slot
      await tx.query(
        `UPDATE slots
         SET status = 'open'
         WHERE id = $1`,
        [oldAppt.slotId]
      );

      // 4. Cancel pending notification jobs for old appointment
      await tx.query(
        `UPDATE notification_jobs
         SET status = 'cancelled'
         WHERE appointment_id = $1 AND status = 'pending'`,
        [appointmentId]
      );

      // 5. Insert new appointment with reschedule_of set
      const newApptRes = await tx.query<{
        id: string;
        patient_id: string;
        slot_id: string;
        status: 'booked';
        created_at: string;
        reschedule_of: string;
      }>(
        `INSERT INTO appointments (patient_id, slot_id, status, reschedule_of, reason)
         VALUES ($1, $2, 'booked', $3, $4)
         RETURNING id, patient_id, slot_id, status, created_at, reschedule_of`,
        [oldAppt.patientId, newSlot.id, appointmentId, reason || 'Rescheduled by patient']
      );

      const newAppointment = newApptRes.rows[0];

      // Retrieve doctor & department details
      const docRes = await tx.query<{ name: string; dept_name: string }>(
        `SELECT doc.name, d.name as dept_name
         FROM doctors doc
         JOIN departments d ON d.id = doc.department_id
         WHERE doc.id = $1`,
        [newSlot.doctor_id]
      );
      const doctor = docRes.rows[0];

      const notifPayload = {
        doctorName: doctor?.name || 'Doctor',
        departmentName: doctor?.dept_name || 'Department',
        startsAt: newSlot.starts_at,
        hospitalPhone: '+91 40 2345 6789',
        cancelUrl: `/appointments/${newAppointment.id}/cancel`,
      };

      // Notification jobs for new appointment
      await tx.query(
        `INSERT INTO notification_jobs (appointment_id, kind, channel, recipient, payload, run_at, status)
         VALUES ($1, 'confirm', 'sms', 'patient', $2, NOW(), 'pending')
         ON CONFLICT (appointment_id, kind, channel) DO NOTHING`,
        [newAppointment.id, JSON.stringify(notifPayload)]
      );

      // Audit log
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, details)
         VALUES ($1, 'APPOINTMENT_RESCHEDULED', 'appointment', $2, $3)`,
        [
          actor.userId,
          newAppointment.id,
          JSON.stringify({ oldAppointmentId: appointmentId, newSlotId: newSlot.id }),
        ]
      );

      const resultRecord: AppointmentRecord = {
        id: newAppointment.id,
        patientId: oldAppt.patientId,
        patientName: oldAppt.patientName,
        slotId: newSlot.id,
        doctorId: newSlot.doctor_id,
        doctorName: doctor?.name,
        departmentName: doctor?.dept_name,
        startsAt: newSlot.starts_at,
        endsAt: newSlot.ends_at,
        status: 'booked',
        createdAt: newAppointment.created_at,
        rescheduleOf: appointmentId,
        reason: reason,
      };

      if (idempotencyKey && idempotencyHash) {
        await storeIdempotency(idempotencyKey, idempotencyHash, resultRecord as any, tx);
      }

      return resultRecord;
    });
  }

  async markNoShow(appointmentId: string, actor: AuthSession): Promise<AppointmentRecord> {
    const appt = await this.getAppointmentById(appointmentId);

    if (appt.status !== 'booked') {
      invalidState(`Only active booked appointments can be marked no-show`);
    }

    return await db.transaction(async (tx) => {
      // 1. Mark appointment as no_show
      await tx.query(
        `UPDATE appointments
         SET status = 'no_show'
         WHERE id = $1`,
        [appointmentId]
      );

      // 2. Increment patient no_show_count (§7)
      await tx.query(
        `UPDATE patients
         SET no_show_count = no_show_count + 1
         WHERE id = $1`,
        [appt.patientId]
      );

      // 3. Audit log (§9)
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, details)
         VALUES ($1, 'APPOINTMENT_NO_SHOW', 'appointment', $2, $3)`,
        [actor.userId, appointmentId, JSON.stringify({ patientId: appt.patientId })]
      );

      return {
        ...appt,
        status: 'no_show',
      };
    });
  }
}

export const appointmentsService = new AppointmentsService();
