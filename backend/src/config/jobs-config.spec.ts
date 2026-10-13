import { parseJobsConfig } from './env';
import { testJobsEnv } from '../../test/helpers/jobs';

describe('parseJobsConfig', () => {
  it('reads every setting from the environment', () => {
    const config = parseJobsConfig(testJobsEnv());
    expect(config).toMatchObject({
      relayPollIntervalMs: 50,
      relayBatchSize: 20,
      executionAttempts: 5,
      workerConcurrency: 2,
    });
    expect(config.queueRateLimits['ai-triage']).toEqual({ max: 1000, durationMs: 1000 });
    expect(Object.keys(config.queueRateLimits).sort()).toEqual([
      'ai-triage',
      'investigation',
      'notifications',
      'postmortem',
      'sla-escalation',
    ]);
  });

  it('has no defaults: every missing variable is reported by name', () => {
    expect.assertions(2);
    try {
      parseJobsConfig({});
    } catch (error) {
      const { variables, message } = error as { variables: string[]; message: string };
      expect(variables).toEqual(
        expect.arrayContaining([
          'OUTBOX_RELAY_POLL_INTERVAL_MS',
          'JOBS_EXECUTION_ATTEMPTS',
          'WORKER_CONCURRENCY',
          'JOBS_RATE_NOTIFICATIONS_MAX',
        ]),
      );
      expect(message).toContain('OUTBOX_RELAY_BATCH_SIZE is required');
    }
  });

  it.each([
    ['OUTBOX_RELAY_BATCH_SIZE', '0'],
    ['OUTBOX_CLAIM_LEASE_MS', '-5'],
    ['WORKER_CONCURRENCY', 'many'],
    ['JOBS_EXECUTION_ATTEMPTS', '2.5'],
  ])('rejects %s=%s without echoing the value', (name, value) => {
    expect.assertions(2);
    try {
      parseJobsConfig({ ...testJobsEnv(), [name]: value });
    } catch (error) {
      expect((error as { variables: string[] }).variables).toEqual([name]);
      expect((error as Error).message).not.toContain(value);
    }
  });

  it('rejects a cap below its base and a retention window not above the processing window', () => {
    expect.assertions(2);
    for (const override of [
      { JOBS_EXECUTION_BACKOFF_CAP_MS: '5' },
      { OUTBOX_RETENTION_WINDOW_MS: '1000' },
    ]) {
      try {
        parseJobsConfig({ ...testJobsEnv(), ...override });
      } catch (error) {
        expect((error as Error).message).toContain('must not be below');
      }
    }
  });
});
