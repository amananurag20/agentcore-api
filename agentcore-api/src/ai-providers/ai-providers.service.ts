import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIProviderConfig, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { resolveEmbeddingDimensions } from '../ai/embedding-model-dimensions';
import { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeIngestionQueueService } from '../knowledge-ingestion/knowledge-ingestion-queue.service';
import { KnowledgeIngestionService } from '../knowledge-ingestion/knowledge-ingestion.service';
import { CreateAIProviderDto } from './dto/create-ai-provider.dto';
import { UpdateAIProviderDto } from './dto/update-ai-provider.dto';

type SafeAIProviderConfig = Omit<
  AIProviderConfig,
  'apiKeyEncrypted' | 'settings'
> & {
  hasApiKey: boolean;
  settings: Record<string, unknown>;
};

@Injectable()
export class AIProvidersService {
  private readonly logger = new Logger(AIProvidersService.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly ingestionQueue: KnowledgeIngestionQueueService,
    private readonly ingestionService: KnowledgeIngestionService,
    private readonly prisma: PrismaService,
  ) {}

  async list(
    currentUser: AuthenticatedUser,
    requestedOrganizationId?: string,
  ): Promise<SafeAIProviderConfig[]> {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      requestedOrganizationId,
    );
    const configs = await this.prisma.aIProviderConfig.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });

    return configs.map((config) => this.toSafeConfig(config));
  }

  async create(
    currentUser: AuthenticatedUser,
    input: CreateAIProviderDto,
  ): Promise<SafeAIProviderConfig> {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    this.validateEmbeddingModel(input.embeddingModel, input.settings ?? {});
    const previousEmbeddingConfig =
      await this.findActiveEmbeddingConfig(organizationId);

    const config = await this.prisma.aIProviderConfig.create({
      data: {
        organizationId,
        provider: input.provider,
        status: input.status ?? 'active',
        name: input.name,
        baseUrl: input.baseUrl,
        apiKeyEncrypted: input.apiKey
          ? this.cryptoService.encrypt(input.apiKey)
          : undefined,
        chatModel: input.chatModel,
        embeddingModel: input.embeddingModel,
        rerankModel: input.rerankModel,
        sttModel: input.sttModel,
        ttsModel: input.ttsModel,
        settings: this.toJsonObject(input.settings),
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'ai_provider.created',
      entityType: 'ai_provider',
      entityId: config.id,
      metadata: {
        provider: config.provider,
        name: config.name,
        hasApiKey: Boolean(config.apiKeyEncrypted),
      },
    });

    await this.reembedIfActiveSpaceChanged(
      organizationId,
      previousEmbeddingConfig,
    );

    return this.toSafeConfig(config);
  }

  async getById(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<SafeAIProviderConfig> {
    const config = await this.findConfigForActor(currentUser, id);
    return this.toSafeConfig(config);
  }

  async update(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateAIProviderDto,
  ): Promise<SafeAIProviderConfig> {
    const existing = await this.findConfigForActor(currentUser, id);
    const organizationId = input.organizationId
      ? this.resolveOrganizationId(currentUser, input.organizationId)
      : existing.organizationId;
    const selectedBy = await this.prisma.knowledgeExtractionConfig.findFirst({
      where: { embeddingProviderId: id },
      select: { organizationId: true },
    });
    if (
      selectedBy &&
      (organizationId !== existing.organizationId ||
        (input.status ?? existing.status) !== 'active' ||
        !(input.embeddingModel ?? existing.embeddingModel))
    ) {
      throw new BadRequestException(
        'Select a different knowledge embedding provider before moving or deactivating this provider',
      );
    }
    const settings = input.settings ?? this.toRecord(existing.settings);
    this.validateEmbeddingModel(
      input.embeddingModel ?? existing.embeddingModel ?? undefined,
      settings,
    );
    const affectedOrganizationIds = [
      ...new Set([existing.organizationId, organizationId]),
    ];
    const previousEmbeddingConfigs = new Map(
      await Promise.all(
        affectedOrganizationIds.map(
          async (affectedOrganizationId) =>
            [
              affectedOrganizationId,
              await this.findActiveEmbeddingConfig(affectedOrganizationId),
            ] as const,
        ),
      ),
    );

    const config = await this.prisma.aIProviderConfig.update({
      where: { id },
      data: {
        organizationId: input.organizationId
          ? this.resolveOrganizationId(currentUser, input.organizationId)
          : undefined,
        provider: input.provider,
        status: input.status,
        name: input.name,
        baseUrl: input.baseUrl,
        apiKeyEncrypted:
          input.apiKey === undefined
            ? undefined
            : this.cryptoService.encrypt(input.apiKey),
        chatModel: input.chatModel,
        embeddingModel: input.embeddingModel,
        rerankModel: input.rerankModel,
        sttModel: input.sttModel,
        ttsModel: input.ttsModel,
        settings: input.settings
          ? this.toJsonObject(input.settings)
          : undefined,
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'ai_provider.updated',
      entityType: 'ai_provider',
      entityId: config.id,
      metadata: this.removeUndefined({
        provider: input.provider,
        status: input.status,
        name: input.name,
        baseUrl: input.baseUrl,
        chatModel: input.chatModel,
        embeddingModel: input.embeddingModel,
        apiKeyUpdated: input.apiKey !== undefined,
      }),
    });

    for (const affectedOrganizationId of affectedOrganizationIds) {
      await this.reembedIfActiveSpaceChanged(
        affectedOrganizationId,
        previousEmbeddingConfigs.get(affectedOrganizationId) ?? null,
      );
    }

    return this.toSafeConfig(config);
  }

  async delete(currentUser: AuthenticatedUser, id: string) {
    const config = await this.findConfigForActor(currentUser, id);
    const selectedBy = await this.prisma.knowledgeExtractionConfig.findFirst({
      where: { embeddingProviderId: id },
      select: { id: true },
    });
    if (selectedBy) {
      throw new BadRequestException(
        'Select a different knowledge embedding provider before deleting this provider',
      );
    }
    const previousEmbeddingConfig = await this.findActiveEmbeddingConfig(
      config.organizationId,
    );
    await this.prisma.aIProviderConfig.delete({ where: { id } });

    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'ai_provider.deleted',
      entityType: 'ai_provider',
      entityId: id,
      metadata: {
        provider: config.provider,
        name: config.name,
      },
    });

    await this.reembedIfActiveSpaceChanged(
      config.organizationId,
      previousEmbeddingConfig,
    );

    return { deleted: true };
  }

  private async findConfigForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<AIProviderConfig> {
    const config = await this.prisma.aIProviderConfig.findUnique({
      where: { id },
    });

    if (!config) {
      throw new NotFoundException('AI provider config not found');
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      config.organizationId !== currentUser.orgId
    ) {
      throw new NotFoundException('AI provider config not found');
    }

    return config;
  }

  private validateEmbeddingModel(
    model: string | undefined,
    settings: Record<string, unknown>,
  ): void {
    if (!model) return;

    const storageDimensions =
      this.configService.get<number>('DEFAULT_EMBEDDING_DIMENSIONS') ?? 1536;
    const modelDimensions = resolveEmbeddingDimensions(model, settings);
    if (modelDimensions === null) {
      throw new BadRequestException(
        `Embedding model ${model} has unknown dimensions; set settings.embeddingDimensions to validate it against the vector index`,
      );
    }
    if (modelDimensions !== storageDimensions) {
      throw new BadRequestException(
        `Embedding model ${model} returns ${modelDimensions} dimensions, but the knowledge index requires ${storageDimensions}`,
      );
    }
  }

  private async findActiveEmbeddingConfig(
    organizationId: string,
  ): Promise<AIProviderConfig | null> {
    const selection = await this.prisma.knowledgeExtractionConfig.findUnique({
      where: { organizationId },
      select: { embeddingProviderId: true },
    });
    if (selection?.embeddingProviderId) {
      return this.prisma.aIProviderConfig.findFirst({
        where: {
          id: selection.embeddingProviderId,
          organizationId,
          status: 'active',
          embeddingModel: { not: null },
        },
      });
    }
    return this.prisma.aIProviderConfig.findFirst({
      where: {
        organizationId,
        status: 'active',
        embeddingModel: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async reembedIfActiveSpaceChanged(
    organizationId: string,
    previousConfig: AIProviderConfig | null,
  ): Promise<void> {
    const activeConfig = await this.findActiveEmbeddingConfig(organizationId);
    if (
      !activeConfig ||
      this.embeddingSpaceIdentity(previousConfig) ===
        this.embeddingSpaceIdentity(activeConfig)
    ) {
      return;
    }

    const sources = await this.prisma.knowledgeSource.findMany({
      where: { organizationId, status: 'ready' },
      select: { id: true },
    });
    if (sources.length === 0) return;

    if (this.ingestionQueue.isEnabled()) {
      await this.prisma.knowledgeSource.updateMany({
        where: { id: { in: sources.map((source) => source.id) } },
        data: { status: 'pending', errorMessage: null },
      });
    }

    const results = await Promise.allSettled(
      sources.map((source) => {
        const job = {
          organizationId,
          sourceId: source.id,
          reason: 'embedding_model_changed' as const,
        };
        return this.ingestionQueue.isEnabled()
          ? this.ingestionQueue.enqueue(job)
          : this.ingestionService.ingestSource(job);
      }),
    );
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [{ sourceId: sources[index].id, reason: result.reason as unknown }]
        : [],
    );
    if (failures.length > 0) {
      await Promise.all(
        failures.map((failure) =>
          this.prisma.knowledgeSource.update({
            where: { id: failure.sourceId },
            data: {
              status: 'failed',
              errorMessage: `Knowledge re-embedding could not be scheduled: ${this.toErrorMessage(failure.reason)}`,
            },
          }),
        ),
      );
      this.logger.error(
        `Failed to schedule ${failures.length}/${sources.length} knowledge sources for re-embedding in organization ${organizationId}`,
      );
    }
  }

  private embeddingSpaceIdentity(config: AIProviderConfig | null): string {
    if (!config) return 'none';
    const settings = this.toRecord(config.settings);
    return JSON.stringify({
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.embeddingModel,
      adapter: settings.adapter,
      dimensions: settings.embeddingDimensions,
    });
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private resolveOrganizationId(
    currentUser: AuthenticatedUser,
    organizationId?: string,
  ): string {
    if (!organizationId) {
      return currentUser.orgId;
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      organizationId !== currentUser.orgId
    ) {
      throw new ForbiddenException('Cannot manage another organization');
    }

    return organizationId;
  }

  private toSafeConfig(config: AIProviderConfig): SafeAIProviderConfig {
    const { apiKeyEncrypted, ...safeConfig } = config;

    return {
      ...safeConfig,
      settings: this.toRecord(safeConfig.settings),
      hasApiKey: Boolean(apiKeyEncrypted),
    };
  }

  private toJsonObject(
    value: Record<string, unknown> | undefined,
  ): Prisma.InputJsonObject {
    return (value ?? {}) as Prisma.InputJsonObject;
  }

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('super_admin');
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }

  private removeUndefined(
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
    );
  }
}
