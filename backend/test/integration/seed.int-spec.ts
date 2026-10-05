import { getPrisma } from '../../src/infra/db/prisma';
import { getRedis } from '../../src/infra/redis/redis';
import { seedAdminUser } from '../../src/modules/identity';
import { PASSWORD, login, resetState } from '../helpers/identity';
import { buildTestApp } from '../helpers/app';

beforeEach(resetState);
afterAll(async () => {
  await getPrisma().$disconnect();
  getRedis().disconnect();
});

describe('seedAdminUser', () => {
  it('creates an ADMIN with an Argon2 hash who can log in', async () => {
    const created = await seedAdminUser({
      name: 'Root',
      email: 'Root@Example.com',
      password: PASSWORD,
    });
    expect(created).toBe(true);

    const admin = await getPrisma().user.findUniqueOrThrow({
      where: { email: 'root@example.com' },
    });
    expect(admin).toMatchObject({ role: 'ADMIN', status: 'ACTIVE', teamId: null, leadId: null });
    expect(admin.passwordHash).toMatch(/^\$argon2id\$/);
    expect((await login(buildTestApp(), 'root@example.com')).res.status).toBe(200);
  });

  it('is idempotent by email, also when run concurrently', async () => {
    const input = { name: 'Root', email: 'root@example.com', password: PASSWORD };
    const results = await Promise.all([
      seedAdminUser(input),
      seedAdminUser(input),
      seedAdminUser(input),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await seedAdminUser({ ...input, password: 'DifferentPass1' })).toBe(false);
    expect(await getPrisma().user.count()).toBe(1);
  });
});
