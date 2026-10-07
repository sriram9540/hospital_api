import { z } from 'zod';

export const joinWaitlistSchema = z.object({
  doctorId: z.string().uuid('Valid doctor ID is required'),
  desiredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be formatted as YYYY-MM-DD'),
});
