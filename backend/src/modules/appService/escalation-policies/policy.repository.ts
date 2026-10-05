import { Prisma } from '../../../generated/prisma/client.js';
import type { Db } from '../transaction.js';
import type { PolicyUserFacts } from '../policy-users.rules.js';

export function insertPolicy(
  db: Db,
  data: { level1Id: string; level2Id: string; level3Id: string; fallbackAdminId: string },
) {
  return db.escalationPolicy.create({ data });
}

export function findPolicyById(db: Db, id: string) {
  return db.escalationPolicy.findUnique({ where: { id } });
}

/** A policy with the id of the service it is attached to (`null` when orphaned). */
export function findPolicyWithOwner(db: Db, id: string) {
  return db.escalationPolicy.findUnique({
    where: { id },
    include: { appService: { select: { id: true } } },
  });
}

export function findPolicyByServiceId(db: Db, serviceId: string) {
  return db.escalationPolicy.findFirst({ where: { appService: { id: serviceId } } });
}

export function updatePolicy(
  db: Db,
  id: string,
  data: { level1Id?: string; level2Id?: string; level3Id?: string; fallbackAdminId?: string },
) {
  return db.escalationPolicy.update({ where: { id }, data: { ...data, updatedAt: new Date() } });
}

/**
 * Reads the given users under `FOR SHARE` (sorted by id), so a concurrent role, status or team
 * change of one of them waits for this transaction. Unknown ids are absent from the result.
 */
export async function lockUsersForShare(
  db: Db,
  userIds: string[],
): Promise<Map<string, PolicyUserFacts>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const rows = await db.$queryRaw<
    {
      id: string;
      role: PolicyUserFacts['role'];
      status: PolicyUserFacts['status'];
      teamId: string | null;
    }[]
  >(
    Prisma.sql`SELECT "id", "role"::text AS "role", "status"::text AS "status", "teamId"
      FROM "User" WHERE "id" = ANY(${unique}::uuid[]) ORDER BY "id" FOR SHARE`,
  );
  return new Map(rows.map(({ id, ...facts }) => [id, facts]));
}
