import type { Db } from '../transaction.js';

export function findUserByEmail(db: Db, email: string) {
  return db.user.findUnique({ where: { email } });
}

export function findSessionWithUser(db: Db, sessionId: string) {
  return db.userSession.findUnique({ where: { id: sessionId }, include: { user: true } });
}

export function createSession(
  db: Db,
  data: {
    userId: string;
    refreshTokenHash: string;
    ip: string;
    userAgent: string | null;
    expiresIn: Date;
  },
) {
  const now = new Date();
  return db.userSession.create({
    data: {
      userId: data.userId,
      refreshTokenHash: data.refreshTokenHash,
      ip: data.ip,
      lastIp: data.ip,
      userAgent: data.userAgent,
      lastSeen: now,
      expiresIn: data.expiresIn,
    },
  });
}

/**
 * Rotates the session's refresh token only if it still holds `expectedHash`. Returns whether this
 * call won (a concurrent rotation of the same token leaves the loser with `false`).
 */
export async function rotateSession(
  db: Db,
  sessionId: string,
  expectedHash: string,
  data: { newHash: string; ip: string; expiresIn: Date },
): Promise<boolean> {
  const now = new Date();
  const result = await db.userSession.updateMany({
    where: { id: sessionId, refreshTokenHash: expectedHash, revoked: false },
    data: {
      lastRefreshHash: expectedHash,
      refreshTokenHash: data.newHash,
      lastSeen: now,
      lastIp: data.ip,
      expiresIn: data.expiresIn,
      updatedAt: now,
    },
  });
  return result.count === 1;
}
