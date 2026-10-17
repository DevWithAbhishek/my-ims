import { AiProviderError } from './ai-provider';
import { FakeAiProvider } from './fake-ai-provider';

const REQUEST = { instructions: 'i', input: { summary: 's', labels: ['a'] } };

describe('FakeAiProvider', () => {
  it('records every request and answers from its queue, then with the default text', async () => {
    const fake = new FakeAiProvider();
    fake.responses = ['first'];
    fake.defaultText = 'default';

    expect((await fake.generate(REQUEST)).text).toBe('first');
    expect(await fake.generate(REQUEST)).toEqual({
      text: 'default',
      model: 'fake-model',
      modelVersion: 'fake-model-1',
    });
    expect(fake.calls).toEqual([REQUEST, REQUEST]);
  });

  it('throws a queued error once and then recovers', async () => {
    const fake = new FakeAiProvider();
    fake.responses = [new AiProviderError('UNAVAILABLE', 503), 'ok'];
    await expect(fake.generate(REQUEST)).rejects.toBeInstanceOf(AiProviderError);
    expect((await fake.generate(REQUEST)).text).toBe('ok');
    expect(fake.calls).toHaveLength(2);
  });
});
