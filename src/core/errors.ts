export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'NON_POSITIVE_PROPERTY'
  | 'THICKNESS_MISMATCH'
  | 'ILLEGAL_TIME'
  | 'SOLVER_NON_FINITE'
  | 'BAD_GRID'
  | 'BAD_BOUNDARY'
  | 'MATERIAL_CHANGED'
  | 'BOUNDARY_VERSION_CHANGED'
  | 'SIM_FINISHED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CONFLICT'
  | 'INTERNAL';

export class AppError extends Error {
  code: ErrorCode;
  details?: unknown;
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
