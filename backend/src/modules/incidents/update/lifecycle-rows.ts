import {
  acknowledgeIncident,
  assignIncident,
  changeSeverity,
  confirmSeverity,
  resolveIncident,
  unassignIncident,
} from '../lifecycle/lifecycle.service.js';
import type { UpdateRow } from './incident-update.dispatcher.js';

const only =
  (...names: string[]) =>
  (fields: string[]) =>
    fields.length === names.length && names.every((name) => fields.includes(name));

const respond = (data: unknown) => ({ status: 200, data });

/** I3: exactly `{ status: ACKNOWLEDGED }`. */
const acknowledgeRow: UpdateRow = {
  id: 'I3',
  matches: (fields, body) => only('status')(fields) && body.status === 'ACKNOWLEDGED',
  handle: async ({ auth, incidentId, requestId }) =>
    respond(await acknowledgeIncident(auth, incidentId, requestId)),
};

/** I4: exactly `{ status: MITIGATING, severity }`. */
const confirmSeverityRow: UpdateRow = {
  id: 'I4',
  matches: (fields, body) => only('status', 'severity')(fields) && body.status === 'MITIGATING',
  handle: async ({ auth, incidentId, body, requestId }) =>
    respond(
      await confirmSeverity(
        auth,
        incidentId,
        body.severity as NonNullable<typeof body.severity>,
        requestId,
      ),
    ),
};

/** I5: exactly `{ severity }`. */
const changeSeverityRow: UpdateRow = {
  id: 'I5',
  matches: only('severity'),
  handle: async ({ auth, incidentId, body, requestId }) =>
    respond(
      await changeSeverity(
        auth,
        incidentId,
        body.severity as NonNullable<typeof body.severity>,
        requestId,
      ),
    ),
};

/** I6: exactly `{ currentAssignee: <uuid> }`. */
const assignRow: UpdateRow = {
  id: 'I6',
  matches: (fields, body) => only('currentAssignee')(fields) && body.currentAssignee !== null,
  handle: async ({ auth, incidentId, body, requestId }) =>
    respond(await assignIncident(auth, incidentId, body.currentAssignee as string, requestId)),
};

/** I7: exactly `{ currentAssignee: null, status: OPEN }`. */
const unassignRow: UpdateRow = {
  id: 'I7',
  matches: (fields, body) =>
    only('currentAssignee', 'status')(fields) &&
    body.currentAssignee === null &&
    body.status === 'OPEN',
  handle: async ({ auth, incidentId, requestId }) =>
    respond(await unassignIncident(auth, incidentId, requestId)),
};

/**
 * I8: `status: RESOLVED` with `resolutionSummary` and `serviceConfirmedWorking` and nothing else.
 * Matching only needs the status; a missing summary is `422` and a flag other than `true` is
 * `400`, decided after the team gate.
 */
const resolveRow: UpdateRow = {
  id: 'I8',
  matches: (fields, body) =>
    body.status === 'RESOLVED' &&
    fields.every((field) =>
      ['status', 'resolutionSummary', 'serviceConfirmedWorking'].includes(field),
    ),
  handle: async ({ auth, incidentId, body, requestId }) =>
    respond(
      await resolveIncident(
        auth,
        incidentId,
        {
          resolutionSummary: body.resolutionSummary,
          serviceConfirmedWorking: body.serviceConfirmedWorking,
        },
        requestId,
      ),
    ),
};

export const LIFECYCLE_ROWS: readonly UpdateRow[] = [
  acknowledgeRow,
  confirmSeverityRow,
  changeSeverityRow,
  assignRow,
  unassignRow,
  resolveRow,
];
