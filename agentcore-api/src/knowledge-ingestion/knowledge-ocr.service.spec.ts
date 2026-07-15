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
        findUnique: jest.fn().mockResolvedValue(null),
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
    const service = new KnowledgeOcrService(
      config({ KNOWLEDGE_OCR_PRIMARY_ENDPOINT: 'http://ocr.local/process' }),
      prisma,
    );

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
        findUnique: jest.fn().mockResolvedValue(null),
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
    const service = new KnowledgeOcrService(
      config({
        KNOWLEDGE_OCR_PRIMARY_ENDPOINT: 'http://ocr.local/process',
        KNOWLEDGE_OCR_FALLBACK_ENDPOINT: 'https://ocr-gateway/process',
        KNOWLEDGE_OCR_MIN_CONFIDENCE: 0.75,
      }),
      prisma,
    );

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

  it('uses managed fallback when the primary provider is unavailable', async () => {
    const prisma = {
      knowledgeExtractionConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
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
    const service = new KnowledgeOcrService(
      config({
        KNOWLEDGE_OCR_PRIMARY_ENDPOINT: 'http://ocr.local/process',
        KNOWLEDGE_OCR_FALLBACK_ENDPOINT: 'https://ocr-gateway/process',
        KNOWLEDGE_OCR_MAX_RETRIES: 0,
      }),
      prisma,
    );

    const result = await service.recognizePage({
      image: Buffer.from('page image'),
      pageNumber: 2,
    });

    expect(result.text).toBe('Recovered by managed OCR');
    expect(global.fetch).toHaveBeenCalledTimes(2);
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
    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  }

  function response(body: Record<string, unknown>): Response {
    return {
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(body),
    } as unknown as Response;
  }
});
