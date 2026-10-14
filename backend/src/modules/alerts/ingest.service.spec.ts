import { logger } from '../../shared/observability/logger.js';
import type { ServiceConfig } from '../appService/index.js';
import { createIngestHandler } from './ingest.service.js';
import type { AlertIngestResponse } from './ingest.types.js';
import type { VerifiedAlertContext } from './webhook.types.js';

const SERVICE_ID = '0190f7a2-6b1c-7c3e-8f4a-1b2c3d4e5f60';
const OTHER_SERVICE_ID = '0190f7a2-6b1c-7c3e-8f4a-1b2c3d4e5f61';

const service = (status: 'ACTIVE' | 'DEACTIVATED'): ServiceConfig => ({
  id: SERVICE_ID,
  name: 'svc',
  status,
  teamId: '0190f7a2-6b1c-7c3e-8f4a-1b2c3d4e5f62',
  defaultSeverity: 'P1',
  escalationPolicyId: '0190f7a2-6b1c-7c3e-8f4a-1b2c3d4e5f63',
  sla: {
    P0: { responseMinutes: 5, resolutionMinutes: 30 },
    P1: { responseMinutes: 10, resolutionMinutes: 60 },
    P2: { responseMinutes: 30, resolutionMinutes: 120 },
    P3: { responseMinutes: 60, resolutionMinutes: 240 },
  },
});

const alert = (overrides: Record<string, unknown> = {}) => ({
  serviceId: SERVICE_ID,
  environment: 'production',
  startedAt: '2026-10-14T10:00:00Z',
  name: 'cpu high',
  ...overrides,
});

function context(items: unknown[], rateLimitedIndices: number[] = []): VerifiedAlertContext {
  return {
    alertSource: { id: 'src', name: 'source', sourceType: 'GENERIC', configuration: {} },
    items,
    rateLimitedIndices,
    requestId: 'req-1',
  };
}

/** Only the rejections that happen before persistence: no database is needed. */
describe('ingestion rejections before persistence', () => {
  const getServiceConfig = jest.fn<Promise<ServiceConfig | null>, [string]>();
  const ingest = createIngestHandler({ getServiceConfig });

  beforeAll(() => {
    logger.level = 'silent';
  });
  beforeEach(() => getServiceConfig.mockReset().mockResolvedValue(service('ACTIVE')));

  const run = async (items: unknown[], limited: number[] = []) => {
    const response = await ingest(context(items, limited));
    return {
      statusCode: response.statusCode,
      results: (response.body as AlertIngestResponse).data.results,
    };
  };

  it('rejects an invalid alert with ALERT_INVALID, naming the field', async () => {
    const { results } = await run([alert({ environment: undefined })]);
    expect(results).toEqual([
      {
        index: 0,
        outcome: 'REJECTED',
        alertId: null,
        incidentId: null,
        error: { code: 'ALERT_INVALID', message: expect.stringContaining('environment') },
      },
    ]);
    expect(getServiceConfig).not.toHaveBeenCalled();
  });

  it('rejects an unknown service', async () => {
    getServiceConfig.mockResolvedValue(null);
    const { results } = await run([alert()]);
    expect(results[0]).toMatchObject({ outcome: 'REJECTED', error: { code: 'UNKNOWN_SERVICE' } });
  });

  it('rejects a deactivated service, for firing and resolved deliveries alike', async () => {
    getServiceConfig.mockResolvedValue(service('DEACTIVATED'));
    const { results } = await run([alert(), alert({ status: 'RESOLVED', sourceEventId: 'e' })]);
    expect(results.map((r) => r.error?.code)).toEqual([
      'SERVICE_DEACTIVATED',
      'SERVICE_DEACTIVATED',
    ]);
  });

  it('rejects an alert without any identity', async () => {
    const { results } = await run([alert({ name: undefined, summary: 'only a summary' })]);
    expect(results[0]).toMatchObject({ error: { code: 'IDENTITY_UNRESOLVABLE' } });
  });

  it('reports rate-limited items without validating them or looking anything up', async () => {
    const { results } = await run([{ not: 'even valid' }, 'text'], [0, 1]);
    expect(results.map((r) => r.error?.code)).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);
    expect(getServiceConfig).not.toHaveBeenCalled();
  });

  it('answers 400 with the same body shape when every alert was rejected', async () => {
    const { statusCode, results } = await run([
      {},
      alert({ environment: '' }),
      alert({ serviceId: 'x' }),
    ]);
    expect(statusCode).toBe(400);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(results.every((r) => r.outcome === 'REJECTED')).toBe(true);
  });

  it('looks each service up once per request', async () => {
    getServiceConfig.mockResolvedValue(null);
    await run([alert(), alert({ name: 'other' }), alert({ serviceId: OTHER_SERVICE_ID })]);
    expect(getServiceConfig).toHaveBeenCalledTimes(2);
  });

  it('keeps one rejection from affecting the next alert', async () => {
    getServiceConfig.mockResolvedValueOnce(null).mockResolvedValue(service('DEACTIVATED'));
    const { results } = await run([alert(), alert({ serviceId: OTHER_SERVICE_ID })]);
    expect(results.map((r) => r.error?.code)).toEqual(['UNKNOWN_SERVICE', 'SERVICE_DEACTIVATED']);
  });
});
