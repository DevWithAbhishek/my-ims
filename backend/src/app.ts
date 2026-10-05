import express, { Router, type Express } from 'express';
import { createHealthRouter, type ReadinessCheck } from './shared/http/health.js';
import { errorMappingMiddleware } from './shared/middleware/error-mapping.js';
import { requestMiddleware } from './shared/middleware/request-ids.js';
import { httpLogger } from './shared/observability/http-logger.js';

export const JSON_BODY_LIMIT = '100kb';

export type AppOptions = {
  readinessChecks: ReadinessCheck[];
  /** Router mounted at `/api/v1`; feature slices register their routes on it. */
  apiRouter?: Router;
};

export function createApp({ readinessChecks, apiRouter = Router() }: AppOptions): Express {
  const app = express();

  app.use(requestMiddleware);
  app.use(httpLogger);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(createHealthRouter(readinessChecks));
  app.use('/api/v1', apiRouter);

  app.use(errorMappingMiddleware);

  return app;
}
