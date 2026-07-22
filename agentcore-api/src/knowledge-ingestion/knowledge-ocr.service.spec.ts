import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeOcrService } from './knowledge-ocr.service';

describe('KnowledgeOcrService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns a tenant-scoped cached page without calling a provider', async () => {
    const updateCache = jest.fn().mockResolvedValue({});
    const prisma = {
      knowledgeExtractionConfig: {
        findUnique: jest.fn().mockResolvedValue(
          extractionConfig({
            primaryEndpoint: 'http://ocr.local/process',
          }),
        ),
      },
      knowledgeOcrPageCache: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cache-1',
          text: 'Cached OCR text',
          confidence: 0.91,
          provider: 'local-tesseract',
          model: 'tesseract-5',
          metadata: { language: 'eng' },
        }),
        update: updateCache,
        upsert: jest.fn(),
      },
    } as unknown as PrismaService;
    global.fetch = jest.fn();
    const service = new KnowledgeOcrService(config({}), prisma);

    const result = await service.recognizePage({
      organizationId: 'org-1',
      image: Buffer.from('page image'),
      pageNumber: 3,
    });

    expect(result).toMatchObject({
      text: 'Cached OCR text',
      provider: 'local-tesseract',
      cacheHit: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(updateCache).toHaveBeenCalledWith({
      where: { id: 'cache-1' },
      data: {
        hitCount: { increment: 1 },
        lastAccessedAt: expect.any(Date) as unknown,
      },
    });
  });

  it('uses managed fallback when primary confidence is low and caches it', async () => {
    let upsertCall: unknown;
    const upsertCache = jest.fn((input: unknown) => {
      upsertCall = input;
      return Promise.resolve({});
    });
    const prisma = {
      knowledgeExtractionConfig: {
        findUnique: jest.fn().mockResolvedValue(
          extractionConfig({
            primaryEndpoint: 'http://ocr.local/process',
            fallbackEndpoint: 'https://ocr-gateway.local/process',
          }),
        ),
      },
      knowledgeOcrPageCache: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        upsert: upsertCache,
      },
    } as unknown as PrismaService;
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          text: 'uncertain text',
          confidence: 42,
          provider: 'local-tesseract',
        }),
      )
      .mockResolvedValueOnce(
        response({
          text: 'Reliable managed OCR text',
          confidence: 0.98,
          provider: 'aws-textract',
        }),
      );
    const service = new KnowledgeOcrService(config({}), prisma);

    const result = await service.recognizePage({
      organizationId: 'org-1',
      image: Buffer.from('page image'),
      pageNumber: 8,
      documentName: 'handbook.pdf',
    });

    expect(result).toMatchObject({
      text: 'Reliable managed OCR text',
      confidence: 0.98,
      provider: 'aws-textract',
      cacheHit: false,
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(upsertCache).toHaveBeenCalledTimes(1);
    const upsertInput = upsertCall as {
      create: { organizationId: string; provider: string; text: string };
    };
    expect(upsertInput.create).toMatchObject({
      organizationId: 'org-1',
      provider: 'aws-textract',
      text: 'Reliable managed OCR text',
    });
  });

  it('uses fallback when the primary provider omits confidence', async () => {
    const prisma = {
      knowledgeExtractionConfig: {
        findUnique: jest.fn().mockResolvedValue(
          extractionConfig({
            primaryEndpoint: 'http://ocr.local/process',
            fallbackEndpoint: 'https://ocr-gateway.local/process',
          }),
        ),
      },
      knowledgeOcrPageCache: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ text: 'uncertain text' }))
      .mockResolvedValueOnce(
        response({ text: 'verified fallback text', confidence: 0.95 }),
      );
    const service = new KnowledgeOcrService(config({}), prisma);

    const result = await service.recognizePage({
      organizationId: 'org-1',
      image: Buffer.from('page image'),
      pageNumber: 4,
    });

    expect(result.text).toBe('verified fallback text');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('uses managed fallback when the primary provider is unavailable', async () => {
    const prisma = {
      knowledgeExtractionConfig: {
        findUnique: jest.fn().mockResolvedValue(
          extractionConfig({
            primaryEndpoint: 'http://ocr.local/process',
            fallbackEndpoint: 'https://ocr-gateway.local/process',
            maxRetries: 0,
          }),
        ),
      },
      knowledgeOcrPageCache: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('local OCR unavailable'))
      .mockResolvedValueOnce(
        response({
          text: 'Recovered by managed OCR',
          confidence: 0.97,
          provider: 'managed-ocr',
        }),
      );
    const service = new KnowledgeOcrService(config({}), prisma);

    const result = await service.recognizePage({
      organizationId: 'org-1',
      image: Buffer.from('page image'),
      pageNumber: 2,
    });

    expect(result.text).toBe('Recovered by managed OCR');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not use legacy OCR provider credentials from the environment', async () => {
    const prisma = {
      knowledgeExtractionConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaService;
    const service = new KnowledgeOcrService(
      config({
        KNOWLEDGE_OCR_PRIMARY_ENDPOINT: 'https://legacy.example.com/ocr',
        KNOWLEDGE_OCR_PRIMARY_API_KEY: 'legacy-secret',
      }),
      prisma,
    );

    const policy = await service.resolveRuntimePolicy('org-1');

    expect(policy.primary).toBeNull();
    expect(policy.fallback).toBeNull();
    expect(service.isConfigured(policy)).toBe(false);
  });

  it('resolves an isolated database policy and decrypts only its provider key', async () => {
    const now = new Date();
    const findExtractionConfig = jest.fn().mockResolvedValue({
      ocrMode: 'fallback',
      ocrMinConfidence: 0.88,
      ocrTimeoutMs: 45_000,
      ocrMaxRetries: 1,
      nativeTextMinCharacters: 80,
      nativeTextMinAlphanumericRatio: 0.6,
      ocrPageConcurrency: 6,
      ocrRenderWidth: 2_000,
      maxPdfPages: 8_000,
      maxExtractedCharacters: 30_000_000,
      primaryOcrProviderId: 'ocr-org-1',
      fallbackOcrProviderId: null,
      primaryOcrProvider: {
        id: 'ocr-org-1',
        organizationId: 'org-1',
        name: 'Private OCR',
        provider: 'aws_textract',
        status: 'active',
        endpoint: 'https://ocr.example.com/process',
        apiKeyEncrypted: 'encrypted',
        settings: { region: 'ap-south-1' },
        createdAt: now,
        updatedAt: now,
      },
      fallbackOcrProvider: null,
    });
    const prisma = {
      knowledgeExtractionConfig: {
        findUnique: findExtractionConfig,
      },
    } as unknown as PrismaService;
    const crypto = { decrypt: jest.fn().mockReturnValue('plain-secret') };
    const service = new KnowledgeOcrService(
      config({}),
      prisma,
      crypto as never,
    );

    const policy = await service.resolveRuntimePolicy('org-1');

    expect(policy).toMatchObject({
      mode: 'fallback',
      minimumConfidence: 0.88,
      ocrPageConcurrency: 6,
      primary: {
        id: 'ocr-org-1',
        provider: 'aws_textract',
        apiKey: 'plain-secret',
      },
    });
    expect(crypto.decrypt).toHaveBeenCalledWith('encrypted');
    expect(findExtractionConfig).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      include: {
        primaryOcrProvider: true,
        fallbackOcrProvider: true,
      },
    });
  });

  function config(values: Record<string, unknown>) {
    const defaults = {
      KNOWLEDGE_OCR_ALLOWED_HOSTS: 'ocr.local,ocr-gateway.local',
      KNOWLEDGE_OCR_ALLOW_PRIVATE_NETWORKS: true,
    };
    return {
      get: jest.fn((key: string) => ({ ...defaults, ...values })[key]),
    } as unknown as ConfigService;
  }

  function extractionConfig(input: {
    primaryEndpoint: string;
    fallbackEndpoint?: string;
    maxRetries?: number;
  }) {
    const now = new Date();
    const provider = (id: string, endpoint: string) => ({
      id,
      organizationId: 'org-1',
      name: id,
      provider: 'custom',
      status: 'active',
      endpoint,
      apiKeyEncrypted: null,
      settings: {},
      createdAt: now,
      updatedAt: now,
    });
    return {
      ocrMode: 'fallback',
      ocrMinConfidence: 0.75,
      ocrTimeoutMs: 60_000,
      ocrMaxRetries: input.maxRetries ?? 2,
      nativeTextMinCharacters: 40,
      nativeTextMinAlphanumericRatio: 0.5,
      ocrPageConcurrency: 4,
      ocrRenderWidth: 1_800,
      maxPdfPages: 5_000,
      maxExtractedCharacters: 25_000_000,
      settings: {},
      primaryOcrProviderId: 'primary',
      fallbackOcrProviderId: input.fallbackEndpoint ? 'fallback' : null,
      primaryOcrProvider: provider('primary', input.primaryEndpoint),
      fallbackOcrProvider: input.fallbackEndpoint
        ? provider('fallback', input.fallbackEndpoint)
        : null,
    };
  }

  function response(body: Record<string, unknown>): Response {
    return {
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(body),
    } as unknown as Response;
  }
});
