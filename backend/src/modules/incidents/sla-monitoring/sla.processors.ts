import { z } from 'zod';
import { getPrisma } from '../../../infra/db/prisma.js';
import {
  NonRetryableJobError,
  type DelayedJobProcessor,
  type DelayedJobScheduler,
  type OutboxProcessor,
} from '../../../infra/jobs/index.js';
import { logger } from '../../../shared/observability/logger.js';
import { evaluateIncident } from './sla.evaluate.js';
import { isMilestone } from './sla.milestones.js';
import { findScanCandidates } from './sla.repository.js';
import { scheduleMilestoneJobs, SLA_MILESTONE_JOB } from './sla.schedule.js';

export type SlaDeps = {
  now?: () => Date;
  scheduler: DelayedJobScheduler;
};

const clock = (deps: { now?: () => Date }): (() => Date) => deps.now ?? (() => new Date());

/**
 * Consumer of `SLA_EVALUATION_REQUESTED` (written by ingestion and by severity and unassign
 * changes): records what is already overdue, then (re)schedules the delayed jobs for what is
 * still ahead under the incident's current severity.
 */
export function createSlaEvaluationProcessor(deps: SlaDeps): OutboxProcessor {
  const now = clock(deps);
  return async ({ payload }) => {
    const { incidentId, requestId } = payload as { incidentId: string; requestId?: string };
    await evaluateIncident(incidentId, { now, ...(requestId === undefined ? {} : { requestId }) });
    await scheduleMilestoneJobs(incidentId, { now, scheduler: deps.scheduler });
  };
}

const milestoneJobData = z.object({
  incidentId: z.uuid(),
  milestone: z.string().refine(isMilestone),
});

/**
 * Consumer of the delayed milestone jobs. The job only says *when* to look: the evaluation decides
 * from the incident's state under its lock, so a stale job (acknowledged, resolved, severity
 * changed) is a harmless no-op. Afterwards it schedules what is still ahead (a milestone further
 * away than one delay allows is scheduled in several steps).
 */
export function createSlaMilestoneProcessor(deps: SlaDeps): DelayedJobProcessor {
  const now = clock(deps);
  return async ({ name, data }) => {
    if (name !== SLA_MILESTONE_JOB) {
      throw new NonRetryableJobError('UNSUPPORTED_EVENT_TYPE', 'Unsupported delayed job');
    }
    const parsed = milestoneJobData.safeParse(data);
    if (!parsed.success) {
      throw new NonRetryableJobError('INVALID_PAYLOAD', 'Invalid delayed job data');
    }
    await evaluateIncident(parsed.data.incidentId, { now });
    await scheduleMilestoneJobs(parsed.data.incidentId, { now, scheduler: deps.scheduler });
  };
}

export type ScanResult = { candidates: number; recorded: number; failed: number };

/**
 * The PostgreSQL safety net: finds unresolved incidents whose thresholds were crossed without the
 * milestone being recorded and evaluates each one. A milestone stays a candidate until its record
 * exists, so every pass retries what an earlier pass, a lost delayed job or an exhausted job left
 * undone; one failing incident never stops the others.
 */
export async function runSlaScan(deps: { now?: () => Date } = {}): Promise<ScanResult> {
  const now = clock(deps);
  const candidates = await findScanCandidates(getPrisma(), now());

  let recorded = 0;
  let failed = 0;
  for (const incidentId of candidates) {
    try {
      recorded += await evaluateIncident(incidentId, { now });
    } catch (err) {
      failed += 1;
      logger.error(
        { err, incidentId, outcome: 'sla_scan_incident_failed' },
        'SLA scan could not evaluate an incident; it is retried on the next scan',
      );
    }
  }
  if (candidates.length > 0) {
    logger.info(
      { candidates: candidates.length, recorded, failed, outcome: 'sla_scan' },
      'SLA scan finished',
    );
  }
  return { candidates: candidates.length, recorded, failed };
}
