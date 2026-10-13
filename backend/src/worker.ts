import { getConfig, getJobsConfig } from './config/env.js';
import { disconnectPrisma, pingDatabase } from './infra/db/prisma.js';
import { closeRedis, pingRedis } from './infra/redis/redis.js';
import { onShutdownSignal } from './shared/lifecycle/shutdown.js';
import { logger } from './shared/observability/logger.js';
import { startWorkers } from './workers/index.js';

async function main(): Promise<void> {
  const config = getConfig();
  getJobsConfig(); // fails startup when any outbox/worker setting is missing

  await pingDatabase();
  await pingRedis();

  const runtime = startWorkers();
  logger.info({ nodeEnv: config.nodeEnv }, 'Worker ready');

  onShutdownSignal(async () => {
    await runtime.stop();
    await disconnectPrisma();
    await closeRedis();
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
