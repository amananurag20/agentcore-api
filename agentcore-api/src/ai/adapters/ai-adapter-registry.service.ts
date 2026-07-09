import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIProviderConfig, Prisma } from '@prisma/client';
import { AnthropicAdapter } from './anthropic.adapter';
import {
  AIAdapterKind,
  AIProviderAdapter,
  AIProviderAdapterOptions,
} from './ai-adapter.types';
import { OllamaAdapter } from './ollama.adapter';
import { OpenAICompatibleAdapter } from './openai-compatible.adapter';

@Injectable()
export class AIAdapterRegistryService {
  private readonly anthropic: AnthropicAdapter;
  private readonly mistral: OpenAICompatibleAdapter;
  private readonly ollama: OllamaAdapter;
  private readonly openAI: OpenAICompatibleAdapter;
  private readonly openAICompatible: OpenAICompatibleAdapter;

  constructor(private readonly configService: ConfigService) {
    const options = this.resolveOptions();
    this.openAI = new OpenAICompatibleAdapter(
      'openai',
      'https://api.openai.com/v1',
      options,
    );
    this.openAICompatible = new OpenAICompatibleAdapter(
      'openai_compatible',
      'https://api.openai.com/v1',
      options,
    );
    this.mistral = new OpenAICompatibleAdapter(
      'mistral',
      'https://api.mistral.ai/v1',
      options,
    );
    this.anthropic = new AnthropicAdapter(options);
    this.ollama = new OllamaAdapter(options);
  }

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

  private resolveOptions(): AIProviderAdapterOptions {
    return {
      maxOutputTokens:
        this.configService.get<number>('AI_PROVIDER_MAX_OUTPUT_TOKENS') ?? 1024,
      maxRetries:
        this.configService.get<number>('AI_PROVIDER_MAX_RETRIES') ?? 2,
      timeoutMs:
        this.configService.get<number>('AI_PROVIDER_TIMEOUT_MS') ?? 15_000,
    };
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }
}
