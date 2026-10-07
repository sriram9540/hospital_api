import { Router, Response, NextFunction } from 'express';
import { waitlistService } from './waitlist.service.js';
import { joinWaitlistSchema } from './waitlist.schema.js';
import { requireAuth, AuthenticatedRequest } from '../auth/auth.middleware.js';
import { validationError } from '../../lib/errors.js';

export const waitlistRouter = Router();

// POST /waitlist (§7)
waitlistRouter.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parse = joinWaitlistSchema.safeParse(req.body);
    if (!parse.success) {
      validationError('Invalid waitlist data', { issues: parse.error.format() });
    }

    if (!req.user!.patientId) {
      validationError('Only patients can join the waitlist');
    }

    const entry = await waitlistService.joinWaitlist(
      req.user!.patientId,
      parse.data.doctorId,
      parse.data.desiredDate
    );

    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

// GET /waitlist/mine
waitlistRouter.get('/mine', requireAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user!.patientId) {
      return res.json([]);
    }
    const entries = await waitlistService.getMyWaitlist(req.user!.patientId);
    res.json(entries);
  } catch (err) {
    next(err);
  }
});
