import type { Redis } from 'ioredis';
import { getRedis } from '../../infra/redis/redis.js';
import { logger } from '../../shared/observability/logger.js';
import { SOURCE_RATE_LIMIT } from './webhook.config.js';
import { dependencyUnavailable } from './webhook.errors.js';

export type RateLimitOutcome =
  /** `allowed` of the request's alerts fit in the window (`0` when there was nothing to count). */
  | { kind: 'ALLOWED'; allowed: number }
  /** The source is blocked; `retryAfterMs` is what is left of the block. */
  | { kind: 'BLOCKED'; retryAfterMs: number }
  /** No capacity was left: this request started a block (the ladder moved up one step). */
  | { kind: 'VIOLATION'; retryAfterMs: number; attemptCount: number; finalStage: boolean };

export interface RateLimiter {
  /** Atomically checks the block, counts up to `alertCount` alerts and escalates on a violation. */
  consume(alertSourceId: string, alertCount: number): Promise<RateLimitOutcome>;
  /**
   * Takes the right to write the Admin notice of the current block when it is still unwritten;
   * returns the number of violations, or `null` when there is nothing to write or someone else is.
   */
  claimPendingNotice(alertSourceId: string): Promise<number | null>;
  /** Records that the notice of the current block was written. */
  acknowledgeNotice(alertSourceId: string): Promise<void>;
}

/** The block the n-th consecutive violation (1-based) starts, and whether it is the final stage. */
export function blockForViolation(violation: number): { durationMs: number; finalStage: boolean } {
  const step = SOURCE_RATE_LIMIT.blockStepsMs[violation - 1];
  return step === undefined
    ? { durationMs: SOURCE_RATE_LIMIT.finalBlockMs, finalStage: true }
    : { durationMs: step, finalStage: false };
}

export function rateLimitKeys(alertSourceId: string) {
  return {
    block: `wh:rl:block:${alertSourceId}`,
    count: `wh:rl:count:${alertSourceId}`,
    level: `wh:rl:level:${alertSourceId}`,
    notice: `wh:rl:notice:${alertSourceId}`,
    noticeLock: `wh:rl:notice-lock:${alertSourceId}`,
  };
}

/**
 * KEYS: block, count, level, notice, notice lock.
 * ARGV: alerts in the request, capacity, window ms, ladder memory ms, notice lock ms, final block
 * ms, then the block of each ladder step in ms.
 * Returns {status, allowed, retryAfterMs, level, finalStage}; status 0 = counted, 1 = new block,
 * 2 = already blocked.
 */
const CONSUME_SCRIPT = `
local blockTtl = redis.call('PTTL', KEYS[1])
if blockTtl > 0 then return {2, 0, blockTtl, 0, 0} end
local n = tonumber(ARGV[1])
if n <= 0 then return {0, 0, 0, 0, 0} end
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
local remaining = tonumber(ARGV[2]) - used
if remaining <= 0 then
  local level = redis.call('INCR', KEYS[3])
  redis.call('PEXPIRE', KEYS[3], ARGV[4])
  local steps = #ARGV - 6
  local ms = tonumber(ARGV[6])
  local final = 1
  if level <= steps then
    ms = tonumber(ARGV[6 + level])
    final = 0
  end
  redis.call('SET', KEYS[1], tostring(level), 'PX', ms)
  redis.call('DEL', KEYS[2])
  if final == 1 then
    redis.call('SET', KEYS[4], 'pending:' .. level, 'PX', ms)
    redis.call('SET', KEYS[5], '1', 'PX', ARGV[5])
  end
  return {1, 0, ms, level, final}
end
local allowed = math.min(n, remaining)
local count = redis.call('INCRBY', KEYS[2], allowed)
if count == allowed then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
return {0, allowed, 0, 0, 0}
`;

/** KEYS: notice, notice lock. ARGV: lock ms. */
const CLAIM_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value or string.sub(value, 1, 8) ~= 'pending:' then return false end
if redis.call('SET', KEYS[2], '1', 'NX', 'PX', ARGV[1]) then
  return tonumber(string.sub(value, 9))
end
return false
`;

/** KEYS: notice. */
const ACKNOWLEDGE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value and string.sub(value, 1, 8) == 'pending:' then
  redis.call('SET', KEYS[1], 'sent:' .. string.sub(value, 9), 'KEEPTTL')
end
return 1
`;

export function createRateLimiter(redis?: Redis): RateLimiter {
  const client = () => redis ?? getRedis();

  return {
    async consume(alertSourceId, alertCount) {
      const keys = rateLimitKeys(alertSourceId);
      let reply: number[];
      try {
        reply = (await client().eval(
          CONSUME_SCRIPT,
          5,
          keys.block,
          keys.count,
          keys.level,
          keys.notice,
          keys.noticeLock,
          alertCount,
          SOURCE_RATE_LIMIT.alertsPerWindow,
          SOURCE_RATE_LIMIT.windowMs,
          SOURCE_RATE_LIMIT.ladderMemoryMs,
          SOURCE_RATE_LIMIT.noticeLockMs,
          SOURCE_RATE_LIMIT.finalBlockMs,
          ...SOURCE_RATE_LIMIT.blockStepsMs,
        )) as number[];
      } catch (err) {
        logger.warn({ err }, 'Source rate limiter unavailable');
        throw dependencyUnavailable();
      }

      const [status, allowed = 0, retryAfterMs = 0, level = 0, final = 0] = reply;
      if (status === 2) return { kind: 'BLOCKED', retryAfterMs };
      if (status === 1) {
        return { kind: 'VIOLATION', retryAfterMs, attemptCount: level, finalStage: final === 1 };
      }
      return { kind: 'ALLOWED', allowed };
    },

    async claimPendingNotice(alertSourceId) {
      const keys = rateLimitKeys(alertSourceId);
      const claimed = await client().eval(
        CLAIM_SCRIPT,
        2,
        keys.notice,
        keys.noticeLock,
        SOURCE_RATE_LIMIT.noticeLockMs,
      );
      return typeof claimed === 'number' ? claimed : null;
    },

    async acknowledgeNotice(alertSourceId) {
      await client().eval(ACKNOWLEDGE_SCRIPT, 1, rateLimitKeys(alertSourceId).notice);
    },
  };
}
