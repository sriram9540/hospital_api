/**
 * Privacy-preserving logger (§9, §10)
 * Never logs patient PII, passwords, or diagnoses. IDs and codes only.
 */
export const logger = {
  info: (msg: string, meta: Record<string, unknown> = {}) => {
    console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, meta && Object.keys(meta).length ? JSON.stringify(meta) : '');
  },
  warn: (msg: string, meta: Record<string, unknown> = {}) => {
    console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, meta && Object.keys(meta).length ? JSON.stringify(meta) : '');
  },
  error: (msg: string, err?: unknown, meta: Record<string, unknown> = {}) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, {
      ...(err instanceof Error ? { errorName: err.name, errorMessage: err.message } : {}),
      ...meta,
    });
  },
};
