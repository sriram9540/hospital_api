import { Router, Response, NextFunction } from 'express';
import { bookAppointmentSchema, rescheduleAppointmentSchema, markNoShowSchema } from './appointments.schema.js';
import { appointmentsService } from './appointments.service.js';
import { requireAuth, requireRole, AuthenticatedRequest } from '../auth/auth.middleware.js';
import { validationError } from '../../lib/errors.js';
import { checkIdempotency, hashPayload } from '../../lib/idempotency.js';

export const appointmentsRouter = Router();

// POST /appointments (Idempotency-Key header required §4, §7)
appointmentsRouter.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parse = bookAppointmentSchema.safeParse(req.body);
    if (!parse.success) {
      validationError('Invalid appointment booking parameters', { issues: parse.error.format() });
    }

    const idempotencyKey = (req.headers['idempotency-key'] as string) || undefined;
    if (!idempotencyKey) {
      validationError('Idempotency-Key header is required for booking appointments');
    }

    const payloadHash = hashPayload({ ...parse.data, patientId: req.user!.patientId });

    // Check existing idempotency key (§4, §7)
    const cachedResponse = await checkIdempotency(idempotencyKey, payloadHash);
    if (cachedResponse) {
      return res.status(200).json(cachedResponse);
    }

    if (!req.user!.patientId) {
      validationError('Current user does not have an active patient record');
    }

    const appointment = await appointmentsService.bookAppointment({
      patientId: req.user!.patientId,
      slotId: parse.data.slotId,
      reason: parse.data.reason,
      idempotencyKey,
      idempotencyHash: payloadHash,
      actorId: req.user!.userId,
    });

    res.status(201).json(appointment);
  } catch (err) {
    next(err);
  }
});

// GET /appointments/mine
appointmentsRouter.get('/mine', requireAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user!.patientId) {
      return res.json([]);
    }
    const appointments = await appointmentsService.getMyAppointments(req.user!.patientId);
    res.json(appointments);
  } catch (err) {
    next(err);
  }
});

// GET /appointments/:id
appointmentsRouter.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const appointment = await appointmentsService.getAppointmentById(req.params.id);
    if (req.user!.role === 'patient' && appointment.patientId !== req.user!.patientId) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

// POST /appointments/:id/cancel
appointmentsRouter.post('/:id/cancel', requireAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const cancelled = await appointmentsService.cancelAppointment(req.params.id, req.user!);
    res.json(cancelled);
  } catch (err) {
    next(err);
  }
});

// POST /appointments/:id/reschedule (body: { newSlotId }, Idempotency-Key required §4, §7)
appointmentsRouter.post('/:id/reschedule', requireAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parse = rescheduleAppointmentSchema.safeParse(req.body);
    if (!parse.success) {
      validationError('Invalid reschedule parameters', { issues: parse.error.format() });
    }

    const idempotencyKey = (req.headers['idempotency-key'] as string) || undefined;
    const payloadHash = hashPayload({ ...parse.data, appointmentId: req.params.id });

    if (idempotencyKey) {
      const cached = await checkIdempotency(idempotencyKey, payloadHash);
      if (cached) {
        return res.status(200).json(cached);
      }
    }

    const rescheduled = await appointmentsService.rescheduleAppointment({
      appointmentId: req.params.id,
      newSlotId: parse.data.newSlotId,
      actor: req.user!,
      reason: parse.data.reason,
      idempotencyKey,
      idempotencyHash: payloadHash,
    });

    res.json(rescheduled);
  } catch (err) {
    next(err);
  }
});

// POST /appointments/:id/mark-no-show (staff)
appointmentsRouter.post('/:id/mark-no-show', requireAuth, requireRole('doctor', 'receptionist', 'admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    markNoShowSchema.safeParse(req.body);
    const result = await appointmentsService.markNoShow(req.params.id, req.user!);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
