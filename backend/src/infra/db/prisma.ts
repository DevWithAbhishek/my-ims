import { PrismaPg } from '@prisma/adapter-pg';
import { getConfig } from '../../config/env.js';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';

export type TransactionClient = Prisma.TransactionClient;

/** Small per-process pool (API and worker each get their own). */
export const DB_POOL_MAX = 10;
const DB_CONNECTION_TIMEOUT_MS = 5000;

let client: PrismaClient | undefined;

/**
 * The process-wide Prisma client. TLS follows the `sslmode` parameter of `DATABASE_URL`
 * (interpreted by `pg`).
 */
export function getPrisma(): PrismaClient {
  if (!client) {
    const adapter = new PrismaPg({
      connectionString: getConfig().databaseUrl,
      max: DB_POOL_MAX,
      connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
    });
    client = new PrismaClient({ adapter });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    const current = client;
    client = undefined;
    await current.$disconnect();
  }
}

export async function pingDatabase(): Promise<void> {
  await getPrisma().$queryRaw`SELECT 1`;
}

export function runInTransaction<T>(
  work: (tx: TransactionClient) => Promise<T>,
  options?: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  },
): Promise<T> {
  return getPrisma().$transaction(work, options);
}

const MODEL_NAMES: readonly string[] = Object.values(Prisma.ModelName);

/**
 * `SELECT … FOR UPDATE` on one row by id, inside a transaction. Returns whether the row exists.
 * Callers must re-check state after the lock is held.
 */
export async function lockRowForUpdate(
  tx: TransactionClient,
  model: Prisma.ModelName,
  id: string,
): Promise<boolean> {
  if (!MODEL_NAMES.includes(model)) {
    throw new Error(`Unknown model: ${String(model)}`);
  }
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${model}"`)} WHERE "id" = ${id}::uuid FOR UPDATE`,
  );
  return rows.length > 0;
}
