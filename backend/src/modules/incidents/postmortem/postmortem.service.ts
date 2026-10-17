import { getPrisma } from '../../../infra/db/prisma.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import { getEscalationPolicyByService } from '../../appService/index.js';
import { requireTeam } from '../../identity/index.js';
import { findIncidentScope } from '../incident.repository.js';
import { assertIncidentAccess, withDatabaseOutageMapping, type Db } from '../incidents.common.js';
import { assertChainMember } from '../lifecycle/lifecycle.rules.js';
import { NO_CHANGE } from '../lifecycle/lifecycle.types.js';
import { runTransition } from '../lifecycle/transition.kernel.js';
import { toPostmortemResponse } from './postmortem.mapper.js';
import { planClosure } from './postmortem.plans.js';
import {
  findIncidentTimes,
  findPostmortemRow,
  lockPostmortemForUpdate,
  markPostmortemGenerating,
  markPostmortemReviewed,
  populateManualPostmortem,
  updatePostmortemContent,
} from './postmortem.repository.js';
import {
  assertManuallyCreatable,
  assertRetryable,
  assertReviewable,
  computeMttrMinutes,
  postmortemNotFound,
} from './postmortem.rules.js';
import type { CreatePostmortemBody } from './postmortem.schema.js';
import type { PostmortemContentUpdate, PostmortemResponse } from './postmortem.types.js';

async function respondWith(tx: Db, incidentId: string): Promise<PostmortemResponse> {
  const row = await findPostmortemRow(tx, incidentId);
  if (row === null) throw postmortemNotFound();
  return toPostmortemResponse(row);
}

/** Gate 2 beyond the team gate: the caller must be one of the four users of the service's policy. */
const chainGate = (auth: AuthContext) => async (scope: { affectedServiceId: string }) =>
  assertChainMember(await getEscalationPolicyByService(scope.affectedServiceId), auth.userId);

/** P1: the incident's postmortem. Any role of the incident's team. */
export async function getPostmortem(
  auth: AuthContext,
  incidentId: string,
): Promise<PostmortemResponse> {
  requireTeam(auth);
  return withDatabaseOutageMapping(async () => {
    const db = getPrisma();
    assertIncidentAccess(auth, await findIncidentScope(db, incidentId));
    const row = await findPostmortemRow(db, incidentId);
    if (row === null) throw postmortemNotFound();
    return toPostmortemResponse(row);
  });
}

/**
 * P2 edit. Under the incident and postmortem locks the state is re-checked and only the sent
 * fields are written; the review fields stay as they are and no event or notification is written.
 */
export function editPostmortem(
  auth: AuthContext,
  incidentId: string,
  fields: PostmortemContentUpdate,
  requestId: string,
) {
  return runTransition({
    auth,
    incidentId,
    requestId,
    decide: async (tx, incident) => {
      const postmortem = await lockPostmortemForUpdate(tx, incidentId);
      assertReviewable(postmortem, incident.status);
      await updatePostmortemContent(tx, postmortem.id, fields);
      return NO_CHANGE;
    },
    respond: (tx) => respondWith(tx, incidentId),
  });
}

/**
 * P3 approve. Chain members only. One transaction: the review, the closure of the incident, both
 * audit events in order and both notifications.
 */
export function approvePostmortem(auth: AuthContext, incidentId: string, requestId: string) {
  return runTransition({
    auth,
    incidentId,
    requestId,
    gate: chainGate(auth),
    decide: async (tx, incident) => {
      const postmortem = await lockPostmortemForUpdate(tx, incidentId);
      assertReviewable(postmortem, incident.status);
      const now = new Date();
      await markPostmortemReviewed(tx, postmortem.id, auth.userId, now);
      return planClosure(postmortem.id, auth.userId, now);
    },
    respond: (tx) => respondWith(tx, incidentId),
  });
}

/** P4 retry. Back to `GENERATING` and a new generation request in the outbox, in one transaction. */
export function retryPostmortemGeneration(
  auth: AuthContext,
  incidentId: string,
  requestId: string,
) {
  return runTransition({
    auth,
    incidentId,
    requestId,
    decide: async (tx, incident) => {
      const postmortem = await lockPostmortemForUpdate(tx, incidentId);
      assertRetryable(postmortem, incident.status);
      await markPostmortemGenerating(tx, postmortem.id);
      return {
        changes: {},
        events: [],
        outbox: [
          {
            eventType: 'POSTMORTEM_GENERATION_REQUESTED' as const,
            aggregateType: 'POSTMORTEM',
            aggregateId: postmortem.id,
            payload: { postmortemId: postmortem.id, incidentId },
          },
        ],
      };
    },
    respond: (tx) => respondWith(tx, incidentId),
  });
}

/**
 * P5 manual create. Chain members only. The `FAILED` row is reused and populated, and the incident
 * is closed with the same two events and notifications as P3, in one transaction.
 */
export function createManualPostmortem(
  auth: AuthContext,
  incidentId: string,
  content: CreatePostmortemBody,
  requestId: string,
) {
  return runTransition({
    auth,
    incidentId,
    requestId,
    gate: chainGate(auth),
    decide: async (tx, incident) => {
      const postmortem = await lockPostmortemForUpdate(tx, incidentId);
      assertManuallyCreatable(postmortem, incident.status);
      const times = await findIncidentTimes(tx, incidentId);
      const now = new Date();
      await populateManualPostmortem(
        tx,
        postmortem.id,
        content,
        computeMttrMinutes(times.createdAt, times.resolvedAt),
        auth.userId,
        now,
      );
      return planClosure(postmortem.id, auth.userId, now);
    },
    respond: (tx) => respondWith(tx, incidentId),
  });
}
