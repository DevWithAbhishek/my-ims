import type { IncidentStatus, Severity } from '../incidents.types.js';
import type { SlaThresholds } from '../sla.js';
import {
  breachMilestone,
  ESCALATION_LEVELS,
  failureMilestone,
  levelMilestone,
  warningMilestone,
  type EscalationLevel,
  type Milestone,
  type SlaClockName,
} from './sla.milestones.js';

const MINUTE_MS = 60_000;
/** 80 % of a window of whole minutes is a whole number of milliseconds (4/5 of 60 000). */
const WARNING_MS_PER_MINUTE = 48_000;

export type SlaSnapshot = {
  status: IncidentStatus;
  severity: Severity;
  createdAt: Date;
  thresholds: SlaThresholds;
};

/** What the evaluation has to do next, in the order the slice defines. */
export type SlaStep =
  | { kind: 'WARNING'; clock: SlaClockName; milestone: Milestone }
  | { kind: 'BREACH'; clock: SlaClockName; milestone: Milestone }
  | { kind: 'ESCALATION'; level: EscalationLevel };

/** The threshold of the incident's **current** severity; a severity change never resets the clock. */
export function thresholdMinutes(snapshot: SlaSnapshot, clock: SlaClockName): number {
  const threshold = snapshot.thresholds[snapshot.severity];
  return clock === 'RESPONSE' ? threshold.responseMinutes : threshold.resolutionMinutes;
}

/** Response runs until acknowledgement (an unassign returns to `OPEN`); resolution until resolved. */
export function isClockRunning(status: IncidentStatus, clock: SlaClockName): boolean {
  return clock === 'RESPONSE' ? status === 'OPEN' : status !== 'RESOLVED' && status !== 'CLOSED';
}

/** The instant (epoch ms) from which the 80 % warning is due: reached once 80 % has elapsed. */
export function warningDueAt(snapshot: SlaSnapshot, clock: SlaClockName): number {
  return snapshot.createdAt.getTime() + thresholdMinutes(snapshot, clock) * WARNING_MS_PER_MINUTE;
}

/** The first instant (epoch ms) at which the window is exceeded: strictly after the deadline. */
export function breachDueAt(snapshot: SlaSnapshot, clock: SlaClockName): number {
  return snapshot.createdAt.getTime() + thresholdMinutes(snapshot, clock) * MINUTE_MS + 1;
}

const CLOCKS: readonly SlaClockName[] = ['RESPONSE', 'RESOLUTION'];

/**
 * The first milestone that is due and not yet recorded, or `null`. Order: response warning,
 * response breach, escalation levels (only after the response breach is recorded and while the
 * incident is still `OPEN`; a level is finished once it or its failure is recorded), then the
 * resolution warning and breach. Pure: the caller supplies the clock reading.
 */
export function nextStep(
  snapshot: SlaSnapshot,
  now: Date,
  recorded: ReadonlySet<Milestone>,
): SlaStep | null {
  const nowMs = now.getTime();

  for (const clock of CLOCKS) {
    if (!isClockRunning(snapshot.status, clock)) continue;

    const warning = warningMilestone(clock);
    if (!recorded.has(warning) && nowMs >= warningDueAt(snapshot, clock)) {
      return { kind: 'WARNING', clock, milestone: warning };
    }
    const breach = breachMilestone(clock);
    if (!recorded.has(breach) && nowMs >= breachDueAt(snapshot, clock)) {
      return { kind: 'BREACH', clock, milestone: breach };
    }
    if (clock === 'RESPONSE' && recorded.has(breach)) {
      const level = ESCALATION_LEVELS.find(
        (candidate) =>
          !recorded.has(levelMilestone(candidate)) && !recorded.has(failureMilestone(candidate)),
      );
      if (level !== undefined) return { kind: 'ESCALATION', level };
    }
  }
  return null;
}

export type ScheduledMilestone = { milestone: Milestone; dueAt: number };

/** Warnings and breaches of running clocks that are not yet due or recorded, with their instants. */
export function upcomingMilestones(
  snapshot: SlaSnapshot,
  now: Date,
  recorded: ReadonlySet<Milestone>,
): ScheduledMilestone[] {
  const upcoming: ScheduledMilestone[] = [];
  for (const clock of CLOCKS) {
    if (!isClockRunning(snapshot.status, clock)) continue;
    const candidates: ScheduledMilestone[] = [
      { milestone: warningMilestone(clock), dueAt: warningDueAt(snapshot, clock) },
      { milestone: breachMilestone(clock), dueAt: breachDueAt(snapshot, clock) },
    ];
    for (const candidate of candidates) {
      if (!recorded.has(candidate.milestone) && candidate.dueAt > now.getTime()) {
        upcoming.push(candidate);
      }
    }
  }
  return upcoming;
}
