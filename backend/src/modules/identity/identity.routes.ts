import { Router } from 'express';
import { requireJsonBody } from '../../shared/middleware/json-body.js';
import {
  loginHandler,
  logoutAllHandler,
  logoutHandler,
  refreshHandler,
} from './auth/auth.controller.js';
import { authenticate, requireRoles } from './auth/guard.js';
import {
  createTeamHandler,
  getTeamHandler,
  listTeamsHandler,
  updateTeamHandler,
} from './teams/team.controller.js';
import {
  createUserHandler,
  getUserHandler,
  listTeamUsersHandler,
  updateUserHandler,
} from './users/user.controller.js';

/** Routes of the identity module, to be mounted at `/api/v1`. */
export function createIdentityRouter(): Router {
  const router = Router();

  router.post('/auth/login', requireJsonBody, loginHandler);
  router.post('/auth/refresh', refreshHandler);
  router.post('/auth/logout', authenticate, logoutHandler);
  router.post('/auth/logout-all', authenticate, logoutAllHandler);

  router.post(
    '/identity/teams',
    authenticate,
    requireRoles('ADMIN'),
    requireJsonBody,
    createTeamHandler,
  );
  router.get('/identity/teams', authenticate, requireRoles('ADMIN'), listTeamsHandler);
  router.get('/identity/teams/:teamId', authenticate, getTeamHandler);
  router.patch(
    '/identity/teams/:teamId',
    authenticate,
    requireRoles('ADMIN'),
    requireJsonBody,
    updateTeamHandler,
  );

  router.post(
    '/identity/users',
    authenticate,
    requireRoles('ADMIN'),
    requireJsonBody,
    createUserHandler,
  );
  router.get(
    '/identity/teams/:teamId/users',
    authenticate,
    requireRoles('ADMIN', 'TEAM_LEAD'),
    listTeamUsersHandler,
  );
  router.get(
    '/identity/users/:userId',
    authenticate,
    requireRoles('ADMIN', 'TEAM_LEAD'),
    getUserHandler,
  );
  router.patch(
    '/identity/users/:userId',
    authenticate,
    requireRoles('ADMIN'),
    requireJsonBody,
    updateUserHandler,
  );

  return router;
}
