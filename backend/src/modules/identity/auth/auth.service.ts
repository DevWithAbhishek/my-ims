import { ForbiddenError, UnauthorizedError } from '../../../shared/errors/AppError.js';
import { runIdentityTransaction } from '../transaction.js';
import {
  createSession,
  findSessionWithUser,
  findUserByEmail,
  rotateSession,
} from './auth.repository.js';
import { verifyPasswordOrDummy } from './password.js';
import { consumeRateLimit, resetRateLimit } from './rate-limit.js';
import { revokeSession, revokeSessionsForUsers } from './session.repository.js';
import {
  buildRefreshToken,
  generateRefreshSecret,
  hashesMatch,
  hashRefreshSecret,
  parseRefreshToken,
  refreshTokenSeconds,
  signAccessToken,
} from './tokens.js';
import { getPrisma } from '../../../infra/db/prisma.js';

export type ClientInfo = { ip: string; userAgent: string | null };

export type IssuedTokens = {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshMaxAgeSeconds: number;
};

function accountDeactivated(): ForbiddenError {
  return new ForbiddenError('Account is deactivated', 'ACCOUNT_DEACTIVATED');
}

function invalidRefreshToken(): UnauthorizedError {
  return new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
}

export async function login(
  input: { email: string; password: string },
  client: ClientInfo,
): Promise<IssuedTokens> {
  const { email, password } = input;
  await consumeRateLimit('login', client.ip, [email]);

  const user = await findUserByEmail(getPrisma(), email);
  const passwordValid = await verifyPasswordOrDummy(user?.passwordHash, password);
  if (!user || !passwordValid) {
    throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (user.status === 'DEACTIVATED') throw accountDeactivated();

  const refreshMaxAgeSeconds = refreshTokenSeconds();
  const secret = generateRefreshSecret();
  const session = await createSession(getPrisma(), {
    userId: user.id,
    refreshTokenHash: hashRefreshSecret(secret),
    ip: client.ip,
    userAgent: client.userAgent,
    expiresIn: new Date(Date.now() + refreshMaxAgeSeconds * 1000),
  });

  await resetRateLimit('login', client.ip, [email]);

  const access = signAccessToken({
    userId: user.id,
    email: user.email,
    role: user.role,
    teamId: user.teamId,
    sessionId: session.id,
  });
  return {
    accessToken: access.token,
    expiresIn: access.expiresIn,
    refreshToken: buildRefreshToken(session.id, user.email, secret),
    refreshMaxAgeSeconds,
  };
}

type RefreshOutcome =
  | { kind: 'ok'; tokens: IssuedTokens }
  | { kind: 'invalid' }
  | { kind: 'reuse' }
  | { kind: 'deactivated' };

export async function refresh(cookieValue: string, client: ClientInfo): Promise<IssuedTokens> {
  const parsed = parseRefreshToken(cookieValue);
  await consumeRateLimit('refresh', client.ip, [parsed?.email ?? '', parsed?.sessionId ?? '']);
  if (!parsed) throw invalidRefreshToken();

  const presentedHash = hashRefreshSecret(parsed.secret);
  const refreshMaxAgeSeconds = refreshTokenSeconds();

  // Reuse must revoke every session and still report 401, so the outcome is returned from the
  // transaction (committing the revocation) and the error is thrown afterwards.
  const outcome = await runIdentityTransaction<RefreshOutcome>(async (tx) => {
    const session = await findSessionWithUser(tx, parsed.sessionId);
    if (!session || session.revoked || session.expiresIn.getTime() <= Date.now()) {
      return { kind: 'invalid' };
    }
    if (hashesMatch(session.lastRefreshHash, presentedHash)) {
      await revokeSessionsForUsers(tx, [session.userId]);
      return { kind: 'reuse' };
    }
    if (!hashesMatch(session.refreshTokenHash, presentedHash)) return { kind: 'invalid' };
    if (session.user.status === 'DEACTIVATED') return { kind: 'deactivated' };

    const secret = generateRefreshSecret();
    const rotated = await rotateSession(tx, session.id, session.refreshTokenHash, {
      newHash: hashRefreshSecret(secret),
      ip: client.ip,
      expiresIn: new Date(Date.now() + refreshMaxAgeSeconds * 1000),
    });
    if (!rotated) {
      // A concurrent request already rotated this token: this one is a reuse.
      await revokeSessionsForUsers(tx, [session.userId]);
      return { kind: 'reuse' };
    }

    const { user } = session;
    const access = signAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      teamId: user.teamId,
      sessionId: session.id,
    });
    return {
      kind: 'ok',
      tokens: {
        accessToken: access.token,
        expiresIn: access.expiresIn,
        refreshToken: buildRefreshToken(session.id, user.email, secret),
        refreshMaxAgeSeconds,
      },
    };
  });

  if (outcome.kind === 'deactivated') throw accountDeactivated();
  if (outcome.kind !== 'ok') throw invalidRefreshToken();

  await resetRateLimit('refresh', client.ip, [parsed.email, parsed.sessionId]);
  return outcome.tokens;
}

export async function logout(userId: string, sessionId: string): Promise<void> {
  await revokeSession(getPrisma(), sessionId, userId);
}

export async function logoutAll(userId: string): Promise<void> {
  await revokeSessionsForUsers(getPrisma(), [userId]);
}
