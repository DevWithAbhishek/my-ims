import { blockDurationMs, RATE_LIMIT, rateLimitKeys } from './rate-limit.js';

describe('rate limit ladder', () => {
  it('escalates 10 min → 20 min → 60 min → 4 h, then blocks the IP', () => {
    const minutes = [1, 2, 3, 4].map((n) => (blockDurationMs(n) ?? 0) / 60_000);
    expect(minutes).toEqual([10, 20, 60, 240]);
    expect(blockDurationMs(5)).toBeNull();
  });

  it('allows 10 requests per minute', () => {
    expect(RATE_LIMIT.maxRequests).toBe(10);
    expect(RATE_LIMIT.windowMs).toBe(60_000);
  });
});

describe('rateLimitKeys', () => {
  it('never embeds the raw email or IP', () => {
    const keys = rateLimitKeys('login', '203.0.113.9', ['person@example.com']);
    for (const key of Object.values(keys)) {
      expect(key).not.toContain('person@example.com');
      expect(key).not.toContain('203.0.113.9');
    }
  });

  it('separates scopes, identities and IPs but shares the IP block', () => {
    const base = rateLimitKeys('login', '1.1.1.1', ['a@x.com']);
    expect(rateLimitKeys('refresh', '1.1.1.1', ['a@x.com']).count).not.toBe(base.count);
    expect(rateLimitKeys('login', '1.1.1.1', ['b@x.com']).count).not.toBe(base.count);
    expect(rateLimitKeys('login', '2.2.2.2', ['a@x.com']).count).not.toBe(base.count);
    expect(rateLimitKeys('refresh', '1.1.1.1', ['b@x.com']).ipBlock).toBe(base.ipBlock);
    expect(rateLimitKeys('login', '2.2.2.2', ['a@x.com']).ipBlock).not.toBe(base.ipBlock);
  });

  it('includes email and session id in the refresh key', () => {
    const a = rateLimitKeys('refresh', '1.1.1.1', ['a@x.com', 's1']);
    expect(rateLimitKeys('refresh', '1.1.1.1', ['a@x.com', 's2']).count).not.toBe(a.count);
    expect(rateLimitKeys('refresh', '1.1.1.1', ['b@x.com', 's1']).count).not.toBe(a.count);
  });
});
