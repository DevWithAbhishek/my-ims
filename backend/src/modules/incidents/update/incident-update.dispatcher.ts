import { ValidationError } from '../../../shared/errors/AppError.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import { addComment } from '../comments/comment.service.js';
import { LIFECYCLE_ROWS } from './lifecycle-rows.js';
import type { UpdateIncidentBody } from './incident-update.schema.js';

export type UpdateContext = {
  auth: AuthContext;
  incidentId: string;
  body: UpdateIncidentBody;
  requestId: string;
};
export type UpdateResult = { status: number; data: unknown };

/** One action of `PATCH /incidents/:incidentId` (I3–I8, I10): the body shape it owns and its handler. */
export type UpdateRow = {
  id: string;
  matches: (presentFields: string[], body: UpdateIncidentBody) => boolean;
  handle: (context: UpdateContext) => Promise<UpdateResult>;
};

/** I10: exactly `{ comment }`. */
const commentRow: UpdateRow = {
  id: 'I10',
  matches: (fields) => fields.length === 1 && fields[0] === 'comment',
  handle: async ({ auth, incidentId, body }) => ({
    status: 201,
    data: await addComment(auth, incidentId, body.comment as NonNullable<typeof body.comment>),
  }),
};

export const UPDATE_ROWS: readonly UpdateRow[] = [...LIFECYCLE_ROWS, commentRow];

/** The names of the fields the request actually carries (`null` counts as present). */
export function presentFields(body: UpdateIncidentBody): string[] {
  return Object.entries(body)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

/** A request must match exactly one row; none or several is `422 VALIDATION_FAILED`. */
export function selectRow(body: UpdateIncidentBody, rows: readonly UpdateRow[] = UPDATE_ROWS) {
  const fields = presentFields(body);
  const matching = rows.filter((row) => row.matches(fields, body));
  if (matching.length !== 1) {
    throw new ValidationError(
      'Request must match exactly one incident action',
      'VALIDATION_FAILED',
      [{ field: '', issue: 'Request must match exactly one incident action' }],
    );
  }
  return matching[0];
}
