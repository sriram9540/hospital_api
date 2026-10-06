import { describe, it, expect } from 'vitest';
import { __test__, logger } from './logger.js';

describe('logger redaction', () => {
  it('redacts email addresses in string values', () => {
    const out = __test__.redactString('contact me at jane.doe@example.com');
    expect(out).not.toContain('jane.doe@example.com');
    expect(out).toContain('[redacted]');
  });

  it('redacts sensitive keys inside objects', () => {
    const out = __test__.redactValue({
      email: 'a@b.com',
      password: 'hunter2',
      id: 'safe-id',
      nested: { phone: '+1 555 123 4567', ok: 1 },
    }) as Record<string, unknown>;
    expect(out.email).toBe('[redacted]');
    expect(out.password).toBe('[redacted]');
    expect(out.id).toBe('safe-id');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.phone).toBe('[redacted]');
    expect(nested.ok).toBe(1);
  });

  it('exposes info/warn/error/debug methods', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });
});
