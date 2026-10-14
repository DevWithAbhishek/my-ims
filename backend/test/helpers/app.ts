import type { Express } from 'express';
import { createApiRouter } from '../../src/api-router';
import { createApp } from '../../src/app';
import { buildReadinessChecks } from '../../src/infra/readiness';
import { createWebhookRouter, type WebhookDeps } from '../../src/modules/alerts';
import type { ReadinessCheck } from '../../src/shared/http/health';

/**
 * The real application wired to the real PostgreSQL and Redis from the test environment.
 * `webhook` replaces individual collaborators of the alert webhook (ingestion, clock, Redis stores).
 */
export function buildTestApp(
  readinessChecks: ReadinessCheck[] = buildReadinessChecks(),
  webhook: Partial<WebhookDeps> = {},
): Express {
  return createApp({
    readinessChecks,
    apiRouter: createApiRouter(),
    webhookRouter: createWebhookRouter(webhook),
  });
}
