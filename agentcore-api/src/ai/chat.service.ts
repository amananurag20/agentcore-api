import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIProviderConfig, AIProviderType } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

export interface ChatContextChunk {
  content: string;
  score: number;
}

export interface ChatResult {
  answer: string;
  model: string;
  provider: AIProviderType | 'local';
}

interface OpenAIChatResponse {
  choices: Array<{
    message?: {
      content?: string;
    };
  }>;
}

@Injectable()
export class ChatService {
  private readonly defaultModel: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly prisma: PrismaService,
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
    if (
      providerConfig.provider !== 'openai' &&
      providerConfig.provider !== 'custom'
    ) {
      return {
        answer: this.createFallbackAnswer(question, context),
        model: providerConfig.chatModel ?? this.defaultModel,
        provider: providerConfig.provider,
      };
    }

    const apiKey = this.cryptoService.decrypt(providerConfig.apiKeyEncrypted!);
    const baseUrl =
      providerConfig.baseUrl?.replace(/\/+$/, '') ??
      'https://api.openai.com/v1';
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: providerConfig.chatModel ?? this.defaultModel,
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
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      throw new Error(`Chat provider returned ${response.status}`);
    }

    const body = (await response.json()) as OpenAIChatResponse;
    const answer = body.choices[0]?.message?.content?.trim();

    if (!answer) {
      throw new Error('Chat provider returned an empty answer');
    }

    return {
      answer,
      model: providerConfig.chatModel ?? this.defaultModel,
      provider: providerConfig.provider,
    };
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
}
