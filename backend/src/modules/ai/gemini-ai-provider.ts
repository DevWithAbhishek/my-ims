import {
  AiProviderError,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProvider,
} from './ai-provider.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;

export type GeminiConfig = {
  apiKey: string;
  model: string;
  requestTimeoutMs: number;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function retryAfterMsOf(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** Whether the error body of a `400` says the API key is invalid (a configuration problem). */
async function isInvalidApiKey(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { details?: unknown } } | null)?.error;
    if (!Array.isArray(error?.details)) return false;
    return error.details.some(
      (detail: unknown) => (detail as { reason?: unknown } | null)?.reason === 'API_KEY_INVALID',
    );
  } catch {
    return false;
  }
}

/** The text parts of the first candidate, joined; empty when the model produced none. */
function textOf(body: unknown): string {
  const candidates = (body as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) return '';
  const parts = (candidates[0] as { content?: { parts?: unknown } } | undefined)?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part: unknown) => (part as { text?: unknown } | null)?.text)
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Gemini `generateContent` (`POST /v1beta/models/<model>:generateContent`) over HTTPS with the
 * global `fetch`; no vendor SDK. The key travels only in the `x-goog-api-key` header. The task's
 * instructions go in `systemInstruction`, the allow-listed input as one JSON object in the user
 * turn, and the answer is requested as JSON. Neither the key, the prompt nor Gemini's error bodies
 * reach an error: only the failure kind and the HTTP status do.
 *
 * Failure mapping: `429` rate limited (honors `Retry-After`); `408` and `5xx` unavailable;
 * `401`/`403`, and a `400` whose details say the key is invalid, are configuration errors (final);
 * network errors and timeouts are retryable; any other `4xx` is rejected (retryable, as for any
 * error the slice does not name as final).
 */
export function createGeminiAiProvider(
  config: GeminiConfig,
  fetchImpl: FetchLike = fetch,
): AiProvider {
  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(config.model)}:generateContent`;

  return {
    async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.instructions }] },
            contents: [{ role: 'user', parts: [{ text: JSON.stringify(request.input) }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
      } catch (error) {
        throw new AiProviderError(isTimeout(error) ? 'TIMEOUT' : 'NETWORK');
      }

      const status = response.status;
      if (status === 429)
        throw new AiProviderError('RATE_LIMITED', status, retryAfterMsOf(response));
      if (status === 408 || status >= 500) throw new AiProviderError('UNAVAILABLE', status);
      if (status === 401 || status === 403) throw new AiProviderError('CONFIGURATION', status);
      if (status === 400 && (await isInvalidApiKey(response))) {
        throw new AiProviderError('CONFIGURATION', status);
      }
      if (status < 200 || status >= 300) throw new AiProviderError('REJECTED', status);

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new AiProviderError(isTimeout(error) ? 'TIMEOUT' : 'UNAVAILABLE', status);
      }
      const reported = (body as { modelVersion?: unknown } | null)?.modelVersion;
      return {
        text: textOf(body),
        model: config.model,
        // Gemini reports the exact version it served; fall back to the requested model id.
        modelVersion: typeof reported === 'string' && reported.length > 0 ? reported : config.model,
      };
    },
  };
}
