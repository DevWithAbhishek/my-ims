import { ValidationError } from '../../../shared/errors/AppError.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import {
  approvePostmortem,
  editPostmortem,
  retryPostmortemGeneration,
} from './postmortem.service.js';
import type { UpdatePostmortemBody } from './postmortem.schema.js';
import {
  POSTMORTEM_CONTENT_FIELDS,
  type PostmortemContentUpdate,
  type PostmortemResponse,
} from './postmortem.types.js';

export type PostmortemUpdateContext = {
  auth: AuthContext;
  incidentId: string;
  body: UpdatePostmortemBody;
  requestId: string;
};

/** One action of `PATCH /incidents/:incidentId/postmortem` (P2, P3, P4). */
export type PostmortemUpdateRow = {
  id: 'P2' | 'P3' | 'P4';
  matches: (presentFields: string[]) => boolean;
  handle: (context: PostmortemUpdateContext) => Promise<PostmortemResponse>;
};

const contentFields: readonly string[] = POSTMORTEM_CONTENT_FIELDS;

/** P2: one or more content fields and nothing else. */
const editRow: PostmortemUpdateRow = {
  id: 'P2',
  matches: (fields) => fields.length > 0 && fields.every((field) => contentFields.includes(field)),
  handle: ({ auth, incidentId, body, requestId }) =>
    editPostmortem(auth, incidentId, contentOf(body), requestId),
};

/** P3: exactly `{ reviewStatus: REVIEWED }`. */
const approveRow: PostmortemUpdateRow = {
  id: 'P3',
  matches: (fields) => fields.length === 1 && fields[0] === 'reviewStatus',
  handle: ({ auth, incidentId, requestId }) => approvePostmortem(auth, incidentId, requestId),
};

/** P4: exactly `{ generationStatus: GENERATING }`. */
const retryRow: PostmortemUpdateRow = {
  id: 'P4',
  matches: (fields) => fields.length === 1 && fields[0] === 'generationStatus',
  handle: ({ auth, incidentId, requestId }) =>
    retryPostmortemGeneration(auth, incidentId, requestId),
};

export const POSTMORTEM_UPDATE_ROWS: readonly PostmortemUpdateRow[] = [
  editRow,
  approveRow,
  retryRow,
];

/** The content fields the request carries (`null` counts as present). */
function contentOf(body: UpdatePostmortemBody): PostmortemContentUpdate {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) => value !== undefined && contentFields.includes(key),
    ),
  ) as PostmortemContentUpdate;
}

/** The names of the fields the request actually carries (`null` counts as present). */
export function presentFields(body: UpdatePostmortemBody): string[] {
  return Object.entries(body)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

/** A request must match exactly one row; none or several is `422 VALIDATION_FAILED`. */
export function selectPostmortemRow(
  body: UpdatePostmortemBody,
  rows: readonly PostmortemUpdateRow[] = POSTMORTEM_UPDATE_ROWS,
): PostmortemUpdateRow {
  const fields = presentFields(body);
  const matching = rows.filter((row) => row.matches(fields));
  if (matching.length !== 1) {
    throw new ValidationError(
      'Request must match exactly one postmortem action',
      'VALIDATION_FAILED',
      [{ field: '', issue: 'Request must match exactly one postmortem action' }],
    );
  }
  return matching[0];
}
