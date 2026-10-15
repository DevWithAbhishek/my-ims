import { AppError } from '../../../shared/errors/AppError.js';
import { parseOrThrow } from '../../../shared/errors/zod.js';
import { selectRow } from './incident-update.dispatcher.js';
import { updateIncidentBodySchema } from './incident-update.schema.js';

const USER = '0198c3a0-7c1e-7a45-8a40-1f2f3a4b5c6d';
const rowOf = (body: unknown) => selectRow(parseOrThrow(updateIncidentBodySchema, body)).id;
const failure = (body: unknown) => {
  try {
    rowOf(body);
  } catch (error) {
    const { statusCode, code } = error as AppError;
    return { statusCode, code };
  }
  throw new Error('matched a row');
};

describe('exactly-one-row matching of the lifecycle actions', () => {
  it.each([
    ['I3', { status: 'ACKNOWLEDGED' }],
    ['I4', { status: 'MITIGATING', severity: 'P1' }],
    ['I5', { severity: 'P2' }],
    ['I6', { currentAssignee: USER }],
    ['I7', { currentAssignee: null, status: 'OPEN' }],
    ['I8', { status: 'RESOLVED', resolutionSummary: 'fixed', serviceConfirmedWorking: true }],
    ['I10', { comment: { body: 'hi' } }],
  ])('%s matches its documented body', (id, body) => {
    expect(rowOf(body)).toBe(id);
  });

  it('routes an incomplete or false I8 body to the resolve row (its handler answers 422 / 400)', () => {
    expect(rowOf({ status: 'RESOLVED' })).toBe('I8');
    expect(
      rowOf({ status: 'RESOLVED', resolutionSummary: 'x', serviceConfirmedWorking: false }),
    ).toBe('I8');
  });

  it.each([
    ['an empty body', {}],
    ['status OPEN alone', { status: 'OPEN' }],
    ['status MITIGATING without severity', { status: 'MITIGATING' }],
    ['status ACKNOWLEDGED with severity', { status: 'ACKNOWLEDGED', severity: 'P1' }],
    ['an assignee with a status', { currentAssignee: USER, status: 'OPEN' }],
    ['an assignee with a severity', { currentAssignee: USER, severity: 'P1' }],
    ['a null assignee with ACKNOWLEDGED', { currentAssignee: null, status: 'ACKNOWLEDGED' }],
    ['a severity next to a resolve', { status: 'RESOLVED', severity: 'P1' }],
    ['a resolution summary without status', { resolutionSummary: 'x' }],
    ['a comment next to an action', { comment: { body: 'x' }, status: 'ACKNOWLEDGED' }],
  ])('%s matches no row: 422', (_name, body) => {
    expect(failure(body)).toEqual({ statusCode: 422, code: 'VALIDATION_FAILED' });
  });
});
