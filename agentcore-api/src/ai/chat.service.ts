import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIProviderConfig, AIProviderType } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { AIAdapterRegistryService } from './adapters/ai-adapter-registry.service';

export interface ChatContextChunk {
  content: string;
  score: number;
}

export interface ChatResult {
  answer: string;
  model: string;
  provider: AIProviderType | 'local';
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly defaultModel: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly prisma: PrismaService,
    private readonly adapterRegistry: AIAdapterRegistryService,
  ) {
    this.defaultModel =
      this.configService.get<string>('DEFAULT_CHAT_MODEL') ?? 'gpt-4.1-mini';
  }

  async answerWithContext(input: {
    organizationId: string;
    question: string;
    context: ChatContextChunk[];
  }): Promise<ChatResult> {
    const providerConfig = await this.findProviderConfig(input.organizationId);

    if (providerConfig?.apiKeyEncrypted) {
      return this.chatWithProvider(
        providerConfig,
        input.question,
        input.context,
      );
    }

    return {
      answer: this.createFallbackAnswer(input.question, input.context),
      model: providerConfig?.chatModel ?? this.defaultModel,
      provider: providerConfig?.provider ?? 'local',
    };
  }

  private async findProviderConfig(
    organizationId: string,
  ): Promise<AIProviderConfig | null> {
    return this.prisma.aIProviderConfig.findFirst({
      where: {
        organizationId,
        status: 'active',
        chatModel: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async chatWithProvider(
    providerConfig: AIProviderConfig,
    question: string,
    context: ChatContextChunk[],
  ): Promise<ChatResult> {
    const adapter = this.adapterRegistry.getAdapter(providerConfig);

    if (!adapter.createChatCompletion) {
      return {
        answer: this.createFallbackAnswer(question, context),
        model: providerConfig.chatModel ?? this.defaultModel,
        provider: providerConfig.provider,
      };
    }

    const apiKey = this.cryptoService.decrypt(providerConfig.apiKeyEncrypted!);
    const model = providerConfig.chatModel ?? this.defaultModel;

    try {
      const result = await adapter.createChatCompletion({
        apiKey,
        baseUrl: providerConfig.baseUrl,
        model,
        messages: [
          {
            role: 'system',
            content:
              'Answer using only the provided business knowledge. If the answer is not in the context, say you do not know and suggest contacting the business.',
          },
          {
            role: 'user',
            content: this.buildPrompt(question, context),
          },
        ],
        temperature: this.readTemperature(providerConfig),
      });

      return {
        answer: result.answer,
        model: result.model,
        provider: providerConfig.provider,
      };
    } catch (error) {
      this.logger.warn(
        `AI chat adapter failed for provider ${providerConfig.id}; using fallback answer. ${this.toErrorMessage(error)}`,
      );

      return {
        answer: this.createFallbackAnswer(question, context),
        model: providerConfig.chatModel ?? this.defaultModel,
        provider: providerConfig.provider,
      };
    }
  }

  private buildPrompt(question: string, context: ChatContextChunk[]): string {
    const contextText = context
      .map((chunk, index) => `[${index + 1}] ${chunk.content}`)
      .join('\n\n');

    return `Context:\n${contextText || 'No context found.'}\n\nQuestion:\n${question}`;
  }

  private createFallbackAnswer(
    question: string,
    context: ChatContextChunk[],
  ): string {
    if (!context.length) {
      return `I do not know from the available knowledge base. Please contact the business for help with: ${question}`;
    }

    return `Based on the available knowledge base: ${context[0].content}`;
  }

  private readTemperature(providerConfig: AIProviderConfig): number {
    const settings = providerConfig.settings;

    if (
      settings &&
      !Array.isArray(settings) &&
      typeof settings === 'object' &&
      typeof settings.temperature === 'number'
    ) {
      return settings.temperature;
    }

    return 0.2;
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
