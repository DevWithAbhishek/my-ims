import { Router } from 'express';
import { createIdentityRouter } from './modules/identity/index.js';

/** Composes the module routers mounted at `/api/v1`. */
export function createApiRouter(): Router {
  const router = Router();
  router.use(createIdentityRouter());
  return router;
}
