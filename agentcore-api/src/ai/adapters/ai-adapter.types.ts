export type AIAdapterKind =
  'openai' | 'openai_compatible' | 'mistral' | 'anthropic' | 'ollama';

export type AIChatRole = 'system' | 'user' | 'assistant';

export type AIChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface AIChatMessage {
  role: AIChatRole;
  content: string | AIChatContentPart[];
}

export interface AIChatRequest {
  apiKey?: string;
  baseUrl?: string | null;
  maxOutputTokens?: number;
  model: string;
  messages: AIChatMessage[];
  temperature?: number;
}

export interface AIChatResponse {
  answer: string;
  model: string;
  adapter: AIAdapterKind;
  usage?: AIUsage;
}

export interface AIEmbeddingRequest {
  apiKey?: string;
  baseUrl?: string | null;
  model: string;
  text: string;
}

export interface AIEmbeddingResponse {
  vector: number[];
  model: string;
  adapter: AIAdapterKind;
  usage?: AIUsage;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AITranscriptionRequest {
  apiKey?: string;
  baseUrl?: string | null;
  model: string;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export interface AITranscriptionResponse {
  text: string;
  model: string;
  adapter: AIAdapterKind;
  usage?: AIUsage;
}

export interface AIProviderAdapter {
  readonly kind: AIAdapterKind;
  createChatCompletion?(input: AIChatRequest): Promise<AIChatResponse>;
  createEmbedding?(input: AIEmbeddingRequest): Promise<AIEmbeddingResponse>;
  createTranscription?(
    input: AITranscriptionRequest,
  ): Promise<AITranscriptionResponse>;
}

export interface AIProviderAdapterOptions {
  maxRetries: number;
  maxOutputTokens: number;
  timeoutMs: number;
}
