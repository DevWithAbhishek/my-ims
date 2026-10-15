import { appendAuditEvent } from '../../../infra/audit/append-audit-event.js';
import { getPrisma } from '../../../infra/db/prisma.js';
import { enqueueOutbox } from '../../../infra/jobs/index.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import { requireTeam } from '../../identity/index.js';
import { enqueueNotification } from '../../notifications/index.js';
import {
  assertIncidentAccess,
  runIncidentTransaction,
  withDatabaseOutageMapping,
  type Db,
} from '../incidents.common.js';
import { INCIDENT_LOCK_TIMEOUT_MS } from './lifecycle.config.js';
import {
  findTransitionScope,
  lockIncidentForUpdate,
  setLockTimeout,
  updateIncident,
} from './lifecycle.repository.js';
import type { LockedIncident, Plan, TransitionScope } from './lifecycle.types.js';

export type TransitionRequest<T> = {
  auth: AuthContext;
  incidentId: string;
  /** Carried in every outbox payload for log correlation. */
  requestId?: string;
  /** Gate 2 beyond the team gate and body validation, before any lock (chain membership, …). */
  gate?: (scope: TransitionScope) => Promise<void> | void;
  /**
   * Under the lock: re-check the state and the role-by-state rules, then decide the change. It
   * may add writes of its own on `tx` (other rows), which commit with the transition.
   */
  decide: (tx: Db, incident: LockedIncident) => Promise<Plan> | Plan;
  /** Builds the response on the same transaction, after the writes. */
  respond: (tx: Db) => Promise<T>;
  lockTimeoutMs?: number;
};

/**
 * The transition kernel. One transaction: load and apply the team gate, lock the incident row
 * with a bounded wait, `decide` under the lock, apply the changes, append the audit events in
 * order, write the outbox events and one notification per audit event (`occurrenceId` = that
 * event's id), then commit. Nothing external runs inside it. A lock timeout or deadlock is
 * `409 CONCURRENCY_CONFLICT`; a database outage `503`.
 */
export async function runTransition<T>(request: TransitionRequest<T>): Promise<T> {
  const { auth, incidentId } = request;
  requireTeam(auth);

  const scope = await withDatabaseOutageMapping(() => findTransitionScope(getPrisma(), incidentId));
  assertIncidentAccess(auth, scope);
  await request.gate?.(scope);

  return runIncidentTransaction(async (tx) => {
    await setLockTimeout(tx, request.lockTimeoutMs ?? INCIDENT_LOCK_TIMEOUT_MS);
    const incident = await lockIncidentForUpdate(tx, incidentId);
    assertIncidentAccess(auth, incident);

    const plan = await request.decide(tx, incident);
    if (Object.keys(plan.changes).length > 0) await updateIncident(tx, incidentId, plan.changes);

    const occurrences: {
      eventType: Plan['events'][number]['eventType'];
      id: string;
      subjectUserId?: string;
    }[] = [];
    for (const event of plan.events) {
      const id = await appendAuditEvent(tx, {
        incidentId,
        eventType: event.eventType,
        actorId: auth.userId,
        metadata: event.metadata,
      });
      occurrences.push({ eventType: event.eventType, id, subjectUserId: event.subjectUserId });
    }
    for (const step of plan.outbox) {
      await enqueueOutbox(tx, {
        ...step,
        payload: {
          ...step.payload,
          ...(request.requestId ? { requestId: request.requestId } : {}),
        },
      });
    }
    for (const occurrence of occurrences) {
      await enqueueNotification(tx, {
        eventType: occurrence.eventType,
        occurrenceId: occurrence.id,
        incidentId,
        serviceId: incident.affectedServiceId,
        teamId: incident.teamId,
        ...(occurrence.subjectUserId === undefined
          ? {}
          : { subjectUserId: occurrence.subjectUserId }),
      });
    }
    return request.respond(tx);
  });
}
