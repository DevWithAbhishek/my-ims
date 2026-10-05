import { Client } from 'pg';
import { applyMigrations } from './migrations';
import { assertTestDatabase, databaseName, testDatabaseUrl, withDatabase } from './test-env';

/** Drops and recreates the test database's schema, then applies all migrations. */
export async function prepareTestDatabase(): Promise<void> {
  const url = testDatabaseUrl();
  assertTestDatabase(url);

  const admin = new Client({ connectionString: withDatabase(url, 'postgres') });
  await admin.connect();
  try {
    const name = databaseName(url);
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await admin.end();
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}
