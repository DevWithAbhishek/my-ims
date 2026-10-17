import { Router } from 'express';
import { requireJsonBody } from '../../shared/middleware/json-body.js';
import { authenticate } from '../identity/index.js';
import { getIncidentHandler, listIncidentsHandler } from './incident.controller.js';
import {
  createPostmortemHandler,
  getPostmortemHandler,
  updatePostmortemHandler,
} from './postmortem/postmortem.controller.js';
import { getTimelineHandler } from './timeline/timeline.controller.js';
import { updateIncidentHandler } from './update/incident-update.controller.js';

/** Routes of the Incidents module, to be mounted at `/api/v1`. All roles may use them (team scoped). */
export function createIncidentsRouter(): Router {
  const router = Router();

  router.get('/incidents', authenticate, listIncidentsHandler);
  router.get('/incidents/:incidentId', authenticate, getIncidentHandler);
  router.get('/incidents/:incidentId/timeline', authenticate, getTimelineHandler);
  router.patch('/incidents/:incidentId', authenticate, requireJsonBody, updateIncidentHandler);

  router.get('/incidents/:incidentId/postmortem', authenticate, getPostmortemHandler);
  router.patch(
    '/incidents/:incidentId/postmortem',
    authenticate,
    requireJsonBody,
    updatePostmortemHandler,
  );
  router.post(
    '/incidents/:incidentId/postmortem',
    authenticate,
    requireJsonBody,
    createPostmortemHandler,
  );

  return router;
}
