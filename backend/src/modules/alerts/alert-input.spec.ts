import { normalizeAlert, type NormalizedAlert } from './alert-input.js';

const SERVICE_ID = '0190f7a2-6b1c-7c3e-8f4a-1b2c3d4e5f60';
const valid = {
  serviceId: SERVICE_ID,
  environment: 'production',
  startedAt: '2026-10-14T10:00:00Z',
  name: 'cpu high',
};

function ok(item: unknown): NormalizedAlert {
  const result = normalizeAlert(item);
  if (!result.ok) throw new Error(`expected valid, got ${result.fields.join(', ')}`);
  return result.alert;
}

function invalidFields(item: unknown): string[] {
  const result = normalizeAlert(item);
  if (result.ok) throw new Error('expected invalid');
  return result.fields;
}

describe('normalizeAlert', () => {
  it('accepts the minimal alert and fills the defaults', () => {
    expect(ok(valid)).toEqual({
      sourceEventId: null,
      sourceFingerprint: null,
      name: 'cpu high',
      serviceId: SERVICE_ID,
      environment: 'production',
      sourceSeverity: null,
      summary: null,
      description: null,
      labels: [],
      additionalDetails: null,
      status: 'FIRING',
      startedAt: new Date('2026-10-14T10:00:00Z'),
      endedAt: null,
      sourceUrl: null,
    });
  });

  it('accepts every optional field and time zone offsets', () => {
    const alert = ok({
      ...valid,
      sourceEventId: 'evt-1',
      sourceFingerprint: 'fp-1',
      sourceSeverity: 'Critical',
      summary: 'sum',
      description: 'desc',
      labels: ['team=payments', 'tier='],
      additionalDetails: 'more',
      status: 'RESOLVED',
      startedAt: '2026-10-14T12:00:00+02:00',
      endedAt: '2026-10-14T10:30:00.250Z',
      sourceUrl: 'https://monitor.example.com/alerts/1',
    });
    expect(alert.startedAt.toISOString()).toBe('2026-10-14T10:00:00.000Z');
    expect(alert.endedAt?.toISOString()).toBe('2026-10-14T10:30:00.250Z');
    expect(alert.status).toBe('RESOLVED');
    expect(alert.labels).toEqual(['team=payments', 'tier=']);
  });

  it('tolerates unknown fields and lower-cases the service id', () => {
    const alert = ok({ ...valid, serviceId: SERVICE_ID.toUpperCase(), extra: { a: 1 } });
    expect(alert.serviceId).toBe(SERVICE_ID);
  });

  it.each([
    ['not an object', 'text', '(alert)'],
    ['an array', [valid], '(alert)'],
    ['null', null, '(alert)'],
    ['missing serviceId', { ...valid, serviceId: undefined }, 'serviceId'],
    ['malformed serviceId', { ...valid, serviceId: 'svc-1' }, 'serviceId'],
    ['missing environment', { ...valid, environment: undefined }, 'environment'],
    ['empty environment', { ...valid, environment: '' }, 'environment'],
    ['environment over 100', { ...valid, environment: 'e'.repeat(101) }, 'environment'],
    ['missing startedAt', { ...valid, startedAt: undefined }, 'startedAt'],
    ['startedAt without a time', { ...valid, startedAt: '2026-10-14' }, 'startedAt'],
    ['startedAt not a date', { ...valid, startedAt: 'yesterday' }, 'startedAt'],
    ['endedAt before startedAt', { ...valid, endedAt: '2026-10-14T09:59:59Z' }, 'endedAt'],
    ['name over 200', { ...valid, name: 'n'.repeat(201) }, 'name'],
    ['sourceEventId empty', { ...valid, sourceEventId: '' }, 'sourceEventId'],
    ['sourceEventId over 200', { ...valid, sourceEventId: 'e'.repeat(201) }, 'sourceEventId'],
    [
      'sourceFingerprint over 200',
      { ...valid, sourceFingerprint: 'f'.repeat(201) },
      'sourceFingerprint',
    ],
    ['sourceSeverity over 50', { ...valid, sourceSeverity: 's'.repeat(51) }, 'sourceSeverity'],
    ['summary over 500', { ...valid, summary: 's'.repeat(501) }, 'summary'],
    ['description over 10000', { ...valid, description: 'd'.repeat(10_001) }, 'description'],
    [
      'additionalDetails over 10000',
      { ...valid, additionalDetails: 'a'.repeat(10_001) },
      'additionalDetails',
    ],
    [
      'more than 50 labels',
      { ...valid, labels: Array.from({ length: 51 }, (_, i) => `k=${i}`) },
      'labels',
    ],
    ['a label without =', { ...valid, labels: ['plain'] }, 'labels.0'],
    ['a label without a key', { ...valid, labels: ['=value'] }, 'labels.0'],
    ['a label over 200', { ...valid, labels: [`k=${'v'.repeat(200)}`] }, 'labels.0'],
    ['unknown status', { ...valid, status: 'PENDING' }, 'status'],
    ['sourceUrl not a URL', { ...valid, sourceUrl: 'not a url' }, 'sourceUrl'],
    ['sourceUrl with another scheme', { ...valid, sourceUrl: 'javascript:alert(1)' }, 'sourceUrl'],
    [
      'sourceUrl over 2000',
      { ...valid, sourceUrl: `https://example.com/${'p'.repeat(2000)}` },
      'sourceUrl',
    ],
    ['null for an optional field', { ...valid, summary: null }, 'summary'],
  ])('rejects %s', (_label, item, field) => {
    expect(invalidFields(item)).toContain(field);
  });

  it('accepts values exactly at the limits', () => {
    ok({
      ...valid,
      name: 'n'.repeat(200),
      environment: 'e'.repeat(100),
      sourceEventId: 'e'.repeat(200),
      sourceSeverity: 's'.repeat(50),
      summary: 's'.repeat(500),
      description: 'd'.repeat(10_000),
      labels: Array.from({ length: 50 }, (_, i) => `k${i}=v`),
      endedAt: '2026-10-14T10:00:00Z',
    });
  });

  it('rejects a NUL character anywhere in the element (it cannot be stored)', () => {
    expect(invalidFields({ ...valid, name: 'a\0b' })).toEqual(['(payload)']);
    expect(invalidFields({ ...valid, nested: { deep: ['x\0'] } })).toEqual(['(payload)']);
    expect(invalidFields({ ...valid, 'k\0ey': 1 })).toEqual(['(payload)']);
  });

  it('reports field names only, never the offending values', () => {
    const fields = invalidFields({ ...valid, environment: 'secret-value'.repeat(20) });
    expect(JSON.stringify(fields)).not.toContain('secret-value');
  });
});
