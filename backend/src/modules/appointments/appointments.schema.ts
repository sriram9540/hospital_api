import { z } from 'zod';

export const bookAppointmentSchema = z.object({
  slotId: z.string().uuid('Valid slot ID is required'),
  reason: z.string().max(250).optional(),
});

export const rescheduleAppointmentSchema = z.object({
  newSlotId: z.string().uuid('Valid new slot ID is required'),
  reason: z.string().max(250).optional(),
});

export const markNoShowSchema = z.object({
  reason: z.string().optional(),
});
