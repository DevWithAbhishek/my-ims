import { BadRequestError, ValidationError } from '../../shared/errors/AppError.js';
import { WEBHOOK } from './webhook.config.js';

export type ParsedBody = { ok: true; value: unknown } | { ok: false };

export function parseJsonBody(rawBody: Buffer): ParsedBody {
  try {
    return { ok: true, value: JSON.parse(rawBody.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The number of alerts to count against the rate limit; `0` when there is nothing to count. */
export function countAlerts(body: ParsedBody): number {
  if (!body.ok || !isPlainObject(body.value)) return 0;
  const { alerts } = body.value;
  return Array.isArray(alerts) ? alerts.length : 0;
}

function isJsonContentType(contentType: string): boolean {
  return contentType.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

function invalid(field: string, issue: string): ValidationError {
  return new ValidationError('Request validation failed', 'VALIDATION_FAILED', [{ field, issue }]);
}

/**
 * Step 6: the envelope `{ "alerts": [...] }`. A missing or non-JSON `Content-Type`, an unknown
 * top-level field or more than 100 alerts is `400 BAD_REQUEST`; malformed JSON and a missing,
 * non-array or empty `alerts` is `422 VALIDATION_FAILED`. Returns the alerts in request order.
 */
export function validateEnvelope(contentType: string | undefined, body: ParsedBody): unknown[] {
  if (contentType === undefined || contentType.trim() === '') {
    throw new BadRequestError('Content-Type header is required');
  }
  if (!isJsonContentType(contentType)) {
    throw new BadRequestError('Content-Type must be application/json');
  }
  if (!body.ok) throw invalid('body', 'Body is not valid JSON');
  if (!isPlainObject(body.value)) throw invalid('body', 'Body must be a JSON object');

  const unknownFields = Object.keys(body.value).filter((key) => key !== 'alerts');
  if (unknownFields.length > 0) {
    throw new BadRequestError(
      'Request contains unknown fields',
      'BAD_REQUEST',
      unknownFields.map((field) => ({ field, issue: 'Unknown field' })),
    );
  }

  const { alerts } = body.value;
  if (alerts === undefined) throw invalid('alerts', 'Required');
  if (!Array.isArray(alerts)) throw invalid('alerts', 'Must be an array');
  if (alerts.length === 0) throw invalid('alerts', 'Must contain at least one alert');
  if (alerts.length > WEBHOOK.maxAlertsPerRequest) {
    throw new BadRequestError('Too many alerts in one request', 'BAD_REQUEST', [
      { field: 'alerts', issue: `At most ${WEBHOOK.maxAlertsPerRequest} alerts per request` },
    ]);
  }
  return alerts as unknown[];
}
