import type { Redis } from 'ioredis';
import { getRedis } from '../../infra/redis/redis.js';
import { logger } from '../../shared/observability/logger.js';
import { dependencyUnavailable } from './webhook.errors.js';
import { WEBHOOK } from './webhook.config.js';

export interface ReplayStore {
  /**
   * Atomically records the signature; `true` when it had not been seen. Fails closed
   * (`503 DEPENDENCY_UNAVAILABLE`) when Redis cannot be reached.
   */
  markSeen(alertSourceId: string, signatureHex: string): Promise<boolean>;
}

export function replayKey(alertSourceId: string, signatureHex: string): string {
  return `wh:replay:${alertSourceId}:${signatureHex}`;
}

export function createReplayStore(redis?: Redis): ReplayStore {
  return {
    async markSeen(alertSourceId, signatureHex) {
      try {
        const stored = await (redis ?? getRedis()).set(
          replayKey(alertSourceId, signatureHex),
          '1',
          'EX',
          WEBHOOK.replayTtlSeconds,
          'NX',
        );
        return stored === 'OK';
      } catch (err) {
        logger.warn({ err }, 'Replay store unavailable');
        throw dependencyUnavailable();
      }
    },
  };
}
