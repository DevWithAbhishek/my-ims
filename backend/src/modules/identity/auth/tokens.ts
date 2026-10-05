import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { getConfig } from '../../../config/env.js';
import { UnauthorizedError } from '../../../shared/errors/AppError.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';

export const REFRESH_COOKIE_NAME = 'ims_refresh_cookie';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

const UNITS_IN_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

/** Converts a configured duration such as `15m` or `7d` to seconds. */
export function durationToSeconds(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) throw new Error('Invalid duration');
  return Number(match[1]) * UNITS_IN_SECONDS[match[2] as keyof typeof UNITS_IN_SECONDS];
}

export function refreshTokenSeconds(): number {
  return durationToSeconds(getConfig().refreshTokenExpiry);
}

const accessClaimsSchema = z.object({
  userId: z.uuid(),
  email: z.string().min(1),
  role: z.enum(['ENGINEER', 'TEAM_LEAD', 'ADMIN']),
  teamId: z.uuid().nullable(),
  sessionId: z.uuid(),
});

export function signAccessToken(claims: AuthContext): { token: string; expiresIn: number } {
  const { jwtSecret, accessTokenExpiry } = getConfig();
  const expiresIn = durationToSeconds(accessTokenExpiry);
  const token = jwt.sign({ ...claims }, jwtSecret, { algorithm: 'HS256', expiresIn });
  return { token, expiresIn };
}

/** Verifies signature and expiry only; never touches the database. */
export function verifyAccessToken(token: string): AuthContext {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, getConfig().jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }
  const claims = accessClaimsSchema.safeParse(decoded);
  if (!claims.success) throw new UnauthorizedError('Invalid or expired access token');
  return claims.data;
}

export type ParsedRefreshToken = { sessionId: string; email: string; secret: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SECRET_LENGTH = 128;

export function generateRefreshSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The cookie value: `<sessionId>.<base64url(email)>.<secret>`. Only the secret is stored (hashed).
 * The email is client-visible context for rate limiting; it is never trusted for authorization.
 */
export function buildRefreshToken(sessionId: string, email: string, secret: string): string {
  return `${sessionId}.${Buffer.from(email, 'utf8').toString('base64url')}.${secret}`;
}

export function parseRefreshToken(value: string): ParsedRefreshToken | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [sessionId, encodedEmail, secret] = parts;
  if (!UUID.test(sessionId) || secret.length === 0 || secret.length > MAX_SECRET_LENGTH) {
    return null;
  }
  const email = Buffer.from(encodedEmail, 'base64url').toString('utf8').toLowerCase();
  return { sessionId, email, secret };
}

export function hashRefreshSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function hashesMatch(stored: string | null | undefined, candidate: string): boolean {
  if (!stored) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

const COOKIE_ATTRIBUTES = `Path=${REFRESH_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`;

export function refreshCookieHeader(value: string, maxAgeSeconds: number): string {
  return `${REFRESH_COOKIE_NAME}=${value}; Max-Age=${maxAgeSeconds}; ${COOKIE_ATTRIBUTES}`;
}

export function clearedRefreshCookieHeader(): string {
  return `${REFRESH_COOKIE_NAME}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}

export function readRefreshCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === REFRESH_COOKIE_NAME) {
      const value = pair.slice(index + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}
