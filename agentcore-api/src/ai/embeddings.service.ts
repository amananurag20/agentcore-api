import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIProviderConfig, AIProviderType } from '@prisma/client';
import { createHash } from 'crypto';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

export interface EmbeddingResult {
  vector: number[];
  model: string;
  provider: AIProviderType | 'local';
}

interface OpenAIEmbeddingResponse {
  data: Array<{
    embedding: number[];
  }>;
}

@Injectable()
export class EmbeddingsService {
  private readonly defaultDimensions: number;
  private readonly defaultModel: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly prisma: PrismaService,
  ) {
    this.defaultDimensions =
      this.configService.get<number>('DEFAULT_EMBEDDING_DIMENSIONS') ?? 1536;
    this.defaultModel =
      this.configService.get<string>('DEFAULT_EMBEDDING_MODEL') ??
      'text-embedding-3-small';
  }

  async embedText(input: {
    organizationId: string;
    text: string;
  }): Promise<EmbeddingResult> {
    const providerConfig = await this.findProviderConfig(input.organizationId);

    if (providerConfig?.apiKeyEncrypted) {
      return this.embedWithProvider(providerConfig, input.text);
    }

    return {
      vector: this.createDeterministicVector(input.text),
      model: providerConfig?.embeddingModel ?? this.defaultModel,
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
        embeddingModel: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async embedWithProvider(
    providerConfig: AIProviderConfig,
    text: string,
  ): Promise<EmbeddingResult> {
    if (
      providerConfig.provider !== 'openai' &&
      providerConfig.provider !== 'custom'
    ) {
      return {
        vector: this.createDeterministicVector(text),
        model: providerConfig.embeddingModel ?? this.defaultModel,
        provider: providerConfig.provider,
      };
    }

    const apiKey = this.cryptoService.decrypt(providerConfig.apiKeyEncrypted!);
    const baseUrl =
      providerConfig.baseUrl?.replace(/\/+$/, '') ??
      'https://api.openai.com/v1';
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: providerConfig.embeddingModel ?? this.defaultModel,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding provider returned ${response.status}`);
    }

    const body = (await response.json()) as OpenAIEmbeddingResponse;
    const vector = body.data[0]?.embedding;

    if (!vector?.length) {
      throw new Error('Embedding provider returned an empty vector');
    }

    return {
      vector,
      model: providerConfig.embeddingModel ?? this.defaultModel,
      provider: providerConfig.provider,
    };
  }

  private createDeterministicVector(text: string): number[] {
    const vector = Array.from({ length: this.defaultDimensions }, () => 0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [text];

    for (const token of tokens) {
      const hash = createHash('sha256').update(token).digest();
      const index = hash.readUInt32BE(0) % this.defaultDimensions;
      const sign = hash[4] % 2 === 0 ? 1 : -1;
      vector[index] += sign;
    }

    const magnitude =
      Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;

    return vector.map((value) => Number((value / magnitude).toFixed(8)));
  }
}
