import os from 'node:os';
import { getConfig, getJobsConfig } from '../config/env.js';
import { disconnectPrisma } from '../infra/db/prisma.js';
import { RedriveError, redriveOutboxEvent } from '../infra/jobs/redrive.js';

/** Usage: npm run redrive:outbox -- <outboxEventId> [--operator <name>] */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const operatorFlag = args.indexOf('--operator');
  const operator = operatorFlag >= 0 ? (args[operatorFlag + 1] ?? '') : os.userInfo().username;
  const operatorValueIndex = operatorFlag >= 0 ? operatorFlag + 1 : -1;
  const id = args.find((arg, index) => !arg.startsWith('--') && index !== operatorValueIndex);

  if (!id || operator === '') {
    console.error('Usage: npm run redrive:outbox -- <outboxEventId> [--operator <name>]');
    return 2;
  }

  getConfig();
  getJobsConfig();
  try {
    await redriveOutboxEvent(id, operator);
    console.log(`Outbox event ${id} requeued (PENDING).`);
    return 0;
  } catch (error) {
    if (error instanceof RedriveError) {
      console.error(`Not re-driven: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await disconnectPrisma();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Re-drive failed');
    process.exit(1);
  },
);
