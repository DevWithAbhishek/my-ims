import { getConfig } from './config/env.js';
import { disconnectPrisma, pingDatabase } from './infra/db/prisma.js';
import { closeRedis, pingRedis } from './infra/redis/redis.js';
import { onShutdownSignal } from './shared/lifecycle/shutdown.js';
import { logger } from './shared/observability/logger.js';

async function main(): Promise<void> {
  const config = getConfig();

  await pingDatabase();
  await pingRedis();

  logger.info({ nodeEnv: config.nodeEnv }, 'Worker ready');

  onShutdownSignal(async () => {
    await disconnectPrisma();
    await closeRedis();
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
