import { Injectable } from '@nestjs/common';
import { AIProviderConfig, Prisma } from '@prisma/client';
import { AnthropicAdapter } from './anthropic.adapter';
import { AIAdapterKind, AIProviderAdapter } from './ai-adapter.types';
import { OllamaAdapter } from './ollama.adapter';
import { OpenAICompatibleAdapter } from './openai-compatible.adapter';

@Injectable()
export class AIAdapterRegistryService {
  private readonly openAI = new OpenAICompatibleAdapter(
    'openai',
    'https://api.openai.com/v1',
  );
  private readonly openAICompatible = new OpenAICompatibleAdapter(
    'openai_compatible',
    'https://api.openai.com/v1',
  );
  private readonly mistral = new OpenAICompatibleAdapter(
    'mistral',
    'https://api.mistral.ai/v1',
  );
  private readonly anthropic = new AnthropicAdapter();
  private readonly ollama = new OllamaAdapter();

  getAdapter(config: AIProviderConfig): AIProviderAdapter {
    const settings = this.toRecord(config.settings);
    const adapter = this.readAdapterHint(settings);

    if (adapter) {
      return this.byKind(adapter);
    }

    if (config.provider === 'openai') {
      return this.openAI;
    }

    if (config.provider === 'anthropic') {
      return this.anthropic;
    }

    if (config.provider === 'local') {
      return this.ollama;
    }

    if (this.looksLikeMistral(config.baseUrl)) {
      return this.mistral;
    }

    return this.openAICompatible;
  }

  private byKind(kind: AIAdapterKind): AIProviderAdapter {
    switch (kind) {
      case 'openai':
        return this.openAI;
      case 'mistral':
        return this.mistral;
      case 'anthropic':
        return this.anthropic;
      case 'ollama':
        return this.ollama;
      case 'openai_compatible':
      default:
        return this.openAICompatible;
    }
  }

  private readAdapterHint(
    settings: Record<string, unknown>,
  ): AIAdapterKind | null {
    const adapter = settings.adapter;

    if (
      adapter === 'openai' ||
      adapter === 'openai_compatible' ||
      adapter === 'mistral' ||
      adapter === 'anthropic' ||
      adapter === 'ollama'
    ) {
      return adapter;
    }

    return null;
  }

  private looksLikeMistral(baseUrl?: string | null): boolean {
    return Boolean(baseUrl?.toLowerCase().includes('mistral.ai'));
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }
}
