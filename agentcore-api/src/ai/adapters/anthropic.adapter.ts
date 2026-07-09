import {
  AIChatRequest,
  AIChatResponse,
  AIProviderAdapter,
} from './ai-adapter.types';

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

export class AnthropicAdapter implements AIProviderAdapter {
  readonly kind = 'anthropic' as const;

  async createChatCompletion(input: AIChatRequest): Promise<AIChatResponse> {
    if (!input.apiKey) {
      throw new Error('Anthropic API key is required');
    }

    const system = input.messages.find((message) => message.role === 'system');
    const messages = input.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      }));

    const response = await fetch(
      `${this.resolveBaseUrl(input.baseUrl)}/messages`,
      {
        method: 'POST',
        headers: {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'x-api-key': input.apiKey,
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: 1024,
          system: system?.content,
          messages,
          temperature: input.temperature ?? 0.2,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Anthropic provider returned ${response.status}: ${await this.readProviderError(response)}`,
      );
    }

    const body = (await response.json()) as AnthropicResponse;
    const answer = (body.content ?? [])
      .map((part) => part.text)
      .filter(Boolean)
      .join('\n')
      .trim();

    if (!answer) {
      throw new Error('Anthropic provider returned an empty answer');
    }

    return {
      answer,
      model: input.model,
      adapter: this.kind,
    };
  }

  private resolveBaseUrl(baseUrl?: string | null): string {
    return (baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  }

  private async readProviderError(response: Response): Promise<string> {
    const text = await response.text();

    if (!text) {
      return response.statusText || 'No provider error body returned';
    }

    try {
      const parsed = JSON.parse(text) as unknown;

      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        const error = record.error;

        if (error && typeof error === 'object') {
          const errorRecord = error as Record<string, unknown>;

          if (typeof errorRecord.message === 'string') {
            return errorRecord.message;
          }
        }

        if (typeof record.message === 'string') {
          return record.message;
        }
      }

      return text;
    } catch {
      return text;
    }
  }
}
