import type { ReadinessCheck } from '../shared/http/health.js';
import { pingDatabase } from './db/prisma.js';
import { pingRedis } from './redis/redis.js';

export function buildReadinessChecks(): ReadinessCheck[] {
  return [
    { name: 'postgresql', check: () => pingDatabase() },
    { name: 'redis', check: () => pingRedis() },
  ];
}
