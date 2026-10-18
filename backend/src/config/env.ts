import dotenv from 'dotenv';
import { z } from 'zod';

type Duration = `${number}${'s' | 'm' | 'h' | 'd'}`;

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  directUrl: string;
  jwtSecret: string;
  redisUrl: string;
  accessTokenExpiry: Duration;
  refreshTokenExpiry: Duration;
}

const postgresUrl = z.string().regex(/^postgres(ql)?:\/\/.+/, 'must be a PostgreSQL URL');
const redisUrl = z.string().regex(/^rediss?:\/\/.+/, 'must be a Redis URL');
const duration = z
  .string()
  .regex(/^\d+[smhd]$/, 'must be a duration such as 15m, 7d')
  .transform((value) => value as Duration);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535),
  DATABASE_URL: postgresUrl,
  DIRECT_URL: postgresUrl,
  JWT_SECRET: z.string().min(1),
  REDIS_URL: redisUrl,
  ACCESS_TOKEN_EXPIRY: duration.default('15m'),
  REFRESH_TOKEN_EXPIRY: duration.default('7d'),
});

/** Thrown for invalid configuration. The message names variables only, never their values. */
export class ConfigError extends Error {
  constructor(
    readonly variables: string[],
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

function toConfigError(env: NodeJS.ProcessEnv, issues: z.ZodError['issues']): ConfigError {
  const problems = new Map<string, string>();
  for (const issue of issues) {
    const name = String(issue.path[0] ?? 'environment');
    const missing = env[name] === undefined || env[name] === '';
    problems.set(name, missing ? 'is required' : issue.message);
  }
  const variables = [...problems.keys()];
  const detail = [...problems].map(([name, problem]) => `${name} ${problem}`).join('; ');
  return new ConfigError(variables, `Invalid configuration: ${detail}`);
}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) throw toConfigError(env, result.error.issues);

  const values = result.data;
  return {
    nodeEnv: values.NODE_ENV,
    port: values.PORT,
    databaseUrl: values.DATABASE_URL,
    directUrl: values.DIRECT_URL,
    jwtSecret: values.JWT_SECRET,
    redisUrl: values.REDIS_URL,
    accessTokenExpiry: values.ACCESS_TOKEN_EXPIRY,
    refreshTokenExpiry: values.REFRESH_TOKEN_EXPIRY,
  };
}

let cached: Config | undefined;

/** Loads `.env` (if present) and returns the validated configuration, parsing it once. */
export function getConfig(): Config {
  if (!cached) {
    dotenv.config({ quiet: true });
    cached = parseConfig(process.env);
  }
  return cached;
}

/** Names of the queues that have their own worker rate limit (see `src/infra/jobs/events.ts`). */
export const RATE_LIMITED_QUEUES = [
  'ai-triage',
  'sla-escalation',
  'notifications',
  'postmortem',
  'investigation',
] as const;

export type RateLimitedQueue = (typeof RATE_LIMITED_QUEUES)[number];

/** Outbox, relay and worker reliability settings (SLICE-08). Every value must be configured. */
export interface JobsConfig {
  relayPollIntervalMs: number;
  relayBatchSize: number;
  claimLeaseMs: number;
  processingWindowMs: number;
  publishTimeoutMs: number;
  publishBackoffBaseMs: number;
  publishBackoffCapMs: number;
  executionBackoffBaseMs: number;
  executionBackoffCapMs: number;
  executionAttempts: number;
  staleRecoveryIntervalMs: number;
  retentionWindowMs: number;
  retentionIntervalMs: number;
  workerConcurrency: number;
  queueRateLimits: Record<RateLimitedQueue, { max: number; durationMs: number }>;
}

const positiveInt = z.coerce.number().int().min(1);

const rateLimitShape = Object.fromEntries(
  RATE_LIMITED_QUEUES.flatMap((queue) => {
    const prefix = `JOBS_RATE_${queue.toUpperCase().replace(/-/g, '_')}`;
    return [
      [`${prefix}_MAX`, positiveInt],
      [`${prefix}_DURATION_MS`, positiveInt],
    ];
  }),
) as Record<string, typeof positiveInt>;

const jobsEnvSchema = z
  .object({
    OUTBOX_RELAY_POLL_INTERVAL_MS: positiveInt,
    OUTBOX_RELAY_BATCH_SIZE: positiveInt,
    OUTBOX_CLAIM_LEASE_MS: positiveInt,
    OUTBOX_PROCESSING_WINDOW_MS: positiveInt,
    OUTBOX_PUBLISH_TIMEOUT_MS: positiveInt,
    OUTBOX_PUBLISH_BACKOFF_BASE_MS: positiveInt,
    OUTBOX_PUBLISH_BACKOFF_CAP_MS: positiveInt,
    JOBS_EXECUTION_BACKOFF_BASE_MS: positiveInt,
    JOBS_EXECUTION_BACKOFF_CAP_MS: positiveInt,
    JOBS_EXECUTION_ATTEMPTS: positiveInt,
    OUTBOX_STALE_RECOVERY_INTERVAL_MS: positiveInt,
    OUTBOX_RETENTION_WINDOW_MS: positiveInt,
    OUTBOX_RETENTION_INTERVAL_MS: positiveInt,
    WORKER_CONCURRENCY: positiveInt,
    ...rateLimitShape,
  })
  .superRefine((values, ctx) => {
    const ordered: [string, string][] = [
      ['OUTBOX_PUBLISH_BACKOFF_CAP_MS', 'OUTBOX_PUBLISH_BACKOFF_BASE_MS'],
      ['JOBS_EXECUTION_BACKOFF_CAP_MS', 'JOBS_EXECUTION_BACKOFF_BASE_MS'],
      ['OUTBOX_RETENTION_WINDOW_MS', 'OUTBOX_PROCESSING_WINDOW_MS'],
    ];
    const record = values as Record<string, number>;
    for (const [larger, smaller] of ordered) {
      if (record[larger] < record[smaller]) {
        ctx.addIssue({ code: 'custom', path: [larger], message: `must not be below ${smaller}` });
      }
    }
  });

export function parseJobsConfig(env: NodeJS.ProcessEnv): JobsConfig {
  const result = jobsEnvSchema.safeParse(env);
  if (!result.success) throw toConfigError(env, result.error.issues);

  const values = result.data as Record<string, number>;
  const queueRateLimits = Object.fromEntries(
    RATE_LIMITED_QUEUES.map((queue) => {
      const prefix = `JOBS_RATE_${queue.toUpperCase().replace(/-/g, '_')}`;
      return [queue, { max: values[`${prefix}_MAX`], durationMs: values[`${prefix}_DURATION_MS`] }];
    }),
  ) as JobsConfig['queueRateLimits'];

  return {
    relayPollIntervalMs: values.OUTBOX_RELAY_POLL_INTERVAL_MS,
    relayBatchSize: values.OUTBOX_RELAY_BATCH_SIZE,
    claimLeaseMs: values.OUTBOX_CLAIM_LEASE_MS,
    processingWindowMs: values.OUTBOX_PROCESSING_WINDOW_MS,
    publishTimeoutMs: values.OUTBOX_PUBLISH_TIMEOUT_MS,
    publishBackoffBaseMs: values.OUTBOX_PUBLISH_BACKOFF_BASE_MS,
    publishBackoffCapMs: values.OUTBOX_PUBLISH_BACKOFF_CAP_MS,
    executionBackoffBaseMs: values.JOBS_EXECUTION_BACKOFF_BASE_MS,
    executionBackoffCapMs: values.JOBS_EXECUTION_BACKOFF_CAP_MS,
    executionAttempts: values.JOBS_EXECUTION_ATTEMPTS,
    staleRecoveryIntervalMs: values.OUTBOX_STALE_RECOVERY_INTERVAL_MS,
    retentionWindowMs: values.OUTBOX_RETENTION_WINDOW_MS,
    retentionIntervalMs: values.OUTBOX_RETENTION_INTERVAL_MS,
    workerConcurrency: values.WORKER_CONCURRENCY,
    queueRateLimits,
  };
}

let cachedJobs: JobsConfig | undefined;

/** Validated outbox/worker settings, parsed once. Startup of the worker fails when any is missing. */
export function getJobsConfig(): JobsConfig {
  if (!cachedJobs) {
    dotenv.config({ quiet: true });
    cachedJobs = parseJobsConfig(process.env);
  }
  return cachedJobs;
}

/** Email delivery settings (SLICE-09, SendGrid). Every value must be configured. */
export interface NotificationsConfig {
  sendgridApiKey: string;
  fromEmail: string;
  sendTimeoutMs: number;
}

const notificationsEnvSchema = z.object({
  SENDGRID_API_KEY: z.string().min(1),
  NOTIFICATION_FROM_EMAIL: z.email(),
  NOTIFICATION_SEND_TIMEOUT_MS: positiveInt,
});

export function parseNotificationsConfig(env: NodeJS.ProcessEnv): NotificationsConfig {
  const result = notificationsEnvSchema.safeParse(env);
  if (!result.success) throw toConfigError(env, result.error.issues);

  return {
    sendgridApiKey: result.data.SENDGRID_API_KEY,
    fromEmail: result.data.NOTIFICATION_FROM_EMAIL,
    sendTimeoutMs: result.data.NOTIFICATION_SEND_TIMEOUT_MS,
  };
}

let cachedNotifications: NotificationsConfig | undefined;

/** Validated email settings, parsed once. Startup of the worker fails when any is missing. */
export function getNotificationsConfig(): NotificationsConfig {
  if (!cachedNotifications) {
    dotenv.config({ quiet: true });
    cachedNotifications = parseNotificationsConfig(process.env);
  }
  return cachedNotifications;
}

/** AI provider settings (SLICE-10, Gemini). Every value must be configured. */
export interface AiConfig {
  geminiApiKey: string;
  geminiModel: string;
  requestTimeoutMs: number;
}

const aiEnvSchema = z.object({
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1),
  AI_REQUEST_TIMEOUT_MS: positiveInt,
});

export function parseAiConfig(env: NodeJS.ProcessEnv): AiConfig {
  const result = aiEnvSchema.safeParse(env);
  if (!result.success) throw toConfigError(env, result.error.issues);

  return {
    geminiApiKey: result.data.GEMINI_API_KEY,
    geminiModel: result.data.GEMINI_MODEL,
    requestTimeoutMs: result.data.AI_REQUEST_TIMEOUT_MS,
  };
}

let cachedAi: AiConfig | undefined;

/** Validated AI provider settings, parsed once. Startup of the worker fails when any is missing. */
export function getAiConfig(): AiConfig {
  if (!cachedAi) {
    dotenv.config({ quiet: true });
    cachedAi = parseAiConfig(process.env);
  }
  return cachedAi;
}

/** SLA monitoring settings (SLICE-07). Every value must be configured. */
export interface SlaConfig {
  /** How often the PostgreSQL scanner looks for crossed SLA thresholds that were not recorded. */
  scanIntervalMs: number;
}

const slaEnvSchema = z.object({
  SLA_SCAN_INTERVAL_MS: positiveInt,
});

export function parseSlaConfig(env: NodeJS.ProcessEnv): SlaConfig {
  const result = slaEnvSchema.safeParse(env);
  if (!result.success) throw toConfigError(env, result.error.issues);

  return { scanIntervalMs: result.data.SLA_SCAN_INTERVAL_MS };
}

let cachedSla: SlaConfig | undefined;

/** Validated SLA settings, parsed once. Startup of the worker fails when any is missing. */
export function getSlaConfig(): SlaConfig {
  if (!cachedSla) {
    dotenv.config({ quiet: true });
    cachedSla = parseSlaConfig(process.env);
  }
  return cachedSla;
}

/** Investigation retrieval setting (SLICE-12), read by the API when a request is stored. */
export interface InvestigationRetrievalConfig {
  /** How many past reviewed postmortems of the service are retrieved (a retrieval parameter). */
  postmortemLimit: number;
}

const retrievalEnvSchema = z.object({
  INVESTIGATION_RETRIEVAL_LIMIT: positiveInt.default(20),
});

export function parseInvestigationRetrievalConfig(
  env: NodeJS.ProcessEnv,
): InvestigationRetrievalConfig {
  const result = retrievalEnvSchema.safeParse(env);
  if (!result.success) throw toConfigError(env, result.error.issues);
  return { postmortemLimit: result.data.INVESTIGATION_RETRIEVAL_LIMIT };
}

let cachedRetrieval: InvestigationRetrievalConfig | undefined;

/** The retrieval limit, parsed once; it defaults to 20 as the slice states. */
export function getInvestigationRetrievalConfig(): InvestigationRetrievalConfig {
  if (!cachedRetrieval) {
    dotenv.config({ quiet: true });
    cachedRetrieval = parseInvestigationRetrievalConfig(process.env);
  }
  return cachedRetrieval;
}

/** Investigation retention settings (SLICE-12). Every value must be configured. */
export interface InvestigationRetentionConfig {
  /** How often the retention job looks for investigations older than 14 days. */
  intervalMs: number;
  /** How many investigations one retention transaction deletes at most. */
  batchSize: number;
}

const retentionEnvSchema = z.object({
  INVESTIGATION_RETENTION_INTERVAL_MS: positiveInt,
  INVESTIGATION_RETENTION_BATCH_SIZE: positiveInt,
});

export function parseInvestigationRetentionConfig(
  env: NodeJS.ProcessEnv,
): InvestigationRetentionConfig {
  const result = retentionEnvSchema.safeParse(env);
  if (!result.success) throw toConfigError(env, result.error.issues);
  return {
    intervalMs: result.data.INVESTIGATION_RETENTION_INTERVAL_MS,
    batchSize: result.data.INVESTIGATION_RETENTION_BATCH_SIZE,
  };
}

let cachedRetention: InvestigationRetentionConfig | undefined;

/** Validated retention settings, parsed once. Startup of the worker fails when any is missing. */
export function getInvestigationRetentionConfig(): InvestigationRetentionConfig {
  if (!cachedRetention) {
    dotenv.config({ quiet: true });
    cachedRetention = parseInvestigationRetentionConfig(process.env);
  }
  return cachedRetention;
}
