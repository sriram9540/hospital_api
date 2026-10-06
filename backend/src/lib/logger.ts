type Level = 'info' | 'warn' | 'error' | 'debug';

const PII_KEYS = new Set([
  'email',
  'phone',
  'password',
  'passwordHash',
  'password_hash',
  'fullName',
  'full_name',
  'dob',
  'token',
  'session',
  'cookie',
  'authorization',
  'address',
]);

const PII_PATTERNS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\+?\d[\d\s\-]{7,}\d/g,
  /\b\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4}\b/g,
];

function redactString(value: string): string {
  let out = value;
  for (const p of PII_PATTERNS) {
    out = out.replace(p, '[redacted]');
  }
  return out;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEYS.has(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function emit(level: Level, meta: Record<string, unknown>, msg: string): void {
  const payload = { ts: new Date().toISOString(), level, ...redactValue(meta) };
  const line = JSON.stringify({ msg, ...payload });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (meta: Record<string, unknown>, msg: string): void => emit('info', meta, msg),
  warn: (meta: Record<string, unknown>, msg: string): void => emit('warn', meta, msg),
  error: (meta: Record<string, unknown>, msg: string): void => emit('error', meta, msg),
  debug: (meta: Record<string, unknown>, msg: string): void => emit('debug', meta, msg),
  child: (_bindings: Record<string, unknown>) => logger,
};

export const __test__ = { redactValue, redactString };
