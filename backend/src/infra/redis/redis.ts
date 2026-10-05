import { Redis } from 'ioredis';
import { getConfig } from '../../config/env.js';
import { logger } from '../../shared/observability/logger.js';

export type RedisPurpose = 'general' | 'bullmq';

/**
 * Creates a Redis connection. BullMQ requires `maxRetriesPerRequest: null`; general-purpose
 * connections fail commands quickly when Redis is unreachable. The connection is established on
 * first use.
 */
export function createRedisConnection(
  purpose: RedisPurpose = 'general',
  url: string = getConfig().redisUrl,
): Redis {
  const connection = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: purpose === 'bullmq' ? null : 1,
    connectTimeout: 5000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  connection.on('error', (err) => {
    logger.warn({ err, purpose }, 'Redis connection error');
  });
  return connection;
}

let shared: Redis | undefined;

/** The process-wide general-purpose connection. */
export function getRedis(): Redis {
  shared ??= createRedisConnection('general');
  return shared;
}

export async function pingRedis(connection: Redis = getRedis()): Promise<void> {
  await connection.ping();
}

export async function closeRedis(): Promise<void> {
  if (shared) {
    const current = shared;
    shared = undefined;
    await current.quit().catch(() => current.disconnect());
  }
}
