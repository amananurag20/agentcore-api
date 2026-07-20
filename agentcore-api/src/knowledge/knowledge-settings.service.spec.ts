import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { KnowledgeSettingsService } from './knowledge-settings.service';

describe('KnowledgeSettingsService', () => {
  const orgAdmin = {
    sub: 'user-1',
    email: 'admin@example.com',
    orgId: 'org-1',
    roles: ['org_admin'],
  } as AuthenticatedUser;

  it('prevents an organization admin from reading another workspace policy', async () => {
    const { service, prisma } = createService();

    await expect(
      service.getExtractionSettings(orgAdmin, 'org-2'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.knowledgeExtractionConfig.findUnique).not.toHaveBeenCalled();
  });

  it('encrypts OCR credentials and never returns them', async () => {
    const { service, prisma, crypto } = createService();
    prisma.knowledgeOcrProviderConfig.create.mockResolvedValue({
      id: 'ocr-1',
      organizationId: 'org-1',
      name: 'Local OCR',
      provider: 'local_tesseract',
      status: 'active',
      endpoint: null,
      apiKeyEncrypted: 'encrypted-secret',
      settings: { language: 'eng' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.createOcrProvider(orgAdmin, {
      name: 'Local OCR',
      provider: 'local_tesseract',
      apiKey: 'secret',
      settings: { language: 'eng' },
    });

    expect(crypto.encrypt).toHaveBeenCalledWith('secret');
    expect(result.hasApiKey).toBe(true);
    expect(result).not.toHaveProperty('apiKeyEncrypted');
    expect(prisma.knowledgeOcrProviderConfig.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: 'org-1' }) as unknown,
    });
  });

  it('rejects OCR selections that do not belong to the active workspace', async () => {
    const { service, prisma } = createService();
    prisma.knowledgeExtractionConfig.findUnique.mockResolvedValue(null);
    prisma.knowledgeOcrProviderConfig.findMany.mockResolvedValue([]);

    await expect(
      service.updateExtractionSettings(orgAdmin, {
        primaryOcrProviderId: 'foreign-provider',
      }),
    ).rejects.toThrow(
      'Selected OCR providers must be active and belong to this workspace',
    );
  });

  it('rejects non-allowlisted OCR endpoints in production', async () => {
    const { service, prisma } = createService({
      NODE_ENV: 'production',
      KNOWLEDGE_OCR_ALLOWED_HOSTS: 'ocr.internal:8080',
    });

    await expect(
      service.createOcrProvider(orgAdmin, {
        name: 'Unsafe OCR',
        provider: 'custom',
        endpoint: 'http://127.0.0.1:9000/ocr',
      }),
    ).rejects.toThrow('OCR endpoint host is not allowed');
    expect(prisma.knowledgeOcrProviderConfig.create).not.toHaveBeenCalled();
  });

  function createService(configValues: Record<string, unknown> = {}) {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const crypto = {
      encrypt: jest.fn().mockReturnValue('encrypted-secret'),
      decrypt: jest.fn(),
    };
    const queue = {
      isEnabled: jest.fn().mockReturnValue(true),
      enqueue: jest.fn(),
    };
    const ingestion = { ingestSource: jest.fn() };
    const prisma = {
      knowledgeExtractionConfig: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        upsert: jest.fn(),
      },
      knowledgeOcrProviderConfig: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      aIProviderConfig: { findFirst: jest.fn() },
      knowledgeSource: { findMany: jest.fn(), updateMany: jest.fn() },
    };
    const config = {
      get: jest.fn((key: string) => configValues[key]),
    } as unknown as ConfigService;
    const service = new KnowledgeSettingsService(
      audit as never,
      config,
      crypto as never,
      queue as never,
      ingestion as never,
      prisma as never,
    );
    return { service, prisma, crypto };
  }
});
