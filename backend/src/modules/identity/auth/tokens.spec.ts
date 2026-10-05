import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = 'postgresql://u:p@localhost:5432/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.JWT_SECRET = 'unit-test-secret';

import {
  buildRefreshToken,
  clearedRefreshCookieHeader,
  durationToSeconds,
  generateRefreshSecret,
  hashesMatch,
  hashRefreshSecret,
  parseRefreshToken,
  readRefreshCookie,
  refreshCookieHeader,
  refreshTokenSeconds,
  signAccessToken,
  verifyAccessToken,
} from './tokens.js';

const claims = {
  userId: randomUUID(),
  email: 'a@example.com',
  role: 'ENGINEER' as const,
  teamId: randomUUID(),
  sessionId: randomUUID(),
};

describe('durationToSeconds', () => {
  it.each([
    ['30s', 30],
    ['15m', 900],
    ['2h', 7200],
    ['7d', 604800],
  ])('%s → %i', (input, expected) => {
    expect(durationToSeconds(input)).toBe(expected);
  });

  it('rejects malformed durations', () => {
    expect(() => durationToSeconds('15')).toThrow();
  });

  it('defaults the refresh token to 7 days', () => {
    expect(refreshTokenSeconds()).toBe(604800);
  });
});

describe('access token', () => {
  it('carries the documented claims and a 15 minute lifetime', () => {
    const { token, expiresIn } = signAccessToken(claims);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(expiresIn).toBe(900);
    expect(decoded).toMatchObject(claims);
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(900);
    expect(verifyAccessToken(token)).toEqual(claims);
  });

  it('keeps a null teamId', () => {
    const { token } = signAccessToken({ ...claims, teamId: null });
    expect(verifyAccessToken(token).teamId).toBeNull();
  });

  it('rejects a wrong signature, an expired token, alg none and missing claims', () => {
    const wrongSecret = jwt.sign(claims, 'other-secret');
    const expired = jwt.sign(claims, 'unit-test-secret', { expiresIn: -10 });
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      JSON.stringify(claims),
    ).toString('base64url')}.`;
    const incomplete = jwt.sign({ userId: claims.userId }, 'unit-test-secret');
    for (const token of [wrongSecret, expired, none, incomplete, 'garbage']) {
      expect(() => verifyAccessToken(token)).toThrow(
        expect.objectContaining({ statusCode: 401, code: 'UNAUTHENTICATED' }),
      );
    }
  });
});

describe('refresh token', () => {
  it('round-trips session id, email and secret', () => {
    const secret = generateRefreshSecret();
    const value = buildRefreshToken(claims.sessionId, 'Mixed@Example.com', secret);
    expect(parseRefreshToken(value)).toEqual({
      sessionId: claims.sessionId,
      email: 'mixed@example.com',
      secret,
    });
  });

  it('generates distinct high-entropy secrets', () => {
    expect(generateRefreshSecret()).not.toBe(generateRefreshSecret());
    expect(generateRefreshSecret().length).toBeGreaterThanOrEqual(43);
  });

  it.each(['', 'a.b', 'not-a-uuid.YQ.secret', `${randomUUID()}.YQ.`, `${randomUUID()}.YQ.s.extra`])(
    'rejects malformed value %p',
    (value) => {
      expect(parseRefreshToken(value)).toBeNull();
    },
  );

  it('hashes deterministically and never returns the secret', () => {
    const secret = generateRefreshSecret();
    expect(hashRefreshSecret(secret)).toBe(hashRefreshSecret(secret));
    expect(hashRefreshSecret(secret)).not.toContain(secret);
    expect(hashRefreshSecret(secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('compares hashes safely', () => {
    const hash = hashRefreshSecret('x');
    expect(hashesMatch(hash, hash)).toBe(true);
    expect(hashesMatch(hash, hashRefreshSecret('y'))).toBe(false);
    expect(hashesMatch(null, hash)).toBe(false);
    expect(hashesMatch('short', hash)).toBe(false);
  });
});

describe('refresh cookie', () => {
  it('sets exactly the documented attributes', () => {
    expect(refreshCookieHeader('v', 604800)).toBe(
      'ims_refresh_cookie=v; Max-Age=604800; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('clears the cookie on the same path', () => {
    expect(clearedRefreshCookieHeader()).toBe(
      'ims_refresh_cookie=; Max-Age=0; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('reads the cookie among others and ignores an empty value', () => {
    expect(readRefreshCookie('a=1; ims_refresh_cookie=abc.def; b=2')).toBe('abc.def');
    expect(readRefreshCookie('ims_refresh_cookie=')).toBeUndefined();
    expect(readRefreshCookie('other=1')).toBeUndefined();
    expect(readRefreshCookie(undefined)).toBeUndefined();
  });
});
