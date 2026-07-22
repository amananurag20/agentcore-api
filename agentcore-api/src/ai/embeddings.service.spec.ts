import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingsService } from './embeddings.service';

function createService(config: Record<string, unknown>) {
  const configService = {
    get: jest.fn((key: string) => config[key]),
  } as unknown as ConfigService;
  const prisma = {
    aIProviderConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    knowledgeExtractionConfig: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  return new EmbeddingsService(
    configService,
    {} as never,
    prisma as never,
    {} as never,
  );
}

describe('EmbeddingsService production controls', () => {
  it('fails closed when no real provider is configured in production', async () => {
    const service = createService({
      NODE_ENV: 'production',
      ALLOW_LOCAL_EMBEDDINGS: false,
    });

    await expect(
      service.embedText({ organizationId: 'org-a', text: 'refund policy' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('allows deterministic embeddings only when explicitly enabled', async () => {
    const service = createService({
      ALLOW_LOCAL_EMBEDDINGS: true,
    });
    const result = await service.embedText({
      organizationId: 'org-a',
      text: 'refund policy',
    });

    expect(result.provider).toBe('local');
    expect(result.vector).toHaveLength(1536);
  });

  it('never allows deterministic embeddings to be persisted in an index', async () => {
    const service = createService({
      ALLOW_LOCAL_EMBEDDINGS: true,
    });

    await expect(
      service.embedForIndexing({
        organizationId: 'org-a',
        text: 'refund policy',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
