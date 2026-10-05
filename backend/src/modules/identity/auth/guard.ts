import type { Request, RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../../../shared/errors/AppError.js';
import type { AuthContext, UserRole } from '../../../shared/types/auth-context.js';
import { verifyAccessToken } from './tokens.js';

const BEARER = /^Bearer (\S+)$/;

/** Gate 0: verifies the Bearer JWT (signature and expiry) and sets `req.auth`. No database read. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const match = BEARER.exec(req.header('authorization') ?? '');
  if (!match) throw new UnauthorizedError('Authentication required');
  req.auth = verifyAccessToken(match[1]);
  next();
};

/** The authenticated caller; throws `401` if `authenticate` did not run. */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw new UnauthorizedError('Authentication required');
  return req.auth;
}

/** Gate 1: the caller must hold one of `roles` (`403 FORBIDDEN_ROLE`). */
export function requireRoles(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!roles.includes(getAuth(req).role)) {
      throw new ForbiddenError('Role is not allowed to perform this action', 'FORBIDDEN_ROLE');
    }
    next();
  };
}

/** Rejects a caller without a team (`403 INVALID_ACTION`) and returns the caller's team id. */
export function requireTeam(auth: AuthContext): string {
  if (auth.teamId === null) {
    throw new ForbiddenError('Caller does not belong to a team', 'INVALID_ACTION');
  }
  return auth.teamId;
}

/** Gate 2: the resource must belong to the caller's team (`403 TEAM_ACCESS_DENIED`). */
export function assertSameTeam(auth: AuthContext, resourceTeamId: string | null): void {
  if (auth.teamId === null || resourceTeamId !== auth.teamId) {
    throw new ForbiddenError('Resource belongs to another team', 'TEAM_ACCESS_DENIED');
  }
}
