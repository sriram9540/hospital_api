import { Router, Request, Response, NextFunction } from 'express';
import { slotsService } from './slots.service.js';
import { getSlotsQuerySchema, blockSlotsSchema } from './slots.schema.js';
import { requireAuth, requireRole, AuthenticatedRequest } from '../auth/auth.middleware.js';
import { validationError } from '../../lib/errors.js';

export const slotsRouter = Router();

// GET /doctors/:id/slots?date=YYYY-MM-DD (Live availability §4, §7)
slotsRouter.get('/doctors/:id/slots', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parse = getSlotsQuerySchema.safeParse(req.query);
    if (!parse.success) {
      validationError('Invalid date parameter. Use YYYY-MM-DD format', { issues: parse.error.format() });
    }

    const slots = await slotsService.getDoctorSlots(req.params.id, parse.data.date);
    res.json(slots);
  } catch (err) {
    next(err);
  }
});

// Admin/Doctor route to block slots for leave
slotsRouter.post('/doctors/:id/block-slots', requireAuth, requireRole('doctor', 'admin', 'receptionist'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parse = blockSlotsSchema.safeParse({ ...req.body, doctorId: req.params.id });
    if (!parse.success) {
      validationError('Invalid parameters', { issues: parse.error.format() });
    }

    const blocked = await slotsService.blockSlotsForLeave(
      parse.data.doctorId,
      parse.data.startDate,
      parse.data.endDate,
      parse.data.reason
    );

    res.json({ message: `Successfully blocked ${blocked} open slots`, count: blocked });
  } catch (err) {
    next(err);
  }
});
