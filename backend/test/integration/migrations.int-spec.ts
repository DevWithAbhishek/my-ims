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
      const names = indexes.rows.map((row) => row.indexname);
      // SLICE-04: identity may repeat across incidents, so these are lookup indexes, not unique.
      expect(names).toEqual(
        expect.arrayContaining([
          'idx_alert_sourceId_sourceEventId',
          'idx_alert_sourceId_fingerprint',
        ]),
      );
      expect(names).not.toContain('uq_alert_source_event_id');
      expect(names).not.toContain('uq_alert_source_fingerprint');

      const unique = await client.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND indexname LIKE 'idx_alert_sourceId_%'`,
      );
      expect(unique.rows).toHaveLength(2);
      for (const row of unique.rows) expect(row.indexdef).not.toMatch(/UNIQUE/i);
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
  it('creates the Notification delivery enum and eventType on an empty database', async () => {
    const client = new Client({ connectionString: withDatabase(testDatabaseUrl(), scratchName) });
    await client.connect();
    try {
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await applyMigrations(client);

      const status = await client.query<{ enumlabel: string }>(
        `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'NotificationDeliveryStatus' ORDER BY e.enumsortorder`,
      );
      expect(status.rows.map((r) => r.enumlabel)).toEqual([
        'REQUESTED',
        'RUNNING',
        'COMPLETED',
        'FAILED',
      ]);

      const columns = await client.query<{
        column_name: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'Notification'`,
      );
      const byName = Object.fromEntries(columns.rows.map((r) => [r.column_name, r]));
      expect(byName.deliveryStatus.udt_name).toBe('NotificationDeliveryStatus');
      expect(byName.deliveryStatus.column_default).toContain('REQUESTED');
      expect(byName.eventType).toMatchObject({ udt_name: 'text', is_nullable: 'NO' });
      expect(Object.keys(byName)).toEqual(
        expect.arrayContaining([
          'attemptCount',
          'lastAttemptTimestamp',
          'providerResponse',
          'idempotencyKey',
          'recipients',
          'incidentId',
        ]),
      );

      const indexes = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'Notification'`,
      );
      expect(indexes.rows.map((r) => r.indexname)).toEqual(
        expect.arrayContaining([
          'Notification_idempotencyKey_key',
          'idx_notification_incident_status',
        ]),
      );

      // The shared enum is untouched and still serves AITriage.
      const lifecycle = await client.query<{ enumlabel: string }>(
        `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'LifecycleStates' ORDER BY e.enumsortorder`,
      );
      expect(lifecycle.rows.map((r) => r.enumlabel)).toEqual(
        expect.arrayContaining(['PENDING', 'SUCCESS', 'FAILED']),
      );
      const triage = await client.query<{ udt_name: string }>(
        `SELECT udt_name FROM information_schema.columns
         WHERE table_name = 'AITriage' AND column_name = 'failureStatus'`,
      );
      expect(triage.rows[0].udt_name).toBe('LifecycleStates');
    } finally {
      await client.end();
    }
  });

  it('converts existing notifications: statuses are mapped and eventType comes from the key', async () => {
    const client = new Client({ connectionString: withDatabase(testDatabaseUrl(), scratchName) });
    await client.connect();
    try {
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      const dir = path.resolve(__dirname, '../../prisma/migrations');
      await client.query(
        readFileSync(path.join(dir, '20261003225123_init', 'migration.sql'), 'utf8'),
      );

      // Rows as the SLICE-05 stand-in wrote them: key "<eventType>:<auditEventId>", no recipients.
      const insert = `INSERT INTO "Notification" ("id","deliveryStatus","notificationType","idempotencyKey","recipients","attemptCount")
        VALUES ($1,$2::"LifecycleStates",'ALERT',$3,'{}',$4)`;
      await client.query(insert, [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'PENDING',
        'ASSIGNED:11111111-1111-4111-8111-111111111111',
        null,
      ]);
      await client.query(insert, [
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'SUCCESS',
        'ACKNOWLEDGED:22222222-2222-4222-8222-222222222222',
        1,
      ]);
      await client.query(insert, [
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'FAILED',
        'ESCALATED_L1:33333333-3333-4333-8333-333333333333',
        3,
      ]);

      const later = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name > '20261003225123_init')
        .map((e) => e.name)
        .sort();
      for (const name of later) {
        await client.query(readFileSync(path.join(dir, name, 'migration.sql'), 'utf8'));
      }

      const rows = await client.query(
        `SELECT "id","deliveryStatus"::text AS "deliveryStatus","eventType","attemptCount","recipients"
         FROM "Notification" ORDER BY "id"`,
      );
      expect(rows.rows).toEqual([
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          deliveryStatus: 'REQUESTED',
          eventType: 'ASSIGNED',
          attemptCount: null,
          recipients: [],
        },
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          deliveryStatus: 'COMPLETED',
          eventType: 'ACKNOWLEDGED',
          attemptCount: 1,
          recipients: [],
        },
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          deliveryStatus: 'FAILED',
          eventType: 'ESCALATED_L1',
          attemptCount: 3,
          recipients: [],
        },
      ]);

      const def = await client.query<{ column_default: string }>(
        `SELECT column_default FROM information_schema.columns
         WHERE table_name = 'Notification' AND column_name = 'deliveryStatus'`,
      );
      expect(def.rows[0].column_default).toContain('REQUESTED');
    } finally {
      await client.end();
    }
  });
});
