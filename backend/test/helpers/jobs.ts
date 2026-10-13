import { randomUUID } from 'node:crypto';
import { parseJobsConfig, type JobsConfig } from '../../src/config/env';
import { runInTransaction } from '../../src/infra/db/prisma';
import type { QueueName } from '../../src/infra/jobs/events';
import type { DeadLetterJobData, JobData, QueueGateway } from '../../src/infra/jobs/gateway';
import { enqueueOutbox } from '../../src/infra/jobs/outbox';

/** Fast, deterministic test settings; the application itself has no built-in defaults. */
export function testJobsEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    OUTBOX_RELAY_POLL_INTERVAL_MS: '50',
    OUTBOX_RELAY_BATCH_SIZE: '20',
    OUTBOX_CLAIM_LEASE_MS: '60000',
    OUTBOX_PROCESSING_WINDOW_MS: '60000',
    OUTBOX_PUBLISH_TIMEOUT_MS: '1000',
    OUTBOX_PUBLISH_BACKOFF_BASE_MS: '1000',
    OUTBOX_PUBLISH_BACKOFF_CAP_MS: '8000',
    JOBS_EXECUTION_BACKOFF_BASE_MS: '10',
    JOBS_EXECUTION_BACKOFF_CAP_MS: '50',
    JOBS_EXECUTION_ATTEMPTS: '5',
    OUTBOX_STALE_RECOVERY_INTERVAL_MS: '100',
    OUTBOX_RETENTION_WINDOW_MS: '3600000',
    OUTBOX_RETENTION_INTERVAL_MS: '100',
    WORKER_CONCURRENCY: '2',
  };
  for (const queue of [
    'AI_TRIAGE',
    'SLA_ESCALATION',
    'NOTIFICATIONS',
    'POSTMORTEM',
    'INVESTIGATION',
  ]) {
    env[`JOBS_RATE_${queue}_MAX`] = '1000';
    env[`JOBS_RATE_${queue}_DURATION_MS`] = '1000';
  }
  return env;
}

export function testJobsConfig(overrides: Partial<JobsConfig> = {}): JobsConfig {
  return { ...parseJobsConfig(testJobsEnv()), ...overrides };
}

/** Records what would be published; can be told to fail. */
export class FakeGateway implements QueueGateway {
  published: { queue: QueueName; data: JobData }[] = [];
  deadLetters: DeadLetterJobData[] = [];
  failWith: Error | null = null;
  publishDelayMs = 0;

  async publish(queue: QueueName, data: JobData): Promise<void> {
    if (this.publishDelayMs > 0) await sleep(this.publishDelayMs);
    if (this.failWith) throw this.failWith;
    this.published.push({ queue, data });
  }

  async publishDeadLetter(data: DeadLetterJobData): Promise<void> {
    this.deadLetters.push(data);
  }

  async close(): Promise<void> {}
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

/** Writes a valid `SLA_EVALUATION_REQUESTED` outbox row in its own committed transaction. */
export async function insertOutbox(
  overrides: { incidentId?: string; eventType?: string; payload?: unknown } = {},
): Promise<{ id: string; incidentId: string }> {
  const incidentId = overrides.incidentId ?? randomUUID();
  const id = await runInTransaction((tx) =>
    enqueueOutbox(tx, {
      eventType: overrides.eventType ?? 'SLA_EVALUATION_REQUESTED',
      aggregateType: 'Incident',
      aggregateId: incidentId,
      payload: overrides.payload ?? { incidentId, requestId: 'req-test' },
    }),
  );
  return { id, incidentId };
}
