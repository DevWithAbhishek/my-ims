import type { Server } from 'node:http';
import { createApp } from './app.js';
import { createApiRouter } from './api-router.js';
import { getConfig } from './config/env.js';
import { disconnectPrisma, pingDatabase } from './infra/db/prisma.js';
import { buildReadinessChecks } from './infra/readiness.js';
import { closeRedis, pingRedis } from './infra/redis/redis.js';
import { createWebhookRouter } from './modules/alerts/index.js';
import { onShutdownSignal } from './shared/lifecycle/shutdown.js';
import { logger } from './shared/observability/logger.js';

async function main(): Promise<void> {
  const config = getConfig();

  await pingDatabase();
  await pingRedis();

  const app = createApp({
    readinessChecks: buildReadinessChecks(),
    apiRouter: createApiRouter(),
    webhookRouter: createWebhookRouter(),
  });
  // Express 5 passes a listen failure (e.g. EADDRINUSE) to this callback.
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(config.port, (err?: Error) =>
      err ? reject(err) : resolve(listening),
    );
  });
  logger.info({ port: config.port }, 'Server listening');

  onShutdownSignal(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve())); // stops the HTTP server from accepting new connections and waits for existing connections to finish before its callback completes.
      server.closeIdleConnections(); // This closes idle HTTP connections, including keep-alive connections that aren't currently processing a request.
    });
    await disconnectPrisma();
    await closeRedis();
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Server failed to start');
  process.exit(1);
});
