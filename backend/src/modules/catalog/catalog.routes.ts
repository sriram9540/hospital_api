import { Router, Request, Response, NextFunction } from 'express';
import { catalogService } from './catalog.service.js';
import { createDepartmentSchema, createDoctorSchema, createScheduleSchema } from './catalog.schema.js';
import { requireAuth, requireRole, AuthenticatedRequest } from '../auth/auth.middleware.js';
import { validationError } from '../../lib/errors.js';

export const catalogRouter = Router();

// Public routes
catalogRouter.get('/departments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const departments = await catalogService.getDepartments();
    res.json(departments);
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/departments/:id/doctors', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const doctors = await catalogService.getDoctors(req.params.id);
    res.json(doctors);
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/doctors', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const departmentId = typeof req.query.departmentId === 'string' ? req.query.departmentId : undefined;
    const doctors = await catalogService.getDoctors(departmentId);
    res.json(doctors);
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/doctors/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const doctor = await catalogService.getDoctorById(req.params.id);
    res.json(doctor);
  } catch (err) {
    next(err);
  }
});

// Staff / Doctor routes
catalogRouter.get('/doctors/:id/schedule', requireAuth, requireRole('doctor', 'receptionist', 'admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const schedule = await catalogService.getDoctorSchedule(req.params.id);
    res.json(schedule);
  } catch (err) {
    next(err);
  }
});

// Admin management routes
export const adminCatalogRouter = Router();

adminCatalogRouter.post('/departments', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parse = createDepartmentSchema.safeParse(req.body);
    if (!parse.success) {
      validationError('Invalid department data', { issues: parse.error.format() });
    }
    const dept = await catalogService.createDepartment(parse.data);
    res.status(201).json(dept);
  } catch (err) {
    next(err);
  }
});

adminCatalogRouter.post('/doctors', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parse = createDoctorSchema.safeParse(req.body);
    if (!parse.success) {
      validationError('Invalid doctor data', { issues: parse.error.format() });
    }
    const doc = await catalogService.createDoctor(parse.data);
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

adminCatalogRouter.post('/schedules', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parse = createScheduleSchema.safeParse(req.body);
    if (!parse.success) {
      validationError('Invalid schedule data', { issues: parse.error.format() });
    }
    const sched = await catalogService.createSchedule(parse.data);
    res.status(201).json(sched);
  } catch (err) {
    next(err);
  }
});
