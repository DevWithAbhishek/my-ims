import { Client } from 'pg';
import { applyMigrations } from '../helpers/migrations';
import { testDatabaseUrl, withDatabase } from '../helpers/test-env';

const scratchName = `ims_migrate_check_${Date.now()}`;
let admin: Client;

beforeAll(async () => {
  admin = new Client({ connectionString: withDatabase(testDatabaseUrl(), 'postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${scratchName}"`);
});

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS "${scratchName}"`);
  await admin.end();
});

describe('migrations', () => {
  it('apply cleanly to an empty database and create the full schema', async () => {
    const client = new Client({ connectionString: withDatabase(testDatabaseUrl(), scratchName) });
    await client.connect();
    try {
      const applied = await applyMigrations(client);
      expect(applied.length).toBeGreaterThan(0);

      const tables = await client.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(tables.rows.map((row) => row.tablename)).toEqual(
        expect.arrayContaining(['User', 'Incident', 'Alert', 'AlertSource', 'OutboxEvent']),
      );

      const indexes = await client.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining(['uq_alert_source_event_id', 'uq_alert_source_fingerprint']),
      );
    } finally {
      await client.end();
    }
  });
});
