import { Client } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
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

  it('adds the audit event types and the outbox lifecycle columns, enum and indexes', async () => {
    const client = new Client({ connectionString: withDatabase(testDatabaseUrl(), scratchName) });
    await client.connect();
    try {
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await applyMigrations(client);

      const audit = await client.query<{ enumlabel: string }>(
        `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'AuditEventType'`,
      );
      expect(audit.rows.map((r) => r.enumlabel)).toEqual(
        expect.arrayContaining([
          'USER_UPDATED',
          'USER_DEACTIVATED',
          'TEAM_UPDATED',
          'TEAM_DEACTIVATED',
          'SERVICE_UPDATED',
          'SERVICE_DEACTIVATED',
          'ESCALATION_POLICY_UPDATED',
          'ALERT_SOURCE_UPDATED',
        ]),
      );

      const status = await client.query<{ enumlabel: string }>(
        `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'OutboxStatus' ORDER BY e.enumsortorder`,
      );
      expect(status.rows.map((r) => r.enumlabel)).toEqual([
        'PENDING',
        'PROCESSING',
        'SUCCESS',
        'DEAD_LETTER',
      ]);

      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'OutboxEvent'`,
      );
      const names = columns.rows.map((r) => r.column_name);
      expect(names).toEqual(
        expect.arrayContaining([
          'publishAttemptCount',
          'executionAttemptCount',
          'publishedAt',
          'leaseExpiresAt',
          'errorClass',
          'lastError',
        ]),
      );
      expect(names).not.toContain('attemptCount');

      const indexes = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'OutboxEvent'`,
      );
      expect(indexes.rows.map((r) => r.indexname)).toEqual(
        expect.arrayContaining(['idx_outbox_claim', 'idx_outbox_retention']),
      );

      const lifecycle = await client.query<{ enumlabel: string }>(
        `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'LifecycleStates'`,
      );
      expect(lifecycle.rows.map((r) => r.enumlabel)).toContain('FAILED'); // shared enum untouched
    } finally {
      await client.end();
    }
  });

  it('converts existing outbox rows: FAILED becomes DEAD_LETTER and attempts carry over', async () => {
    const client = new Client({ connectionString: withDatabase(testDatabaseUrl(), scratchName) });
    await client.connect();
    try {
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      const dir = path.resolve(__dirname, '../../prisma/migrations');
      const init = readFileSync(path.join(dir, '20261003225123_init', 'migration.sql'), 'utf8');
      await client.query(init);

      const aggregate = '11111111-1111-4111-8111-111111111111';
      const insert = `INSERT INTO "OutboxEvent" ("id","eventType","aggregateType","aggregateId","payload","status","attemptCount")
        VALUES ($1,'LEGACY','Incident',$2,'{}'::jsonb,$3::"LifecycleStates",$4)`;
      await client.query(insert, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', aggregate, 'PENDING', 0]);
      await client.query(insert, ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', aggregate, 'SUCCESS', 1]);
      await client.query(insert, ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', aggregate, 'FAILED', 3]);

      // Apply everything after init, in order.

      const later = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name > '20261003225123_init')
        .map((e) => e.name)
        .sort();
      for (const name of later) {
        await client.query(readFileSync(path.join(dir, name, 'migration.sql'), 'utf8'));
      }

      const rows = await client.query<{
        id: string;
        status: string;
        executionAttemptCount: number;
        publishAttemptCount: number;
      }>(
        `SELECT "id","status"::text AS "status","executionAttemptCount","publishAttemptCount"
         FROM "OutboxEvent" ORDER BY "id"`,
      );
      expect(rows.rows).toEqual([
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'PENDING',
          executionAttemptCount: 0,
          publishAttemptCount: 0,
        },
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          status: 'SUCCESS',
          executionAttemptCount: 1,
          publishAttemptCount: 0,
        },
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          status: 'DEAD_LETTER',
          executionAttemptCount: 3,
          publishAttemptCount: 0,
        },
      ]);

      const def = await client.query<{ column_default: string }>(
        `SELECT column_default FROM information_schema.columns
         WHERE table_name = 'OutboxEvent' AND column_name = 'status'`,
      );
      expect(def.rows[0].column_default).toContain('PENDING');
    } finally {
      await client.end();
    }
  });
});
