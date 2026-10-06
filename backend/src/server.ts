import 'dotenv/config';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { logger } from './lib/logger.js';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser(process.env.SESSION_SECRET));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  app.use((req, _res, next) => {
    logger.info({ method: req.method, path: req.path }, 'request');
    next();
  });

  return app;
}

const app = createApp();

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => {
    logger.info({ port }, 'hospital-app backend listening');
  });
}

export { app };
export default app;
