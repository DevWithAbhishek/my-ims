import { REQUEST_RATE_LIMIT } from './investigation.config';
import { parseBlockNotice } from './investigation.rate-limit';

describe('parseBlockNotice', () => {
  it('reads a pending notice', () => {
    expect(parseBlockNotice('pending|1760000000000|4|5')).toEqual({
      startedAtMs: 1760000000000,
      attemptCount: 4,
      level: 5,
    });
  });

  it('rejects anything else', () => {
    expect(parseBlockNotice('sent|1|4|5')).toBeNull();
    expect(parseBlockNotice('pending|x|4|5')).toBeNull();
    expect(parseBlockNotice('')).toBeNull();
  });
});

describe('REQUEST_RATE_LIMIT', () => {
  it('is 3 requests a minute with the 10 min, 20 min, 60 min, 4 h, 8 h ladder', () => {
    const minute = 60_000;
    expect(REQUEST_RATE_LIMIT.requestsPerWindow).toBe(3);
    expect(REQUEST_RATE_LIMIT.windowMs).toBe(minute);
    expect(REQUEST_RATE_LIMIT.blockStepsMs).toEqual([
      10 * minute,
      20 * minute,
      60 * minute,
      240 * minute,
      480 * minute,
    ]);
  });
});
