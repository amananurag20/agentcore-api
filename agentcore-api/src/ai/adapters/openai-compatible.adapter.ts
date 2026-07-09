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
      throw new Error(`Chat provider returned ${response.status}`);
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
      throw new Error(`Embedding provider returned ${response.status}`);
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
}
