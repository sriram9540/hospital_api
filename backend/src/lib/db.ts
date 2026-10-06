import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

declare global {
  // eslint-disable-next-line no-var
  var __hospital_prisma__: PrismaClient | undefined;
}

const env = process.env.NODE_ENV ?? 'development';
const isProd = env === 'production';

function readDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) return undefined;
  return url;
}

function createClient(): PrismaClient {
  const url = readDatabaseUrl();

  if (!url) {
    if (isProd) {
      throw new Error('DATABASE_URL is required in production');
    }
    logger.warn(
      { component: 'db' },
      'DATABASE_URL not set; Prisma client will use schema-level url (may fail on connect)',
    );
  }

  return new PrismaClient({
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
    datasources: {
      db: { url: url ?? process.env.DATABASE_URL ?? '' },
    },
  });
}

export const db: PrismaClient =
  globalThis.__hospital_prisma__ ?? createClient();

if (!isProd) {
  globalThis.__hospital_prisma__ = db;
}

export type { PrismaClient } from '@prisma/client';

export async function disconnectDb(): Promise<void> {
  await db.$disconnect();
}

export async function pingDb(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1');
    return true;
  } catch (err) {
    logger.error({ component: 'db', err: redactError(err) }, 'database ping failed');
    return false;
  }
}

function redactError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const message = err.message
    .replace(/postgres(ql)?:\/\/[^@\s]+@/gi, 'postgres://[redacted]@')
    .replace(/password=[^\s]+/gi, 'password=[redacted]');
  return { name: err.name, message };
}
