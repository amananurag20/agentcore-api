export type AIAdapterKind =
  'openai' | 'openai_compatible' | 'mistral' | 'anthropic' | 'ollama';

export type AIChatRole = 'system' | 'user' | 'assistant';

export interface AIChatMessage {
  role: AIChatRole;
  content: string;
}

export interface AIChatRequest {
  apiKey?: string;
  baseUrl?: string | null;
  model: string;
  messages: AIChatMessage[];
  temperature?: number;
}

export interface AIChatResponse {
  answer: string;
  model: string;
  adapter: AIAdapterKind;
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
}

export interface AIProviderAdapter {
  readonly kind: AIAdapterKind;
  createChatCompletion?(input: AIChatRequest): Promise<AIChatResponse>;
  createEmbedding?(input: AIEmbeddingRequest): Promise<AIEmbeddingResponse>;
}
