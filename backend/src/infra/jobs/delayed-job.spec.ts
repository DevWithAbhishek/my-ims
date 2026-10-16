import { UnrecoverableError } from 'bullmq';
import { NonRetryableJobError, RetryableJobError } from './errors';
import { processDelayedJob } from './processor';
import {
  clearProcessors,
  getRegisteredDelayedProcessors,
  registerDelayedProcessor,
} from './registry';

const config = {
  executionAttempts: 5,
  executionBackoffBaseMs: 10,
  executionBackoffCapMs: 50,
  processingWindowMs: 1000,
  workerConcurrency: 1,
  queueRateLimits: {},
} as never;

const job = (attemptsMade: number, data: unknown = { incidentId: 'i-1' }) => ({
  name: 'delayed.SLA_MILESTONE',
  data,
  attemptsMade,
  opts: { attempts: 5 },
});

describe('processDelayedJob', () => {
  it('hands the consumer the name without the internal prefix, string data and the attempt number', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    await processDelayedJob(
      job(0, { incidentId: 'i-1', ignored: 3 }) as never,
      'sla-escalation',
      handler,
      { config },
    );
    expect(handler).toHaveBeenCalledWith({
      name: 'SLA_MILESTONE',
      data: { incidentId: 'i-1' },
      attempt: 1,
    });
  });

  it('rethrows a retryable failure so BullMQ retries it', async () => {
    const error = new RetryableJobError('NETWORK', 'down');
    await expect(
      processDelayedJob(job(1) as never, 'sla-escalation', async () => Promise.reject(error), {
        config,
      }),
    ).rejects.toBe(error);
  });

  it('ends the job for good on the last attempt and on a non-retryable failure', async () => {
    await expect(
      processDelayedJob(
        job(4) as never,
        'sla-escalation',
        async () => Promise.reject(new RetryableJobError('NETWORK', 'down')),
        { config },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      processDelayedJob(
        job(0) as never,
        'sla-escalation',
        async () => Promise.reject(new NonRetryableJobError('INVALID_PAYLOAD', 'bad')),
        { config },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('delayed processor registry', () => {
  afterEach(clearProcessors);

  it('allows one delayed-job processor per queue', () => {
    registerDelayedProcessor('sla-escalation', async () => undefined);
    expect(getRegisteredDelayedProcessors().has('sla-escalation')).toBe(true);
    expect(() => registerDelayedProcessor('sla-escalation', async () => undefined)).toThrow(
      /already registered/,
    );
  });
});
