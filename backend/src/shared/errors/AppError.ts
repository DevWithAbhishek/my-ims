export type ErrorDetail = Record<string, unknown>;

export type AppErrorOptions = {
  statusCode: number;
  code: string;
  message: string;
  details?: ErrorDetail[];
  /** Seconds for the `Retry-After` header (429 and 503). */
  retryAfterSeconds?: number;
  expose?: boolean;
};

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: ErrorDetail[];
  readonly retryAfterSeconds?: number;
  readonly expose: boolean;

  constructor({
    statusCode,
    code,
    message,
    details = [],
    retryAfterSeconds,
    expose = true,
  }: AppErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
    this.expose = expose;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code = 'BAD_REQUEST', details: ErrorDetail[] = []) {
    super({ statusCode: 400, code, message, details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', code = 'UNAUTHENTICATED', details: ErrorDetail[] = []) {
    super({ statusCode: 401, code, message, details });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', code = 'FORBIDDEN', details: ErrorDetail[] = []) {
    super({ statusCode: 403, code, message, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code: string, details: ErrorDetail[] = []) {
    super({ statusCode: 404, code, message, details });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: string, details: ErrorDetail[] = []) {
    super({ statusCode: 409, code, message, details });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string, code: string, details: ErrorDetail[] = []) {
    super({ statusCode: 413, code, message, details });
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code = 'VALIDATION_FAILED', details: ErrorDetail[] = []) {
    super({ statusCode: 422, code, message, details });
  }
}

export class TooManyRequestsError extends AppError {
  constructor(
    message: string,
    code: string,
    retryAfterSeconds?: number,
    details: ErrorDetail[] = [],
  ) {
    super({ statusCode: 429, code, message, details, retryAfterSeconds });
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error', code = 'INTERNAL_ERROR') {
    super({ statusCode: 500, code, message, expose: false });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(
    message = 'Service unavailable',
    code = 'DEPENDENCY_UNAVAILABLE',
    retryAfterSeconds?: number,
    details: ErrorDetail[] = [],
  ) {
    super({ statusCode: 503, code, message, details, retryAfterSeconds });
  }
}
