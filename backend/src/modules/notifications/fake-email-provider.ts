import type { EmailMessage, EmailProvider, EmailReceipt } from './email-provider.js';

/** An in-memory provider for tests: records every message and can be told to fail. */
export class FakeEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  /** Errors thrown by the next sends, in order; an empty queue means success. */
  failures: Error[] = [];
  sendDelayMs = 0;

  async send(message: EmailMessage): Promise<EmailReceipt> {
    if (this.sendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(message);
    return { provider: 'fake', accepted: message.to.length };
  }
}
