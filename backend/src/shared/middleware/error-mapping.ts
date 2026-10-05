import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, BadRequestError, InternalError } from '../errors/AppError.js';
import { zodErrorToAppError } from '../errors/zod.js';
import { childLogger } from '../observability/logger.js';

/** Errors raised by Express' body parser (malformed JSON, bad encoding, aborted request, ...). */
function isBodyParserError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { type, status } = error as { type?: unknown; status?: unknown };
  return typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500;
}

function toAppError(error: unknown): AppError | undefined {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return zodErrorToAppError(error);
  if (isBodyParserError(error)) return new BadRequestError('Malformed request body');
  return undefined;
}

export const errorMappingMiddleware: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const requestId = res.locals.requestId as string | undefined;
  const log = childLogger({ requestId });
  const appError = toAppError(error);

  if (!appError) {
    log.error({ err: error }, 'Unhandled error');
    sendError(res, new InternalError(), requestId);
    return;
  }

  if (appError.statusCode >= 500) {
    log.error({ err: appError, errorCode: appError.code }, appError.message);
  } else {
    log.warn({ errorCode: appError.code, statusCode: appError.statusCode }, appError.message);
  }
  sendError(res, appError, requestId);
};

function sendError(
  res: Parameters<ErrorRequestHandler>[2],
  error: AppError,
  requestId: string | undefined,
): void {
  if (error.retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }

  res.status(error.statusCode).json({
    error: {
      code: error.code,
      message: error.expose ? error.message : 'Internal server error',
      details: error.expose ? error.details : [],
      requestId: requestId ?? null,
    },
  });
}
