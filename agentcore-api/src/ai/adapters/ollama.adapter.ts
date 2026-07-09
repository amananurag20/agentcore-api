import {
  AIChatRequest,
  AIChatResponse,
  AIEmbeddingRequest,
  AIEmbeddingResponse,
  AIProviderAdapter,
} from './ai-adapter.types';

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
  response?: string;
}

interface OllamaEmbeddingResponse {
  embedding?: number[];
}

export class OllamaAdapter implements AIProviderAdapter {
  readonly kind = 'ollama' as const;

  async createChatCompletion(input: AIChatRequest): Promise<AIChatResponse> {
    const response = await fetch(
      `${this.resolveBaseUrl(input.baseUrl)}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          stream: false,
          options: {
            temperature: input.temperature ?? 0.2,
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Ollama chat provider returned ${response.status}: ${await this.readProviderError(response)}`,
      );
    }

    const body = (await response.json()) as OllamaChatResponse;
    const answer = (body.message?.content ?? body.response ?? '').trim();

    if (!answer) {
      throw new Error('Ollama chat provider returned an empty answer');
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
      `${this.resolveBaseUrl(input.baseUrl)}/api/embeddings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          prompt: input.text,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Ollama embedding provider returned ${response.status}: ${await this.readProviderError(response)}`,
      );
    }

    const body = (await response.json()) as OllamaEmbeddingResponse;
    const vector = body.embedding;

    if (!vector?.length) {
      throw new Error('Ollama embedding provider returned an empty vector');
    }

    return {
      vector,
      model: input.model,
      adapter: this.kind,
    };
  }

  private resolveBaseUrl(baseUrl?: string | null): string {
    return (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
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

        if (typeof record.error === 'string') {
          return record.error;
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
