import { zodErrorToAppError } from '../../../shared/errors/zod.js';
import { createServiceBodySchema, updateServiceBodySchema } from './service.schema.js';

const uuid = 'a0000000-0000-4000-8000-00000000000a';

const validCreate = {
  name: 'checkout',
  P0ResponseSlaMinutes: 5,
  P0ResolutionSlaMinutes: 30,
  P1ResponseSlaMinutes: 10,
  P1ResolutionSlaMinutes: 60,
  P2ResponseSlaMinutes: 30,
  P2ResolutionSlaMinutes: 120,
  P3ResponseSlaMinutes: 60,
  P3ResolutionSlaMinutes: 240,
  teamId: uuid,
  escalationPolicy: { level1: uuid, level2: uuid, level3: uuid, fallbackAdmin: uuid },
};

function failure(
  schema: typeof createServiceBodySchema | typeof updateServiceBodySchema,
  body: unknown,
) {
  const result = schema.safeParse(body);
  if (result.success) throw new Error('expected a validation failure');
  return zodErrorToAppError(result.error);
}

describe('createServiceBodySchema', () => {
  it('accepts a valid body and leaves defaultSeverity undefined when absent', () => {
    const parsed = createServiceBodySchema.parse(validCreate);
    expect(parsed.defaultSeverity).toBeUndefined();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '5'],
    ['above the integer ceiling', 2_147_483_648],
  ])('rejects a %s SLA value with 422', (_name, value) => {
    const error = failure(createServiceBodySchema, { ...validCreate, P2ResponseSlaMinutes: value });
    expect(error.statusCode).toBe(422);
  });

  it('rejects resolution below response with 422 on the resolution field', () => {
    const error = failure(createServiceBodySchema, { ...validCreate, P3ResolutionSlaMinutes: 59 });
    expect(error.statusCode).toBe(422);
    expect(error.details).toEqual([
      {
        field: 'P3ResolutionSlaMinutes',
        issue: 'Must be greater than or equal to P3ResponseSlaMinutes',
      },
    ]);
  });

  it.each([
    ['top level', { ...validCreate, escalationDelayMinutes: 5 }],
    [
      'inside the policy',
      { ...validCreate, escalationPolicy: { ...validCreate.escalationPolicy, delayMinutes: 5 } },
    ],
  ])('rejects a timing field %s with 400', (_name, body) => {
    expect(failure(createServiceBodySchema, body).statusCode).toBe(400);
  });
});

describe('updateServiceBodySchema', () => {
  it('requires at least one field', () => {
    expect(failure(updateServiceBodySchema, {}).statusCode).toBe(422);
  });

  it('accepts a partial SLA update and checks ordering only when both values are sent', () => {
    expect(updateServiceBodySchema.parse({ P1ResponseSlaMinutes: 999 })).toEqual({
      P1ResponseSlaMinutes: 999,
    });
    const error = failure(updateServiceBodySchema, {
      P1ResponseSlaMinutes: 20,
      P1ResolutionSlaMinutes: 10,
    });
    expect(error.statusCode).toBe(422);
  });

  it('rejects a non-uuid escalationPolicyId with 422 and unknown fields with 400', () => {
    expect(failure(updateServiceBodySchema, { escalationPolicyId: 'nope' }).statusCode).toBe(422);
    expect(failure(updateServiceBodySchema, { name: 'x', delayMinutes: 1 }).statusCode).toBe(400);
  });
});
