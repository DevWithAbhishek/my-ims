import { ZodError } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { isConcurrencyFailure } from '../db/errors.js';

export type RetryableReason =
  | 'NETWORK'
  | 'SERVICE_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'TRANSIENT_DATABASE'
  | 'REDIS_UNAVAILABLE'
  | 'WORKER_INTERRUPTED'
  | 'UNKNOWN_INTERNAL';

export type NonRetryableReason =
  | 'INVALID_PAYLOAD'
  | 'UNSUPPORTED_EVENT_TYPE'
  | 'BUSINESS_RULE_VIOLATION'
  | 'AUTHENTICATION_OR_CONFIGURATION'
  | 'RESOURCE_NOT_FOUND'
  | 'AUTHORIZATION_FAILURE';

/** Thrown by consumers for a failure that is worth retrying (temporary network/service/provider). */
export class RetryableJobError extends Error {
  constructor(
    readonly reason: RetryableReason,
    message: string,
    /** A delay supplied by the provider (for example on rate limiting); honored by the retry. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RetryableJobError';
  }
}

/** Thrown by consumers for a failure that retrying cannot fix: the job goes straight to dead letter. */
export class NonRetryableJobError extends Error {
  constructor(
    readonly reason: NonRetryableReason,
    message: string,
  ) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}

export type Classification = {
  retryable: boolean;
  errorClass: string;
  retryAfterMs?: number;
};

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
]);
const PRISMA_TRANSIENT_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034']);

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/** Maps any thrown value to a retry decision. Unknown errors are retryable (limited by attempts). */
export function classifyError(error: unknown): Classification {
  if (error instanceof NonRetryableJobError) {
    return { retryable: false, errorClass: error.reason };
  }
  if (error instanceof RetryableJobError) {
    return { retryable: true, errorClass: error.reason, retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof ZodError) {
    return { retryable: false, errorClass: 'INVALID_PAYLOAD' };
  }
  const code = codeOf(error);
  if (isConcurrencyFailure(error)) {
    return { retryable: true, errorClass: 'TRANSIENT_DATABASE' };
  }
  if (
    (error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientInitializationError) &&
    code !== undefined &&
    PRISMA_TRANSIENT_CODES.has(code)
  ) {
    return { retryable: true, errorClass: 'TRANSIENT_DATABASE' };
  }
  if (error instanceof Error && error.name === 'MaxRetriesPerRequestError') {
    return { retryable: true, errorClass: 'REDIS_UNAVAILABLE' };
  }
  if (code !== undefined && NETWORK_CODES.has(code)) {
    return { retryable: true, errorClass: 'NETWORK' };
  }
  if (error instanceof Error && /Connection is closed/i.test(error.message)) {
    return { retryable: true, errorClass: 'REDIS_UNAVAILABLE' };
  }
  if (error instanceof Error && /stalled more than/i.test(error.message)) {
    return { retryable: true, errorClass: 'WORKER_INTERRUPTED' };
  }
  return { retryable: true, errorClass: 'UNKNOWN_INTERNAL' };
}

const MAX_ERROR_LENGTH = 500;
const REDACTIONS: [RegExp, string][] = [
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted-url]'],
  [/\bBearer\s+\S+/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted-token]'],
];

/**
 * The text stored in `lastError`. Only errors thrown deliberately by consumers keep their message
 * (redacted and truncated); anything else is reduced to its type and code, because messages from
 * drivers and libraries can contain SQL, parameters or payload fragments. Never a stack trace.
 */
export function sanitizeError(error: unknown): string {
  if (error instanceof RetryableJobError || error instanceof NonRetryableJobError) {
    let text = error.message;
    for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
    return text.slice(0, MAX_ERROR_LENGTH);
  }
  const name = error instanceof Error ? error.name : typeof error;
  const code = codeOf(error);
  return (code === undefined ? name : `${name} (${code})`).slice(0, MAX_ERROR_LENGTH);
}
