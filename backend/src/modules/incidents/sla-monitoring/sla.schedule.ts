import { getPrisma } from '../../../infra/db/prisma.js';
import { QUEUES, type DelayedJobScheduler } from '../../../infra/jobs/index.js';
import { upcomingMilestones } from './sla.calculator.js';
import { findRecordedMilestones, findSlaIncident } from './sla.repository.js';

/** Name of the delayed job that evaluates an incident at a milestone's precise time. */
export const SLA_MILESTONE_JOB = 'SLA_MILESTONE';

/**
 * Longest single delay handed to the queue (the largest 32-bit signed integer, in milliseconds).
 * A milestone further away is scheduled for this long and re-scheduled when that job runs.
 */
export const MAX_SINGLE_DELAY_MS = 2_147_483_647;

/**
 * Schedules a delayed job for every warning and breach of the incident that is not yet due or
 * recorded, at its precise instant. The job id is deterministic, so scheduling again (after a
 * severity change, an unassign, or a lost job) replaces the waiting job instead of adding another.
 */
export async function scheduleMilestoneJobs(
  incidentId: string,
  deps: { now: () => Date; scheduler: DelayedJobScheduler },
): Promise<number> {
  const db = getPrisma();
  const incident = await findSlaIncident(db, incidentId, { lock: false });
  if (!incident) return 0;

  const now = deps.now();
  const recorded = await findRecordedMilestones(db, incidentId);
  const upcoming = upcomingMilestones(incident, now, recorded);

  for (const { milestone, dueAt } of upcoming) {
    await deps.scheduler.scheduleDelayed(QUEUES.SLA_ESCALATION, {
      jobId: `sla-${incidentId}-${milestone}`,
      name: SLA_MILESTONE_JOB,
      data: { incidentId, milestone },
      delayMs: Math.min(dueAt - now.getTime(), MAX_SINGLE_DELAY_MS),
    });
  }
  return upcoming.length;
}
