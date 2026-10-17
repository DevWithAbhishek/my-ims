/**
 * The AI provider abstraction (ADR-013), shared by alert triage, postmortem generation and
 * investigation. Business code depends on this interface only; no vendor SDK or API is used
 * outside an adapter.
 */

/**
 * What a provider is given: the task's instructions and the allow-listed input fields. The input
 * is a flat record so a test can assert exactly which fields leave the system.
 */
export type AiGenerateRequest = {
  instructions: string;
  input: Readonly<Record<string, string | readonly string[] | null>>;
};

export type AiGenerateResult = {
  /** The model's answer, unparsed. */
  text: string;
  model: string;
  modelVersion: string;
};

export type AiProviderErrorKind =
  'NETWORK' | 'TIMEOUT' | 'UNAVAILABLE' | 'RATE_LIMITED' | 'REJECTED' | 'CONFIGURATION';

/**
 * Thrown by a provider when a call failed. It carries no provider message, prompt, response body
 * or credential: only the kind and, for a few kinds, the HTTP status.
 */
export class AiProviderError extends Error {
  constructor(
    readonly kind: AiProviderErrorKind,
    readonly statusCode?: number,
    /** A delay supplied by the provider (rate limiting); honored by the retry. */
    readonly retryAfterMs?: number,
  ) {
    super(`AI provider failure: ${kind}`);
    this.name = 'AiProviderError';
  }

  /**
   * Only a configuration or authentication problem is final: retrying cannot fix it. Everything
   * else (unavailable, timeout, rate limit, network, rejected) is retried under the SLICE-08 policy.
   */
  get retryable(): boolean {
    return this.kind !== 'CONFIGURATION';
  }
}

/** The only place a prompt leaves the system; called from the worker, never inside a transaction. */
export interface AiProvider {
  generate(request: AiGenerateRequest): Promise<AiGenerateResult>;
}
