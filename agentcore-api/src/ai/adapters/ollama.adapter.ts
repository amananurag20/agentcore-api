import {
  AIChatRequest,
  AIChatResponse,
  AIEmbeddingRequest,
  AIEmbeddingResponse,
  AIProviderAdapter,
  AIProviderAdapterOptions,
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

const RETRYABLE_STATUSES = [408, 425, 429, 500, 502, 503, 504];

export class OllamaAdapter implements AIProviderAdapter {
  readonly kind = 'ollama' as const;

  constructor(
    private readonly options: AIProviderAdapterOptions = {
      maxOutputTokens: 1024,
      maxRetries: 2,
      timeoutMs: 15_000,
    },
  ) {}

  async createChatCompletion(input: AIChatRequest): Promise<AIChatResponse> {
    const response = await this.fetchWithRetry(
      `${this.resolveBaseUrl(input.baseUrl)}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages.map((message) =>
            this.toOllamaMessage(message),
          ),
          stream: false,
          options: {
            num_predict: input.maxOutputTokens ?? this.options.maxOutputTokens,
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
    const response = await this.fetchWithRetry(
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

  private toOllamaMessage(message: AIChatRequest['messages'][number]) {
    if (typeof message.content === 'string') return message;
    return {
      role: message.role,
      content: message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
      images: message.content
        .filter((part) => part.type === 'image_url')
        .map((part) => part.image_url.url.replace(/^data:[^;]+;base64,/, '')),
    };
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
