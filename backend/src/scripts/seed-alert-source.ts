import { z } from 'zod';
import { getConfig } from '../config/env.js';
import { disconnectPrisma } from '../infra/db/prisma.js';
import {
  DEFAULT_SEVERITY_MAPPING,
  seedAlertSource,
  type SeverityMapping,
} from '../modules/alerts/index.js';
import { logger } from '../shared/observability/logger.js';

const seedEnvSchema = z.object({
  SEED_ALERT_SOURCE_ID: z.uuid(),
  SEED_ALERT_SOURCE_NAME: z.string().min(1).max(200),
  SEED_ALERT_SOURCE_SIGNING_SECRET: z.string().min(32).max(256),
  SEED_ALERT_SOURCE_SEVERITY_MAPPING: z.string().optional(),
});

const severityMappingSchema = z
  .record(z.string().min(1), z.enum(['P0', 'P1', 'P2', 'P3']))
  .refine((mapping) => Object.keys(mapping).length > 0);

function parseSeverityMapping(raw: string | undefined): SeverityMapping {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SEVERITY_MAPPING;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('Invalid seed configuration: SEED_ALERT_SOURCE_SEVERITY_MAPPING');
  }
  const parsed = severityMappingSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('Invalid seed configuration: SEED_ALERT_SOURCE_SEVERITY_MAPPING');
  }
  return parsed.data;
}

async function main(): Promise<void> {
  getConfig(); // loads `.env` and validates the application configuration
  const parsed = seedEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Invalid seed configuration: ${names.join(', ')}`);
  }

  const result = await seedAlertSource({
    id: parsed.data.SEED_ALERT_SOURCE_ID,
    name: parsed.data.SEED_ALERT_SOURCE_NAME,
    signingSecret: parsed.data.SEED_ALERT_SOURCE_SIGNING_SECRET,
    severityMapping: parseSeverityMapping(parsed.data.SEED_ALERT_SOURCE_SEVERITY_MAPPING),
  });
  logger.info({ result, alertSourceId: parsed.data.SEED_ALERT_SOURCE_ID }, 'Alert source seeded');
}

main()
  .catch((err: unknown) => {
    logger.fatal({ err }, 'Alert source seed failed');
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
