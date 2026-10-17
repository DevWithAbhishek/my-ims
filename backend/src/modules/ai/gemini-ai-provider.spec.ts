import { AiProviderError } from './ai-provider';
import { createGeminiAiProvider } from './gemini-ai-provider';

const CONFIG = { apiKey: 'AIza-secret-key', model: 'gemini-flash-test', requestTimeoutMs: 10000 };
const REQUEST = {
  instructions: 'Triage this alert.',
  input: { summary: 'CPU high', description: null, labels: ['a=b'], additionalDetails: null },
};

type Call = { url: string; init: RequestInit };

function provider(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond({ url, init });
  };
  return { calls, ai: createGeminiAiProvider(CONFIG, fetchImpl) };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

async function failureOf(ai: ReturnType<typeof provider>['ai']): Promise<AiProviderError> {
  try {
    await ai.generate(REQUEST);
  } catch (error) {
    expect(error).toBeInstanceOf(AiProviderError);
    return error as AiProviderError;
  }
  throw new Error('expected the call to fail');
}

describe('createGeminiAiProvider', () => {
  it('calls generateContent of the configured model with the key in a header only', async () => {
    const { calls, ai } = provider(() =>
      json({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }], modelVersion: 'v-1.2' }),
    );
    await ai.generate(REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-test:generateContent',
    );
    const init = calls[0]!.init;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'AIza-secret-key',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(String(calls[0]!.url)).not.toContain('AIza-secret-key');
    expect(String(init.body)).not.toContain('AIza-secret-key');
  });

  it('sends the instructions as the system instruction and the input as one JSON object', async () => {
    const { calls, ai } = provider(() => json({ candidates: [] }));
    await ai.generate(REQUEST);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      systemInstruction: { parts: [{ text: 'Triage this alert.' }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(REQUEST.input) }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });
  });

  it('returns the text, the configured model and the version Gemini reports', async () => {
    const { ai } = provider(() =>
      json({
        candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }],
        modelVersion: 'gemini-flash-test-002',
      }),
    );
    expect(await ai.generate(REQUEST)).toEqual({
      text: '{"a":1}',
      model: 'gemini-flash-test',
      modelVersion: 'gemini-flash-test-002',
    });
  });

  it('falls back to the model id when no version is reported, and to empty text when none is produced', async () => {
    const { ai } = provider(() => json({ candidates: [{ finishReason: 'SAFETY' }] }));
    expect(await ai.generate(REQUEST)).toEqual({
      text: '',
      model: 'gemini-flash-test',
      modelVersion: 'gemini-flash-test',
    });
  });

  it('maps 429 to a retryable rate-limit error and honors Retry-After', async () => {
    const { ai } = provider(() => json({}, 429, { 'retry-after': '7' }));
    const error = await failureOf(ai);
    expect([error.kind, error.retryable, error.statusCode, error.retryAfterMs]).toEqual([
      'RATE_LIMITED',
      true,
      429,
      7000,
    ]);
  });

  it('caps an absurd Retry-After and ignores a malformed one', async () => {
    expect(
      (await failureOf(provider(() => json({}, 429, { 'retry-after': '99999' })).ai)).retryAfterMs,
    ).toBe(600_000);
    expect(
      (await failureOf(provider(() => json({}, 429, { 'retry-after': 'soon' })).ai)).retryAfterMs,
    ).toBe(undefined);
  });

  it.each([408, 500, 502, 503, 504])('maps %i to a retryable unavailable error', async (status) => {
    const error = await failureOf(provider(() => json({}, status)).ai);
    expect([error.kind, error.retryable, error.statusCode]).toEqual(['UNAVAILABLE', true, status]);
  });

  it.each([401, 403])('maps %i to a final configuration error', async (status) => {
    const error = await failureOf(provider(() => json({}, status)).ai);
    expect([error.kind, error.retryable]).toEqual(['CONFIGURATION', false]);
  });

  it('maps a 400 that says the key is invalid to a final configuration error', async () => {
    const body = {
      error: {
        code: 400,
        message: 'API key not valid.',
        status: 'INVALID_ARGUMENT',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
        ],
      },
    };
    const error = await failureOf(provider(() => json(body, 400)).ai);
    expect([error.kind, error.retryable]).toEqual(['CONFIGURATION', false]);
  });

  it('treats any other 4xx as rejected, which is retryable', async () => {
    for (const [status, body] of [
      [400, { error: { status: 'INVALID_ARGUMENT', details: [] } }],
      [400, 'not json'],
      [404, {}],
    ] as const) {
      const ai = provider(() =>
        typeof body === 'string' ? new Response(body, { status }) : json(body, status),
      ).ai;
      const error = await failureOf(ai);
      expect([error.kind, error.retryable, error.statusCode]).toEqual(['REJECTED', true, status]);
    }
  });

  it('maps a timeout and a network failure to retryable errors', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    for (const failure of [timeout, aborted]) {
      const error = await failureOf(provider(() => Promise.reject(failure)).ai);
      expect([error.kind, error.retryable]).toEqual(['TIMEOUT', true]);
    }
    const error = await failureOf(provider(() => Promise.reject(new TypeError('fetch failed'))).ai);
    expect([error.kind, error.retryable]).toEqual(['NETWORK', true]);
  });

  it('maps a success body that is not JSON to a retryable unavailable error', async () => {
    const error = await failureOf(provider(() => new Response('<html>', { status: 200 })).ai);
    expect([error.kind, error.retryable]).toEqual(['UNAVAILABLE', true]);
  });

  it('never puts the key, the prompt or a provider message in an error', async () => {
    const body = { error: { message: 'bad request for AIza-secret-key Triage this alert.' } };
    const error = await failureOf(provider(() => json(body, 400)).ai);
    const printed = JSON.stringify({ ...error, text: error.message, stack: error.stack });
    expect(printed).not.toContain('AIza-secret-key');
    expect(printed).not.toContain('Triage this alert');
    expect(printed).not.toContain('bad request');
  });

  it('uses a request timeout signal of the configured length', async () => {
    const spy = jest.spyOn(AbortSignal, 'timeout');
    const { ai } = provider(() => json({ candidates: [] }));
    await ai.generate(REQUEST);
    expect(spy).toHaveBeenCalledWith(10000);
    spy.mockRestore();
  });
});
