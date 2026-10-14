import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { getPrisma } from '../../src/infra/db/prisma';
import { computeSignature } from '../../src/modules/alerts/signature';

export const SIGNING_SECRET = 'integration-signing-secret-0123456789';
export const SEVERITY_MAPPING = { critical: 'P0', high: 'P1', warning: 'P2', info: 'P3' };

export async function createAlertSource(
  overrides: {
    id?: string;
    name?: string;
    status?: 'ACTIVE' | 'DEACTIVATED';
    signingSecret?: string;
  } = {},
) {
  return getPrisma().alertSource.create({
    data: {
      ...(overrides.id ? { id: overrides.id } : {}),
      name: overrides.name ?? 'Test source',
      sourceType: 'GENERIC',
      status: overrides.status ?? 'ACTIVE',
      configuration: {
        signingSecret: overrides.signingSecret ?? SIGNING_SECRET,
        severityMapping: SEVERITY_MAPPING,
      },
    },
  });
}

/** `n` distinct alerts; the nonce keeps every request's signature unique. */
export function makeAlerts(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `alert-${i}`,
    environment: 'production',
    nonce: randomUUID(),
  }));
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export function signBody(body: string | Buffer, timestamp: number, secret = SIGNING_SECRET) {
  const raw = typeof body === 'string' ? Buffer.from(body) : body;
  return `sha256=${computeSignature(secret, String(timestamp), raw).toString('hex')}`;
}

export type SendOptions = {
  secret?: string;
  timestamp?: number;
  /** Sent instead of `{ alerts }` (the signature still covers it unless `signedBody` is given). */
  body?: string | Buffer;
  /** What the signature is computed over, when it differs from what is sent (tampering). */
  signedBody?: string | Buffer;
  contentType?: string | null;
  headers?: Record<string, string | null>;
  requestId?: string;
};

/** Signs and posts a webhook request like a well-behaved source would. */
export function postWebhook(
  app: Express,
  alertSourceId: string,
  alerts: unknown,
  options: SendOptions = {},
) {
  const body = options.body ?? JSON.stringify({ alerts });
  const timestamp = options.timestamp ?? nowSeconds();
  const signature = signBody(options.signedBody ?? body, timestamp, options.secret);

  const req = request(app).post(`/webhooks/alerts/${alertSourceId}`);
  if (options.contentType !== null)
    req.set('Content-Type', options.contentType ?? 'application/json');
  req.set('X-Signature', signature).set('X-Timestamp', String(timestamp));
  if (options.requestId) req.set('X-Request-Id', options.requestId);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) req.unset(name);
    else req.set(name, value);
  }
  return req.send(body);
}

/** The error response without the per-request id, for comparing responses. */
export function withoutRequestId(body: { error: Record<string, unknown> }) {
  return Object.fromEntries(Object.entries(body.error).filter(([key]) => key !== 'requestId'));
}
