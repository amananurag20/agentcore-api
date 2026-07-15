import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KnowledgeOcrProviderConfig, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

export type KnowledgeOcrMode = 'disabled' | 'fallback' | 'always';

export interface KnowledgeOcrPageResult {
  text: string;
  confidence: number | null;
  provider: string;
  model: string | null;
  cacheHit: boolean;
  metadata: Record<string, unknown>;
}

export interface OcrEndpointConfig {
  id?: string;
  endpoint: string;
  apiKey?: string;
  provider: string;
  settings: Record<string, unknown>;
  updatedAt?: Date;
}

export interface KnowledgeExtractionRuntimePolicy {
  mode: KnowledgeOcrMode;
  primary: OcrEndpointConfig | null;
  fallback: OcrEndpointConfig | null;
  minimumConfidence: number;
  timeoutMs: number;
  maxRetries: number;
  nativeTextMinimumCharacters: number;
  nativeTextMinimumRatio: number;
  ocrPageConcurrency: number;
  ocrRenderWidth: number;
  maxPdfPages: number;
  maxExtractedCharacters: number;
  pipelineSignature: string;
}

interface OcrEndpointResponse {
  text?: unknown;
  confidence?: unknown;
  provider?: unknown;
  model?: unknown;
  metadata?: unknown;
}

@Injectable()
export class KnowledgeOcrService {
  private readonly logger = new Logger(KnowledgeOcrService.name);
  private readonly deploymentDefaults: KnowledgeExtractionRuntimePolicy;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Optional() private readonly cryptoService?: CryptoService,
  ) {
    const mode =
      this.configService.get<KnowledgeOcrMode>('KNOWLEDGE_OCR_MODE') ??
      'fallback';
    const primary = this.readEndpointConfig('PRIMARY', true);
    const fallback = this.readEndpointConfig('FALLBACK', false);
    const timeoutMs =
      this.configService.get<number>('KNOWLEDGE_OCR_TIMEOUT_MS') ?? 60_000;
    const maxRetries =
      this.configService.get<number>('KNOWLEDGE_OCR_MAX_RETRIES') ?? 2;
    const minimumConfidence =
      this.configService.get<number>('KNOWLEDGE_OCR_MIN_CONFIDENCE') ?? 0.75;
    const defaults = {
      mode,
      primary,
      fallback,
      minimumConfidence,
      timeoutMs,
      maxRetries,
      nativeTextMinimumCharacters:
        this.configService.get<number>(
          'KNOWLEDGE_PDF_NATIVE_TEXT_MIN_CHARACTERS_PER_PAGE',
        ) ?? 40,
      nativeTextMinimumRatio:
        this.configService.get<number>(
          'KNOWLEDGE_PDF_NATIVE_TEXT_MIN_ALPHANUMERIC_RATIO',
        ) ?? 0.5,
      ocrPageConcurrency:
        this.configService.get<number>('KNOWLEDGE_OCR_PAGE_CONCURRENCY') ?? 4,
      ocrRenderWidth:
        this.configService.get<number>('KNOWLEDGE_OCR_RENDER_WIDTH') ?? 1_800,
      maxPdfPages:
        this.configService.get<number>('KNOWLEDGE_PDF_MAX_PAGES') ?? 5_000,
      maxExtractedCharacters:
        this.configService.get<number>('KNOWLEDGE_MAX_EXTRACTED_CHARACTERS') ??
        25_000_000,
    };
    this.deploymentDefaults = {
      ...defaults,
      pipelineSignature: this.createPipelineSignature(defaults),
    };
  }

  getMode(): KnowledgeOcrMode {
    return this.deploymentDefaults.mode;
  }

  isConfigured(policy = this.deploymentDefaults): boolean {
    return policy.mode !== 'disabled' && Boolean(policy.primary);
  }

  async resolveRuntimePolicy(
    organizationId?: string,
  ): Promise<KnowledgeExtractionRuntimePolicy> {
    if (!organizationId) return this.deploymentDefaults;
    const config = await this.prisma.knowledgeExtractionConfig.findUnique({
      where: { organizationId },
      include: {
        primaryOcrProvider: true,
        fallbackOcrProvider: true,
      },
    });
    if (!config) return this.deploymentDefaults;

    const values = {
      mode: config.ocrMode,
      primary: config.primaryOcrProviderId
        ? this.toEndpointConfig(config.primaryOcrProvider)
        : this.deploymentDefaults.primary,
      fallback: config.fallbackOcrProviderId
        ? this.toEndpointConfig(config.fallbackOcrProvider)
        : this.deploymentDefaults.fallback,
      minimumConfidence: config.ocrMinConfidence,
      timeoutMs: config.ocrTimeoutMs,
      maxRetries: config.ocrMaxRetries,
      nativeTextMinimumCharacters: config.nativeTextMinCharacters,
      nativeTextMinimumRatio: config.nativeTextMinAlphanumericRatio,
      ocrPageConcurrency: config.ocrPageConcurrency,
      ocrRenderWidth: config.ocrRenderWidth,
      maxPdfPages: config.maxPdfPages,
      maxExtractedCharacters: config.maxExtractedCharacters,
    };
    return {
      ...values,
      pipelineSignature: this.createPipelineSignature(values),
    };
  }

  async recognizePage(input: {
    organizationId?: string;
    image: Buffer;
    pageNumber: number;
    documentName?: string | null;
    policy?: KnowledgeExtractionRuntimePolicy;
  }): Promise<KnowledgeOcrPageResult> {
    const policy =
      input.policy ?? (await this.resolveRuntimePolicy(input.organizationId));
    if (!this.isConfigured(policy) || !policy.primary) {
      throw new ServiceUnavailableException(
        'OCR is required for this page but no OCR provider is configured',
      );
    }

    const pageFingerprint = createHash('sha256')
      .update(input.image)
      .digest('hex');
    const cached = input.organizationId
      ? await this.readCache(
          input.organizationId,
          pageFingerprint,
          policy.pipelineSignature,
        )
      : null;
    if (cached) return cached;

    let primaryResult: KnowledgeOcrPageResult;
    try {
      primaryResult = await this.callProvider(policy.primary, input, policy);
    } catch (error) {
      if (!policy.fallback) throw error;
      this.logger.warn(
        `Primary OCR failed for page ${input.pageNumber}; using fallback OCR: ${this.errorMessage(error)}`,
      );
      const result = await this.callProvider(policy.fallback, input, policy);
      if (input.organizationId) {
        await this.writeCache(
          input.organizationId,
          pageFingerprint,
          policy.pipelineSignature,
          result,
        );
      }
      return result;
    }

    let result = primaryResult;
    if (
      policy.fallback &&
      (primaryResult.text.trim().length === 0 ||
        (primaryResult.confidence !== null &&
          primaryResult.confidence < policy.minimumConfidence))
    ) {
      try {
        result = await this.callProvider(policy.fallback, input, policy);
      } catch (error) {
        this.logger.warn(
          `Fallback OCR failed for page ${input.pageNumber}; retaining primary OCR result: ${this.errorMessage(error)}`,
        );
      }
    }

    if (input.organizationId) {
      await this.writeCache(
        input.organizationId,
        pageFingerprint,
        policy.pipelineSignature,
        result,
      );
    }
    return result;
  }

  private async callProvider(
    provider: OcrEndpointConfig,
    input: {
      image: Buffer;
      pageNumber: number;
      documentName?: string | null;
    },
    policy: KnowledgeExtractionRuntimePolicy,
  ): Promise<KnowledgeOcrPageResult> {
    if (!this.isEndpointAllowed(provider.endpoint)) {
      throw new ServiceUnavailableException(
        'OCR provider endpoint is not allowed by the deployment policy',
      );
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
      try {
        const form = new FormData();
        form.set(
          'file',
          new Blob([Uint8Array.from(input.image)], { type: 'image/png' }),
          `page-${input.pageNumber}.png`,
        );
        form.set('pageNumber', String(input.pageNumber));
        if (input.documentName) form.set('documentName', input.documentName);
        form.set('settings', JSON.stringify(provider.settings));

        const response = await fetch(provider.endpoint, {
          method: 'POST',
          headers: provider.apiKey
            ? { Authorization: `Bearer ${provider.apiKey}` }
            : undefined,
          body: form,
          signal: AbortSignal.timeout(policy.timeoutMs),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const body = (await response.json()) as OcrEndpointResponse;
        const confidence = this.normalizeConfidence(body.confidence);
        return {
          text: typeof body.text === 'string' ? body.text : '',
          confidence,
          provider:
            typeof body.provider === 'string'
              ? body.provider
              : provider.provider,
          model: typeof body.model === 'string' ? body.model : null,
          cacheHit: false,
          metadata: this.toRecord(body.metadata),
        };
      } catch (error) {
        lastError = error;
        if (attempt < policy.maxRetries) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(500 * 2 ** attempt, 4_000)),
          );
        }
      }
    }
    throw new ServiceUnavailableException(
      `OCR provider ${provider.provider} failed after ${policy.maxRetries + 1} attempts: ${this.errorMessage(lastError)}`,
    );
  }

  private async readCache(
    organizationId: string,
    pageFingerprint: string,
    pipelineSignature = this.deploymentDefaults.pipelineSignature,
  ): Promise<KnowledgeOcrPageResult | null> {
    const cached = await this.prisma.knowledgeOcrPageCache.findUnique({
      where: {
        organizationId_pageFingerprint_pipelineSignature: {
          organizationId,
          pageFingerprint,
          pipelineSignature,
        },
      },
    });
    if (!cached) return null;

    await this.prisma.knowledgeOcrPageCache.update({
      where: { id: cached.id },
      data: { hitCount: { increment: 1 }, lastAccessedAt: new Date() },
    });
    return {
      text: cached.text,
      confidence: cached.confidence,
      provider: cached.provider,
      model: cached.model,
      cacheHit: true,
      metadata: this.toRecord(cached.metadata),
    };
  }

  private async writeCache(
    organizationId: string,
    pageFingerprint: string,
    pipelineSignature: string,
    result: KnowledgeOcrPageResult,
  ) {
    await this.prisma.knowledgeOcrPageCache.upsert({
      where: {
        organizationId_pageFingerprint_pipelineSignature: {
          organizationId,
          pageFingerprint,
          pipelineSignature,
        },
      },
      create: {
        organizationId,
        pageFingerprint,
        pipelineSignature,
        provider: result.provider,
        model: result.model,
        confidence: result.confidence,
        text: result.text,
        metadata: result.metadata as Prisma.InputJsonObject,
      },
      update: {
        provider: result.provider,
        model: result.model,
        confidence: result.confidence,
        text: result.text,
        metadata: result.metadata as Prisma.InputJsonObject,
        lastAccessedAt: new Date(),
      },
    });
  }

  private readEndpointConfig(
    slot: 'PRIMARY' | 'FALLBACK',
    allowLegacy: boolean,
  ): OcrEndpointConfig | null {
    const endpoint =
      this.configService.get<string>(`KNOWLEDGE_OCR_${slot}_ENDPOINT`) ||
      (allowLegacy
        ? this.configService.get<string>('KNOWLEDGE_OCR_ENDPOINT')
        : undefined);
    if (!endpoint) return null;
    return {
      endpoint,
      apiKey:
        this.configService.get<string>(`KNOWLEDGE_OCR_${slot}_API_KEY`) ||
        (allowLegacy
          ? this.configService.get<string>('KNOWLEDGE_OCR_API_KEY')
          : undefined),
      provider:
        this.configService.get<string>(`KNOWLEDGE_OCR_${slot}_PROVIDER`) ??
        (slot === 'PRIMARY' ? 'local' : 'managed'),
      settings: {},
    };
  }

  private toEndpointConfig(
    provider: KnowledgeOcrProviderConfig | null,
  ): OcrEndpointConfig | null {
    if (!provider || provider.status !== 'active') return null;
    return {
      id: provider.id,
      endpoint: provider.endpoint,
      apiKey:
        provider.apiKeyEncrypted && this.cryptoService
          ? this.cryptoService.decrypt(provider.apiKeyEncrypted)
          : undefined,
      provider: provider.provider,
      settings: this.toRecord(provider.settings),
      updatedAt: provider.updatedAt,
    };
  }

  private createPipelineSignature(input: {
    mode: KnowledgeOcrMode;
    primary: OcrEndpointConfig | null;
    fallback: OcrEndpointConfig | null;
    minimumConfidence: number;
  }) {
    return createHash('sha256')
      .update(
        JSON.stringify({
          version: 2,
          mode: input.mode,
          primary: this.endpointIdentity(input.primary),
          fallback: this.endpointIdentity(input.fallback),
          minimumConfidence: input.minimumConfidence,
        }),
      )
      .digest('hex');
  }

  private endpointIdentity(config: OcrEndpointConfig | null) {
    if (!config) return null;
    return {
      id: config.id,
      endpoint: config.endpoint,
      provider: config.provider,
      settings: config.settings,
      updatedAt: config.updatedAt?.toISOString(),
    };
  }

  private normalizeConfidence(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = value > 1 ? value / 100 : value;
    return Math.max(0, Math.min(1, normalized));
  }

  private toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isEndpointAllowed(endpoint: string) {
    const allowedHosts = this.configService
      .get<string>('KNOWLEDGE_OCR_ALLOWED_HOSTS')
      ?.split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (!allowedHosts?.length) {
      return this.configService.get<string>('NODE_ENV') !== 'production';
    }
    const url = new URL(endpoint);
    return (
      allowedHosts.includes(url.host.toLowerCase()) ||
      allowedHosts.includes(url.hostname.toLowerCase())
    );
  }
}
