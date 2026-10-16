import { EmailProviderError } from './email-provider';
import { createSendGridEmailProvider } from './sendgrid-email-provider';

const config = {
  apiKey: 'SG.secret-key-value',
  fromEmail: 'ims@example.com',
  requestTimeoutMs: 1000,
};
const message = {
  idempotencyKey: 'ASSIGNED:i:a',
  to: ['a@example.com', 'b@example.com'],
  subject: 'Subject',
  text: 'Body',
};

const respond = (status: number, headers: Record<string, string> = {}) =>
  jest.fn(
    async () =>
      new Response('{"errors":[{"message":"a@example.com is bad"}]}', { status, headers }),
  );

async function failure(fetchImpl: ReturnType<typeof respond>): Promise<EmailProviderError> {
  try {
    await createSendGridEmailProvider(config, fetchImpl).send(message);
  } catch (error) {
    return error as EmailProviderError;
  }
  throw new Error('expected a failure');
}

describe('SendGrid email provider', () => {
  it('sends one message to all recipients and returns a sanitized receipt', async () => {
    const fetchImpl = respond(202, { 'x-message-id': 'msg-1' });
    const receipt = await createSendGridEmailProvider(config, fetchImpl).send(message);

    expect(receipt).toEqual({ provider: 'sendgrid', statusCode: 202, messageId: 'msg-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${config.apiKey}`);
    expect(JSON.parse(init.body as string)).toEqual({
      personalizations: [{ to: [{ email: 'a@example.com' }, { email: 'b@example.com' }] }],
      from: { email: 'ims@example.com' },
      subject: 'Subject',
      content: [{ type: 'text/plain', value: 'Body' }],
    });
  });

  it.each([
    [429, true, 'RATE_LIMITED'],
    [500, true, 'SERVICE_UNAVAILABLE'],
    [503, true, 'SERVICE_UNAVAILABLE'],
    [408, true, 'SERVICE_UNAVAILABLE'],
    [401, false, 'CONFIGURATION'],
    [403, false, 'CONFIGURATION'],
    [400, false, 'REJECTED'],
    [413, false, 'REJECTED'],
  ])('classifies HTTP %i (retryable: %s) as %s', async (status, retryable, kind) => {
    const error = await failure(respond(status));
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.retryable).toBe(retryable);
    expect(error.kind).toBe(kind);
    expect(error.receipt).toEqual({ provider: 'sendgrid', statusCode: status });
  });

  it('honors Retry-After on 429 (bounded)', async () => {
    expect((await failure(respond(429, { 'retry-after': '7' }))).retryAfterMs).toBe(7000);
    expect((await failure(respond(429, { 'retry-after': '999999' }))).retryAfterMs).toBe(600_000);
    expect((await failure(respond(429))).retryAfterMs).toBeUndefined();
  });

  it('treats a network error or timeout as retryable', async () => {
    const error = await failure(jest.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    expect(error).toMatchObject({ retryable: true, kind: 'NETWORK' });
  });

  it('never leaks the key, addresses or the provider body into errors or receipts', async () => {
    for (const status of [400, 401, 429, 500]) {
      const error = await failure(respond(status));
      const text = JSON.stringify({ m: error.message, r: error.receipt });
      expect(text).not.toContain(config.apiKey);
      expect(text).not.toContain('example.com');
      expect(text).not.toContain('is bad');
    }
  });
});
