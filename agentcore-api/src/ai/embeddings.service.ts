import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIProviderConfig, AIProviderType } from '@prisma/client';
import { createHash } from 'crypto';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { AIUsageService } from '../ai-usage/ai-usage.service';
import { AIAdapterRegistryService } from './adapters/ai-adapter-registry.service';
import { ProviderEndpointPolicyService } from './provider-endpoint-policy.service';

export interface EmbeddingResult {
  vector: number[];
  model: string;
  provider: AIProviderType | 'local';
  isFallback: boolean;
}

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);
  private readonly defaultDimensions: number;
  private readonly defaultModel: string;
  private readonly allowLocalFallback: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly prisma: PrismaService,
    private readonly adapterRegistry: AIAdapterRegistryService,
    @Optional() private readonly usageService?: AIUsageService,
    @Optional()
    private readonly endpointPolicy?: ProviderEndpointPolicyService,
  ) {
    this.defaultDimensions =
      this.configService.get<number>('DEFAULT_EMBEDDING_DIMENSIONS') ?? 1536;
    this.defaultModel =
      this.configService.get<string>('DEFAULT_EMBEDDING_MODEL') ??
      'text-embedding-3-small';
    this.allowLocalFallback =
      this.configService.get<boolean>('ALLOW_LOCAL_EMBEDDINGS') ??
      this.configService.get<string>('NODE_ENV') !== 'production';
  }

  async embedText(input: {
    organizationId: string;
    text: string;
  }): Promise<EmbeddingResult> {
    const providerConfig = await this.findProviderConfig(input.organizationId);

    if (providerConfig?.apiKeyEncrypted) {
      return this.embedWithProvider(providerConfig, input.text);
    }

    if (!this.allowLocalFallback) {
      throw new ServiceUnavailableException(
        'No active embedding provider is configured for this organization',
      );
    }
    return this.localEmbedding(input.text, providerConfig);
  }

  async embedForIndexing(input: {
    organizationId: string;
    text: string;
  }): Promise<EmbeddingResult> {
    const embedding = await this.embedText(input);
    if (embedding.isFallback) {
      throw new ServiceUnavailableException(
        'Knowledge ingestion requires a configured embedding provider; local deterministic embeddings are not persisted',
      );
    }
    return embedding;
  }

  async embedManyForIndexing(input: {
    organizationId: string;
    texts: string[];
  }): Promise<EmbeddingResult[]> {
    if (!input.texts.length) return [];
    const providerConfig = await this.findProviderConfig(input.organizationId);
    if (!providerConfig?.apiKeyEncrypted) {
      throw new ServiceUnavailableException(
        'Knowledge ingestion requires a configured embedding provider',
      );
    }
    const concurrency = Math.max(
      1,
      this.configService.get<number>('KNOWLEDGE_EMBEDDING_CONCURRENCY') ?? 4,
    );
    const results: EmbeddingResult[] = [];
    for (let offset = 0; offset < input.texts.length; offset += concurrency) {
      const batch = input.texts.slice(offset, offset + concurrency);
      const embedded = await Promise.all(
        batch.map((text) => this.embedWithProvider(providerConfig, text)),
      );
      embedded.forEach((result, index) => {
        if (result.isFallback) {
          throw new ServiceUnavailableException(
            'Knowledge ingestion cannot persist fallback embeddings',
          );
        }
        results[offset + index] = result;
      });
    }
    return results;
  }

  private async findProviderConfig(
    organizationId: string,
  ): Promise<AIProviderConfig | null> {
    const selection = await this.prisma.knowledgeExtractionConfig.findUnique({
      where: { organizationId },
      select: { embeddingProviderId: true },
    });
    if (selection?.embeddingProviderId) {
      const selected = await this.prisma.aIProviderConfig.findFirst({
        where: {
          id: selection.embeddingProviderId,
          organizationId,
          status: 'active',
          validationStatus: 'verified',
          embeddingModel: { not: null },
        },
      });
      if (!selected) {
        throw new ServiceUnavailableException(
          'The selected embedding provider is unavailable or inactive',
        );
      }
      return selected;
    }
    return this.prisma.aIProviderConfig.findFirst({
      where: {
        organizationId,
        status: 'active',
        validationStatus: 'verified',
        embeddingModel: { not: null },
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
  }

  private async embedWithProvider(
    providerConfig: AIProviderConfig,
    text: string,
  ): Promise<EmbeddingResult> {
    const adapter = this.adapterRegistry.getAdapter(providerConfig);

    if (!adapter.createEmbedding) {
      if (!this.allowLocalFallback) {
        throw new ServiceUnavailableException(
          `Provider ${providerConfig.provider} does not support embeddings`,
        );
      }
      return this.localEmbedding(text, providerConfig);
    }

    const model = providerConfig.embeddingModel ?? this.defaultModel;
    const startedAt = Date.now();

    try {
      const apiKey = this.cryptoService.decrypt(
        providerConfig.apiKeyEncrypted!,
      );
      await this.usageService?.assertBudgetAvailable(providerConfig);
      await this.endpointPolicy?.assertProviderAllowed(providerConfig);
      const result = await adapter.createEmbedding({
        apiKey,
        baseUrl: providerConfig.baseUrl,
        model,
        text,
      });
      await this.usageService?.record({
        provider: providerConfig,
        capability: 'embedding',
        model: result.model,
        usage: result.usage,
        latencyMs: Date.now() - startedAt,
        success: true,
      });

      return {
        vector: this.assertVectorDimensions(result.vector),
        model: result.model,
        provider: providerConfig.provider,
        isFallback: false,
      };
    } catch (error) {
      await this.usageService?.record({
        provider: providerConfig,
        capability: 'embedding',
        model,
        latencyMs: Date.now() - startedAt,
        success: false,
      });
      if (!this.allowLocalFallback) {
        throw new ServiceUnavailableException(
          `Embedding provider failed: ${this.toErrorMessage(error)}`,
        );
      }
      this.logger.warn(
        `AI embedding adapter failed for provider ${providerConfig.id}; using local deterministic vector. ${this.toErrorMessage(error)}`,
      );
      return this.localEmbedding(text, providerConfig);
    }
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

  private localEmbedding(
    text: string,
    providerConfig: AIProviderConfig | null,
  ): EmbeddingResult {
    return {
      vector: this.createDeterministicVector(text),
      model: providerConfig?.embeddingModel ?? this.defaultModel,
      provider: 'local',
      isFallback: true,
    };
  }

  private assertVectorDimensions(vector: number[]): number[] {
    if (vector.length !== this.defaultDimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.defaultDimensions}, received ${vector.length}`,
      );
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error('Embedding provider returned non-finite values');
    }
    return vector;
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
