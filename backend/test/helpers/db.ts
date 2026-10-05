import { getPrisma } from '../../src/infra/db/prisma';
import { assertTestDatabase, testDatabaseUrl } from './test-env';

/** Empties every application table. Use between tests that write data. */
export async function resetDatabase(): Promise<void> {
  assertTestDatabase(testDatabaseUrl());
  const tables = await getPrisma().$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;

  const list = tables.map(({ tablename }) => `"${tablename}"`).join(', ');
  await getPrisma().$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
