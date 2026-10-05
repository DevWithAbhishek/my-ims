import type { Request, RequestHandler, Response } from 'express';
import { UnauthorizedError } from '../../../shared/errors/AppError.js';
import { parseOrThrow } from '../../../shared/errors/zod.js';
import { getAuth } from './guard.js';
import { loginBodySchema } from './auth.schema.js';
import * as authService from './auth.service.js';
import { clearedRefreshCookieHeader, readRefreshCookie, refreshCookieHeader } from './tokens.js';

function clientInfo(req: Request): authService.ClientInfo {
  return {
    ip: req.ip ?? 'unknown',
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
  };
}

function sendTokens(res: Response, tokens: authService.IssuedTokens): void {
  res.setHeader('Authorization', `Bearer ${tokens.accessToken}`);
  res.setHeader(
    'Set-Cookie',
    refreshCookieHeader(tokens.refreshToken, tokens.refreshMaxAgeSeconds),
  );
  res.status(200).json({ data: { tokenType: 'Bearer', expiresIn: tokens.expiresIn } });
}

export const loginHandler: RequestHandler = async (req, res) => {
  const body = parseOrThrow(loginBodySchema, req.body);
  sendTokens(res, await authService.login(body, clientInfo(req)));
};

export const refreshHandler: RequestHandler = async (req, res) => {
  const cookie = readRefreshCookie(req.get('cookie'));
  if (!cookie) throw new UnauthorizedError('Refresh token is missing', 'INVALID_REQUEST');
  sendTokens(res, await authService.refresh(cookie, clientInfo(req)));
};

function sendLoggedOut(res: Response): void {
  res.setHeader('Set-Cookie', clearedRefreshCookieHeader());
  res.status(200).json({ data: { message: 'Logged out successfully' } });
}

export const logoutHandler: RequestHandler = async (req, res) => {
  const auth = getAuth(req);
  await authService.logout(auth.userId, auth.sessionId);
  sendLoggedOut(res);
};

export const logoutAllHandler: RequestHandler = async (req, res) => {
  await authService.logoutAll(getAuth(req).userId);
  sendLoggedOut(res);
};
