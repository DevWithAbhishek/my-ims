import { Router } from 'express';
import { requireJsonBody } from '../../shared/middleware/json-body.js';
import { authenticate, requireRoles } from '../identity/index.js';
import {
  createPolicyHandler,
  getPolicyHandler,
  updatePolicyHandler,
} from './escalation-policies/policy.controller.js';
import {
  createServiceHandler,
  getServiceHandler,
  listServicesHandler,
  updateServiceHandler,
} from './services/service.controller.js';

/** Routes of the AppService module, to be mounted at `/api/v1`. */
export function createAppServiceRouter(): Router {
  const router = Router();

  router.post(
    '/services',
    authenticate,
    requireRoles('ADMIN'),
    requireJsonBody,
    createServiceHandler,
  );
  router.get('/services', authenticate, listServicesHandler);
  router.get('/services/:serviceId', authenticate, getServiceHandler);
  router.patch(
    '/services/:serviceId',
    authenticate,
    requireRoles('ADMIN'),
    requireJsonBody,
    updateServiceHandler,
  );

  router.post(
    '/services/:serviceId/escalation-policies',
    authenticate,
    requireRoles('ADMIN'),
    requireJsonBody,
    createPolicyHandler,
  );
  router.get(
    '/services/:serviceId/escalation-policies/:escalationPolicyId',
    authenticate,
    requireRoles('ADMIN', 'TEAM_LEAD'),
    getPolicyHandler,
  );
  router.patch(
    '/services/:serviceId/escalation-policies/:escalationPolicyId',
    authenticate,
    requireRoles('ADMIN'),
    requireJsonBody,
    updatePolicyHandler,
  );

  return router;
}
