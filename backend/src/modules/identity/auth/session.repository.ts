import type { Db } from '../transaction.js';

/** Revokes every non-revoked session of the given users. */
export async function revokeSessionsForUsers(db: Db, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await db.userSession.updateMany({
    where: { userId: { in: userIds }, revoked: false },
    data: { revoked: true, updatedAt: new Date() },
  });
}

export async function revokeSession(db: Db, sessionId: string, userId: string): Promise<void> {
  await db.userSession.updateMany({
    where: { id: sessionId, userId, revoked: false },
    data: { revoked: true, updatedAt: new Date() },
  });
}
