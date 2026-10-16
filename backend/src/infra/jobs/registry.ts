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

/** What a delayed job (see `DelayedJob`) hands its consumer. */
export type DelayedJobInput = {
  /** The name given when it was scheduled (without the internal prefix). */
  name: string;
  data: Record<string, string>;
  /** 1-based execution attempt number. */
  attempt: number;
};

/**
 * Consumer of delayed jobs on a queue. Delayed jobs have no outbox row, so a failure that exhausts
 * the attempts is logged and nothing else: the consumer's slice must have its own recovery.
 */
export type DelayedJobProcessor = (input: DelayedJobInput) => Promise<void>;

const processors = new Map<QueueName, OutboxProcessor>();
const delayedProcessors = new Map<QueueName, DelayedJobProcessor>();

/** Called by a consumer's slice (from `src/workers`) to attach its processor to a queue. */
export function registerProcessor(queue: QueueName, processor: OutboxProcessor): void {
  if (processors.has(queue)) throw new Error(`A processor is already registered for ${queue}`);
  processors.set(queue, processor);
}

/** Attaches the consumer of a queue's delayed jobs; the queue also needs an outbox processor. */
export function registerDelayedProcessor(queue: QueueName, processor: DelayedJobProcessor): void {
  if (delayedProcessors.has(queue)) {
    throw new Error(`A delayed-job processor is already registered for ${queue}`);
  }
  delayedProcessors.set(queue, processor);
}

export function getRegisteredDelayedProcessors(): ReadonlyMap<QueueName, DelayedJobProcessor> {
  return delayedProcessors;
}

export function getRegisteredProcessors(): ReadonlyMap<QueueName, OutboxProcessor> {
  return processors;
}

/** Test support. */
export function clearProcessors(): void {
  processors.clear();
  delayedProcessors.clear();
}
