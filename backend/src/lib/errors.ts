/**
 * Standardized App Errors (§5, §7)
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'SLOT_TAKEN'
  | 'SLOT_IN_PAST'
  | 'CUTOFF_PASSED'
  | 'INVALID_STATE'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, statusCode: number = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function notFound(message = 'Resource not found', details = {}): never {
  throw new AppError('NOT_FOUND', message, 404, details);
}

export function unauthenticated(message = 'Authentication required', details = {}): never {
  throw new AppError('UNAUTHENTICATED', message, 401, details);
}

export function forbidden(message = 'Access forbidden', details = {}): never {
  throw new AppError('FORBIDDEN', message, 403, details);
}

export function slotTaken(message = 'Selected slot is already booked or unavailable', details = {}): never {
  throw new AppError('SLOT_TAKEN', message, 409, details);
}

export function slotInPast(message = 'Cannot book a slot in the past', details = {}): never {
  throw new AppError('SLOT_IN_PAST', message, 400, details);
}

export function cutoffPassed(message = 'Action not permitted after cancellation cutoff', details = {}): never {
  throw new AppError('CUTOFF_PASSED', message, 400, details);
}

export function invalidState(message = 'Invalid state transition for appointment', details = {}): never {
  throw new AppError('INVALID_STATE', message, 400, details);
}

export function idempotencyConflict(message = 'Idempotency key reused with different request payload', details = {}): never {
  throw new AppError('IDEMPOTENCY_KEY_CONFLICT', message, 409, details);
}

export function validationError(message = 'Invalid request parameters', details = {}): never {
  throw new AppError('VALIDATION_ERROR', message, 400, details);
}
