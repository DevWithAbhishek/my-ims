import { deriveIdempotencyKey, entityIdOf } from './idempotency-key';

describe('deriveIdempotencyKey', () => {
  it('is <eventType>:<entityId>:<occurrenceId>', () => {
    expect(deriveIdempotencyKey('ASSIGNED', 'inc-1', 'audit-1')).toBe('ASSIGNED:inc-1:audit-1');
  });

  it('is deterministic and differs per occurrence', () => {
    expect(deriveIdempotencyKey('SLA_WARNING', 'i', 'RESPONSE_WARNING')).toBe(
      deriveIdempotencyKey('SLA_WARNING', 'i', 'RESPONSE_WARNING'),
    );
    expect(deriveIdempotencyKey('ASSIGNED', 'i', 'a1')).not.toBe(
      deriveIdempotencyKey('ASSIGNED', 'i', 'a2'),
    );
  });
});

describe('entityIdOf', () => {
  it('prefers the incident, then team, service and alert source', () => {
    expect(entityIdOf({ incidentId: 'i', teamId: 't', serviceId: 's' })).toBe('i');
    expect(entityIdOf({ teamId: 't', serviceId: 's' })).toBe('t');
    expect(entityIdOf({ serviceId: 's', alertSourceId: 'a' })).toBe('s');
    expect(entityIdOf({ alertSourceId: 'a' })).toBe('a');
    expect(entityIdOf({})).toBeUndefined();
  });
});
