import { getAiConfig, getJobsConfig, getNotificationsConfig, getSlaConfig } from '../config/env.js';
import { QUEUES } from '../infra/jobs/events.js';
import { createBullmqGateway } from '../infra/jobs/gateway.js';
import { startLoop } from '../infra/jobs/loop.js';
import { registerDelayedProcessor, registerProcessor } from '../infra/jobs/registry.js';
import { startJobsRuntime, type JobsRuntime } from '../infra/jobs/runtime.js';
import { createRedisConnection } from '../infra/redis/redis.js';
import { createAlertTriageProcessor, createGeminiAiProvider } from '../modules/ai/index.js';
import {
  createSlaEvaluationProcessor,
  createSlaMilestoneProcessor,
  runSlaScan,
} from '../modules/incidents/index.js';
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
  const sla = getSlaConfig();
  const ai = getAiConfig();

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

  // SLICE-10: advisory alert triage; the provider is called here, never inside a transaction.
  registerProcessor(
    QUEUES.AI_TRIAGE,
    createAlertTriageProcessor({
      provider: createGeminiAiProvider({
        apiKey: ai.geminiApiKey,
        model: ai.geminiModel,
        requestTimeoutMs: ai.requestTimeoutMs,
      }),
      maxAttempts: jobs.executionAttempts,
    }),
  );

  // SLICE-07: the same gateway publishes outbox events and schedules the delayed milestone jobs.
  const connection = createRedisConnection('general');
  const gateway = createBullmqGateway(connection, jobs.executionAttempts);
  registerProcessor(QUEUES.SLA_ESCALATION, createSlaEvaluationProcessor({ scheduler: gateway }));
  registerDelayedProcessor(
    QUEUES.SLA_ESCALATION,
    createSlaMilestoneProcessor({ scheduler: gateway }),
  );

  const runtime = startJobsRuntime(jobs, gateway);
  const scanner = startLoop('sla-scan', sla.scanIntervalMs, async () => {
    await runSlaScan();
  });

  return {
    async stop() {
      await scanner.stop();
      await runtime.stop();
      connection.disconnect();
    },
  };
}
