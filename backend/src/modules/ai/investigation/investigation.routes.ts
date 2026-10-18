import { Router } from 'express';
import { authenticate } from '../../identity/index.js';
import { createInvestigationHandlers } from './investigation.controller.js';
import { createInvestigationRateLimiter } from './investigation.rate-limit.js';
import type { InvestigationServiceDeps } from './investigation.service.js';

/** N1–N3 under `/api/v1`. All roles; team scoped by the caller's token. */
export function createAiRouter(overrides: Partial<InvestigationServiceDeps> = {}): Router {
  const handlers = createInvestigationHandlers({
    limiter: createInvestigationRateLimiter(),
    ...overrides,
  });
  const router = Router();
  router.post('/incidents/:incidentId/investigations', authenticate, handlers.request);
  router.get('/incidents/:incidentId/investigations', authenticate, handlers.list);
  router.get('/incidents/:incidentId/investigations/:investigationId', authenticate, handlers.get);
  return router;
}
