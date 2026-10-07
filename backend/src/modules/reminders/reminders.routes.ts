import { Router, Response, NextFunction } from 'express';
import { remindersService } from './reminders.service.js';
import { requireAuth, requireRole, AuthenticatedRequest } from '../auth/auth.middleware.js';
import { triggerRemindersQuerySchema } from './reminders.schema.js';

export const remindersRouter = Router();

remindersRouter.get('/jobs', requireAuth, requireRole('doctor', 'receptionist', 'admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const appointmentId = typeof req.query.appointmentId === 'string' ? req.query.appointmentId : undefined;
    const jobs = await remindersService.getRecentJobs(appointmentId);
    res.json(jobs);
  } catch (err) {
    next(err);
  }
});

remindersRouter.post('/process', requireAuth, requireRole('admin', 'receptionist'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parse = triggerRemindersQuerySchema.safeParse(req.query);
    const limit = parse.success ? parse.data.limit : 20;
    const result = await remindersService.runWorkerCycle(limit);
    res.json({ message: 'Processed reminder cycle', ...result });
  } catch (err) {
    next(err);
  }
});
