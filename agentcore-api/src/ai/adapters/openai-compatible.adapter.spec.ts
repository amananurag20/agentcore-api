import { OpenAICompatibleAdapter } from './openai-compatible.adapter';

describe('OpenAICompatibleAdapter streaming', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('emits provider deltas and returns the reconciled answer and usage', async () => {
    const encoder = new TextEncoder();
    const payload = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ];
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            payload.forEach((part) => controller.enqueue(encoder.encode(part)));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
    const deltas: string[] = [];
    const adapter = new OpenAICompatibleAdapter('openai');

    const result = await adapter.streamChatCompletion({
      apiKey: 'test',
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'Hi' }],
      onDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(['Hello', ' there']);
    expect(result.answer).toBe('Hello there');
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
    });
  });

  it('stops reading when the caller aborts', async () => {
    const controller = new AbortController();
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
              ),
            );
          },
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatibleAdapter('openai');
    const promise = adapter.streamChatCompletion({
      apiKey: 'test',
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'Hi' }],
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
