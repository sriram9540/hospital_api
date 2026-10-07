/**
 * Idempotency Helper (§4, §6, §7)
 */
import crypto from 'crypto';
import { db } from './db.js';
import { idempotencyConflict } from './errors.js';

export function hashPayload(payload: unknown): string {
  const normalized = JSON.stringify(payload || {});
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export async function checkIdempotency(key: string, requestHash: string): Promise<Record<string, unknown> | null> {
  const result = await db.query<{ response: string; request_hash: string }>(
    `SELECT response, request_hash FROM idempotency_keys WHERE key = $1 AND expires_at > NOW()`,
    [key]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    if (row.request_hash !== requestHash) {
      idempotencyConflict('Idempotency key provided has already been used with different parameters');
    }
    return JSON.parse(row.response);
  }

  return null;
}

export async function storeIdempotency(
  key: string,
  requestHash: string,
  responseObj: Record<string, unknown>,
  client?: any
): Promise<void> {
  const runner = client || db;
  await runner.query(
    `INSERT INTO idempotency_keys (key, request_hash, response, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
     ON CONFLICT (key) DO UPDATE SET response = $3, expires_at = NOW() + INTERVAL '24 hours'`,
    [key, requestHash, JSON.stringify(responseObj)]
  );
}
