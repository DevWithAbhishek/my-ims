import { AppError } from '../../../shared/errors/AppError.js';
import { parseOrThrow } from '../../../shared/errors/zod.js';
import {
  presentFields,
  selectRow,
  UPDATE_ROWS,
  type UpdateRow,
} from './incident-update.dispatcher.js';
import { updateIncidentBodySchema } from './incident-update.schema.js';

const parse = (body: unknown) => parseOrThrow(updateIncidentBodySchema, body);
const code = (fn: () => unknown): { status: number; code: string } => {
  try {
    fn();
  } catch (error) {
    const { statusCode, code: errorCode } = error as AppError;
    return { status: statusCode, code: errorCode };
  }
  throw new Error('did not throw');
};

describe('update body schema', () => {
  it('trims the comment body and keeps the title as sent', () => {
    expect(parse({ comment: { title: 'T', body: '  hello  ' } })).toEqual({
      comment: { title: 'T', body: 'hello' },
    });
  });

  it.each([
    ['whitespace-only body', { comment: { body: '   ' } }],
    ['missing body', { comment: { title: 'x' } }],
    ['body over 10,000 characters', { comment: { body: 'a'.repeat(10_001) } }],
    ['title over 200 characters', { comment: { title: 'a'.repeat(201), body: 'x' } }],
    ['malformed assignee', { currentAssignee: 'nope' }],
    ['unknown status', { status: 'CLOSED' }],
  ])('rejects %s with 422', (_name, body) => {
    expect(code(() => parse(body))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
  });

  it.each([
    ['an unknown top-level field', { comment: { body: 'x' }, author: 'me' }],
    ['an unknown comment field', { comment: { body: 'x', authorId: 'me' } }],
  ])('rejects %s with 400', (_name, body) => {
    expect(code(() => parse(body))).toEqual({ status: 400, code: 'BAD_REQUEST' });
  });

  it('accepts the maximum body and title lengths', () => {
    expect(() =>
      parse({ comment: { title: 'a'.repeat(200), body: 'a'.repeat(10_000) } }),
    ).not.toThrow();
  });
});

describe('selectRow', () => {
  it('selects the comment row for exactly { comment }', () => {
    expect(selectRow(parse({ comment: { body: 'x' } })).id).toBe('I10');
  });

  it.each([
    ['an empty body', {}],
    ['an action owned by another slice', { status: 'ACKNOWLEDGED' }],
    ['a null assignee (present, matches no row yet)', { currentAssignee: null }],
    ['a comment combined with another field', { comment: { body: 'x' }, severity: 'P1' }],
  ])('rejects %s with 422', (_name, body) => {
    expect(code(() => selectRow(parse(body)))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
  });

  it('rejects a body that matches more than one row', () => {
    const row = (id: string): UpdateRow => ({
      id,
      matches: () => true,
      handle: () => Promise.reject(new Error('unused')),
    });
    expect(code(() => selectRow(parse({ severity: 'P1' }), [row('a'), row('b')])).status).toBe(422);
    expect(selectRow(parse({ severity: 'P1' }), [row('a')]).id).toBe('a');
  });

  it('counts null as a present field and ignores undefined', () => {
    expect(presentFields(parse({ currentAssignee: null, severity: 'P1' })).sort()).toEqual([
      'currentAssignee',
      'severity',
    ]);
    expect(UPDATE_ROWS.map((row) => row.id)).toEqual(['I10']);
  });
});
