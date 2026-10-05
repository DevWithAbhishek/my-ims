import { z } from 'zod';
import { getConfig } from '../config/env.js';
import { disconnectPrisma } from '../infra/db/prisma.js';
import { seedAdminUser } from '../modules/identity/index.js';
import { logger } from '../shared/observability/logger.js';

const seedEnvSchema = z.object({
  SEED_ADMIN_NAME: z.string().min(1).max(50),
  SEED_ADMIN_EMAIL: z.email().max(72),
  SEED_ADMIN_PASSWORD: z.string().min(8).max(24),
});

async function main(): Promise<void> {
  getConfig(); // loads `.env` and validates the application configuration
  const parsed = seedEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Invalid seed configuration: ${names.join(', ')}`);
  }

  const created = await seedAdminUser({
    name: parsed.data.SEED_ADMIN_NAME,
    email: parsed.data.SEED_ADMIN_EMAIL,
    password: parsed.data.SEED_ADMIN_PASSWORD,
  });
  logger.info({ created }, created ? 'Admin user created' : 'Admin user already exists');
}

main()
  .catch((err: unknown) => {
    logger.fatal({ err }, 'Admin seed failed');
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
