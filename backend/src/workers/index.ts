import { getJobsConfig } from '../config/env.js';
import { startJobsRuntime, type JobsRuntime } from '../infra/jobs/runtime.js';

/**
 * Composition point of the worker process. Slices that own a consumer register their processor
 * here (`registerProcessor(QUEUES.X, handler)`) before the runtime starts; none exist yet.
 */
export function startWorkers(): JobsRuntime {
  return startJobsRuntime(getJobsConfig());
}
