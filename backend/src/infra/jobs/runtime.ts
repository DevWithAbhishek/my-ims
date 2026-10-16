import type { Worker } from 'bullmq';
import type { JobsConfig } from '../../config/env.js';
import { logger } from '../../shared/observability/logger.js';
import { createRedisConnection } from '../redis/redis.js';
import { createBullmqGateway, type QueueGateway } from './gateway.js';
import { startLoop } from './loop.js';
import { purgeFinishedOutbox, recoverStaleOutbox } from './maintenance.js';
import { createJobWorker } from './processor.js';
import { getRegisteredDelayedProcessors, getRegisteredProcessors } from './registry.js';
import { runRelayCycle } from './relay.js';

export type JobsRuntime = { stop(): Promise<void> };

/**
 * Starts everything the worker process runs: the relay, the stale-`PROCESSING` recovery pass, the
 * retention job and one BullMQ worker for every queue that has a registered processor.
 * `stop()` finishes in-flight work and closes the Redis connections.
 */
export function startJobsRuntime(config: JobsConfig, gatewayOverride?: QueueGateway): JobsRuntime {
  const publisherConnection = gatewayOverride ? undefined : createRedisConnection('general');
  const gateway =
    gatewayOverride ?? createBullmqGateway(publisherConnection!, config.executionAttempts);

  const processors = [...getRegisteredProcessors()];
  const delayedProcessors = getRegisteredDelayedProcessors();
  const workerConnection = processors.length > 0 ? createRedisConnection('bullmq') : undefined;
  const workers: Worker[] = workerConnection
    ? processors.map(([queue, processor]) =>
        createJobWorker(
          queue,
          processor,
          { config, gateway },
          workerConnection,
          delayedProcessors.get(queue),
        ),
      )
    : [];

  const loops = [
    startLoop('outbox-relay', config.relayPollIntervalMs, async () => {
      const result = await runRelayCycle(config, gateway);
      return result.claimed >= config.relayBatchSize;
    }),
    startLoop('outbox-stale-recovery', config.staleRecoveryIntervalMs, async () => {
      await recoverStaleOutbox();
    }),
    startLoop('outbox-retention', config.retentionIntervalMs, async () => {
      await purgeFinishedOutbox(config.retentionWindowMs);
    }),
  ];

  logger.info(
    { queues: processors.map(([queue]) => queue) },
    'Jobs runtime started (relay, recovery, retention, workers)',
  );

  return {
    async stop() {
      await Promise.all(loops.map((loop) => loop.stop()));
      await Promise.all(workers.map((worker) => worker.close()));
      await gateway.close();
      publisherConnection?.disconnect();
      workerConnection?.disconnect();
    },
  };
}
