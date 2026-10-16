import type { Prisma } from '../../generated/prisma/client.js';

/** One message to all of `to` (addresses are looked up at send time and never stored). */
export type EmailMessage = {
  /** Passed to providers that can deduplicate on it. */
  idempotencyKey: string;
  to: string[];
  subject: string;
  text: string;
};

/** What the provider answered, reduced to facts that are safe to store. */
export type EmailReceipt = Prisma.InputJsonObject;

/**
 * Thrown by a provider when a send failed. `receipt` is already sanitized (no addresses, no
 * credentials, no provider message bodies).
 */
export class EmailProviderError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly kind:
      'NETWORK' | 'SERVICE_UNAVAILABLE' | 'RATE_LIMITED' | 'CONFIGURATION' | 'REJECTED',
    readonly receipt: EmailReceipt,
    readonly retryAfterMs?: number,
  ) {
    super(`Email provider failure: ${kind}`);
    this.name = 'EmailProviderError';
  }
}

/** The only place an email leaves the system; called from the worker, never inside a transaction. */
export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailReceipt>;
}
