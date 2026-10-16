import { getJobsConfig, getNotificationsConfig } from '../config/env.js';
import { QUEUES } from '../infra/jobs/events.js';
import { registerProcessor } from '../infra/jobs/registry.js';
import { startJobsRuntime, type JobsRuntime } from '../infra/jobs/runtime.js';
import {
  createNotificationProcessor,
  createSendGridEmailProvider,
} from '../modules/notifications/index.js';

/**
 * Composition point of the worker process. Slices that own a consumer register their processor
 * here before the runtime starts.
 */
export function startWorkers(): JobsRuntime {
  const jobs = getJobsConfig();
  const email = getNotificationsConfig();

  registerProcessor(
    QUEUES.NOTIFICATIONS,
    createNotificationProcessor({
      provider: createSendGridEmailProvider({
        apiKey: email.sendgridApiKey,
        fromEmail: email.fromEmail,
        requestTimeoutMs: email.sendTimeoutMs,
      }),
      processingWindowMs: jobs.processingWindowMs,
      maxAttempts: jobs.executionAttempts,
    }),
  );

  return startJobsRuntime(jobs);
}
