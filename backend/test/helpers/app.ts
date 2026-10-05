import type { Express } from 'express';
import { createApiRouter } from '../../src/api-router';
import { createApp } from '../../src/app';
import { buildReadinessChecks } from '../../src/infra/readiness';
import type { ReadinessCheck } from '../../src/shared/http/health';

/** The real application wired to the real PostgreSQL and Redis from the test environment. */
export function buildTestApp(readinessChecks: ReadinessCheck[] = buildReadinessChecks()): Express {
  return createApp({ readinessChecks, apiRouter: createApiRouter() });
}
