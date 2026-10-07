import { z } from 'zod';

export const createDepartmentSchema = z.object({
  name: z.string().min(2, 'Department name is required'),
  description: z.string().optional(),
  icon: z.string().optional(),
});

export const createDoctorSchema = z.object({
  departmentId: z.string().uuid('Valid department ID is required'),
  name: z.string().min(2, 'Doctor name is required'),
  specialization: z.string().min(2, 'Specialization is required'),
  slotMinutes: z.number().int().min(10).max(120).default(30),
  overbookLimit: z.number().int().min(0).max(5).default(0),
  email: z.string().email().optional(),
});

export const createScheduleSchema = z.object({
  doctorId: z.string().uuid('Valid doctor ID is required'),
  weekday: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Start time must be HH:MM'),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'End time must be HH:MM'),
}).refine(data => data.endTime > data.startTime, {
  message: 'End time must be after start time',
  path: ['endTime'],
});
