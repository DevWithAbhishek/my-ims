import {
  EmailProviderError,
  type EmailMessage,
  type EmailProvider,
  type EmailReceipt,
} from './email-provider.js';

const SENDGRID_SEND_URL = 'https://api.sendgrid.com/v3/mail/send';
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;

export type SendGridConfig = {
  apiKey: string;
  fromEmail: string;
  requestTimeoutMs: number;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function retryAfterMsOf(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/**
 * SendGrid v3 Mail Send (`POST /v3/mail/send`) over HTTPS with the global `fetch`; no vendor SDK.
 * One request, one message, all recipients in one `to` list. SendGrid has no idempotency key, so
 * the key in the message is not sent. Neither the API key, the addresses nor SendGrid's error
 * bodies reach an error message or a receipt: only the HTTP status and the message id do.
 */
export function createSendGridEmailProvider(
  config: SendGridConfig,
  fetchImpl: FetchLike = fetch,
): EmailProvider {
  return {
    async send(message: EmailMessage): Promise<EmailReceipt> {
      let response: Response;
      try {
        response = await fetchImpl(SENDGRID_SEND_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            personalizations: [{ to: message.to.map((email) => ({ email })) }],
            from: { email: config.fromEmail },
            subject: message.subject,
            content: [{ type: 'text/plain', value: message.text }],
          }),
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
      } catch {
        throw new EmailProviderError(true, 'NETWORK', { provider: 'sendgrid', error: 'NETWORK' });
      }

      const status = response.status;
      const receipt = { provider: 'sendgrid', statusCode: status };
      if (status >= 200 && status < 300) {
        const messageId = response.headers.get('x-message-id');
        return messageId ? { ...receipt, messageId } : receipt;
      }
      if (status === 429) {
        throw new EmailProviderError(true, 'RATE_LIMITED', receipt, retryAfterMsOf(response));
      }
      if (status === 408 || status >= 500) {
        throw new EmailProviderError(true, 'SERVICE_UNAVAILABLE', receipt);
      }
      if (status === 401 || status === 403) {
        throw new EmailProviderError(false, 'CONFIGURATION', receipt);
      }
      throw new EmailProviderError(false, 'REJECTED', receipt);
    },
  };
}
