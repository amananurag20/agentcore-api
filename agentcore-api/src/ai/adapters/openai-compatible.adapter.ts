import {
  AIAdapterKind,
  AIChatRequest,
  AIChatResponse,
  AIEmbeddingRequest,
  AIEmbeddingResponse,
  AIProviderAdapter,
} from './ai-adapter.types';

interface OpenAICompatibleChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string; type?: string }>;
    };
  }>;
}

interface OpenAICompatibleEmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
}

export class OpenAICompatibleAdapter implements AIProviderAdapter {
  constructor(
    public readonly kind: AIAdapterKind = 'openai_compatible',
    private readonly defaultBaseUrl = 'https://api.openai.com/v1',
  ) {}

  async createChatCompletion(input: AIChatRequest): Promise<AIChatResponse> {
    const response = await fetch(
      `${this.resolveBaseUrl(input.baseUrl)}/chat/completions`,
      {
        method: 'POST',
        headers: this.buildHeaders(input.apiKey),
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          temperature: input.temperature ?? 0.2,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Chat provider returned ${response.status}: ${await this.readProviderError(response)}`,
      );
    }

    const body = (await response.json()) as OpenAICompatibleChatResponse;
    const answer = this.extractContent(body).trim();

    if (!answer) {
      throw new Error('Chat provider returned an empty answer');
    }

    return {
      answer,
      model: input.model,
      adapter: this.kind,
    };
  }

  async createEmbedding(
    input: AIEmbeddingRequest,
  ): Promise<AIEmbeddingResponse> {
    const response = await fetch(
      `${this.resolveBaseUrl(input.baseUrl)}/embeddings`,
      {
        method: 'POST',
        headers: this.buildHeaders(input.apiKey),
        body: JSON.stringify({
          model: input.model,
          input: input.text,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Embedding provider returned ${response.status}: ${await this.readProviderError(response)}`,
      );
    }

    const body = (await response.json()) as OpenAICompatibleEmbeddingResponse;
    const vector = body.data?.[0]?.embedding;

    if (!vector?.length) {
      throw new Error('Embedding provider returned an empty vector');
    }

    return {
      vector,
      model: input.model,
      adapter: this.kind,
    };
  }

  private resolveBaseUrl(baseUrl?: string | null): string {
    return (baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
  }

  private buildHeaders(apiKey?: string): Record<string, string> {
    return {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json',
    };
  }

  private extractContent(body: OpenAICompatibleChatResponse): string {
    const content = body.choices?.[0]?.message?.content;

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((part) => part.text)
        .filter(Boolean)
        .join('\n');
    }

    return '';
  }

  private async readProviderError(response: Response): Promise<string> {
    const text = await response.text();

    if (!text) {
      return response.statusText || 'No provider error body returned';
    }

    try {
      const parsed = JSON.parse(text) as unknown;
      return this.extractErrorMessage(parsed) ?? text;
    } catch {
      return text;
    }
  }

  private extractErrorMessage(value: unknown): string | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const record = value as Record<string, unknown>;

    if (typeof record.message === 'string') {
      return record.message;
    }

    if (typeof record.detail === 'string') {
      return record.detail;
    }

    if (record.error) {
      if (typeof record.error === 'string') {
        return record.error;
      }

      if (typeof record.error === 'object') {
        const errorRecord = record.error as Record<string, unknown>;

        if (typeof errorRecord.message === 'string') {
          return errorRecord.message;
        }

        if (typeof errorRecord.type === 'string') {
          return errorRecord.type;
        }
      }
    }

    return null;
  }
}
