/**
 * Standalone API server for Render (no frontend serving).
 * Local monolith dev still uses root server.ts (API + Vite).
 */
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { CONFIG } from './lib/config.js';
import { getPool, closeDb } from './lib/db.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { reminderWorker } from './workers/reminder.worker.js';

import { authRouter } from './modules/auth/auth.routes.js';
import { catalogRouter, adminCatalogRouter } from './modules/catalog/catalog.routes.js';
import { slotsRouter } from './modules/slots/slots.routes.js';
import { appointmentsRouter } from './modules/appointments/appointments.routes.js';
import { remindersRouter } from './modules/reminders/reminders.routes.js';
import { waitlistRouter } from './modules/waitlist/waitlist.routes.js';

async function startApiServer() {
  const app = express();
  app.set('trust proxy', 1);

  // CORS: frontend is a separate origin in production.
  // Auth uses Bearer tokens, so no credentials/cookies are required.
  const allowedOrigins = CONFIG.FRONTEND_URL.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: allowedOrigins.length > 0 ? allowedOrigins : true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      maxAge: 600,
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  try {
    await getPool();
    logger.info('Connected to Neon Postgres successfully');
    reminderWorker.start(CONFIG.REMINDER_POLL_INTERVAL_MS);
  } catch (err) {
    logger.error('Failed to initialize database', err);
    process.exit(1);
  }

  const apiV1 = express.Router();
  apiV1.use('/auth', authRouter);
  apiV1.use('/', catalogRouter);
  apiV1.use('/admin', adminCatalogRouter);
  apiV1.use('/', slotsRouter);
  apiV1.use('/appointments', appointmentsRouter);
  apiV1.use('/reminders', remindersRouter);
  apiV1.use('/waitlist', waitlistRouter);
  apiV1.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'MEDI BOOK Appointment API', time: new Date().toISOString() });
  });
  app.use('/api/v1', apiV1);

  // Render health check (root path, outside versioned API)
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'MEDI BOOK Appointment API', time: new Date().toISOString() });
  });

  // Error handling middleware (same contract as monolith server.ts)
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        logger.error(`Server error during ${req.method} ${req.path}`, err);
      }
      return res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    logger.error(`Unhandled error during ${req.method} ${req.path}`, err);
    return res.status(500).json({
      error: {
        code: 'INTERNAL',
        message: 'An unexpected internal error occurred. Please try again later.',
        details: {},
      },
    });
  });

  const port = CONFIG.PORT;
  const server = app.listen(port, '0.0.0.0', () => {
    logger.info(`Hospital API listening on http://0.0.0.0:${port}`);
  });

  const shutdown = async () => {
    logger.info('Shutting down API server...');
    reminderWorker.stop();
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startApiServer().catch((err) => {
  logger.error('Fatal error starting API server', err);
});
