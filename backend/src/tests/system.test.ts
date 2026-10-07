import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, db } from '../lib/db.js';
import { appointmentsService } from '../modules/appointments/appointments.service.js';
import { authService, AuthSession } from '../modules/auth/auth.service.js';
import { reminderWorker } from '../workers/reminder.worker.js';
import { hashPayload } from '../lib/idempotency.js';
import { AppError } from '../lib/errors.js';

describe('Hospital System Independent Verification (§13)', () => {
  let doctorId: string;
  let patientA: { session: AuthSession; patientId: string };
  let patientB: { session: AuthSession; patientId: string };

  beforeAll(async () => {
    await getDb();

    // Fetch existing doctor
    const docRes = await db.query(`SELECT id FROM doctors LIMIT 1`);
    doctorId = docRes.rows[0].id;

    // Register two distinct patients for AuthZ & concurrency tests
    const userA = await authService.register({
      email: `patient.a.${Date.now()}@test.com`,
      password: 'password123',
      fullName: 'Patient Alpha',
      phone: '+919999900001',
    });
    patientA = { session: userA.session, patientId: userA.session.patientId! };

    const userB = await authService.register({
      email: `patient.b.${Date.now()}@test.com`,
      password: 'password123',
      fullName: 'Patient Beta',
      phone: '+919999900002',
    });
    patientB = { session: userB.session, patientId: userB.session.patientId! };
  });

  // TEST 1: Concurrency (50 parallel bookings on 1 slot -> 1 success, 49 SLOT_TAKEN)
  it('1. Concurrency: 50 parallel bookings on 1 slot -> 1 success, 49 SLOT_TAKEN', async () => {
    // Create an open future slot
    const slotRes = await db.query(
      `INSERT INTO slots (doctor_id, starts_at, ends_at, status)
       VALUES ($1, NOW() + INTERVAL '10 days', NOW() + INTERVAL '10 days 30 minutes', 'open')
       RETURNING id`,
      [doctorId]
    );
    const slotId = slotRes.rows[0].id;

    // 50 parallel booking attempts
    const promises = Array.from({ length: 50 }, (_, i) => {
      return appointmentsService.bookAppointment({
        patientId: patientA.patientId,
        slotId,
        reason: `Concurrent test attempt ${i}`,
      });
    });

    const results = await Promise.allSettled(promises);

    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(49);

    for (const fail of failures) {
      const err = (fail as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('SLOT_TAKEN');
      expect((err as AppError).statusCode).toBe(409);
    }

    // Verify exactly one active booked appointment exists for that slot
    const apptCheck = await db.query(
      `SELECT COUNT(*)::int as count FROM appointments WHERE slot_id = $1 AND status = 'booked'`,
      [slotId]
    );
    expect(apptCheck.rows[0].count).toBe(1);
  });

  // TEST 2: Idempotency (replay -> same appointment, no dup row)
  it('2. Idempotency: replay -> same appointment, no duplicate row', async () => {
    const slotRes = await db.query(
      `INSERT INTO slots (doctor_id, starts_at, ends_at, status)
       VALUES ($1, NOW() + INTERVAL '11 days', NOW() + INTERVAL '11 days 30 minutes', 'open')
       RETURNING id`,
      [doctorId]
    );
    const slotId = slotRes.rows[0].id;

    const idempotencyKey = `idemp-test-${Date.now()}`;
    const payload = { slotId, patientId: patientA.patientId, reason: 'Checkup' };
    const hash = hashPayload(payload);

    // First attempt
    const firstCall = await appointmentsService.bookAppointment({
      patientId: patientA.patientId,
      slotId,
      reason: 'Checkup',
      idempotencyKey,
      idempotencyHash: hash,
    });

    expect(firstCall).toBeDefined();
    expect(firstCall.slotId).toBe(slotId);

    // Replay with exact same idempotency key and hash via checkIdempotency or service
    const { checkIdempotency } = await import('../lib/idempotency.js');
    const cached = await checkIdempotency(idempotencyKey, hash);

    expect(cached).toBeDefined();
    expect((cached as any).id).toBe(firstCall.id);

    // Verify database has only 1 appointment row
    const countRes = await db.query(
      `SELECT COUNT(*)::int as count FROM appointments WHERE slot_id = $1`,
      [slotId]
    );
    expect(countRes.rows[0].count).toBe(1);

    // Conflict test: same key with different hash -> IDEMPOTENCY_KEY_CONFLICT
    const differentHash = hashPayload({ ...payload, reason: 'Different reason' });
    await expect(checkIdempotency(idempotencyKey, differentHash)).rejects.toThrow();
  });

  // TEST 3: Reschedule atomicity (forced failure -> old appointment untouched)
  it('3. Reschedule atomicity: forced failure leaves old appointment untouched', async () => {
    const slot1Res = await db.query(
      `INSERT INTO slots (doctor_id, starts_at, ends_at, status)
       VALUES ($1, NOW() + INTERVAL '12 days', NOW() + INTERVAL '12 days 30 minutes', 'open')
       RETURNING id`,
      [doctorId]
    );
    const oldSlotId = slot1Res.rows[0].id;

    const originalAppt = await appointmentsService.bookAppointment({
      patientId: patientA.patientId,
      slotId: oldSlotId,
      reason: 'Original appointment',
    });

    expect(originalAppt.status).toBe('booked');

    // Attempt reschedule to a non-existent or taken slot (forced failure)
    const fakeSlotId = '00000000-0000-0000-0000-000000000000';

    await expect(
      appointmentsService.rescheduleAppointment({
        appointmentId: originalAppt.id,
        newSlotId: fakeSlotId,
        actor: patientA.session,
      })
    ).rejects.toThrow();

    // Verify old appointment and old slot are completely untouched
    const apptCheck = await appointmentsService.getAppointmentById(originalAppt.id);
    expect(apptCheck.status).toBe('booked');

    const slotCheck = await db.query(`SELECT status FROM slots WHERE id = $1`, [oldSlotId]);
    expect(slotCheck.rows[0].status).toBe('booked');
  });

  // TEST 4: Cancel frees slot + kills pending reminders
  it('4. Cancel frees slot + kills pending reminders', async () => {
    const slotRes = await db.query(
      `INSERT INTO slots (doctor_id, starts_at, ends_at, status)
       VALUES ($1, NOW() + INTERVAL '13 days', NOW() + INTERVAL '13 days 30 minutes', 'open')
       RETURNING id`,
      [doctorId]
    );
    const slotId = slotRes.rows[0].id;

    const appt = await appointmentsService.bookAppointment({
      patientId: patientA.patientId,
      slotId,
      reason: 'Cancel test',
    });

    // Check pending jobs exist
    const initialJobs = await db.query(
      `SELECT status FROM notification_jobs WHERE appointment_id = $1 AND status = 'pending'`,
      [appt.id]
    );
    expect(initialJobs.rows.length).toBeGreaterThan(0);

    // Cancel appointment
    const cancelled = await appointmentsService.cancelAppointment(appt.id, patientA.session);
    expect(cancelled.status).toBe('cancelled');

    // Slot must be free ('open')
    const slotResAfter = await db.query(`SELECT status FROM slots WHERE id = $1`, [slotId]);
    expect(slotResAfter.rows[0].status).toBe('open');

    // Pending reminders must be killed (marked 'cancelled')
    const cancelledJobs = await db.query(
      `SELECT status FROM notification_jobs WHERE appointment_id = $1 AND status = 'cancelled'`,
      [appt.id]
    );
    expect(cancelledJobs.rows.length).toBeGreaterThan(0);

    const pendingJobs = await db.query(
      `SELECT status FROM notification_jobs WHERE appointment_id = $1 AND status = 'pending' AND kind != 'cancel_notice'`,
      [appt.id]
    );
    expect(pendingJobs.rows.length).toBe(0);
  });

  // TEST 5: Reminder worker twice -> each reminder sent once
  it('5. Reminder worker runs twice -> each reminder sent once', async () => {
    const slotRes = await db.query(
      `INSERT INTO slots (doctor_id, starts_at, ends_at, status)
       VALUES ($1, NOW() + INTERVAL '14 days', NOW() + INTERVAL '14 days 30 minutes', 'open')
       RETURNING id`,
      [doctorId]
    );
    const slotId = slotRes.rows[0].id;

    const appt = await appointmentsService.bookAppointment({
      patientId: patientA.patientId,
      slotId,
      reason: 'Worker test',
    });

    // First cycle
    const cycle1 = await reminderWorker.processDueJobs(20);
    expect(cycle1.sent).toBeGreaterThanOrEqual(1);

    // Check the job is now 'sent'
    const confirmJob = await db.query(
      `SELECT status, attempts FROM notification_jobs WHERE appointment_id = $1 AND kind = 'confirm'`,
      [appt.id]
    );
    expect(confirmJob.rows[0].status).toBe('sent');
    expect(confirmJob.rows[0].attempts).toBe(1);

    // Second cycle immediately: job is already sent, so it must not be sent again!
    const cycle2 = await reminderWorker.processDueJobs(20);
    const confirmJobAfter = await db.query(
      `SELECT status, attempts FROM notification_jobs WHERE appointment_id = $1 AND kind = 'confirm'`,
      [appt.id]
    );
    expect(confirmJobAfter.rows[0].attempts).toBe(1); // Not sent twice
  });

  // TEST 6: AuthZ (Patient A cannot touch Patient B's appointment)
  it('6. AuthZ: Patient A cannot read, cancel, or reschedule Patient B appointment', async () => {
    const slotRes = await db.query(
      `INSERT INTO slots (doctor_id, starts_at, ends_at, status)
       VALUES ($1, NOW() + INTERVAL '15 days', NOW() + INTERVAL '15 days 30 minutes', 'open')
       RETURNING id`,
      [doctorId]
    );
    const slotId = slotRes.rows[0].id;

    // Patient B books appointment
    const apptB = await appointmentsService.bookAppointment({
      patientId: patientB.patientId,
      slotId,
      reason: 'Private consultation',
    });

    // Patient A attempts to cancel Patient B's appointment -> FORBIDDEN
    await expect(
      appointmentsService.cancelAppointment(apptB.id, patientA.session)
    ).rejects.toThrow('You are not authorized to cancel this appointment');

    // Patient A attempts to reschedule Patient B's appointment -> FORBIDDEN
    const slotRes2 = await db.query(
      `INSERT INTO slots (doctor_id, starts_at, ends_at, status)
       VALUES ($1, NOW() + INTERVAL '16 days', NOW() + INTERVAL '16 days 30 minutes', 'open')
       RETURNING id`,
      [doctorId]
    );
    const slot2Id = slotRes2.rows[0].id;

    await expect(
      appointmentsService.rescheduleAppointment({
        appointmentId: apptB.id,
        newSlotId: slot2Id,
        actor: patientA.session,
      })
    ).rejects.toThrow('You are not authorized to reschedule this appointment');
  });

  // TEST 7: Cutoff + past-slot rules return correct error codes
  it('7. Cutoff and past-slot rules return correct error codes', async () => {
    // 7A: Past slot booking -> SLOT_IN_PAST
    const pastSlotRes = await db.query(
      `INSERT INTO slots (doctor_id, starts_at, ends_at, status)
       VALUES ($1, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour 30 minutes', 'open')
       RETURNING id`,
      [doctorId]
    );
    const pastSlotId = pastSlotRes.rows[0].id;

    try {
      await appointmentsService.bookAppointment({
        patientId: patientA.patientId,
        slotId: pastSlotId,
      });
      expect.fail('Should have thrown SLOT_IN_PAST');
    } catch (err: any) {
      expect(err.code).toBe('SLOT_IN_PAST');
      expect(err.statusCode).toBe(400);
    }

    // 7B: Cancellation cutoff check (< 2 hours) -> CUTOFF_PASSED
    // Create slot starting in 30 minutes (< 2 hours cutoff)
    const tightSlotRes = await db.query(
      `INSERT INTO slots (doctor_id, starts_at, ends_at, status)
       VALUES ($1, NOW() + INTERVAL '30 minutes', NOW() + INTERVAL '60 minutes', 'open')
       RETURNING id`,
      [doctorId]
    );
    const tightSlotId = tightSlotRes.rows[0].id;

    const tightAppt = await appointmentsService.bookAppointment({
      patientId: patientA.patientId,
      slotId: tightSlotId,
    });

    try {
      await appointmentsService.cancelAppointment(tightAppt.id, patientA.session);
      expect.fail('Should have thrown CUTOFF_PASSED');
    } catch (err: any) {
      expect(err.code).toBe('CUTOFF_PASSED');
      expect(err.statusCode).toBe(400);
    }
  });
});
