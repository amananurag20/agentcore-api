import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AIProviderConfig, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AIUsageService } from '../ai-usage/ai-usage.service';
import { resolveEmbeddingDimensions } from '../ai/embedding-model-dimensions';
import { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeIngestionQueueService } from '../knowledge-ingestion/knowledge-ingestion-queue.service';
import { ProviderEndpointPolicyService } from '../ai/provider-endpoint-policy.service';
import { AIAdapterRegistryService } from '../ai/adapters/ai-adapter-registry.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { CreateAIProviderDto } from './dto/create-ai-provider.dto';
import { UpdateAIProviderDto } from './dto/update-ai-provider.dto';

type SafeAIProviderConfig = Omit<
  AIProviderConfig,
  'apiKeyEncrypted' | 'settings'
> & {
  hasApiKey: boolean;
  settings: Record<string, unknown>;
  usage?: Awaited<ReturnType<AIUsageService['summarize']>>;
};

@Injectable()
export class AIProvidersService {
  constructor(
    private readonly auditService: AuditService,
    private readonly aiUsageService: AIUsageService,
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly ingestionQueue: KnowledgeIngestionQueueService,
    private readonly prisma: PrismaService,
    private readonly endpointPolicy: ProviderEndpointPolicyService,
    private readonly adapterRegistry: AIAdapterRegistryService,
    private readonly rateLimit: RateLimitService,
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
      where: { organizationId, deletedAt: null },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
    const summaries = await this.aiUsageService.summarizeMany(configs);
    return configs.map((config) => ({
      ...this.toSafeConfig(config),
      usage: summaries.get(config.id),
    }));
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
    await this.endpointPolicy.assertProviderAllowed({
      provider: input.provider,
      baseUrl: input.baseUrl ?? null,
      settings: input.settings ?? {},
    });
    const providerCount = await this.prisma.aIProviderConfig.count({
      where: { organizationId, deletedAt: null },
    });
    const previousEmbeddingConfig =
      await this.findActiveEmbeddingConfig(organizationId);

    const config = await this.prisma.aIProviderConfig.create({
      data: {
        organizationId,
        provider: input.provider,
        status: 'inactive',
        priority: providerCount === 0 ? 0 : 100,
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
    return this.withUsage(config);
  }

  async validate(currentUser: AuthenticatedUser, id: string) {
    const config = await this.findConfigForActor(currentUser, id);
    const startedAt = Date.now();
    await this.rateLimit.consume(
      `ai-provider-test:${config.organizationId}:${currentUser.sub}:${id}`,
      this.configService.get<number>('AI_PROVIDER_TEST_RATE_LIMIT') ?? 10,
      this.configService.get<number>('AI_PROVIDER_TEST_RATE_WINDOW_SECONDS') ??
        60,
      'Too many AI provider tests. Please wait before trying again.',
    );

    try {
      await this.endpointPolicy.assertProviderAllowed(config);
      const result = await this.validateProvider(config);
      const updated = await this.prisma.aIProviderConfig.update({
        where: { id },
        data: {
          lastValidatedAt: new Date(),
          validationStatus: 'verified',
          validationLatency: Date.now() - startedAt,
          validationError: null,
          validatedModels: result.models,
        },
      });
      await this.auditService.record({
        actor: currentUser,
        organizationId: config.organizationId,
        action: 'ai_provider.validated',
        entityType: 'ai_provider',
        entityId: id,
        metadata: { status: 'verified', modelCount: result.models.length },
      });
      return this.withUsage(updated);
    } catch (error) {
      const message = this.toErrorMessage(error).slice(0, 500);
      const updated = await this.prisma.aIProviderConfig.update({
        where: { id },
        data: {
          lastValidatedAt: new Date(),
          validationStatus: 'failed',
          validationLatency: Date.now() - startedAt,
          validationError: message,
          validatedModels: [],
        },
      });
      await this.auditService.record({
        actor: currentUser,
        organizationId: config.organizationId,
        action: 'ai_provider.validation_failed',
        entityType: 'ai_provider',
        entityId: id,
        metadata: { status: 'failed', error: message },
      });
      return this.withUsage(updated);
    }
  }

  async setPrimary(currentUser: AuthenticatedUser, id: string) {
    const existing = await this.findConfigForActor(currentUser, id);
    if (existing.validationStatus !== 'verified' || !existing.chatModel) {
      throw new BadRequestException(
        'Test this provider and configure a chat model before making it primary',
      );
    }
    const previousEmbeddingConfig = await this.findActiveEmbeddingConfig(
      existing.organizationId,
    );
    const config = await this.prisma.$transaction(async (client) => {
      await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${existing.organizationId}))`;
      await client.aIProviderConfig.updateMany({
        where: { organizationId: existing.organizationId, deletedAt: null },
        data: { priority: 100 },
      });
      return client.aIProviderConfig.update({
        where: { id },
        data: { priority: 0, status: 'active' },
      });
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'ai_provider.primary_changed',
      entityType: 'ai_provider',
      entityId: id,
      metadata: { provider: config.provider, name: config.name },
    });
    await this.reembedIfActiveSpaceChanged(
      existing.organizationId,
      previousEmbeddingConfig,
    );
    return this.withUsage(config);
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
    await this.endpointPolicy.assertProviderAllowed({
      provider: input.provider ?? existing.provider,
      baseUrl: input.baseUrl === undefined ? existing.baseUrl : input.baseUrl,
      settings: settings,
    });
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
    const requiresRevalidation =
      input.apiKey !== undefined ||
      input.baseUrl !== undefined ||
      input.provider !== undefined ||
      input.chatModel !== undefined ||
      input.embeddingModel !== undefined ||
      (input.settings !== undefined &&
        this.toRecord(existing.settings).adapter !== input.settings.adapter);
    if (
      input.status === 'active' &&
      (requiresRevalidation || existing.validationStatus !== 'verified')
    ) {
      throw new BadRequestException(
        'Test this provider successfully before activating it',
      );
    }

    const config = await this.prisma.aIProviderConfig.update({
      where: { id },
      data: {
        organizationId: input.organizationId
          ? this.resolveOrganizationId(currentUser, input.organizationId)
          : undefined,
        provider: input.provider,
        status: requiresRevalidation ? 'inactive' : input.status,
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
        validationStatus: requiresRevalidation ? 'untested' : undefined,
        lastValidatedAt: requiresRevalidation ? null : undefined,
        validationLatency: requiresRevalidation ? null : undefined,
        validationError: requiresRevalidation ? null : undefined,
        validatedModels: requiresRevalidation ? [] : undefined,
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
    await this.prisma.aIProviderConfig.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: 'inactive',
        priority: 100,
        apiKeyEncrypted: null,
      },
    });

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
    const config = await this.prisma.aIProviderConfig.findFirst({
      where: { id, deletedAt: null },
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
          validationStatus: 'verified',
          embeddingModel: { not: null },
          deletedAt: null,
        },
      });
    }
    return this.prisma.aIProviderConfig.findFirst({
      where: {
        organizationId,
        status: 'active',
        validationStatus: 'verified',
        embeddingModel: { not: null },
        deletedAt: null,
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
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

    if (!this.ingestionQueue.isEnabled()) {
      const indexedSources = await this.prisma.knowledgeSource.count({
        where: { organizationId, status: 'ready' },
      });
      if (indexedSources === 0) return;
      throw new ServiceUnavailableException(
        'Redis must be available to schedule knowledge re-embedding',
      );
    }
    const fingerprint = createHash('sha256')
      .update(`${this.embeddingSpaceIdentity(activeConfig)}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16);
    await this.ingestionQueue.enqueueOrganizationReembedding({
      organizationId,
      fingerprint,
      reason: 'embedding_model_changed',
    });
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

  private async withUsage(
    config: AIProviderConfig,
  ): Promise<SafeAIProviderConfig> {
    return {
      ...this.toSafeConfig(config),
      usage: await this.aiUsageService.summarize(config),
    };
  }

  private async validateProvider(
    config: AIProviderConfig,
  ): Promise<{ models: Prisma.InputJsonArray }> {
    const settings = this.toRecord(config.settings);
    const adapter =
      typeof settings.adapter === 'string' ? settings.adapter : '';
    const isOllama = config.provider === 'local' || adapter === 'ollama';
    const isAnthropic =
      config.provider === 'anthropic' || adapter === 'anthropic';
    const apiKey = config.apiKeyEncrypted
      ? this.cryptoService.decrypt(config.apiKeyEncrypted)
      : undefined;

    if (!isOllama && !apiKey) {
      throw new Error('API key is missing');
    }

    if (isAnthropic) {
      if (!config.chatModel) {
        throw new Error('A chat model is required to validate Anthropic');
      }
      const baseUrl = this.validBaseUrl(
        config.baseUrl ?? 'https://api.anthropic.com/v1',
      );
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'x-api-key': apiKey!,
        },
        body: JSON.stringify({
          model: config.chatModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Reply OK' }],
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      });
      if (!response.ok) {
        throw new Error(
          `Provider returned ${response.status}: ${await this.providerError(response)}`,
        );
      }
      await this.verifyEmbeddingDimensions(config, apiKey);
      return { models: [config.chatModel] };
    }

    const baseUrl = this.validBaseUrl(
      config.baseUrl ??
        (isOllama
          ? 'http://localhost:11434'
          : config.provider === 'openai'
            ? 'https://api.openai.com/v1'
            : ''),
    );
    const response = await fetch(
      isOllama ? `${baseUrl}/api/tags` : `${baseUrl}/models`,
      {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      },
    );
    if (!response.ok) {
      throw new Error(
        `Provider returned ${response.status}: ${await this.providerError(response)}`,
      );
    }
    const body = (await response.json()) as Record<string, unknown>;
    const entries = Array.isArray(body.data)
      ? body.data
      : Array.isArray(body.models)
        ? body.models
        : [];
    const availableModels = entries
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const record = entry as Record<string, unknown>;
        return typeof record.id === 'string'
          ? record.id
          : typeof record.name === 'string'
            ? record.name
            : null;
      })
      .filter((model): model is string => Boolean(model));
    const configuredModels = [config.chatModel, config.embeddingModel].filter(
      (model): model is string => Boolean(model),
    );
    const missingModels =
      availableModels.length > 0
        ? configuredModels.filter((model) => !availableModels.includes(model))
        : [];
    if (missingModels.length > 0) {
      throw new Error(
        `Credentials are valid, but configured model access was not found: ${missingModels.join(', ')}`,
      );
    }
    await this.verifyEmbeddingDimensions(config, apiKey);
    return { models: availableModels.slice(0, 200) };
  }

  private async verifyEmbeddingDimensions(
    config: AIProviderConfig,
    apiKey?: string,
  ): Promise<void> {
    if (!config.embeddingModel) return;
    const adapter = this.adapterRegistry.getAdapter(config);
    if (!adapter.createEmbedding) {
      throw new Error('Configured provider does not support embeddings');
    }
    const result = await adapter.createEmbedding({
      apiKey,
      baseUrl: config.baseUrl,
      model: config.embeddingModel,
      text: 'AgentCore embedding dimension verification',
    });
    const expected =
      this.configService.get<number>('DEFAULT_EMBEDDING_DIMENSIONS') ?? 1536;
    if (
      result.vector.length !== expected ||
      result.vector.some((value) => !Number.isFinite(value))
    ) {
      throw new Error(
        `Embedding model returned ${result.vector.length} dimensions; the knowledge index requires ${expected}`,
      );
    }
  }

  private validBaseUrl(value: string): string {
    if (!value) throw new Error('Base URL is required');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Base URL must be a valid HTTP or HTTPS URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('Base URL must use HTTP or HTTPS');
    }
    return url.toString().replace(/\/+$/, '');
  }

  private async providerError(response: Response): Promise<string> {
    const text = (await response.text()).slice(0, 300);
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const nested = body.error;
      if (nested && typeof nested === 'object') {
        const message = (nested as Record<string, unknown>).message;
        if (typeof message === 'string') return message;
      }
      return typeof body.message === 'string' ? body.message : text;
    } catch {
      return text || response.statusText;
    }
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
