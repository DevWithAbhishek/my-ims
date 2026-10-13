import { z } from 'zod';
import { invalidCursor } from './incidents.common.js';

export const ORDER_BY_VALUES = [
  'createdAt',
  'severity',
  'status',
  'title',
  'affectedServiceId',
  'teamId',
] as const;
export type OrderBy = (typeof ORDER_BY_VALUES)[number];
export type Sort = 'asc' | 'desc';

/** The last row of a page: its sort value (as text) and `id`, bound to the ordering it was issued under. */
export type Cursor = { orderBy: OrderBy; sort: Sort; value: string; id: string };

const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
const STATUSES = ['OPEN', 'ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'CLOSED'];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Whether `value` is a well-formed sort value for `orderBy` (it is later cast by the database). */
function isValidSortValue(orderBy: OrderBy, value: string): boolean {
  switch (orderBy) {
    case 'createdAt':
      return ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
    case 'severity':
      return SEVERITIES.includes(value);
    case 'status':
      return STATUSES.includes(value);
    case 'title':
      return !value.includes('\u0000');
    case 'affectedServiceId':
    case 'teamId':
      return z.uuid().safeParse(value).success;
  }
}

const wireSchema = z
  .object({
    o: z.enum(ORDER_BY_VALUES),
    s: z.enum(['asc', 'desc']),
    v: z.string(),
    id: z.uuid(),
  })
  .strict();

/** Opaque, unsigned: team scope is applied again on every request. */
export function encodeCursor(cursor: Cursor): string {
  const wire = { o: cursor.orderBy, s: cursor.sort, v: cursor.value, id: cursor.id };
  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor for the ordering of the current request. Anything undecodable, of the wrong
 * shape, with an invalid sort value or issued under another `orderBy`/`sort` is `INVALID_CURSOR`.
 */
export function decodeCursor(raw: string, expected: { orderBy: OrderBy; sort: Sort }): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const wire = wireSchema.safeParse(parsed);
  if (!wire.success) throw invalidCursor();

  const { o, s, v, id } = wire.data;
  if (o !== expected.orderBy || s !== expected.sort || !isValidSortValue(o, v)) {
    throw invalidCursor();
  }
  return { orderBy: o, sort: s, value: v, id };
}
