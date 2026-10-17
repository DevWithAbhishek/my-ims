import type { AiGenerateRequest, AiGenerateResult, AiProvider } from './ai-provider.js';

/**
 * An in-memory provider for tests: records every request and answers from a queue of outputs
 * (text) or errors, in order. With an empty queue it answers with `defaultText`.
 */
export class FakeAiProvider implements AiProvider {
  readonly calls: AiGenerateRequest[] = [];
  /** Answers of the next calls, in order: a string is the model's text, an Error is thrown. */
  responses: (string | Error)[] = [];
  defaultText = '';
  model = 'fake-model';
  modelVersion = 'fake-model-1';
  delayMs = 0;

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    this.calls.push(request);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return {
      text: next ?? this.defaultText,
      model: this.model,
      modelVersion: this.modelVersion,
    };
  }
}
