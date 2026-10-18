import type { Redis } from 'ioredis';
import { getRedis } from '../../../infra/redis/redis.js';
import { logger } from '../../../shared/observability/logger.js';
import { REQUEST_RATE_LIMIT } from './investigation.config.js';
import { dependencyUnavailable } from './investigation.outage.js';

/** The Admin notice of a block that has to be written (the final stage started or is unwritten). */
export type BlockNotice = {
  /** Start of the block window: with the user it identifies the block. */
  startedAtMs: number;
  /** Requests counted in the window that caused the block. */
  attemptCount: number;
  level: number;
};

export type RateLimitOutcome =
  | { kind: 'ALLOWED' }
  /** This request was the 4th in its window: a block of the next ladder step started. */
  | { kind: 'VIOLATION'; retryAfterMs: number; notice: BlockNotice | null }
  /** The user is blocked; `notice` is set when the block's Admin notice is still unwritten. */
  | { kind: 'BLOCKED'; retryAfterMs: number; notice: BlockNotice | null };

export interface InvestigationRateLimiter {
  /** Atomically checks the block, counts the request and escalates on a violation. */
  consume(userId: string, nowMs: number): Promise<RateLimitOutcome>;
  /** Records that the notice of the current block was written. */
  acknowledgeNotice(userId: string): Promise<void>;
}

export function rateLimitKeys(userId: string) {
  return {
    block: `inv:rl:block:${userId}`,
    count: `inv:rl:count:${userId}`,
    level: `inv:rl:level:${userId}`,
    notice: `inv:rl:notice:${userId}`,
    noticeLock: `inv:rl:notice-lock:${userId}`,
  };
}

/**
 * KEYS: block, count, level, notice, notice lock.
 * ARGV: capacity, window ms, ladder memory ms, notice lock ms, now ms, then the block of each
 * ladder step in ms (the last step is the final stage).
 * Returns {status, retryAfterMs, notice}; status 0 = counted, 1 = new block, 2 = already blocked.
 * A request that meets a block is not counted and does not escalate. The final stage leaves a
 * `pending|<start>|<attempts>|<level>` notice that exactly one caller at a time may claim.
 */
const CONSUME_SCRIPT = `
local blockTtl = redis.call('PTTL', KEYS[1])
if blockTtl > 0 then
  local info = ''
  local notice = redis.call('GET', KEYS[4])
  if notice and string.sub(notice, 1, 8) == 'pending|' then
    if redis.call('SET', KEYS[5], '1', 'NX', 'PX', ARGV[4]) then info = notice end
  end
  return {2, blockTtl, info}
end
local used = redis.call('INCR', KEYS[2])
if used == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[2]) end
if used <= tonumber(ARGV[1]) then return {0, 0, ''} end
local level = redis.call('INCR', KEYS[3])
redis.call('PEXPIRE', KEYS[3], ARGV[3])
local steps = #ARGV - 5
local ms = tonumber(ARGV[5 + math.min(level, steps)])
redis.call('SET', KEYS[1], tostring(level), 'PX', ms)
redis.call('DEL', KEYS[2])
local info = ''
if level >= steps then
  info = 'pending|' .. ARGV[5] .. '|' .. used .. '|' .. level
  redis.call('SET', KEYS[4], info, 'PX', ms)
  redis.call('SET', KEYS[5], '1', 'PX', ARGV[4])
end
return {1, ms, info}
`;

/** KEYS: notice. */
const ACKNOWLEDGE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value and string.sub(value, 1, 8) == 'pending|' then
  redis.call('SET', KEYS[1], 'sent|' .. string.sub(value, 9), 'KEEPTTL')
end
return 1
`;

export function parseBlockNotice(info: string): BlockNotice | null {
  const [tag, startedAtMs, attemptCount, level] = info.split('|');
  if (tag !== 'pending') return null;
  const parsed = {
    startedAtMs: Number(startedAtMs),
    attemptCount: Number(attemptCount),
    level: Number(level),
  };
  return Object.values(parsed).every(Number.isFinite) ? parsed : null;
}

export function createInvestigationRateLimiter(redis?: Redis): InvestigationRateLimiter {
  const client = () => redis ?? getRedis();

  return {
    async consume(userId, nowMs) {
      const keys = rateLimitKeys(userId);
      let reply: [number, number, string];
      try {
        reply = (await client().eval(
          CONSUME_SCRIPT,
          5,
          keys.block,
          keys.count,
          keys.level,
          keys.notice,
          keys.noticeLock,
          REQUEST_RATE_LIMIT.requestsPerWindow,
          REQUEST_RATE_LIMIT.windowMs,
          REQUEST_RATE_LIMIT.ladderMemoryMs,
          REQUEST_RATE_LIMIT.noticeLockMs,
          nowMs,
          ...REQUEST_RATE_LIMIT.blockStepsMs,
        )) as [number, number, string];
      } catch (err) {
        logger.warn({ err }, 'Investigation rate limiter unavailable');
        throw dependencyUnavailable('Service temporarily unavailable');
      }

      const [status, retryAfterMs, info] = reply;
      if (status === 0) return { kind: 'ALLOWED' };
      const notice = info === '' ? null : parseBlockNotice(info);
      return { kind: status === 1 ? 'VIOLATION' : 'BLOCKED', retryAfterMs, notice };
    },

    async acknowledgeNotice(userId) {
      await client().eval(ACKNOWLEDGE_SCRIPT, 1, rateLimitKeys(userId).notice);
    },
  };
}
