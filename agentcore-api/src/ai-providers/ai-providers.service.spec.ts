/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type { AIProviderConfig } from '@prisma/client';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { AIProvidersService } from './ai-providers.service';

describe('AIProvidersService', () => {
  const user = {
    sub: 'user-1',
    email: 'admin@example.com',
    orgId: 'org-1',
    roles: ['org_admin'],
  } as AuthenticatedUser;
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('runs endpoint policy, rate limiting, and live embedding verification', async () => {
    const { service, endpointPolicy, rateLimit, prisma, adapter } = setup();
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        response({ data: [{ id: 'chat-model' }, { id: 'embed-model' }] }),
      );
    adapter.createEmbedding.mockResolvedValue({
      vector: Array.from({ length: 1536 }, () => 0.01),
      model: 'embed-model',
      adapter: 'openai',
    });

    const result = await service.validate(user, 'provider-1');

    expect(rateLimit.consume).toHaveBeenCalledWith(
      'ai-provider-test:org-1:user-1:provider-1',
      10,
      60,
      expect.any(String),
    );
    expect(endpointPolicy.assertProviderAllowed).toHaveBeenCalled();
    expect(adapter.createEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'embed-model' }),
    );
    expect(prisma.aIProviderConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ validationStatus: 'verified' }),
      }),
    );
    expect(result.validationStatus).toBe('verified');
  });

  it('marks validation failed when the provider returns the wrong vector size', async () => {
    const { service, prisma, adapter } = setup();
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        response({ data: [{ id: 'chat-model' }, { id: 'embed-model' }] }),
      );
    adapter.createEmbedding.mockResolvedValue({
      vector: [0.1, 0.2],
      model: 'embed-model',
      adapter: 'openai',
    });

    const result = await service.validate(user, 'provider-1');

    expect(prisma.aIProviderConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          validationStatus: 'failed',
          validationError: expect.stringContaining('2 dimensions'),
        }),
      }),
    );
    expect(result.validationStatus).toBe('failed');
  });

  it('soft deletes providers without erasing usage history', async () => {
    const { service, prisma } = setup();
    prisma.knowledgeExtractionConfig.findFirst.mockResolvedValue(null);

    await expect(service.delete(user, 'provider-1')).resolves.toEqual({
      deleted: true,
    });

    expect(prisma.aIProviderConfig.update).toHaveBeenCalledWith({
      where: { id: 'provider-1' },
      data: expect.objectContaining({
        deletedAt: expect.any(Date),
        status: 'inactive',
        apiKeyEncrypted: null,
      }),
    });
    expect(prisma.aIProviderConfig.delete).not.toHaveBeenCalled();
  });

  function setup() {
    const configRecord = provider();
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const usage = {
      summarize: jest.fn().mockResolvedValue({}),
      summarizeMany: jest.fn(),
    };
    const config = { get: jest.fn() };
    const crypto = { decrypt: jest.fn().mockReturnValue('api-key') };
    const queue = { isEnabled: jest.fn().mockReturnValue(true) };
    const prisma = {
      aIProviderConfig: {
        findFirst: jest.fn().mockResolvedValue(configRecord),
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ ...configRecord, ...data }),
          ),
        delete: jest.fn(),
      },
      knowledgeExtractionConfig: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({
          embeddingProviderId: 'provider-1',
        }),
      },
    };
    const endpointPolicy = {
      assertProviderAllowed: jest.fn().mockResolvedValue(undefined),
    };
    const adapter = { createEmbedding: jest.fn() };
    const registry = { getAdapter: jest.fn().mockReturnValue(adapter) };
    const rateLimit = { consume: jest.fn().mockResolvedValue(undefined) };
    const service = new AIProvidersService(
      audit as never,
      usage as never,
      config as never,
      crypto as never,
      queue as never,
      prisma as never,
      endpointPolicy as never,
      registry as never,
      rateLimit as never,
    );
    return { service, endpointPolicy, rateLimit, prisma, adapter };
  }

  function provider(): AIProviderConfig {
    return {
      id: 'provider-1',
      organizationId: 'org-1',
      provider: 'openai',
      status: 'active',
      priority: 0,
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEncrypted: 'encrypted',
      chatModel: 'chat-model',
      embeddingModel: 'embed-model',
      rerankModel: null,
      sttModel: null,
      ttsModel: null,
      settings: { embeddingDimensions: 1536 },
      lastValidatedAt: null,
      validationStatus: 'untested',
      validationLatency: null,
      validationError: null,
      validatedModels: [],
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  function response(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(body),
    } as unknown as Response;
  }
});
