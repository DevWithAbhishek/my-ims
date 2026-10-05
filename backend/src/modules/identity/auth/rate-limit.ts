import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getRedis } from '../../../infra/redis/redis.js';
import { ServiceUnavailableError, TooManyRequestsError } from '../../../shared/errors/AppError.js';
import { logger } from '../../../shared/observability/logger.js';

export type RateLimitScope = 'login' | 'refresh';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const RATE_LIMIT = {
  maxRequests: 10,
  windowMs: MINUTE_MS,
  /** Block per consecutive violation: 10 min → 20 min → 60 min → 4 h, then the IP is blocked. */
  blockStepsMs: [10 * MINUTE_MS, 20 * MINUTE_MS, 60 * MINUTE_MS, 4 * HOUR_MS],
  ipBlockMs: 24 * HOUR_MS,
  /** How long violations are remembered; each violation refreshes it. */
  ladderMemoryMs: 24 * HOUR_MS,
  unavailableRetryAfterSeconds: 5,
} as const;

/** Atomically checks blocks, counts the request, and escalates the ladder on a violation. */
const CHECK_SCRIPT = `
local ipTtl = redis.call('PTTL', KEYS[1])
if ipTtl > 0 then return {1, ipTtl} end
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then return {1, blockTtl} end
local count = redis.call('INCR', KEYS[3])
if count == 1 then redis.call('PEXPIRE', KEYS[3], ARGV[2]) end
if count <= tonumber(ARGV[1]) then return {0, 0} end
redis.call('DEL', KEYS[3])
local level = redis.call('INCR', KEYS[4])
redis.call('PEXPIRE', KEYS[4], ARGV[3])
local steps = #ARGV - 4
if level > steps then
  redis.call('SET', KEYS[1], '1', 'PX', ARGV[4])
  return {1, tonumber(ARGV[4])}
end
local ms = tonumber(ARGV[4 + level])
redis.call('SET', KEYS[2], '1', 'PX', ms)
return {1, ms}
`;

/** Block duration (ms) for the n-th consecutive violation (1-based); `null` means block the IP. */
export function blockDurationMs(violation: number): number | null {
  return RATE_LIMIT.blockStepsMs[violation - 1] ?? null;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** Redis keys never contain raw emails or IPs. */
export function rateLimitKeys(scope: RateLimitScope, ip: string, parts: readonly string[]) {
  const id = digest([ip, ...parts].join('\n'));
  return {
    ipBlock: `rl:ip-block:${digest(ip)}`,
    block: `rl:block:${scope}:${id}`,
    count: `rl:count:${scope}:${id}`,
    level: `rl:level:${scope}:${id}`,
  };
}

/**
 * Counts one attempt for (IP + `parts`) and throws `429 RATE_LIMITED` while blocked.
 * Fails closed (`503 DEPENDENCY_UNAVAILABLE`) when Redis cannot be reached.
 */
export async function consumeRateLimit(
  scope: RateLimitScope,
  ip: string,
  parts: readonly string[],
  redis: Redis = getRedis(),
): Promise<void> {
  const keys = rateLimitKeys(scope, ip, parts);
  let result: [number, number];
  try {
    result = (await redis.eval(
      CHECK_SCRIPT,
      4,
      keys.ipBlock,
      keys.block,
      keys.count,
      keys.level,
      RATE_LIMIT.maxRequests,
      RATE_LIMIT.windowMs,
      RATE_LIMIT.ladderMemoryMs,
      RATE_LIMIT.ipBlockMs,
      ...RATE_LIMIT.blockStepsMs,
    )) as [number, number];
  } catch (err) {
    logger.warn({ err }, 'Rate limiter unavailable');
    throw new ServiceUnavailableError(
      'Service temporarily unavailable',
      'DEPENDENCY_UNAVAILABLE',
      RATE_LIMIT.unavailableRetryAfterSeconds,
    );
  }

  const [blocked, remainingMs] = result;
  if (blocked === 1) {
    throw new TooManyRequestsError(
      'Too many requests',
      'RATE_LIMITED',
      Math.max(1, Math.ceil(remainingMs / 1000)),
    );
  }
}

/** Clears this key's request counter after a success. Best effort: never fails the request. */
export async function resetRateLimit(
  scope: RateLimitScope,
  ip: string,
  parts: readonly string[],
  redis: Redis = getRedis(),
): Promise<void> {
  try {
    await redis.del(rateLimitKeys(scope, ip, parts).count);
  } catch (err) {
    logger.warn({ err }, 'Rate limiter reset failed');
  }
}
