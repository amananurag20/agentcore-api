import {
  BadRequestException,
  ConflictException,
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
  const adminUser = {
    sub: 'admin-1',
    email: 'admin@example.com',
    orgId: 'org-1',
    roles: ['org_admin'],
  };

  it('deletes an unused organization-scoped WhatsApp configuration', async () => {
    const deleteConfig = jest.fn().mockResolvedValue({});
    const auditRecord = jest.fn().mockResolvedValue(undefined);
    const service = createService(
      {
        organizationProduct: {
          findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
        },
        whatsAppAssistantConfig: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'config-1',
            organizationId: 'org-1',
            name: 'Primary Meta',
            provider: 'meta',
            status: 'inactive',
          }),
          delete: deleteConfig,
        },
        whatsAppConversation: { count: jest.fn().mockResolvedValue(0) },
      },
      { consume: jest.fn() },
      { sendText: jest.fn() },
      { record: auditRecord },
    );

    await expect(service.deleteConfig(adminUser, 'config-1')).resolves.toEqual({
      deleted: true,
      id: 'config-1',
    });
    expect(deleteConfig).toHaveBeenCalledWith({ where: { id: 'config-1' } });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'whatsapp.config_deleted' }),
    );
  });

  it('preserves conversation history when configuration deletion is requested', async () => {
    const deleteConfig = jest.fn();
    const service = createService({
      organizationProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
      },
      whatsAppAssistantConfig: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'config-1',
          organizationId: 'org-1',
          status: 'inactive',
        }),
        delete: deleteConfig,
      },
      whatsAppConversation: { count: jest.fn().mockResolvedValue(1) },
    });

    await expect(
      service.deleteConfig(adminUser, 'config-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(deleteConfig).not.toHaveBeenCalled();
  });

  it('requires a configuration to be inactive before deletion', async () => {
    const count = jest.fn();
    const service = createService({
      organizationProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
      },
      whatsAppAssistantConfig: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'config-1',
          organizationId: 'org-1',
          status: 'active',
        }),
      },
      whatsAppConversation: { count },
    });

    await expect(
      service.deleteConfig(adminUser, 'config-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(count).not.toHaveBeenCalled();
  });

  it('creates a validated local WhatsApp template draft', async () => {
    const create = jest
      .fn<(input: unknown) => Promise<Record<string, unknown>>>()
      .mockResolvedValue({
        id: 'template-1',
        configId: 'config-1',
        name: 'appointment_reminder',
        language: 'en_US',
        status: 'DRAFT',
        source: 'local',
      });
    const service = createService({
      organizationProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
      },
      whatsAppAssistantConfig: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'config-1',
          organizationId: 'org-1',
          provider: 'meta',
        }),
      },
      whatsAppTemplate: { create },
    });

    await expect(
      service.createTemplate(adminUser, 'config-1', {
        name: 'appointment_reminder',
        language: 'en_US',
        category: 'UTILITY' as never,
        components: [
          {
            type: 'BODY',
            text: 'Hi {{1}}, your appointment is on {{2}}.',
            example: { body_text: [['Ada', 'Monday']] },
          },
        ],
      }),
    ).resolves.toMatchObject({ status: 'DRAFT', source: 'local' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rejects draft variables without matching Meta examples', async () => {
    const create = jest.fn();
    const service = createService({
      organizationProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
      },
      whatsAppAssistantConfig: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'config-1',
          organizationId: 'org-1',
          provider: 'meta',
        }),
      },
      whatsAppTemplate: { create },
    });

    await expect(
      service.createTemplate(adminUser, 'config-1', {
        name: 'appointment_reminder',
        language: 'en_US',
        category: 'UTILITY' as never,
        components: [{ type: 'BODY', text: 'Hello {{1}}' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts Meta authentication components and rejects generic auth copy', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'auth-1',
      status: 'DRAFT',
      source: 'local',
    });
    const service = createService({
      organizationProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
      },
      whatsAppAssistantConfig: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'config-1',
          organizationId: 'org-1',
          provider: 'meta',
        }),
      },
      whatsAppTemplate: { create },
    });
    const valid = {
      name: 'login_code',
      language: 'en_US',
      category: 'AUTHENTICATION' as never,
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: 10 },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }],
        },
      ],
    };

    await expect(
      service.createTemplate(adminUser, 'config-1', valid),
    ).resolves.toMatchObject({ status: 'DRAFT' });
    await expect(
      service.createTemplate(adminUser, 'config-1', {
        ...valid,
        components: [
          { type: 'BODY', text: 'Your code is {{1}}' },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' },
            ],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires review examples for dynamic URLs and sample handles for media headers', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'template-1' });
    const service = createService({
      organizationProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
      },
      whatsAppAssistantConfig: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'config-1',
          organizationId: 'org-1',
          provider: 'meta',
        }),
      },
      whatsAppTemplate: { create },
    });
    const base = {
      name: 'offer_image',
      language: 'en_US',
      category: 'MARKETING' as never,
      components: [
        {
          type: 'HEADER',
          format: 'IMAGE',
          example: { header_handle: ['4::sample-handle'] },
        },
        { type: 'BODY', text: 'See your offer' },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              text: 'View offer',
              url: 'https://example.com/offers/{{1}}',
              example: ['summer2026'],
            },
          ],
        },
      ],
    };

    await expect(
      service.createTemplate(adminUser, 'config-1', base),
    ).resolves.toBeDefined();
    await expect(
      service.createTemplate(adminUser, 'config-1', {
        ...base,
        components: [
          { type: 'BODY', text: 'See your offer' },
          {
            type: 'BUTTONS',
            buttons: [
              {
                type: 'URL',
                text: 'View offer',
                url: 'https://example.com/offers/{{1}}',
              },
            ],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates runtime send values against the approved template definition', () => {
    const service = createService() as unknown as {
      normalizeTemplateSendComponents(
        category: string,
        definitions: Record<string, unknown>[],
        components: Record<string, unknown>[],
      ): Record<string, unknown>[];
    };
    const definitions = [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Hello {{1}}, order {{2}} is ready.' },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'View order',
            url: 'https://example.com/orders/{{1}}',
          },
        ],
      },
    ];
    const components = [
      {
        type: 'header',
        parameters: [
          { type: 'image', image: { link: 'https://cdn.example.com/a.jpg' } },
        ],
      },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Ada' },
          { type: 'text', text: 'ORD-1' },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'ORD-1' }],
      },
    ];

    expect(
      service.normalizeTemplateSendComponents(
        'UTILITY',
        definitions,
        components,
      ),
    ).toHaveLength(3);
    expect(() =>
      service.normalizeTemplateSendComponents(
        'UTILITY',
        definitions,
        components.filter((component) => component.type !== 'body'),
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      service.normalizeTemplateSendComponents('UTILITY', definitions, [
        ...components.slice(0, 2),
        { ...components[2], index: '9' },
      ]),
    ).toThrow(BadRequestException);
  });

  it('requires both authentication code bindings at send time', () => {
    const service = createService() as unknown as {
      normalizeTemplateSendComponents(
        category: string,
        definitions: Record<string, unknown>[],
        components: Record<string, unknown>[],
      ): Record<string, unknown>[];
    };
    const definitions = [
      { type: 'BODY', add_security_recommendation: true },
      {
        type: 'BUTTONS',
        buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }],
      },
    ];
    const body = {
      type: 'body',
      parameters: [{ type: 'text', text: '483920' }],
    };
    const button = {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: '483920' }],
    };

    expect(
      service.normalizeTemplateSendComponents('AUTHENTICATION', definitions, [
        body,
        button,
      ]),
    ).toHaveLength(2);
    expect(() =>
      service.normalizeTemplateSendComponents('AUTHENTICATION', definitions, [
        body,
      ]),
    ).toThrow(BadRequestException);
  });

  it('submits an immutable draft to Meta and persists its provider lifecycle', async () => {
    const update = jest
      .fn<(input: unknown) => Promise<Record<string, unknown>>>()
      .mockResolvedValue({
        id: 'template-1',
        status: 'PENDING',
        providerTemplateId: 'meta-template-1',
      });
    const createMetaTemplate = jest.fn().mockResolvedValue({
      id: 'meta-template-1',
      status: 'PENDING',
    });
    const service = createService(
      {
        organizationProduct: {
          findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
        },
        whatsAppAssistantConfig: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'config-1',
            organizationId: 'org-1',
            provider: 'meta',
          }),
        },
        whatsAppTemplate: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'template-1',
            configId: 'config-1',
            name: 'appointment_reminder',
            language: 'en_US',
            category: 'UTILITY',
            status: 'DRAFT',
            providerTemplateId: null,
            components: [{ type: 'BODY', text: 'Appointment confirmed' }],
          }),
          update,
        },
      },
      { consume: jest.fn() },
      { createMetaTemplate },
    );

    await expect(
      service.submitTemplate(adminUser, 'config-1', 'template-1'),
    ).resolves.toMatchObject({ status: 'PENDING' });
    expect(createMetaTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'config-1' }),
      expect.objectContaining({ name: 'appointment_reminder' }),
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

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
