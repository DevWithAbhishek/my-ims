import { getPrisma } from '../../infra/db/prisma.js';
import { NotFoundError } from '../../shared/errors/AppError.js';
import type { AuthContext } from '../../shared/types/auth-context.js';
import { assertCanAccessIncident } from '../incidents/index.js';
import { toAlertDetail } from './alert.mapper.js';
import { findAlertOfIncident } from './alert.repository.js';
import type { AlertDetailResponse } from './alerts.types.js';

/** I12: the incident's gates first, then the alert, which must belong to that incident. */
export async function getAlertDetail(
  auth: AuthContext,
  incidentId: string,
  alertId: string,
): Promise<AlertDetailResponse> {
  await assertCanAccessIncident(auth, incidentId);

  const row = await findAlertOfIncident(getPrisma(), incidentId, alertId);
  if (row === null) {
    throw new NotFoundError('Alert not found', 'ALERT_NOT_FOUND', [{ resource: 'alert' }]);
  }
  return toAlertDetail(row);
}
