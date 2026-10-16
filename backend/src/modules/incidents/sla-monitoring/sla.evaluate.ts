import { policyUserViolations, type PolicyLevel } from '../../appService/index.js';
import { runInTransaction, type TransactionClient } from '../../../infra/db/prisma.js';
import { appendAuditEvent } from '../../../infra/audit/append-audit-event.js';
import { logger } from '../../../shared/observability/logger.js';
import { enqueueNotification } from '../../notifications/index.js';
import { INCIDENT_LOCK_TIMEOUT_MS } from '../lifecycle/lifecycle.config.js';
import { setLockTimeout } from '../lifecycle/lifecycle.repository.js';
import { nextStep, type SlaStep } from './sla.calculator.js';
import {
  ALL_MILESTONES,
  escalationAuditEvent,
  failureMilestone,
  levelMilestone,
  type EscalationLevel,
} from './sla.milestones.js';
import { findRecordedMilestones, findResponder, findSlaIncident } from './sla.repository.js';

export type EvaluationDeps = {
  /** The clock; injected so thresholds are testable. */
  now: () => Date;
  /** Correlation id of the outbox event that asked for this evaluation, when there is one. */
  requestId?: string;
};

type StepOutcome = 'NOTHING_DUE' | 'RECORDED' | 'ALREADY_RECORDED';

const LEVEL_FIELD: Record<EscalationLevel, PolicyLevel> = {
  1: 'level1',
  2: 'level2',
  3: 'level3',
  4: 'fallbackAdmin',
};

/**
 * Records the milestone of `step`. The notification goes first: its unique key is the database-level
 * once-only guard, and `created = false` means the milestone was already recorded, so nothing else
 * is written. Audit events are written only where the matrix says Yes.
 */
async function recordStep(
  tx: TransactionClient,
  incident: { id: string; teamId: string; affectedServiceId: string },
  step: SlaStep,
  deps: EvaluationDeps,
): Promise<StepOutcome> {
  const common = {
    incidentId: incident.id,
    ...(deps.requestId === undefined ? {} : { requestId: deps.requestId }),
  };

  if (step.kind === 'WARNING') {
    const { created } = await enqueueNotification(tx, {
      eventType: 'SLA_WARNING',
      occurrenceId: step.milestone,
      ...common,
    });
    if (!created) return 'ALREADY_RECORDED';
    await appendAuditEvent(tx, {
      incidentId: incident.id,
      eventType: 'SLA_WARNING',
      actorId: null,
      metadata: { kind: step.clock },
    });
    return 'RECORDED';
  }

  if (step.kind === 'BREACH') {
    const { created } = await enqueueNotification(tx, {
      eventType: step.clock === 'RESPONSE' ? 'RESPONSE_BREACH' : 'RESOLUTION_BREACH',
      occurrenceId: step.milestone,
      ...common,
    });
    return created ? 'RECORDED' : 'ALREADY_RECORDED';
  }

  const responder = await findResponder(tx, incident.affectedServiceId, step.level);
  const field = LEVEL_FIELD[step.level];
  const invalid =
    responder === null ||
    policyUserViolations(
      { [field]: responder.userId },
      new Map([[responder.userId, responder.facts]]),
      incident.teamId,
    ).length > 0;

  if (invalid) {
    const { created } = await enqueueNotification(tx, {
      eventType: 'ESCALATION_FAILED',
      occurrenceId: failureMilestone(step.level),
      ...common,
    });
    if (created) {
      logger.warn(
        { incidentId: incident.id, level: step.level, outcome: 'escalation_failed' },
        'Escalation responder is invalid; the next level is attempted',
      );
    }
    return created ? 'RECORDED' : 'ALREADY_RECORDED';
  }

  const auditEvent = escalationAuditEvent(step.level);
  const { created } = await enqueueNotification(tx, {
    eventType: auditEvent,
    occurrenceId: levelMilestone(step.level),
    ...common,
  });
  if (!created) return 'ALREADY_RECORDED';
  await appendAuditEvent(tx, {
    incidentId: incident.id,
    eventType: auditEvent,
    actorId: null,
    metadata: { notifiedUser: responder.userId },
  });
  return 'RECORDED';
}

/**
 * One transaction: lock the incident (same lock as the transition kernel), re-read status, severity
 * and acknowledgement under it, and record the first due milestone, if any. An acknowledgement that
 * committed first wins: the incident is no longer `OPEN` and no escalation happens.
 */
async function evaluateOnce(
  tx: TransactionClient,
  incidentId: string,
  deps: EvaluationDeps,
): Promise<{ outcome: StepOutcome; step: SlaStep | null }> {
  await setLockTimeout(tx, INCIDENT_LOCK_TIMEOUT_MS);
  const incident = await findSlaIncident(tx, incidentId, { lock: true });
  if (!incident) return { outcome: 'NOTHING_DUE', step: null };

  const recorded = await findRecordedMilestones(tx, incidentId);
  const step = nextStep(incident, deps.now(), recorded);
  if (!step) return { outcome: 'NOTHING_DUE', step: null };

  return { outcome: await recordStep(tx, incident, step, deps), step };
}

/**
 * Evaluates one incident until nothing is due: every due milestone is recorded once, in its own
 * transaction, so an escalation level re-verifies the incident under the lock. Safe to call any
 * number of times and from any number of workers: the milestone's unique notification key makes
 * a repeat a no-op. Returns how many milestones this call recorded.
 */
export async function evaluateIncident(incidentId: string, deps: EvaluationDeps): Promise<number> {
  let recordedCount = 0;
  // Every pass records or skips one of at most ALL_MILESTONES.length milestones.
  for (let pass = 0; pass <= ALL_MILESTONES.length; pass += 1) {
    const { outcome, step } = await runInTransaction((tx) => evaluateOnce(tx, incidentId, deps));
    if (outcome === 'NOTHING_DUE') break;
    if (outcome === 'RECORDED') {
      recordedCount += 1;
      logger.info(
        {
          incidentId,
          step: step?.kind,
          ...(step?.kind === 'ESCALATION' ? { level: step.level } : { milestone: step?.milestone }),
          requestId: deps.requestId,
          outcome: 'milestone_recorded',
        },
        'SLA milestone recorded',
      );
    }
  }
  return recordedCount;
}
