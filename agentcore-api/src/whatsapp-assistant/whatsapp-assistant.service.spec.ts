import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { WhatsAppAssistantConfig } from '@prisma/client';
import { createHmac } from 'crypto';
import { WhatsAppAssistantService } from './whatsapp-assistant.service';

function createService(
  prisma: Record<string, unknown> = {},
  rateLimit: Record<string, unknown> = { consume: jest.fn() },
  outbound: Record<string, unknown> = { sendText: jest.fn() },
  audit: Record<string, unknown> = { record: jest.fn() },
  chat: Record<string, unknown> = {
    answerWithContext: jest.fn(),
    answerConversationally: jest.fn().mockReturnValue(null),
  },
  knowledge: Record<string, unknown> = { search: jest.fn() },
) {
  return new WhatsAppAssistantService(
    audit as never,
    {} as never,
    chat as never,
    { decrypt: () => 'app-secret' } as never,
    knowledge as never,
    outbound as never,
    prisma as never,
    { enqueue: jest.fn(), isEnabled: () => true } as never,
    {
      get: (key: string, fallback?: unknown) =>
        key === 'NODE_ENV' ? 'test' : fallback,
    } as never,
    {} as never,
    rateLimit as never,
  );
}

const signedConfig = {
  id: 'config-1',
  appSecretEncrypted: 'encrypted',
} as WhatsAppAssistantConfig;

describe('WhatsAppAssistantService hardening', () => {
  it('selects an approved template using the detected conversation locale', async () => {
    const service = createService({
      whatsAppTemplate: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'en', name: 'order_update', language: 'en_US' },
          { id: 'hi', name: 'order_update', language: 'hi' },
        ]),
      },
    }) as unknown as {
      selectApprovedTemplate(
        config: WhatsAppAssistantConfig,
        name: string,
        requestedLanguage: string | undefined,
        conversationLocale: string,
      ): Promise<{ language: string }>;
    };

    await expect(
      service.selectApprovedTemplate(
        { id: 'config-1', defaultLocale: 'en_US' } as WhatsAppAssistantConfig,
        'order_update',
        undefined,
        'hi',
      ),
    ).resolves.toMatchObject({ language: 'hi' });
  });

  it('rate limits valid webhook traffic by config and IP', async () => {
    const consume = jest.fn().mockResolvedValue(undefined);
    const service = createService({}, { consume }) as unknown as {
      limitWebhook(configId: string, clientIp: string): Promise<void>;
    };

    await service.limitWebhook('config-1', '203.0.113.10');

    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume).toHaveBeenCalledWith(
      'whatsapp-webhook:config:config-1',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('accepts only an exact X-Hub-Signature-256 HMAC', () => {
    const service = createService() as unknown as {
      assertWebhookSignature(
        config: WhatsAppAssistantConfig,
        rawBody?: Buffer,
        headers?: Record<string, string>,
      ): void;
    };
    const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
    const signature = createHmac('sha256', 'app-secret')
      .update(rawBody)
      .digest('hex');

    expect(() =>
      service.assertWebhookSignature(signedConfig, rawBody, {
        'x-hub-signature-256': `sha256=${signature}`,
      }),
    ).not.toThrow();
    expect(() =>
      service.assertWebhookSignature(signedConfig, rawBody, {
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      }),
    ).toThrow(ForbiddenException);
  });

  it('fails webhook verification closed when required configuration or parameters are missing', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      id: 'config-1',
      organizationId: 'org-1',
      status: 'active',
      webhookVerifyTokenEncrypted: null,
    });
    const service = createService({
      organizationProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
      },
      whatsAppAssistantConfig: { findFirst },
    });

    await expect(
      service.verifyWebhook('config-1', 'subscribe', 'token', 'challenge'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    findFirst.mockResolvedValue({
      id: 'config-1',
      organizationId: 'org-1',
      status: 'active',
      webhookVerifyTokenEncrypted: 'encrypted',
    });
    await expect(
      service.verifyWebhook('config-1', undefined, 'app-secret', 'challenge'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.verifyWebhook('config-1', 'subscribe', 'app-secret', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns the challenge only for the exact configured verification token', async () => {
    const service = createService({
      organizationProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
      },
      whatsAppAssistantConfig: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'config-1',
          organizationId: 'org-1',
          status: 'active',
          webhookVerifyTokenEncrypted: 'encrypted',
        }),
      },
    });

    await expect(
      service.verifyWebhook(
        'config-1',
        'subscribe',
        'app-secret',
        'challenge-value',
      ),
    ).resolves.toBe('challenge-value');
    await expect(
      service.verifyWebhook(
        'config-1',
        'subscribe',
        'wrong-token',
        'challenge-value',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('deduplicates before updating the conversation session window', async () => {
    const upsert = jest.fn();
    const service = createService({
      whatsAppMessage: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'message-1',
          processedAt: new Date(),
        }),
      },
      whatsAppConversation: { upsert },
    }) as unknown as {
      persistInboundMessage(
        config: WhatsAppAssistantConfig,
        input: { contactWaId: string; providerMessageId: string },
      ): Promise<{ messageId: string; created: boolean; processed: boolean }>;
    };

    await expect(
      service.persistInboundMessage(
        {
          id: 'config-1',
          organizationId: 'org-1',
        } as WhatsAppAssistantConfig,
        { contactWaId: '15551234567', providerMessageId: 'wamid.duplicate' },
      ),
    ).resolves.toEqual({
      messageId: 'message-1',
      created: false,
      processed: true,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('uses the active topic, recent history, folder scope, and confidence filter for follow-ups', async () => {
    const answerWithContext = jest.fn().mockResolvedValue({
      answer: 'The premium plan includes priority support.',
      model: 'test-model',
      provider: 'openai',
      adapter: 'openai',
      usedFallback: false,
    });
    const search = jest.fn().mockResolvedValue([
      {
        id: 'chunk-strong',
        content: 'Premium pricing includes priority support.',
        score: 0.82,
      },
      {
        id: 'chunk-weak',
        content: 'An unrelated document.',
        score: 0.1,
      },
    ]);
    const sendText = jest.fn().mockResolvedValue({
      provider: 'meta',
      status: 'sent',
      providerMessageId: 'wamid.reply',
    });
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({
        metadata: {
          memory: {
            activeTopicQuery: 'premium pricing',
            clarificationRequested: false,
            clarificationAttempts: 0,
          },
        },
      })
      .mockResolvedValueOnce({ status: 'open', assignedAgentId: null });
    const findMany = jest.fn().mockResolvedValue([
      {
        role: 'assistant',
        content: 'Our plans start at $20.',
        metadata: {},
      },
      { role: 'contact', content: 'Tell me about pricing.', metadata: {} },
    ]);
    let updateInput: { data: { status: string } } | undefined;
    const updateMany = jest.fn((input: { data: { status: string } }) => {
      updateInput = input;
      return Promise.resolve({ count: 1 });
    });
    const create = jest
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'assistant-message', ...data }),
      );
    const service = createService(
      {
        whatsAppConversation: { findUnique, updateMany },
        whatsAppMessage: { findMany, create },
      },
      { consume: jest.fn() },
      { sendText },
      { record: jest.fn().mockResolvedValue(undefined) },
      {
        answerConversationally: jest.fn().mockReturnValue(null),
        answerWithContext,
      },
      { search },
    ) as unknown as {
      createAssistantReply(
        config: WhatsAppAssistantConfig,
        organizationId: string,
        conversationId: string,
        contactWaId: string,
        content: string,
        appointmentAction: undefined,
        locale: string,
        inboundMessageId: string,
      ): Promise<unknown>;
    };

    await service.createAssistantReply(
      {
        id: 'config-1',
        settings: {
          memoryEnabled: true,
          recentMessageLimit: 8,
          knowledgeScope: 'folders',
          folderIds: ['folder-1'],
        },
      } as WhatsAppAssistantConfig,
      'org-1',
      'conversation-1',
      '15551234567',
      'What about that?',
      undefined,
      'en',
      'current-inbound',
    );

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1' }),
      expect.objectContaining({
        query: 'premium pricing\nFollow-up request: What about that?',
        limit: 10,
        productKey: 'whatsapp_assistant',
        folderIds: ['folder-1'],
      }),
    );
    expect(answerWithContext).toHaveBeenCalledWith(
      expect.objectContaining({
        history: [
          { role: 'user', content: 'Tell me about pricing.' },
          { role: 'assistant', content: 'Our plans start at $20.' },
        ],
        context: [
          {
            content: 'Premium pricing includes priority support.',
            score: 0.82,
          },
        ],
      }),
    );
    expect(updateInput?.data).toMatchObject({ status: 'open' });
  });

  it('hands off after the configured number of low-confidence clarifications', () => {
    const service = createService() as unknown as {
      resolveLowConfidenceDecision(
        policy: {
          enabled: boolean;
          recentMessageLimit: number;
          lowConfidenceAction: 'clarify' | 'handoff';
          maxClarificationAttempts: number;
        },
        previous: {
          clarificationRequested: boolean;
          clarificationAttempts: number;
        },
      ): { attempts: number; shouldHandoff: boolean };
    };
    const policy = {
      enabled: true,
      recentMessageLimit: 8,
      lowConfidenceAction: 'clarify' as const,
      maxClarificationAttempts: 2,
    };

    expect(
      service.resolveLowConfidenceDecision(policy, {
        clarificationRequested: false,
        clarificationAttempts: 0,
      }),
    ).toEqual({ attempts: 1, shouldHandoff: false });
    expect(
      service.resolveLowConfidenceDecision(policy, {
        clarificationRequested: true,
        clarificationAttempts: 1,
      }),
    ).toEqual({ attempts: 2, shouldHandoff: true });
  });

  it('sends a guarded response and suppresses future AI replies after repeated low confidence', async () => {
    let sentInput: { content: string } | undefined;
    const sendText = jest.fn((input: { content: string }) => {
      sentInput = input;
      return Promise.resolve({
        provider: 'meta',
        status: 'sent',
        providerMessageId: 'wamid.handoff',
      });
    });
    const auditRecord = jest.fn().mockResolvedValue(undefined);
    let updateInput: { data: { status: string } } | undefined;
    const updateMany = jest.fn((input: { data: { status: string } }) => {
      updateInput = input;
      return Promise.resolve({ count: 1 });
    });
    const service = createService(
      {
        whatsAppConversation: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({
              metadata: {
                memory: {
                  activeTopicQuery: 'refund policy',
                  clarificationRequested: true,
                  clarificationAttempts: 1,
                },
              },
            })
            .mockResolvedValueOnce({ status: 'open', assignedAgentId: null }),
          updateMany,
        },
        whatsAppMessage: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest
            .fn()
            .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
              Promise.resolve({ id: 'assistant-message', ...data }),
            ),
        },
      },
      { consume: jest.fn() },
      { sendText },
      { record: auditRecord },
      {
        answerConversationally: jest.fn().mockReturnValue(null),
        answerWithContext: jest.fn(),
      },
      { search: jest.fn().mockResolvedValue([]) },
    ) as unknown as {
      createAssistantReply(
        config: WhatsAppAssistantConfig,
        organizationId: string,
        conversationId: string,
        contactWaId: string,
        content: string,
        appointmentAction: undefined,
        locale: string,
        inboundMessageId: string,
      ): Promise<unknown>;
    };

    await service.createAssistantReply(
      {
        id: 'config-1',
        settings: {
          memoryEnabled: true,
          lowConfidenceAction: 'clarify',
          maxClarificationAttempts: 2,
        },
      } as WhatsAppAssistantConfig,
      'org-1',
      'conversation-1',
      '15551234567',
      'I still do not understand it',
      undefined,
      'en',
      'current-inbound',
    );

    expect(sentInput?.content).toContain('human agent');
    expect(updateInput?.data.status).toBe('waiting_for_agent');
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'whatsapp.auto_handoff_requested' }),
    );
  });

  it('persists a final processing-failure handoff and marks the inbound message processed', async () => {
    let conversationUpdate: { data: { status: string } } | undefined;
    let inboundUpdate:
      { data: { processedAt: Date; processingError: string } } | undefined;
    const create = jest.fn().mockResolvedValue({ id: 'failure-notice' });
    const auditRecord = jest.fn().mockResolvedValue(undefined);
    const service = createService(
      {
        whatsAppConversation: {
          updateMany: jest.fn((input: { data: { status: string } }) => {
            conversationUpdate = input;
            return Promise.resolve({ count: 1 });
          }),
        },
        whatsAppMessage: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'inbound-1',
            direction: 'inbound',
            processedAt: null,
            conversation: {
              id: 'conversation-1',
              organizationId: 'org-1',
              contactWaId: '15551234567',
              config: { id: 'config-1' },
            },
          }),
          create,
          update: jest.fn(
            (input: {
              data: { processedAt: Date; processingError: string };
            }) => {
              inboundUpdate = input;
              return Promise.resolve({});
            },
          ),
        },
      },
      { consume: jest.fn() },
      {
        sendText: jest.fn().mockResolvedValue({
          provider: 'meta',
          status: 'sent',
          providerMessageId: 'wamid.failure-notice',
        }),
      },
      { record: auditRecord },
    );

    await service.recoverInboundFailure(
      'inbound-1',
      new Error('knowledge provider unavailable'),
    );

    expect(conversationUpdate?.data.status).toBe('waiting_for_agent');
    expect(create).toHaveBeenCalled();
    expect(inboundUpdate?.data.processedAt).toBeInstanceOf(Date);
    expect(inboundUpdate?.data.processingError).toContain(
      'knowledge provider unavailable',
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'whatsapp.auto_handoff_requested' }),
    );
  });

  it('marks assigned inbound messages processed without invoking AI', async () => {
    type UpdateMessage = (input: {
      where: { id: string };
      data: { processingError?: string | null };
    }) => Promise<unknown>;
    let updateInput: Parameters<UpdateMessage>[0] | undefined;
    const updateImplementation: UpdateMessage = (input) => {
      updateInput = input;
      return Promise.resolve({});
    };
    const update = jest.fn(updateImplementation);
    const service = createService({
      whatsAppMessage: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'message-1',
          direction: 'inbound',
          processedAt: null,
          conversation: {
            id: 'conversation-1',
            status: 'open',
            assignedAgentId: 'agent-1',
            config: signedConfig,
          },
        }),
        update,
      },
    });

    await service.processInboundMessage('message-1');

    expect(update).toHaveBeenCalled();
    expect(updateInput?.where).toEqual({ id: 'message-1' });
    expect(updateInput?.data.processingError).toBeNull();
  });

  it('persists a failed agent send and returns a sanitized provider error', async () => {
    type MessageCreateInput = {
      data: { deliveryStatus?: string; providerMessageId?: string };
    };
    type MessageUpdateInput = {
      where: { id: string };
      data: {
        deliveryStatus?: string;
        deliveryError?: string;
        deliveryAttempts?: { increment: number };
      };
    };
    type ConversationUpdateInput = {
      data: { status?: string; assignedAgentId?: string };
    };
    const providerError = new Error('private provider response body');
    const sendText = jest.fn().mockRejectedValue(providerError);
    let createInput: MessageCreateInput | undefined;
    const create = jest.fn((input: MessageCreateInput) => {
      createInput = input;
      return Promise.resolve({
        id: 'message-1',
        deliveryStatus: 'pending',
        deliveryAttempts: 0,
        metadata: {},
      });
    });
    let messageUpdateInput: MessageUpdateInput | undefined;
    const updateMessage = jest.fn((input: MessageUpdateInput) => {
      messageUpdateInput = input;
      return Promise.resolve({});
    });
    const conversation = {
      id: 'conversation-1',
      organizationId: 'org-1',
      configId: 'config-1',
      contactWaId: '919876543210',
      assignedAgentId: null,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      messages: [],
    };
    let conversationUpdateInput: ConversationUpdateInput | undefined;
    const updateConversation = jest.fn((input: ConversationUpdateInput) => {
      conversationUpdateInput = input;
      return Promise.resolve({
        ...conversation,
        status: 'waiting_for_agent',
        assignedAgentId: 'agent-1',
      });
    });
    const service = createService(
      {
        organizationProduct: {
          findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
        },
        whatsAppAssistantConfig: {
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'config-1' }),
        },
        whatsAppConversation: {
          findUnique: jest.fn().mockResolvedValue(conversation),
          update: updateConversation,
        },
        whatsAppMessage: { create, update: updateMessage },
      },
      { consume: jest.fn().mockResolvedValue(undefined) },
      { sendText },
      { record: jest.fn().mockResolvedValue(undefined) },
    );

    let thrown: unknown;
    try {
      await service.sendAgentMessage(
        {
          sub: 'agent-1',
          email: 'agent@example.com',
          orgId: 'org-1',
          roles: ['agent'],
        },
        conversation.id,
        { content: 'Hello' },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect((thrown as Error).message).not.toContain(providerError.message);
    expect(conversationUpdateInput?.data).toMatchObject({
      status: 'waiting_for_agent',
      assignedAgentId: 'agent-1',
    });
    expect(createInput?.data.deliveryStatus).toBe('pending');
    expect(createInput?.data.providerMessageId).toBeUndefined();
    expect(messageUpdateInput?.where).toEqual({ id: 'message-1' });
    expect(messageUpdateInput?.data).toMatchObject({
      deliveryStatus: 'failed',
      deliveryError: 'Provider delivery failed after retry attempts',
      deliveryAttempts: { increment: 1 },
    });
  });
});
