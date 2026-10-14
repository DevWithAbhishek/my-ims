import { Router } from 'express';
import { authenticate } from '../identity/index.js';
import { getAlertHandler } from './alert.controller.js';

/** Routes of the Alerts module under `/api/v1` (the webhook is mounted separately). All roles. */
export function createAlertsRouter(): Router {
  const router = Router();
  router.get('/incidents/:incidentId/alerts/:alertId', authenticate, getAlertHandler);
  return router;
}
