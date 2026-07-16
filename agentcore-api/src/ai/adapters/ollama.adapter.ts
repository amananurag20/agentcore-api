import {
  AIChatRequest,
  AIChatResponse,
  AIChatStreamRequest,
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
  prompt_eval_count?: number;
  eval_count?: number;
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
      input.signal,
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
      usage: {
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
        totalTokens: (body.prompt_eval_count ?? 0) + (body.eval_count ?? 0),
      },
    };
  }

  async streamChatCompletion(
    input: AIChatStreamRequest,
  ): Promise<AIChatResponse> {
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
          stream: true,
          options: {
            num_predict: input.maxOutputTokens ?? this.options.maxOutputTokens,
            temperature: input.temperature ?? 0.2,
          },
        }),
      },
      input.signal,
    );
    if (!response.ok) {
      throw new Error(
        `Ollama chat provider returned ${response.status}: ${await this.readProviderError(response)}`,
      );
    }
    if (!response.body) throw new Error('Ollama provider returned no stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      while (true) {
        if (input.signal?.aborted)
          throw (
            input.signal.reason ?? new DOMException('Aborted', 'AbortError')
          );
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const chunk = JSON.parse(line) as OllamaChatResponse;
          inputTokens = chunk.prompt_eval_count ?? inputTokens;
          outputTokens = chunk.eval_count ?? outputTokens;
          const delta = chunk.message?.content ?? chunk.response ?? '';
          if (!delta) continue;
          answer += delta;
          await input.onDelta(delta);
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!answer.trim())
      throw new Error('Ollama chat provider returned an empty answer');
    return {
      answer: answer.trim(),
      model: input.model,
      adapter: this.kind,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
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
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...init,
          redirect: 'manual',
          signal: signal
            ? AbortSignal.any([
                signal,
                AbortSignal.timeout(this.options.timeoutMs),
              ])
            : AbortSignal.timeout(this.options.timeoutMs),
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
