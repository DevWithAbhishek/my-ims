import type { Severity, SlaClock, SlaState, SlaStatus } from './incidents.types.js';

const MINUTE_MS = 60_000;
/** A clock is `WARNING` from 80 % of its threshold elapsed (4/5, kept in integers). */
const WARNING_NUMERATOR = 4;
const WARNING_DENOMINATOR = 5;

export type SlaThresholds = Record<
  Severity,
  { responseMinutes: number; resolutionMinutes: number }
>;

export type SlaInput = {
  severity: Severity;
  createdAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  thresholds: SlaThresholds;
};

function buildClock(
  createdAt: Date,
  thresholdMinutes: number,
  metAt: Date | null,
  now: Date,
): SlaClock {
  const thresholdMs = thresholdMinutes * MINUTE_MS;
  const deadline = createdAt.getTime() + thresholdMs;
  const elapsed = now.getTime() - createdAt.getTime();

  let state: SlaState;
  if (metAt !== null) state = 'MET';
  else if (now.getTime() > deadline) state = 'BREACHED';
  else if (elapsed * WARNING_DENOMINATOR >= thresholdMs * WARNING_NUMERATOR) state = 'WARNING';
  else state = 'ON_TRACK';

  return {
    thresholdMinutes,
    deadlineAt: new Date(deadline).toISOString(),
    state,
    metAt: metAt === null ? null : metAt.toISOString(),
  };
}

/**
 * SLA status at `now`: the deadline is `createdAt` plus the threshold of the **current** severity
 * (a severity change never resets the clock). A clock is `MET` once the incident has been
 * acknowledged (response) or resolved (resolution), and a breach never changes incident state.
 */
export function buildSlaStatus(input: SlaInput, now: Date = new Date()): SlaStatus {
  const threshold = input.thresholds[input.severity];
  return {
    applicableSeverity: input.severity,
    response: buildClock(input.createdAt, threshold.responseMinutes, input.acknowledgedAt, now),
    resolution: buildClock(input.createdAt, threshold.resolutionMinutes, input.resolvedAt, now),
  };
}
