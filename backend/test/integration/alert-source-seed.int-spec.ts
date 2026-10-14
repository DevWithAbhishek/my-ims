import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as audit from '../../src/infra/audit/append-audit-event';
import { getPrisma } from '../../src/infra/db/prisma';
import { getRedis } from '../../src/infra/redis/redis';
import {
  DEFAULT_SEVERITY_MAPPING,
  seedAlertSource,
  type SeedAlertSourceInput,
} from '../../src/modules/alerts';
import { resetState } from '../helpers/identity';
import { testDatabaseUrl, testRedisUrl } from '../helpers/test-env';

const ID = '0192b5e0-7c1a-7d2e-8f3b-4a5c6d7e8f90';
const SECRET_1 = 'first-signing-secret-0123456789-abcdef';
const SECRET_2 = 'second-signing-secret-0123456789-abcdef';

const input = (overrides: Partial<SeedAlertSourceInput> = {}): SeedAlertSourceInput => ({
  id: ID,
  name: 'Generic source',
  signingSecret: SECRET_1,
  severityMapping: DEFAULT_SEVERITY_MAPPING,
  ...overrides,
});

const db = () => getPrisma();
const auditEvents = () => db().auditEvent.findMany({ orderBy: { createdAt: 'asc' } });
const source = () => db().alertSource.findUniqueOrThrow({ where: { id: ID } });

beforeEach(resetState);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await db().$disconnect();
  getRedis().disconnect();
});

describe('seedAlertSource', () => {
  it('creates a GENERIC, ACTIVE source with the secret and the four-value mapping, and no audit', async () => {
    expect(await seedAlertSource(input())).toBe('CREATED');

    expect(await source()).toMatchObject({
      id: ID,
      name: 'Generic source',
      sourceType: 'GENERIC',
      status: 'ACTIVE',
      configuration: {
        signingSecret: SECRET_1,
        severityMapping: { critical: 'P0', high: 'P1', warning: 'P2', info: 'P3' },
      },
    });
    expect(await auditEvents()).toHaveLength(0);
  });

  it('an unchanged re-run writes nothing', async () => {
    await seedAlertSource(input());
    const before = await source();

    expect(await seedAlertSource(input())).toBe('UNCHANGED');
    expect(await source()).toEqual(before);
    expect(await auditEvents()).toHaveLength(0);
  });

  it('rotating the secret appends exactly one audit event naming the key, never a value', async () => {
    await seedAlertSource(input());
    expect(await seedAlertSource(input({ signingSecret: SECRET_2 }))).toBe('UPDATED');

    expect((await source()).configuration).toMatchObject({ signingSecret: SECRET_2 });
    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'ALERT_SOURCE_UPDATED',
      actor: null,
      incidentId: null,
      metadata: { alertSourceId: ID, changedKeys: ['signingSecret'] },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET_1);
    expect(serialized).not.toContain(SECRET_2);
  });

  it('editing the mapping is audited by key name only', async () => {
    await seedAlertSource(input());
    const severityMapping = { critical: 'P1', high: 'P1', warning: 'P3', info: 'P3' } as const;
    expect(await seedAlertSource(input({ severityMapping }))).toBe('UPDATED');

    expect((await source()).configuration).toMatchObject({ severityMapping });
    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toEqual({ alertSourceId: ID, changedKeys: ['severityMapping'] });
  });

  it('changing both is still one event, with both keys', async () => {
    await seedAlertSource(input());
    await seedAlertSource(
      input({ signingSecret: SECRET_2, severityMapping: { critical: 'P0', other: 'P3' } }),
    );
    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toEqual({
      alertSourceId: ID,
      changedKeys: ['severityMapping', 'signingSecret'],
    });
  });

  it('keeps other configuration keys, the name and the status of an existing source', async () => {
    await seedAlertSource(input());
    const current = await source();
    await db().alertSource.update({
      where: { id: ID },
      data: {
        status: 'DEACTIVATED',
        configuration: { ...(current.configuration as object), extra: { keep: true } },
      },
    });

    expect(await seedAlertSource(input({ name: 'Renamed', signingSecret: SECRET_2 }))).toBe(
      'UPDATED',
    );
    expect(await source()).toMatchObject({
      name: 'Generic source',
      status: 'DEACTIVATED',
      configuration: { extra: { keep: true }, signingSecret: SECRET_2 },
    });
    expect((await auditEvents())[0]!.metadata).toMatchObject({ changedKeys: ['signingSecret'] });
  });

  it('is atomic: if the audit write fails the configuration is not changed', async () => {
    await seedAlertSource(input());
    jest.spyOn(audit, 'appendAuditEvent').mockRejectedValueOnce(new Error('audit failed'));

    await expect(seedAlertSource(input({ signingSecret: SECRET_2 }))).rejects.toThrow(
      'audit failed',
    );
    expect((await source()).configuration).toMatchObject({ signingSecret: SECRET_1 });
    expect(await auditEvents()).toHaveLength(0);
  });

  it('seeded simultaneously, a new source is created once and nothing is audited', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => seedAlertSource(input())));
    expect(results.filter((r) => r === 'CREATED')).toHaveLength(1);
    expect(results.filter((r) => r === 'UNCHANGED')).toHaveLength(4);
    expect(await db().alertSource.count()).toBe(1);
    expect(await auditEvents()).toHaveLength(0);
  });

  it('two simultaneous rotations are serialized and each audited', async () => {
    await seedAlertSource(input());
    await Promise.all([
      seedAlertSource(input({ signingSecret: SECRET_2 })),
      seedAlertSource(input({ signingSecret: 'third-signing-secret-0123456789-abcdef' })),
    ]);
    expect(await auditEvents()).toHaveLength(2);
  });
});

describe('npm run seed:alert-source (script)', () => {
  const script = path.resolve(__dirname, '../../src/scripts/seed-alert-source.ts');
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', script], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl(),
        REDIS_URL: testRedisUrl(),
        SEED_ALERT_SOURCE_ID: ID,
        SEED_ALERT_SOURCE_NAME: 'Scripted source',
        SEED_ALERT_SOURCE_SIGNING_SECRET: SECRET_1,
        ...env,
      },
      encoding: 'utf8',
    });

  it('seeds from the environment and never prints the secret', async () => {
    const created = run({});
    expect(created.status).toBe(0);
    expect(created.stdout).toContain('CREATED');
    expect((await source()).configuration).toMatchObject({
      signingSecret: SECRET_1,
      severityMapping: DEFAULT_SEVERITY_MAPPING,
    });

    const rotated = run({ SEED_ALERT_SOURCE_SIGNING_SECRET: SECRET_2 });
    expect(rotated.status).toBe(0);
    expect(rotated.stdout).toContain('UPDATED');
    for (const output of [created, rotated]) {
      expect(output.stdout + output.stderr).not.toContain(SECRET_1);
      expect(output.stdout + output.stderr).not.toContain(SECRET_2);
    }
    expect(await auditEvents()).toHaveLength(1);
  }, 60_000);

  it('rejects a weak secret or a bad mapping, naming the variable only', async () => {
    const weak = run({ SEED_ALERT_SOURCE_SIGNING_SECRET: 'short-secret' });
    expect(weak.status).toBe(1);
    expect(weak.stdout + weak.stderr).toContain('SEED_ALERT_SOURCE_SIGNING_SECRET');
    expect(weak.stdout + weak.stderr).not.toContain('short-secret');

    const bad = run({ SEED_ALERT_SOURCE_SEVERITY_MAPPING: '{"critical":"P9"}' });
    expect(bad.status).toBe(1);
    expect(bad.stdout + bad.stderr).toContain('SEED_ALERT_SOURCE_SEVERITY_MAPPING');
    expect(await db().alertSource.count()).toBe(0);
  }, 60_000);
});
