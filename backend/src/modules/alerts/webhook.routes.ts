import { Router } from 'express';
import { writeBlockedNotice } from './admin-notice.js';
import { ingestNotImplemented } from './ingest.placeholder.js';
import { createRateLimiter } from './rate-limiter.js';
import { captureRawBody } from './raw-body.js';
import { createReplayStore } from './replay.store.js';
import { findAlertSourceById } from './source.repository.js';
import { createWebhookHandler, type WebhookDeps } from './webhook.controller.js';

/**
 * `POST /webhooks/alerts/:alertSourceId` (W1). Mounted at the application root, before the JSON
 * body parser: the signature covers the raw bytes and the body limit is 1 MB. `overrides` replace
 * individual collaborators (SLICE-04's ingestion, test doubles).
 */
export function createWebhookRouter(overrides: Partial<WebhookDeps> = {}): Router {
  const deps: WebhookDeps = {
    findSource: findAlertSourceById,
    replayStore: createReplayStore(),
    rateLimiter: createRateLimiter(),
    notifyBlocked: writeBlockedNotice,
    ingest: ingestNotImplemented,
    now: Date.now,
    ...overrides,
  };

  const router = Router();
  router.post('/webhooks/alerts/:alertSourceId', captureRawBody(), createWebhookHandler(deps));
  return router;
}
