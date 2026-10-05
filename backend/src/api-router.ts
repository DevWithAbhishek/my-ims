import { Router } from 'express';
import { createAppServiceRouter } from './modules/appService/index.js';
import { createIdentityRouter } from './modules/identity/index.js';

/** Composes the module routers mounted at `/api/v1`. */
export function createApiRouter(): Router {
  const router = Router();
  router.use(createIdentityRouter());
  router.use(createAppServiceRouter());
  return router;
}
