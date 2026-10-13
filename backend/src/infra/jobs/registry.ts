import type { OutboxPayload, QueueName } from './events.js';

export type ProcessorInput = {
  outboxEventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: OutboxPayload;
  /** 1-based execution attempt number. */
  attempt: number;
};

/**
 * A consumer. It must be idempotent (delivery is at-least-once) and signal failures by throwing
 * `RetryableJobError` / `NonRetryableJobError`; any other error is retried a limited number of times.
 */
export type OutboxProcessor = (input: ProcessorInput) => Promise<void>;

const processors = new Map<QueueName, OutboxProcessor>();

/** Called by a consumer's slice (from `src/workers`) to attach its processor to a queue. */
export function registerProcessor(queue: QueueName, processor: OutboxProcessor): void {
  if (processors.has(queue)) throw new Error(`A processor is already registered for ${queue}`);
  processors.set(queue, processor);
}

export function getRegisteredProcessors(): ReadonlyMap<QueueName, OutboxProcessor> {
  return processors;
}

/** Test support. */
export function clearProcessors(): void {
  processors.clear();
}
