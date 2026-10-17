import { AppError } from '../../../shared/errors/AppError.js';
import { parseOrThrow } from '../../../shared/errors/zod.js';
import { selectPostmortemRow } from './postmortem.dispatcher.js';
import { updatePostmortemBodySchema } from './postmortem.schema.js';

const select = (body: unknown) =>
  selectPostmortemRow(parseOrThrow(updatePostmortemBodySchema, body));
const failure = (body: unknown): AppError => {
  try {
    select(body);
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('PATCH /incidents/:incidentId/postmortem row matching', () => {
  it.each([
    [{ summary: 'text' }, 'P2'],
    [{ unknowns: null }, 'P2'],
    [{ riskLevel: 'P0', impact: 'text', contributingFactors: 'text' }, 'P2'],
    [{ reviewStatus: 'REVIEWED' }, 'P3'],
    [{ generationStatus: 'GENERATING' }, 'P4'],
  ])('%j matches %s', (body, id) => {
    expect(select(body).id).toBe(id);
  });

  it.each([
    [{}],
    [{ summary: 'text', reviewStatus: 'REVIEWED' }],
    [{ reviewStatus: 'REVIEWED', generationStatus: 'GENERATING' }],
    [{ riskLevel: 'P1', generationStatus: 'GENERATING' }],
  ])('%j matches no row: 422 VALIDATION_FAILED', (body) => {
    const error = failure(body);
    expect(error).toMatchObject({ statusCode: 422, code: 'VALIDATION_FAILED' });
  });

  it.each([
    [{ reviewStatus: 'PENDING' }],
    [{ reviewStatus: 'REJECTED' }],
    [{ generationStatus: 'FAILED' }],
    [{ generationStatus: 'DRAFT' }],
    [{ summary: '' }],
    [{ summary: '   ' }],
    [{ summary: 'x'.repeat(20_001) }],
    [{ unknowns: '' }],
    [{ riskLevel: 'P4' }],
    [{ summary: 5 }],
  ])('%j is invalid: 422 VALIDATION_FAILED, before any state check', (body) => {
    expect(failure(body)).toMatchObject({ statusCode: 422, code: 'VALIDATION_FAILED' });
  });

  it.each([['mttrMinutes'], ['provenance'], ['review'], ['prompt'], ['inputData'], ['factors']])(
    'the non-editable or unknown field %s is 400 BAD_REQUEST',
    (field) => {
      expect(failure({ summary: 'text', [field]: 1 })).toMatchObject({
        statusCode: 400,
        code: 'BAD_REQUEST',
      });
    },
  );

  it('accepts a text of exactly 20,000 characters and trims it', () => {
    expect(select({ summary: 'x'.repeat(20_000) }).id).toBe('P2');
    expect(parseOrThrow(updatePostmortemBodySchema, { summary: '  padded  ' }).summary).toBe(
      'padded',
    );
  });
});
