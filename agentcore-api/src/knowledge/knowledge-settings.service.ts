import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import {
  KnowledgeExtractionConfig,
  KnowledgeOcrProviderConfig,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { APPLICATION_DEFAULTS } from '../config/application-defaults';
import { CryptoService } from '../crypto/crypto.service';
import { KnowledgeIngestionQueueService } from '../knowledge-ingestion/knowledge-ingestion-queue.service';
import { KnowledgeIngestionService } from '../knowledge-ingestion/knowledge-ingestion.service';
import { OcrEndpointPolicyService } from '../knowledge-ingestion/ocr-endpoint-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateKnowledgeOcrProviderDto,
  UpdateKnowledgeExtractionSettingsDto,
  UpdateKnowledgeOcrProviderDto,
} from './dto/knowledge-extraction-settings.dto';

type SafeOcrProvider = Omit<
  KnowledgeOcrProviderConfig,
  'apiKeyEncrypted' | 'settings'
> & {
  hasApiKey: boolean;
  settings: Record<string, unknown>;
};

interface EffectiveExtractionSettings {
  id: string | null;
  organizationId: string;
  configured: boolean;
  ocrMode: 'disabled' | 'fallback' | 'always';
  primaryOcrProviderId: string | null;
  fallbackOcrProviderId: string | null;
  embeddingProviderId: string | null;
  nativeTextMinCharacters: number;
  nativeTextMinAlphanumericRatio: number;
  ocrMinConfidence: number;
  ocrTimeoutMs: number;
  ocrMaxRetries: number;
  ocrPageConcurrency: number;
  ocrRenderWidth: number;
  maxPdfPages: number;
  maxExtractedCharacters: number;
  settings: Record<string, unknown>;
  createdAt: Date | null;
  updatedAt: Date | null;
}

@Injectable()
export class KnowledgeSettingsService {
  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly ingestionQueue: KnowledgeIngestionQueueService,
    private readonly ingestionService: KnowledgeIngestionService,
    private readonly prisma: PrismaService,
    @Optional() private readonly ocrEndpointPolicy?: OcrEndpointPolicyService,
  ) {
    void this.ingestionService;
  }

  async getExtractionSettings(
    currentUser: AuthenticatedUser,
    requestedOrganizationId?: string,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      requestedOrganizationId,
    );
    const config = await this.prisma.knowledgeExtractionConfig.findUnique({
      where: { organizationId },
    });

    return {
      ...this.toEffectiveSettings(organizationId, config),
      deploymentLimits: {
        maxPdfPages: 20_000,
        maxExtractedCharacters: 50_000_000,
        maxOcrPageConcurrency: 32,
        maxOcrRenderWidth: 4_000,
        maxOcrTimeoutMs: 300_000,
        maxOcrRetries: 5,
      },
    };
  }

  async updateExtractionSettings(
    currentUser: AuthenticatedUser,
    input: UpdateKnowledgeExtractionSettingsDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    const previous = await this.prisma.knowledgeExtractionConfig.findUnique({
      where: { organizationId },
    });
    const current = this.toEffectiveSettings(organizationId, previous);
    const desiredPrimary =
      input.primaryOcrProviderId === undefined
        ? current.primaryOcrProviderId
        : input.primaryOcrProviderId;
    const desiredFallback =
      input.fallbackOcrProviderId === undefined
        ? current.fallbackOcrProviderId
        : input.fallbackOcrProviderId;
    if (desiredPrimary && desiredPrimary === desiredFallback) {
      throw new BadRequestException(
        'Primary and fallback OCR providers must be different',
      );
    }

    await this.validateOcrProviderSelections(organizationId, input);
    await this.validateEmbeddingProviderSelection(
      organizationId,
      input.embeddingProviderId,
    );

    if (
      (previous?.embeddingProviderId ?? null) !==
      (input.embeddingProviderId === undefined
        ? current.embeddingProviderId
        : input.embeddingProviderId)
    ) {
      await this.assertReembeddingCanBeScheduled(organizationId);
    }

    const data = this.settingsData(current, input);
    const config = await this.prisma.knowledgeExtractionConfig.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'knowledge.extraction_settings.updated',
      entityType: 'knowledge_extraction_config',
      entityId: config.id,
      metadata: {
        ocrMode: config.ocrMode,
        primaryOcrProviderId: config.primaryOcrProviderId,
        fallbackOcrProviderId: config.fallbackOcrProviderId,
        embeddingProviderId: config.embeddingProviderId,
      },
    });

    if (
      (previous?.embeddingProviderId ?? null) !== config.embeddingProviderId
    ) {
      await this.scheduleReembedding(organizationId);
    }

    return this.getExtractionSettings(currentUser, organizationId);
  }

  async listOcrProviders(
    currentUser: AuthenticatedUser,
    requestedOrganizationId?: string,
  ): Promise<SafeOcrProvider[]> {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      requestedOrganizationId,
    );
    const providers = await this.prisma.knowledgeOcrProviderConfig.findMany({
      where: { organizationId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return providers.map((provider) => this.toSafeProvider(provider));
  }

  async createOcrProvider(
    currentUser: AuthenticatedUser,
    input: CreateKnowledgeOcrProviderDto,
  ): Promise<SafeOcrProvider> {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    this.validateOcrProviderConfiguration(input);
    if (input.endpoint) {
      await this.assertEndpointAllowed(input.endpoint, Boolean(input.apiKey));
    }
    const provider = await this.prisma.knowledgeOcrProviderConfig.create({
      data: {
        organizationId,
        name: input.name.trim(),
        provider: input.provider,
        status: input.status ?? 'active',
        endpoint: input.endpoint ?? null,
        apiKeyEncrypted: input.apiKey
          ? this.cryptoService.encrypt(input.apiKey)
          : null,
        settings: this.toJsonObject(input.settings),
      },
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'knowledge.ocr_provider.created',
      entityType: 'knowledge_ocr_provider',
      entityId: provider.id,
      metadata: {
        name: provider.name,
        provider: provider.provider,
        hasApiKey: Boolean(provider.apiKeyEncrypted),
      },
    });
    return this.toSafeProvider(provider);
  }

  async updateOcrProvider(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateKnowledgeOcrProviderDto,
  ): Promise<SafeOcrProvider> {
    const existing = await this.findProviderForActor(currentUser, id);
    if (
      input.organizationId &&
      input.organizationId !== existing.organizationId
    ) {
      this.resolveOrganizationId(currentUser, input.organizationId);
      throw new BadRequestException(
        'OCR providers cannot be moved between organizations',
      );
    }
    const effectiveEndpoint =
      input.endpoint === undefined ? existing.endpoint : input.endpoint;
    if (effectiveEndpoint && (input.endpoint || input.apiKey !== undefined)) {
      await this.assertEndpointAllowed(
        effectiveEndpoint,
        input.apiKey === undefined
          ? Boolean(existing.apiKeyEncrypted)
          : Boolean(input.apiKey),
      );
    }
    this.validateOcrProviderConfiguration({
      provider: input.provider ?? existing.provider,
      endpoint:
        input.endpoint === undefined ? existing.endpoint : input.endpoint,
      apiKey:
        input.apiKey === undefined
          ? existing.apiKeyEncrypted
            ? 'configured'
            : undefined
          : input.apiKey,
      settings: input.settings ?? this.toRecord(existing.settings),
    });
    if (input.status === 'inactive' && existing.status === 'active') {
      const selected = await this.prisma.knowledgeExtractionConfig.findFirst({
        where: {
          organizationId: existing.organizationId,
          OR: [{ primaryOcrProviderId: id }, { fallbackOcrProviderId: id }],
        },
        select: { id: true },
      });
      if (selected) {
        throw new BadRequestException(
          'Remove this OCR provider from the extraction policy before deactivating it',
        );
      }
    }
    const provider = await this.prisma.knowledgeOcrProviderConfig.update({
      where: { id },
      data: {
        name: input.name?.trim(),
        provider: input.provider,
        status: input.status,
        endpoint: input.endpoint,
        apiKeyEncrypted:
          input.apiKey === undefined
            ? undefined
            : input.apiKey
              ? this.cryptoService.encrypt(input.apiKey)
              : null,
        settings: input.settings
          ? this.toJsonObject(input.settings)
          : undefined,
      },
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: provider.organizationId,
      action: 'knowledge.ocr_provider.updated',
      entityType: 'knowledge_ocr_provider',
      entityId: provider.id,
      metadata: {
        name: provider.name,
        provider: provider.provider,
        status: provider.status,
        apiKeyUpdated: input.apiKey !== undefined,
      },
    });
    return this.toSafeProvider(provider);
  }

  async deleteOcrProvider(currentUser: AuthenticatedUser, id: string) {
    const provider = await this.findProviderForActor(currentUser, id);
    const selected = await this.prisma.knowledgeExtractionConfig.findFirst({
      where: {
        organizationId: provider.organizationId,
        OR: [{ primaryOcrProviderId: id }, { fallbackOcrProviderId: id }],
      },
      select: { id: true },
    });
    if (selected) {
      throw new BadRequestException(
        'Remove this OCR provider from the extraction policy before deleting it',
      );
    }
    await this.prisma.knowledgeOcrProviderConfig.delete({ where: { id } });
    await this.auditService.record({
      actor: currentUser,
      organizationId: provider.organizationId,
      action: 'knowledge.ocr_provider.deleted',
      entityType: 'knowledge_ocr_provider',
      entityId: provider.id,
      metadata: { name: provider.name, provider: provider.provider },
    });
    return { deleted: true };
  }

  private settingsData(
    current: EffectiveExtractionSettings,
    input: UpdateKnowledgeExtractionSettingsDto,
  ): Omit<
    Prisma.KnowledgeExtractionConfigUncheckedCreateInput,
    'organizationId'
  > {
    return {
      ocrMode: input.ocrMode ?? current.ocrMode,
      primaryOcrProviderId:
        input.primaryOcrProviderId === undefined
          ? current.primaryOcrProviderId
          : input.primaryOcrProviderId,
      fallbackOcrProviderId:
        input.fallbackOcrProviderId === undefined
          ? current.fallbackOcrProviderId
          : input.fallbackOcrProviderId,
      embeddingProviderId:
        input.embeddingProviderId === undefined
          ? current.embeddingProviderId
          : input.embeddingProviderId,
      nativeTextMinCharacters:
        input.nativeTextMinCharacters ?? current.nativeTextMinCharacters,
      nativeTextMinAlphanumericRatio:
        input.nativeTextMinAlphanumericRatio ??
        current.nativeTextMinAlphanumericRatio,
      ocrMinConfidence: input.ocrMinConfidence ?? current.ocrMinConfidence,
      ocrTimeoutMs: input.ocrTimeoutMs ?? current.ocrTimeoutMs,
      ocrMaxRetries: input.ocrMaxRetries ?? current.ocrMaxRetries,
      ocrPageConcurrency:
        input.ocrPageConcurrency ?? current.ocrPageConcurrency,
      ocrRenderWidth: input.ocrRenderWidth ?? current.ocrRenderWidth,
      maxPdfPages: input.maxPdfPages ?? current.maxPdfPages,
      maxExtractedCharacters:
        input.maxExtractedCharacters ?? current.maxExtractedCharacters,
      settings: this.toJsonObject(input.settings ?? current.settings),
    };
  }

  private async validateOcrProviderSelections(
    organizationId: string,
    input: UpdateKnowledgeExtractionSettingsDto,
  ) {
    const ids = [
      input.primaryOcrProviderId,
      input.fallbackOcrProviderId,
    ].filter((value): value is string => Boolean(value));
    if (!ids.length) return;
    const providers = await this.prisma.knowledgeOcrProviderConfig.findMany({
      where: { id: { in: ids }, organizationId, status: 'active' },
      select: { id: true },
    });
    if (providers.length !== new Set(ids).size) {
      throw new BadRequestException(
        'Selected OCR providers must be active and belong to this workspace',
      );
    }
  }

  private async validateEmbeddingProviderSelection(
    organizationId: string,
    id: string | null | undefined,
  ) {
    if (!id) return;
    const provider = await this.prisma.aIProviderConfig.findFirst({
      where: {
        id,
        organizationId,
        status: 'active',
        validationStatus: 'verified',
        embeddingModel: { not: null },
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!provider) {
      throw new BadRequestException(
        'Embedding provider must be active, verified, include an embedding model, and belong to this workspace',
      );
    }
  }

  private async findProviderForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<KnowledgeOcrProviderConfig> {
    const provider = await this.prisma.knowledgeOcrProviderConfig.findUnique({
      where: { id },
    });
    if (
      !provider ||
      (!this.isSuperAdmin(currentUser) &&
        provider.organizationId !== currentUser.orgId)
    ) {
      throw new NotFoundException('OCR provider config not found');
    }
    return provider;
  }

  private toEffectiveSettings(
    organizationId: string,
    config: KnowledgeExtractionConfig | null,
  ): EffectiveExtractionSettings {
    if (config) {
      return {
        ...config,
        configured: true,
        settings: this.toRecord(config.settings),
      };
    }
    return {
      id: null,
      organizationId,
      configured: false,
      ocrMode: APPLICATION_DEFAULTS.knowledge.ocrMode,
      primaryOcrProviderId: null,
      fallbackOcrProviderId: null,
      embeddingProviderId: null,
      nativeTextMinCharacters:
        APPLICATION_DEFAULTS.knowledge.nativeTextMinCharactersPerPage,
      nativeTextMinAlphanumericRatio:
        APPLICATION_DEFAULTS.knowledge.nativeTextMinAlphanumericRatio,
      ocrMinConfidence: APPLICATION_DEFAULTS.knowledge.ocrMinConfidence,
      ocrTimeoutMs: APPLICATION_DEFAULTS.knowledge.ocrTimeoutMs,
      ocrMaxRetries: APPLICATION_DEFAULTS.knowledge.ocrMaxRetries,
      ocrPageConcurrency: APPLICATION_DEFAULTS.knowledge.ocrPageConcurrency,
      ocrRenderWidth: APPLICATION_DEFAULTS.knowledge.ocrRenderWidth,
      maxPdfPages: APPLICATION_DEFAULTS.knowledge.maxPdfPages,
      maxExtractedCharacters:
        APPLICATION_DEFAULTS.knowledge.maxExtractedCharacters,
      settings: {},
      createdAt: null,
      updatedAt: null,
    };
  }

  private async scheduleReembedding(organizationId: string) {
    const fingerprint = createHash('sha256')
      .update(`${organizationId}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16);
    await this.ingestionQueue.enqueueOrganizationReembedding({
      organizationId,
      fingerprint,
      reason: 'embedding_model_changed',
    });
  }

  private async assertReembeddingCanBeScheduled(
    organizationId: string,
  ): Promise<void> {
    if (this.ingestionQueue.isEnabled()) return;
    const indexedSources = await this.prisma.knowledgeSource.count({
      where: { organizationId, status: 'ready' },
    });
    if (indexedSources > 0) {
      throw new ServiceUnavailableException(
        'Redis must be available before changing the embedding provider for an indexed workspace',
      );
    }
  }

  private resolveOrganizationId(
    currentUser: AuthenticatedUser,
    requestedOrganizationId?: string,
  ): string {
    if (!requestedOrganizationId) return currentUser.orgId;
    if (
      !this.isSuperAdmin(currentUser) &&
      requestedOrganizationId !== currentUser.orgId
    ) {
      throw new ForbiddenException('Cannot manage another organization');
    }
    return requestedOrganizationId;
  }

  private isSuperAdmin(user: AuthenticatedUser) {
    return user.roles.includes('super_admin');
  }

  private toSafeProvider(
    provider: KnowledgeOcrProviderConfig,
  ): SafeOcrProvider {
    const { apiKeyEncrypted, ...safe } = provider;
    return {
      ...safe,
      hasApiKey: Boolean(apiKeyEncrypted),
      settings: this.toRecord(safe.settings),
    };
  }

  private toJsonObject(
    value?: Record<string, unknown>,
  ): Prisma.InputJsonObject {
    return (value ?? {}) as Prisma.InputJsonObject;
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    return value && !Array.isArray(value) && typeof value === 'object'
      ? value
      : {};
  }

  private async assertEndpointAllowed(
    endpoint: string,
    hasApiKey: boolean,
  ): Promise<void> {
    const policy =
      this.ocrEndpointPolicy ??
      new OcrEndpointPolicyService(this.configService);
    await policy.assertAllowed(endpoint, hasApiKey);
  }

  private validateOcrProviderConfiguration(input: {
    provider: string;
    endpoint?: string | null;
    apiKey?: string;
    settings?: Record<string, unknown>;
  }): void {
    if (
      (input.provider === 'custom' ||
        input.provider === 'azure_document_intelligence') &&
      !input.endpoint
    ) {
      throw new BadRequestException(
        `${input.provider} OCR requires an endpoint`,
      );
    }
    if (input.provider === 'azure_document_intelligence' && !input.apiKey) {
      throw new BadRequestException(
        'Azure Document Intelligence requires an API key',
      );
    }
    if (input.provider === 'google_document_ai') {
      const settings = input.settings ?? {};
      for (const key of ['projectId', 'location', 'processorId']) {
        if (typeof settings[key] !== 'string' || !settings[key]) {
          throw new BadRequestException(
            `Google Document AI requires settings.${key}`,
          );
        }
      }
    }
    if (input.provider === 'aws_textract' && input.apiKey) {
      try {
        const credentials = JSON.parse(input.apiKey) as Record<string, unknown>;
        if (
          typeof credentials.accessKeyId !== 'string' ||
          typeof credentials.secretAccessKey !== 'string'
        ) {
          throw new Error('invalid credentials');
        }
      } catch {
        throw new BadRequestException(
          'AWS Textract API key must be credential JSON with accessKeyId and secretAccessKey, or left empty for the AWS credential chain',
        );
      }
    }
  }
}
