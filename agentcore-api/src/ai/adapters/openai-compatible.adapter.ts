import {
  AIAdapterKind,
  AIChatRequest,
  AIChatResponse,
  AIChatStreamRequest,
  AIEmbeddingRequest,
  AIEmbeddingResponse,
  AIProviderAdapter,
  AIProviderAdapterOptions,
  AITranscriptionRequest,
  AITranscriptionResponse,
} from './ai-adapter.types';

interface OpenAICompatibleChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string; type?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAICompatibleChatStreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: OpenAICompatibleChatResponse['usage'];
}

interface OpenAICompatibleEmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAICompatibleTranscriptionResponse {
  text?: string;
}

const RETRYABLE_STATUSES = [408, 425, 429, 500, 502, 503, 504];

export class OpenAICompatibleAdapter implements AIProviderAdapter {
  constructor(
    public readonly kind: AIAdapterKind = 'openai_compatible',
    private readonly defaultBaseUrl = 'https://api.openai.com/v1',
    private readonly options: AIProviderAdapterOptions = {
      maxOutputTokens: 1024,
      maxRetries: 2,
      timeoutMs: 15_000,
    },
  ) {}

  async createChatCompletion(input: AIChatRequest): Promise<AIChatResponse> {
    const response = await this.fetchWithRetry(
      `${this.resolveBaseUrl(input.baseUrl)}/chat/completions`,
      {
        method: 'POST',
        headers: this.buildHeaders(input.apiKey),
        body: JSON.stringify({
          max_tokens: input.maxOutputTokens ?? this.options.maxOutputTokens,
          model: input.model,
          messages: input.messages,
          temperature: input.temperature ?? 0.2,
        }),
      },
      input.signal,
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
      usage: this.toUsage(body.usage),
    };
  }

  async streamChatCompletion(
    input: AIChatStreamRequest,
  ): Promise<AIChatResponse> {
    const response = await this.fetchWithRetry(
      `${this.resolveBaseUrl(input.baseUrl)}/chat/completions`,
      {
        method: 'POST',
        headers: this.buildHeaders(input.apiKey),
        body: JSON.stringify({
          max_tokens: input.maxOutputTokens ?? this.options.maxOutputTokens,
          model: input.model,
          messages: input.messages,
          temperature: input.temperature ?? 0.2,
          stream: true,
          ...(this.kind === 'openai'
            ? { stream_options: { include_usage: true } }
            : {}),
        }),
      },
      input.signal,
    );

    if (!response.ok) {
      throw new Error(
        `Chat provider returned ${response.status}: ${await this.readProviderError(response)}`,
      );
    }
    if (!response.body) throw new Error('Chat provider returned no stream');

    let answer = '';
    let usage: OpenAICompatibleChatResponse['usage'];
    await this.readLineStream(
      response.body,
      async (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        const chunk = JSON.parse(data) as OpenAICompatibleChatStreamChunk;
        usage = chunk.usage ?? usage;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (!delta) return;
        answer += delta;
        await input.onDelta(delta);
      },
      input.signal,
    );

    if (!answer.trim())
      throw new Error('Chat provider returned an empty answer');
    return {
      answer: answer.trim(),
      model: input.model,
      adapter: this.kind,
      usage: this.toUsage(usage),
    };
  }

  async createEmbedding(
    input: AIEmbeddingRequest,
  ): Promise<AIEmbeddingResponse> {
    const response = await this.fetchWithRetry(
      `${this.resolveBaseUrl(input.baseUrl)}/embeddings`,
      {
        method: 'POST',
        headers: this.buildHeaders(input.apiKey),
        body: JSON.stringify({
          model: input.model,
          input: input.text,
        }),
      },
      input.signal,
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
      usage: this.toUsage(body.usage),
    };
  }

  private toUsage(usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  }) {
    if (!usage) return undefined;
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
    };
  }

  async createTranscription(
    input: AITranscriptionRequest,
  ): Promise<AITranscriptionResponse> {
    const form = new FormData();
    form.append('model', input.model);
    form.append(
      'file',
      new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }),
      input.fileName,
    );
    const response = await this.fetchWithRetry(
      `${this.resolveBaseUrl(input.baseUrl)}/audio/transcriptions`,
      {
        method: 'POST',
        headers: input.apiKey
          ? { Authorization: `Bearer ${input.apiKey}` }
          : undefined,
        body: form,
      },
    );
    if (!response.ok) {
      throw new Error(
        `Transcription provider returned ${response.status}: ${await this.readProviderError(response)}`,
      );
    }
    const body =
      (await response.json()) as OpenAICompatibleTranscriptionResponse;
    const text = body.text?.trim();
    if (!text) throw new Error('Transcription provider returned empty text');
    return { text, model: input.model, adapter: this.kind };
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

  private async readLineStream(
    body: ReadableStream<Uint8Array>,
    onLine: (line: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        if (signal?.aborted)
          throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) await onLine(line);
      }
      buffer += decoder.decode();
      if (buffer) await onLine(buffer);
    } finally {
      reader.releaseLock();
    }
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
