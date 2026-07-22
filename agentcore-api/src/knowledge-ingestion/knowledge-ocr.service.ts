import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KnowledgeOcrProviderConfig, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import {
  AnalyzeDocumentCommand,
  DetectDocumentTextCommand,
  TextractClient,
} from '@aws-sdk/client-textract';
import { GoogleAuth } from 'google-auth-library';
import { recognize as recognizeWithTesseract } from 'tesseract.js';
import { CryptoService } from '../crypto/crypto.service';
import { APPLICATION_DEFAULTS } from '../config/application-defaults';
import { PrismaService } from '../prisma/prisma.service';
import { OcrEndpointPolicyService } from './ocr-endpoint-policy.service';

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
  endpoint: string | null;
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
  maxPdfBytes: number;
  maxOcrPagesPerDocument: number;
  maxEmptyOcrPageRatio: number;
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
    @Optional() private readonly endpointPolicy?: OcrEndpointPolicyService,
  ) {
    const defaults = {
      mode: APPLICATION_DEFAULTS.knowledge.ocrMode,
      primary: null,
      fallback: null,
      minimumConfidence: APPLICATION_DEFAULTS.knowledge.ocrMinConfidence,
      timeoutMs: APPLICATION_DEFAULTS.knowledge.ocrTimeoutMs,
      maxRetries: APPLICATION_DEFAULTS.knowledge.ocrMaxRetries,
      nativeTextMinimumCharacters:
        APPLICATION_DEFAULTS.knowledge.nativeTextMinCharactersPerPage,
      nativeTextMinimumRatio:
        APPLICATION_DEFAULTS.knowledge.nativeTextMinAlphanumericRatio,
      ocrPageConcurrency: APPLICATION_DEFAULTS.knowledge.ocrPageConcurrency,
      ocrRenderWidth: APPLICATION_DEFAULTS.knowledge.ocrRenderWidth,
      maxPdfPages: APPLICATION_DEFAULTS.knowledge.maxPdfPages,
      maxPdfBytes: APPLICATION_DEFAULTS.knowledge.maxPdfBytes,
      maxOcrPagesPerDocument:
        APPLICATION_DEFAULTS.knowledge.maxOcrPagesPerDocument,
      maxEmptyOcrPageRatio: APPLICATION_DEFAULTS.knowledge.maxEmptyOcrPageRatio,
      maxExtractedCharacters:
        APPLICATION_DEFAULTS.knowledge.maxExtractedCharacters,
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
      maxPdfBytes: this.numericSetting(
        config.settings,
        'maxPdfBytes',
        this.deploymentDefaults.maxPdfBytes,
      ),
      maxOcrPagesPerDocument: this.numericSetting(
        config.settings,
        'maxOcrPagesPerDocument',
        this.deploymentDefaults.maxOcrPagesPerDocument,
      ),
      maxEmptyOcrPageRatio: this.numericSetting(
        config.settings,
        'maxEmptyOcrPageRatio',
        this.deploymentDefaults.maxEmptyOcrPageRatio,
      ),
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
        primaryResult.confidence === null ||
        primaryResult.confidence < policy.minimumConfidence)
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
    if (provider.provider === 'local_tesseract') {
      return this.callLocalTesseract(provider, input, policy);
    }
    if (provider.provider === 'aws_textract') {
      return this.callAwsTextract(provider, input, policy);
    }
    if (provider.provider === 'google_document_ai') {
      return this.callGoogleDocumentAi(provider, input, policy);
    }
    if (provider.provider === 'azure_document_intelligence') {
      return this.callAzureDocumentIntelligence(provider, input, policy);
    }
    return this.callCustomProvider(provider, input, policy);
  }

  private async callCustomProvider(
    provider: OcrEndpointConfig,
    input: {
      image: Buffer;
      pageNumber: number;
      documentName?: string | null;
    },
    policy: KnowledgeExtractionRuntimePolicy,
  ): Promise<KnowledgeOcrPageResult> {
    if (!provider.endpoint) {
      throw new ServiceUnavailableException(
        `${provider.provider} OCR endpoint is not configured`,
      );
    }
    const endpointPolicy =
      this.endpointPolicy ?? new OcrEndpointPolicyService(this.configService);
    await endpointPolicy.assertAllowed(
      provider.endpoint,
      Boolean(provider.apiKey),
    );
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
          redirect: 'manual',
        });
        if (response.status >= 300 && response.status < 400) {
          throw new Error('OCR provider redirects are not allowed');
        }
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

  private async callLocalTesseract(
    provider: OcrEndpointConfig,
    input: { image: Buffer; pageNumber: number },
    policy: KnowledgeExtractionRuntimePolicy,
  ): Promise<KnowledgeOcrPageResult> {
    const language =
      typeof provider.settings.language === 'string'
        ? provider.settings.language
        : 'eng';
    const result = await this.withTimeout(
      recognizeWithTesseract(input.image, language),
      policy.timeoutMs,
      'Local Tesseract OCR timed out',
    );
    return {
      text: result.data.text ?? '',
      confidence: this.normalizeConfidence(result.data.confidence),
      provider: 'local_tesseract',
      model: language,
      cacheHit: false,
      metadata: { language, pageNumber: input.pageNumber },
    };
  }

  private async callAwsTextract(
    provider: OcrEndpointConfig,
    input: { image: Buffer },
    policy: KnowledgeExtractionRuntimePolicy,
  ): Promise<KnowledgeOcrPageResult> {
    const credentials = provider.apiKey
      ? (JSON.parse(provider.apiKey) as {
          accessKeyId: string;
          secretAccessKey: string;
          sessionToken?: string;
        })
      : undefined;
    const region =
      typeof provider.settings.region === 'string'
        ? provider.settings.region
        : APPLICATION_DEFAULTS.knowledge.awsRegion;
    const client = new TextractClient({ region, credentials });
    const features = Array.isArray(provider.settings.features)
      ? provider.settings.features.filter(
          (value): value is 'TABLES' | 'FORMS' | 'LAYOUT' =>
            value === 'TABLES' || value === 'FORMS' || value === 'LAYOUT',
        )
      : [];
    const response = await this.withTimeout(
      features.length
        ? client.send(
            new AnalyzeDocumentCommand({
              Document: { Bytes: input.image },
              FeatureTypes: features,
            }),
          )
        : client.send(
            new DetectDocumentTextCommand({ Document: { Bytes: input.image } }),
          ),
      policy.timeoutMs,
      'AWS Textract timed out',
    );
    const lines = (response.Blocks ?? []).filter(
      (block) => block.BlockType === 'LINE' && block.Text,
    );
    return {
      text: lines.map((line) => line.Text).join('\n'),
      confidence: this.averageConfidence(lines.map((line) => line.Confidence)),
      provider: 'aws_textract',
      model: features.length ? 'analyze-document' : 'detect-document-text',
      cacheHit: false,
      metadata: {
        region,
        featureTypes: features,
        blockCount: response.Blocks?.length ?? 0,
        tableCount: (response.Blocks ?? []).filter(
          (block) => block.BlockType === 'TABLE',
        ).length,
      },
    };
  }

  private async callGoogleDocumentAi(
    provider: OcrEndpointConfig,
    input: { image: Buffer },
    policy: KnowledgeExtractionRuntimePolicy,
  ): Promise<KnowledgeOcrPageResult> {
    const projectId = this.requiredSetting(provider, 'projectId');
    const location = this.requiredSetting(provider, 'location');
    const processorId = this.requiredSetting(provider, 'processorId');
    if (!/^[a-z0-9-]+$/i.test(location)) {
      throw new ServiceUnavailableException(
        'Google Document AI settings.location is invalid',
      );
    }
    const version =
      typeof provider.settings.processorVersion === 'string'
        ? `/processorVersions/${provider.settings.processorVersion}`
        : '';
    const host = `${location}-documentai.googleapis.com`;
    const endpoint = `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/processors/${encodeURIComponent(processorId)}${version}:process`;
    const credentials = provider.apiKey
      ? (JSON.parse(provider.apiKey) as Record<string, unknown>)
      : undefined;
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const response = await this.withTimeout(
      auth.request<{
        document?: {
          text?: string;
          pages?: Array<{ layout?: { confidence?: number } }>;
          entities?: unknown[];
        };
      }>({
        url: endpoint,
        method: 'POST',
        data: {
          rawDocument: {
            content: input.image.toString('base64'),
            mimeType: 'image/png',
          },
        },
      }),
      policy.timeoutMs,
      'Google Document AI timed out',
    );
    const document = response.data.document;
    return {
      text: document?.text ?? '',
      confidence: this.averageConfidence(
        document?.pages?.map((page) => page.layout?.confidence) ?? [],
      ),
      provider: 'google_document_ai',
      model: processorId,
      cacheHit: false,
      metadata: {
        location,
        pageCount: document?.pages?.length ?? 0,
        entityCount: document?.entities?.length ?? 0,
      },
    };
  }

  private async callAzureDocumentIntelligence(
    provider: OcrEndpointConfig,
    input: { image: Buffer },
    policy: KnowledgeExtractionRuntimePolicy,
  ): Promise<KnowledgeOcrPageResult> {
    if (!provider.endpoint || !provider.apiKey) {
      throw new ServiceUnavailableException(
        'Azure Document Intelligence requires an HTTPS endpoint and API key',
      );
    }
    const endpointPolicy =
      this.endpointPolicy ?? new OcrEndpointPolicyService(this.configService);
    await endpointPolicy.assertAllowed(provider.endpoint, true);
    const model =
      typeof provider.settings.model === 'string'
        ? provider.settings.model
        : 'prebuilt-read';
    const apiVersion =
      typeof provider.settings.apiVersion === 'string'
        ? provider.settings.apiVersion
        : '2024-11-30';
    const analyzeUrl = `${provider.endpoint.replace(/\/+$/, '')}/documentintelligence/documentModels/${encodeURIComponent(model)}:analyze?api-version=${encodeURIComponent(apiVersion)}`;
    const submitted = await fetch(analyzeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Ocp-Apim-Subscription-Key': provider.apiKey,
      },
      body: Uint8Array.from(input.image),
      signal: AbortSignal.timeout(policy.timeoutMs),
      redirect: 'manual',
    });
    if (!submitted.ok || submitted.status < 200 || submitted.status >= 300) {
      throw new Error(`Azure OCR returned HTTP ${submitted.status}`);
    }
    const operationUrl = submitted.headers.get('operation-location');
    if (!operationUrl) throw new Error('Azure OCR omitted operation-location');
    await endpointPolicy.assertAllowed(operationUrl, true);
    const deadline = Date.now() + policy.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const response = await fetch(operationUrl, {
        headers: { 'Ocp-Apim-Subscription-Key': provider.apiKey },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        redirect: 'manual',
      });
      if (!response.ok)
        throw new Error(`Azure OCR returned HTTP ${response.status}`);
      const body = (await response.json()) as {
        status?: string;
        analyzeResult?: {
          content?: string;
          pages?: Array<{ words?: Array<{ confidence?: number }> }>;
          tables?: unknown[];
        };
        error?: { message?: string };
      };
      if (body.status === 'failed') {
        throw new Error(body.error?.message ?? 'Azure OCR failed');
      }
      if (body.status === 'succeeded') {
        const result = body.analyzeResult;
        return {
          text: result?.content ?? '',
          confidence: this.averageConfidence(
            result?.pages?.flatMap((page) =>
              (page.words ?? []).map((word) => word.confidence),
            ) ?? [],
          ),
          provider: 'azure_document_intelligence',
          model,
          cacheHit: false,
          metadata: {
            pageCount: result?.pages?.length ?? 0,
            tableCount: result?.tables?.length ?? 0,
          },
        };
      }
    }
    throw new Error('Azure OCR timed out');
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

  private averageConfidence(values: Array<number | undefined>): number | null {
    const valid = values.filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value),
    );
    if (!valid.length) return null;
    return this.normalizeConfidence(
      valid.reduce((sum, value) => sum + value, 0) / valid.length,
    );
  }

  private requiredSetting(provider: OcrEndpointConfig, key: string): string {
    const value = provider.settings[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new ServiceUnavailableException(
        `${provider.provider} OCR requires settings.${key}`,
      );
    }
    return value.trim();
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private numericSetting(
    value: Prisma.JsonValue,
    key: string,
    fallback: number,
  ): number {
    const setting = this.toRecord(value)[key];
    return typeof setting === 'number' && Number.isFinite(setting)
      ? setting
      : fallback;
  }
}
