import { SOURCE_RATE_LIMIT } from './webhook.config.js';
import { blockForViolation } from './rate-limiter.js';

const MIN = 60_000;

describe('blockForViolation', () => {
  it('escalates 5 min → 20 min → 45 min → 2 h', () => {
    expect([1, 2, 3, 4].map((n) => blockForViolation(n))).toEqual([
      { durationMs: 5 * MIN, finalStage: false },
      { durationMs: 20 * MIN, finalStage: false },
      { durationMs: 45 * MIN, finalStage: false },
      { durationMs: 120 * MIN, finalStage: false },
    ]);
  });

  it('the fifth violation (and every later one) is the final stage', () => {
    for (const n of [5, 6, 20]) {
      expect(blockForViolation(n)).toEqual({
        durationMs: SOURCE_RATE_LIMIT.finalBlockMs,
        finalStage: true,
      });
    }
  });
});
