export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'NON_FINITE'
  | 'THICKNESS_MISMATCH'
  | 'NON_POSITIVE_PROPERTY'
  | 'ILLEGAL_TIME'
  | 'VERSION_MISMATCH'
  | 'MATERIAL_MODIFIED'
  | 'IDEMPOTENCY_REPLAY';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new AppError(code, message, details);
}
