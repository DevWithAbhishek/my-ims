import { Router } from 'express';
import { createAppServiceRouter } from './modules/appService/index.js';
import { createIdentityRouter } from './modules/identity/index.js';
import { createIncidentsRouter } from './modules/incidents/index.js';

/** Composes the module routers mounted at `/api/v1`. */
export function createApiRouter(): Router {
  const router = Router();
  router.use(createIdentityRouter());
  router.use(createAppServiceRouter());
  router.use(createIncidentsRouter());
  return router;
}
