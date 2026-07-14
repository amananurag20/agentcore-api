import {
  AIChatRequest,
  AIChatResponse,
  AIProviderAdapter,
  AIProviderAdapterOptions,
} from './ai-adapter.types';

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

const RETRYABLE_STATUSES = [408, 425, 429, 500, 502, 503, 504];

export class AnthropicAdapter implements AIProviderAdapter {
  readonly kind = 'anthropic' as const;

  constructor(
    private readonly options: AIProviderAdapterOptions = {
      maxOutputTokens: 1024,
      maxRetries: 2,
      timeoutMs: 15_000,
    },
  ) {}

  async createChatCompletion(input: AIChatRequest): Promise<AIChatResponse> {
    if (!input.apiKey) {
      throw new Error('Anthropic API key is required');
    }

    const system = input.messages.find((message) => message.role === 'system');
    const messages = input.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: this.toAnthropicContent(message.content),
      }));

    const response = await this.fetchWithRetry(
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
          max_tokens: input.maxOutputTokens ?? this.options.maxOutputTokens,
          system:
            typeof system?.content === 'string'
              ? system.content
              : system?.content
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text)
                  .join('\n'),
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

  private toAnthropicContent(
    content: AIChatRequest['messages'][number]['content'],
  ) {
    if (typeof content === 'string') return content;
    return content.map((part) => {
      if (part.type === 'text') return part;
      const match = /^data:([^;]+);base64,(.+)$/.exec(part.image_url.url);
      if (!match) {
        return { type: 'text', text: '[Image attachment unavailable]' };
      }
      return {
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] },
      };
    });
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });

        if (
          attempt < this.options.maxRetries &&
          RETRYABLE_STATUSES.includes(response.status)
        ) {
          await this.sleep(this.resolveRetryDelayMs(response, attempt));
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;

        if (attempt < this.options.maxRetries) {
          await this.sleep(250 * (attempt + 1));
          continue;
        }
      }
    }

    throw new Error(
      `AI provider request failed: ${this.toErrorMessage(lastError)}`,
    );
  }

  private resolveRetryDelayMs(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('retry-after');

    if (retryAfter) {
      const retryAfterSeconds = Number(retryAfter);

      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
        return Math.min(retryAfterSeconds * 1000, 5000);
      }
    }

    return 250 * (attempt + 1);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
